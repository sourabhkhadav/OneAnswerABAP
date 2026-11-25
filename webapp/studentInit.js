sap.ui.define([
    "sap/ui/core/mvc/XMLView",
    "sap/ui/model/resource/ResourceModel",
    "sap/ui/model/odata/v4/ODataModel",
    "sap/ui/model/json/JSONModel",
    "sap/ui/Device"
], function (XMLView, ResourceModel, ODataModel, JSONModel, Device) {
    "use strict";

    // Load app CSS
    sap.ui.require(["sap/ui/dom/includeStylesheet"], function (includeStylesheet) {
        includeStylesheet(sap.ui.require.toUrl("zoa/zoarequestui/css/style.css"));
    });

    function performServerLogout() {
        sessionStorage.removeItem("zoa_auth_session");
        fetch("/auth/logout", { method: "POST", credentials: "same-origin" })
            .catch(function () {})
            .finally(function () {
                window.location.href = "login.html";
            });
    }

    function escapeHtml(str) {
        return String(str || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    window.zoaConfirmLogout = function () {
        var existingModal = document.getElementById("zoa-logout-modal");
        if (existingModal) {
            existingModal.remove();
        }
        var role = "STUDENT";
        var uid = "";
        try {
            var raw = sessionStorage.getItem("zoa_auth_session");
            if (raw) {
                var sess = JSON.parse(raw);
                role = (sess.role || "STUDENT").toUpperCase();
                uid = (sess.userId || "").toUpperCase();
            }
        } catch (e) {}

        var roleLabel = role.charAt(0) + role.slice(1).toLowerCase();
        var userDisplay = role + (uid ? " (" + uid + ")" : "");

        var backdrop = document.createElement("div");
        backdrop.id = "zoa-logout-modal";
        backdrop.className = "zoaLogoutBackdrop";
        backdrop.innerHTML =
            '<div class="zoaLogoutCard" role="dialog" aria-modal="true">' +
                '<div class="zoaLogoutIconWrap">&#8618;</div>' +
                '<h3 class="zoaLogoutTitle">Sign out of ' + escapeHtml(roleLabel) + ' Portal?</h3>' +
                '<p class="zoaLogoutDesc">You are currently signed in as <strong>' + escapeHtml(userDisplay) + '</strong>.</p>' +
                '<div class="zoaLogoutActions">' +
                    '<button type="button" id="zoa-stay-btn" class="zoaStayBtn">Stay Signed In</button>' +
                    '<button type="button" id="zoa-yes-logout-btn" class="zoaConfirmLogoutBtn">Yes, Logout</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(backdrop);

        backdrop.addEventListener("click", function (ev) {
            if (ev.target === backdrop) {
                backdrop.remove();
            }
        });
        document.getElementById("zoa-stay-btn").addEventListener("click", function () {
            backdrop.remove();
        });
        document.getElementById("zoa-yes-logout-btn").addEventListener("click", function () {
            performServerLogout();
        });
    };

    // Ensure corner indicator (Role + ID + Logout) floats at top-right
    function ensureStudentBar() {
        var authBar = document.getElementById("zoa-authority-bar");
        if (authBar) {
            var rawAuth = sessionStorage.getItem("zoa_auth_session");
            if (rawAuth) {
                try {
                    var authSess = JSON.parse(rawAuth);
                    var authEl = document.getElementById("zoa-user-name");
                    if (authEl) {
                        var authRole = (authSess.role || "AUTHORITY").toUpperCase();
                        var authUid = (authSess.userId || "").toUpperCase();
                        authEl.innerText = authRole + (authUid ? " (" + authUid + ")" : "");
                    }
                } catch (e) {}
            }
            return;
        }
        var existing = document.getElementById("zoa-student-bar");
        if (!existing) {
            var bar = document.createElement("div");
            bar.id = "zoa-student-bar";
            bar.style.cssText = "position:fixed; top:10px; right:18px; z-index:99999; display:inline-flex; align-items:center; gap:8px; background:#FFFFFF; padding:4px 12px; border-radius:20px; box-shadow:0 2px 8px rgba(0,0,0,0.12); border:1px solid #CBD5E1; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size:12px; color:#1E293B; height:auto; max-height:36px;";
            bar.innerHTML = '<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#10B981;"></span>' +
                '<span id="zoa-student-name" style="font-weight:600; color:#0F172A;">STUDENT</span>' +
                '<span style="color:#CBD5E1;">|</span>' +
                '<a href="javascript:void(0)" id="zoa-student-logout" style="color:#DC2626; text-decoration:none; font-weight:500;">🚪 Logout</a>';
            document.body.appendChild(bar);
            var logoutLink = document.getElementById("zoa-student-logout");
            if (logoutLink) {
                logoutLink.addEventListener("click", function () {
                    window.zoaConfirmLogout();
                });
            }
        }
        var raw = sessionStorage.getItem("zoa_auth_session");
        if (raw) {
            try {
                var sess = JSON.parse(raw);
                var el = document.getElementById("zoa-student-name");
                if (el) {
                    var role = (sess.role || "STUDENT").toUpperCase();
                    var uid = (sess.userId || "").toUpperCase();
                    el.innerText = role + (uid ? " (" + uid + ")" : "");
                }
            } catch (e) {}
        }
    }

    function bootStudentView() {
        var oI18nModel = new ResourceModel({
            bundleName: "zoa.zoarequestui.i18n.i18n",
            supportedLocales: [""],
            fallbackLocale: ""
        });

        var oODataModel = new ODataModel({
            serviceUrl: "/sap/opu/odata4/sap/zoa_ui_oa_request_o4/srvd/sap/zoa_ui_oa_request/0001/",
            synchronizationMode: "None",
            operationMode: "Server",
            autoExpandSelect: true,
            earlyRequests: true,
            groupId: "$auto"
        });

        var oDeviceModel = new JSONModel(Device);
        oDeviceModel.setDefaultBindingMode("OneWay");

        XMLView.create({
            viewName: "zoa.zoarequestui.view.Shell"
        }).then(function (oView) {
            oView.setModel(oODataModel);
            oView.setModel(oI18nModel, "i18n");
            oView.setModel(oDeviceModel, "device");
            var sTargetId = document.getElementById("app-container")
                ? "app-container"
                : (document.getElementById("student-container") ? "student-container" : "content");
            oView.placeAt(sTargetId);
            // Force full height after rendering & attach top-right corner badge
            oView.addEventDelegate({
                onAfterRendering: function () {
                    var oDom = oView.getDomRef();
                    if (oDom) { oDom.style.height = "100%"; }
                    ensureStudentBar();
                }
            });
            ensureStudentBar();
        });
    }

    fetch("/auth/session", { credentials: "same-origin", cache: "no-store" })
        .then(function (res) {
            if (res.status === 404) {
                bootStudentView();
                return null;
            }
            return res.json();
        })
        .then(function (sess) {
            if (!sess) { return; }
            if (!sess.authenticated) {
                sessionStorage.removeItem("zoa_auth_session");
                window.location.replace("login.html");
                return;
            }
            sessionStorage.setItem("zoa_auth_session", JSON.stringify(sess));
            ensureStudentBar();
            bootStudentView();
        })
        .catch(function () {
            window.location.replace("login.html");
        });
});
