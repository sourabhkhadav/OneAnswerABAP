"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { PassThrough } = require("node:stream");

const SESSION_COOKIE_NAME = "zoa_sid";
const STUDENT_SHARED_PASSWORD = "hana@123";
const STUDENT_ID_PATTERN = /^S23AH\d+$/i;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const AUTHORITY_ROLES = {
    S23AH18: { role: "DIRECTOR", label: "Director" },
    S23AH56: { role: "TEACHER", label: "Teacher" },
    S23AH63: { role: "HOD", label: "HOD" }
};

// Ephemeral AES-256-GCM key used to encrypt SAP Basic Auth headers in server memory
const SESSION_SECRET = crypto.randomBytes(32);
const sessions = new Map();

/**
 * Load key=value entries from local .env without overwriting existing process.env values.
 */
function loadDotEnv(dir) {
    const envPath = path.join(dir, ".env");
    if (!fs.existsSync(envPath)) {
        return {};
    }
    const parsed = {};
    const content = fs.readFileSync(envPath, "utf8").replace(/^\uFEFF/, "");
    const lines = content.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) {
            continue;
        }
        const eqIdx = line.indexOf("=");
        if (eqIdx <= 0) {
            continue;
        }
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if ((val.startsWith("\"") && val.endsWith("\"")) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        parsed[key] = val;
    }
    return parsed;
}

/**
 * Read Student service-account credentials strictly from environment / .env.
 */
function getStudentServiceCredentials(config) {
    const projectRoot = path.resolve(__dirname, "..", "..");
    const fileEnv = Object.assign({}, loadDotEnv(projectRoot), loadDotEnv(process.cwd()));
    const user = (
        process.env.SAP_STUDENT_USER ||
        fileEnv.SAP_STUDENT_USER ||
        process.env.SAP_USER ||
        process.env.FIORI_TOOLS_USER ||
        fileEnv.SAP_USER ||
        fileEnv.FIORI_TOOLS_USER ||
        ""
    ).trim();
    const password =
        process.env.SAP_STUDENT_PASSWORD ||
        fileEnv.SAP_STUDENT_PASSWORD ||
        process.env.SAP_PASSWORD ||
        process.env.FIORI_TOOLS_PASSWORD ||
        fileEnv.SAP_PASSWORD ||
        fileEnv.FIORI_TOOLS_PASSWORD ||
        "";
    const client = (process.env.SAP_CLIENT || process.env.FIORI_TOOLS_CLIENT || fileEnv.SAP_CLIENT || fileEnv.FIORI_TOOLS_CLIENT || config.client || "800").trim();
    return { user, password, client, projectRoot };
}

function encryptText(plainText) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", SESSION_SECRET, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { iv, encrypted, authTag };
}

function decryptText(payload) {
    const decipher = crypto.createDecipheriv("aes-256-gcm", SESSION_SECRET, payload.iv);
    decipher.setAuthTag(payload.authTag);
    return Buffer.concat([decipher.update(payload.encrypted), decipher.final()]).toString("utf8");
}

function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) {
        return cookies;
    }
    for (const part of String(cookieHeader).split(";")) {
        const idx = part.indexOf("=");
        if (idx <= 0) {
            continue;
        }
        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (name) {
            cookies[name] = value;
        }
    }
    return cookies;
}

function mergeSetCookies(cookieJar, setCookieHeader) {
    if (!setCookieHeader) {
        return;
    }
    const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const entry of list) {
        const firstPart = String(entry).split(";")[0];
        const eqIdx = firstPart.indexOf("=");
        if (eqIdx <= 0) {
            continue;
        }
        const name = firstPart.slice(0, eqIdx).trim();
        const value = firstPart.slice(eqIdx + 1).trim();
        const lower = String(entry).toLowerCase();
        if (!value || lower.includes("max-age=0")) {
            delete cookieJar[name];
        } else {
            cookieJar[name] = value;
        }
    }
}

function serializeCookies(cookieJar) {
    const entries = Object.entries(cookieJar || {});
    return entries.map(([k, v]) => `${k}=${v}`).join("; ");
}

function buildClearCookiesHeaders(req) {
    const headers = [
        `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    ];
    const incoming = parseCookies(req.headers.cookie);
    for (const name of Object.keys(incoming)) {
        if (/^(SAP_SESSIONID|sap-usercontext|MYSAPSSO2|sap-XSRF)/i.test(name)) {
            headers.push(`${name}=; Path=/; Max-Age=0`);
        }
    }
    return headers;
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > 64 * 1024) {
                reject(new Error("Request payload too large"));
            }
        });
        req.on("end", () => {
            if (!raw.trim()) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch (err) {
                reject(err);
            }
        });
        req.on("error", reject);
    });
}

function normalizeStatusCode(status, statusText) {
    const raw = String(status || "").trim().toUpperCase();
    const txt = String(statusText || "").trim().toUpperCase();
    if (raw === "C" || raw === "CONFIRMED" || raw === "APPROVED" || txt === "CONFIRMED" || txt === "APPROVED") {
        return "C";
    }
    if (raw === "N" || raw === "REJECTED" || raw === "DECLINED" || raw === "NOT HAPPENING" ||
        txt === "NOT HAPPENING" || txt === "REJECTED" || txt === "DECLINED") {
        return "N";
    }
    if (raw === "P" || raw === "PENDING" || txt === "PENDING" || (!raw && !txt)) {
        return "P";
    }
    return raw;
}

function readRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on("data", (chunk) => {
            total += chunk.length;
            if (total > 2 * 1024 * 1024) {
                reject(new Error("Request payload too large"));
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function attachReplayBody(req, bodyBuf) {
    const replay = new PassThrough();
    replay.end(bodyBuf);
    req.pipe = replay.pipe.bind(replay);
    req.unpipe = replay.unpipe.bind(replay);
    req.resume = replay.resume.bind(replay);
    req.pause = replay.pause.bind(replay);
}

function extractMutationTargetsFromPath(reqMethod, reqPath) {
    const method = String(reqMethod || "GET").toUpperCase();
    const targets = [];
    if (method === "DELETE" || method === "PATCH" || method === "MERGE") {
        const match = reqPath.match(/(?:^|\/)(Request\([^)]+\))\/?$/i);
        if (match) {
            targets.push(match[1]);
        }
    } else if (method === "POST") {
        const editMatch = reqPath.match(/(?:^|\/)(Request\([^)]+\))\/[^/]*\.Edit(?:\([^)]*\))?\/?$/i);
        if (editMatch) {
            targets.push(editMatch[1]);
        }
    }
    return targets;
}

function extractMutationTargetsFromBatch(batchText) {
    const targets = new Set();
    const mutationRegex = /^(?:DELETE|PATCH|MERGE)\s+(?:\/[^\s]*\/)?(Request\([^)\s]+\))/gim;
    let match;
    while ((match = mutationRegex.exec(batchText)) !== null) {
        targets.add(match[1]);
    }
    const editRegex = /^POST\s+(?:\/[^\s]*\/)?(Request\([^)\s]+\))\/[^\s]*\.Edit(?:\([^)]*\))?/gim;
    while ((match = editRegex.exec(batchText)) !== null) {
        targets.add(match[1]);
    }
    return Array.from(targets);
}

async function isRequestPendingInSap(config, session, entitySegment) {
    const servicePath = config.servicePath.endsWith("/") ? config.servicePath : `${config.servicePath}/`;
    const client = config.client || "800";
    const checkUrl = `${config.backendUrl}${servicePath}${entitySegment}?sap-client=${encodeURIComponent(client)}&$select=Status,StatusText`;
    const headers = {
        Accept: "application/json",
        Authorization: decryptText(session.encryptedAuth)
    };
    const cookieHeader = serializeCookies(session.sapCookies);
    if (cookieHeader) {
        headers.Cookie = cookieHeader;
    }
    const response = await requestSap(checkUrl, { method: "GET", headers });
    mergeSetCookies(session.sapCookies, response.headers["set-cookie"]);
    if (response.statusCode < 200 || response.statusCode >= 300) {
        return false;
    }
    try {
        const data = JSON.parse(response.body);
        return normalizeStatusCode(data.Status, data.StatusText) === "P";
    } catch {
        return false;
    }
}

function sendJson(res, statusCode, payload, extraHeaders) {
    const body = JSON.stringify(payload);
    const headers = Object.assign(
        {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Length": Buffer.byteLength(body)
        },
        extraHeaders || {}
    );
    res.writeHead(statusCode, headers);
    res.end(body);
}

/**
 * Execute a direct HTTPS/HTTP request to SAP (used for credential verification & ICF logoff).
 */
function requestSap(targetUrl, options) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(targetUrl);
        const transport = parsed.protocol === "https:" ? https : http;
        const req = transport.request(
            {
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: options.method || "GET",
                headers: options.headers || {},
                rejectUnauthorized: false,
                timeout: 15000
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => {
                    data += chunk;
                });
                res.on("end", () => {
                    resolve({
                        statusCode: res.statusCode || 0,
                        headers: res.headers,
                        body: data
                    });
                });
            }
        );
        req.on("timeout", () => {
            req.destroy(new Error("SAP backend verification timed out"));
        });
        req.on("error", reject);
        req.end();
    });
}

async function verifyAuthorityAgainstSap(config, username, password) {
    const basicHeader = "Basic " + Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    const servicePath = config.servicePath.endsWith("/") ? config.servicePath : `${config.servicePath}/`;
    const client = config.client || "800";
    const verifyUrl = `${config.backendUrl}${servicePath}Authority?sap-client=${encodeURIComponent(client)}&$top=1`;

    const response = await requestSap(verifyUrl, {
        method: "GET",
        headers: {
            Accept: "application/json",
            Authorization: basicHeader,
            "x-csrf-token": "fetch"
        }
    });

    const sapCookies = {};
    mergeSetCookies(sapCookies, response.headers["set-cookie"]);
    return {
        statusCode: response.statusCode,
        basicHeader,
        sapCookies
    };
}

async function destroySession(config, sid) {
    if (!sid) {
        return;
    }
    const existing = sessions.get(sid);
    sessions.delete(sid);
    if (!existing) {
        return;
    }
    const cookieHeader = serializeCookies(existing.sapCookies);
    if (!cookieHeader) {
        return;
    }
    try {
        const client = config.client || "800";
        const logoffUrl = `${config.backendUrl}/sap/public/bc/icf/logoff?sap-client=${encodeURIComponent(client)}`;
        await requestSap(logoffUrl, {
            method: "GET",
            headers: {
                Cookie: cookieHeader
            }
        });
    } catch {
        // Best-effort SAP ICF logoff; local session is already removed
    }
}

function getActiveSession(req) {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies[SESSION_COOKIE_NAME];
    if (!sid) {
        return null;
    }
    const session = sessions.get(sid);
    if (!session) {
        return null;
    }
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
        sessions.delete(sid);
        return null;
    }
    return { sid, session };
}

function createSessionRecord(data) {
    const sid = crypto.randomBytes(24).toString("hex");
    sessions.set(sid, {
        userId: data.userId,
        role: data.role,
        roleTitle: data.roleTitle,
        isStudent: data.isStudent,
        encryptedAuth: encryptText(data.basicHeader),
        sapCookies: data.sapCookies || {},
        createdAt: Date.now()
    });
    return sid;
}

/**
 * Intercept outgoing response headers so Chrome never caches Basic Auth or global SAP cookies.
 */
function attachResponseIsolation(res, session) {
    const origSetHeader = res.setHeader.bind(res);
    const origWriteHead = res.writeHead.bind(res);

    res.setHeader = function patchedSetHeader(name, value) {
        const lower = String(name).toLowerCase();
        if (lower === "www-authenticate") {
            return res;
        }
        if (lower === "set-cookie") {
            mergeSetCookies(session.sapCookies, value);
            return res;
        }
        return origSetHeader(name, value);
    };

    res.writeHead = function patchedWriteHead(statusCode, statusMessage, headersObj) {
        let actualHeaders = headersObj;
        let actualMessage = statusMessage;
        if (typeof statusMessage === "object" && statusMessage !== null) {
            actualHeaders = statusMessage;
            actualMessage = undefined;
        }
        if (actualHeaders) {
            const filtered = {};
            for (const [k, v] of Object.entries(actualHeaders)) {
                const lower = k.toLowerCase();
                if (lower === "www-authenticate") {
                    continue;
                }
                if (lower === "set-cookie") {
                    mergeSetCookies(session.sapCookies, v);
                    continue;
                }
                filtered[k] = v;
            }
            return actualMessage !== undefined
                ? origWriteHead(statusCode, actualMessage, filtered)
                : origWriteHead(statusCode, filtered);
        }
        return actualMessage !== undefined
            ? origWriteHead(statusCode, actualMessage)
            : origWriteHead(statusCode);
    };
}

/**
 * UI5 custom middleware providing per-user SAP authentication and session isolation.
 */
module.exports = function sapSessionAuth({ options }) {
    const config = (options && options.configuration) || {};
    const backendConfig = {
        backendUrl: (config.backendUrl || "https://eight20s.mydomain.com:44360").replace(/\/+$/, ""),
        client: String(config.client || "800"),
        servicePath: config.servicePath || "/sap/opu/odata4/sap/zoa_ui_oa_request_o4/srvd/sap/zoa_ui_oa_request/0001/"
    };

    return async function sapSessionAuthMiddleware(req, res, next) {
        const reqPath = (req.url || "/").split("?")[0];

        if (reqPath === "/auth/session" && req.method === "GET") {
            const active = getActiveSession(req);
            if (!active) {
                sendJson(res, 200, { authenticated: false });
                return;
            }
            const { session } = active;
            sendJson(res, 200, {
                authenticated: true,
                userId: session.userId,
                role: session.role,
                roleTitle: session.roleTitle,
                isStudent: session.isStudent
            });
            return;
        }

        if (reqPath === "/auth/logout" && req.method === "POST") {
            const cookies = parseCookies(req.headers.cookie);
            await destroySession(backendConfig, cookies[SESSION_COOKIE_NAME]);
            sendJson(
                res,
                200,
                { ok: true },
                { "Set-Cookie": buildClearCookiesHeaders(req) }
            );
            return;
        }

        if (reqPath === "/auth/login" && req.method === "POST") {
            let body;
            try {
                body = await readJsonBody(req);
            } catch {
                sendJson(res, 400, { ok: false, error: "Invalid login request body." });
                return;
            }

            const rawUser = String(body.username || "").trim();
            const rawPass = String(body.password || "").trim();
            if (!rawUser || !rawPass) {
                sendJson(res, 400, { ok: false, error: "Please enter both Username and Password." });
                return;
            }

            const prevCookies = parseCookies(req.headers.cookie);
            const upperUser = rawUser.toUpperCase();
            const authorityMeta = AUTHORITY_ROLES[upperUser];

            if (authorityMeta) {
                try {
                    const sapResult = await verifyAuthorityAgainstSap(backendConfig, upperUser, rawPass);
                    if (sapResult.statusCode === 401 || sapResult.statusCode === 403) {
                        sendJson(res, 401, {
                            ok: false,
                            error: `Invalid SAP Username or Password for ${upperUser}.`
                        });
                        return;
                    }
                    if (sapResult.statusCode < 200 || sapResult.statusCode >= 300) {
                        sendJson(res, 502, {
                            ok: false,
                            error: `SAP authentication failed (HTTP ${sapResult.statusCode}).`
                        });
                        return;
                    }

                    await destroySession(backendConfig, prevCookies[SESSION_COOKIE_NAME]);
                    const newSid = createSessionRecord({
                        userId: upperUser,
                        role: authorityMeta.role,
                        roleTitle: `${authorityMeta.label} (${upperUser})`,
                        isStudent: false,
                        basicHeader: sapResult.basicHeader,
                        sapCookies: sapResult.sapCookies
                    });

                    const clearOld = buildClearCookiesHeaders(req).filter((c) => !c.startsWith(`${SESSION_COOKIE_NAME}=`));
                    const setCookies = [
                        `${SESSION_COOKIE_NAME}=${newSid}; Path=/; HttpOnly; SameSite=Lax`,
                        ...clearOld
                    ];
                    const sessionPayload = {
                        userId: upperUser,
                        role: authorityMeta.role,
                        roleTitle: `${authorityMeta.label} (${upperUser})`,
                        isStudent: false
                    };
                    sendJson(
                        res,
                        200,
                        { ok: true, redirectUrl: "index.html", session: sessionPayload },
                        { "Set-Cookie": setCookies }
                    );
                    return;
                } catch (err) {
                    sendJson(res, 502, {
                        ok: false,
                        error: `Unable to reach SAP backend (${err.message}).`
                    });
                    return;
                }
            }

            // Student login: any S23AH<number> ID other than the 3 Authority IDs gets Student role
            if (!STUDENT_ID_PATTERN.test(upperUser)) {
                sendJson(res, 400, {
                    ok: false,
                    error: "Invalid Student ID format. Use S23AH followed by numbers (e.g. S23AH11)."
                });
                return;
            }

            if (rawPass !== STUDENT_SHARED_PASSWORD) {
                sendJson(res, 401, { ok: false, error: "Invalid password. Please try again." });
                return;
            }

            const svc = getStudentServiceCredentials(backendConfig);
            if (!svc.user || !svc.password) {
                const missing = [];
                if (!svc.user) { missing.push("FIORI_TOOLS_USER"); }
                if (!svc.password) { missing.push("FIORI_TOOLS_PASSWORD"); }
                sendJson(res, 500, {
                    ok: false,
                    error: `Student service account is not configured in ${path.join(svc.projectRoot, ".env")} (missing/unsaved: ${missing.join(", ")}). Save .env and try again.`
                });
                return;
            }

            await destroySession(backendConfig, prevCookies[SESSION_COOKIE_NAME]);
            const svcBasic = "Basic " + Buffer.from(`${svc.user}:${svc.password}`, "utf8").toString("base64");
            const studentSid = createSessionRecord({
                userId: upperUser,
                role: "STUDENT",
                roleTitle: `Student (${upperUser})`,
                isStudent: true,
                basicHeader: svcBasic,
                sapCookies: {}
            });

            const clearOld = buildClearCookiesHeaders(req).filter((c) => !c.startsWith(`${SESSION_COOKIE_NAME}=`));
            const setCookies = [
                `${SESSION_COOKIE_NAME}=${studentSid}; Path=/; HttpOnly; SameSite=Lax`,
                ...clearOld
            ];
            const studentPayload = {
                userId: upperUser,
                role: "STUDENT",
                roleTitle: `Student (${upperUser})`,
                isStudent: true
            };
            sendJson(
                res,
                200,
                { ok: true, redirectUrl: "student.html", session: studentPayload },
                { "Set-Cookie": setCookies }
            );
            return;
        }

        // Enforce strict session credentials on all SAP backend proxy requests
        if (reqPath === "/sap" || reqPath.startsWith("/sap/")) {
            const active = getActiveSession(req);
            if (!active) {
                sendJson(res, 401, {
                    error: "SAP session expired or not logged in. Please sign in at /login.html."
                });
                return;
            }

            const { session } = active;
            if (session.isStudent) {
                const isAuthorityAction = /(?:confirmRequest|rejectRequest|\/Edit(?:\(|$))/i.test(reqPath);
                const isRequestMutation = (req.method === "PATCH" || req.method === "MERGE") && /\/Request(?:\(|$)/i.test(reqPath);
                if (isAuthorityAction || isRequestMutation) {
                    sendJson(res, 403, {
                        error: "Forbidden: Students cannot approve, reject, or edit requests."
                    });
                    return;
                }
                req.headers["x-zoa-session-role"] = "STUDENT";
                req.headers["x-zoa-student-id"] = session.userId;
            }

            // Always overwrite Authorization with the active user's encrypted Basic Auth
            req.headers.authorization = decryptText(session.encryptedAuth);

            // Rule 2: Block update/edit/delete on any PENDING request (direct or inside $batch)
            const directTargets = extractMutationTargetsFromPath(req.method, reqPath);
            if (directTargets.length > 0) {
                try {
                    for (const target of directTargets) {
                        if (await isRequestPendingInSap(backendConfig, session, target)) {
                            sendJson(res, 403, {
                                error: "Pending requests cannot be edited or deleted."
                            });
                            return;
                        }
                    }
                } catch {
                    // Fail closed if status cannot be verified before mutating
                    sendJson(res, 502, {
                        error: "Unable to verify request status before update/delete."
                    });
                    return;
                }
            } else if (req.method === "POST" && reqPath.endsWith("/$batch")) {
                let batchBuf;
                try {
                    batchBuf = await readRawBody(req);
                } catch {
                    sendJson(res, 400, { error: "Invalid $batch request body." });
                    return;
                }
                const batchTargets = extractMutationTargetsFromBatch(batchBuf.toString("utf8"));
                if (batchTargets.length > 0) {
                    try {
                        for (const target of batchTargets) {
                            if (await isRequestPendingInSap(backendConfig, session, target)) {
                                sendJson(res, 403, {
                                    error: "Pending requests cannot be edited or deleted."
                                });
                                return;
                            }
                        }
                    } catch {
                        sendJson(res, 502, {
                            error: "Unable to verify request status before batch update/delete."
                        });
                        return;
                    }
                }
                attachReplayBody(req, batchBuf);
            }

            // Never forward browser SAP cookies from previous logins; use only this session's cookies
            const isolatedCookies = serializeCookies(session.sapCookies);
            if (isolatedCookies) {
                req.headers.cookie = isolatedCookies;
            } else {
                delete req.headers.cookie;
            }

            attachResponseIsolation(res, session);
        }

        next();
    };
};

