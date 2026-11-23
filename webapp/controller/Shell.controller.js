sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast"
], function (Controller, JSONModel, MessageToast) {
    "use strict";

    var GROQ_API_KEY = (window.ONE_ANSWER_CONFIG && window.ONE_ANSWER_CONFIG.GROQ_API_KEY) || "";
    var GROQ_MODEL = (window.ONE_ANSWER_CONFIG && window.ONE_ANSWER_CONFIG.GROQ_MODEL) || "qwen/qwen3.8-27b";
    var SERVICE_BASE_URL = "/sap/opu/odata4/sap/zoa_ui_oa_request_o4/srvd/sap/zoa_ui_oa_request/0001/";

    return Controller.extend("zoa.zoarequestui.controller.Shell", {

        onInit: function () {
            var aInitialMessages = [
                {
                    sender: "One Answer AI",
                    text: "Hello! I am the One Answer Student Assistant. I am directly connected to the live SAP OData database (/Request, /Alert, /EventsHolidays, /Authority). You can ask me anything about events, holidays, request status, or authority decisions.",
                    time: this._now(),
                    initials: "OA"
                }
            ];

            this.getView().setModel(new JSONModel({ messages: aInitialMessages, busy: false }), "chat");
            this.getView().setModel(new JSONModel({ alertCount: "" }), "shellModel");

            // Setup polling for alerts every 30 seconds (per ABAP backend specification)
            this._startAlertsPolling();
        },

        onExit: function () {
            if (this._iAlertTimer) {
                clearInterval(this._iAlertTimer);
                this._iAlertTimer = null;
            }
        },

        // ── Auto Poll Alerts from Backend Database ────────────────
        _startAlertsPolling: function () {
            this._refreshAlertsCount();
            this._iAlertTimer = setInterval(this._refreshAlertsCount.bind(this), 30000);
        },

        _refreshAlertsCount: function () {
            var that = this;
            fetch(SERVICE_BASE_URL + "Alert")
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    var aAlerts = data.value || [];
                    var sCount = aAlerts.length > 0 ? String(aAlerts.length) : "";
                    that.getView().getModel("shellModel").setProperty("/alertCount", sCount);
                    var oTab = that.byId("tabAlerts");
                    if (oTab) { oTab.setCount(sCount); }
                })
                .catch(function () {});
        },

        // ── Events ───────────────────────────────────────────────
        onEventPress: function (oEvent) {
            var oItem = oEvent.getSource();
            MessageToast.show(oItem.getTitle());
        },

        onEventTilePress: function () {},

        // ── Alerts / Notifications ───────────────────────────────
        onAlertsLoaded: function (oEvent) {
            var iCount = oEvent.getParameter("total");
            var sCount = iCount > 0 ? String(iCount) : "";
            this.getView().getModel("shellModel").setProperty("/alertCount", sCount);
            var oTab = this.byId("tabAlerts");
            if (oTab) { oTab.setCount(sCount); }
        },

        onAlertClose: function (oEvent) {
            var oItem = oEvent.getSource();
            oItem.getParent().removeItem(oItem);
            var iCount = parseInt(this.getView().getModel("shellModel").getProperty("/alertCount") || "0", 10);
            var sNew = iCount > 1 ? String(iCount - 1) : "";
            this.getView().getModel("shellModel").setProperty("/alertCount", sNew);
            var oTab = this.byId("tabAlerts");
            if (oTab) { oTab.setCount(sNew); }
        },

        onNotificationsPress: function () {
            this.byId("mainTabBar").setSelectedKey("alerts");
        },

        // ── Ask AI (Pure Live Data from Backend Database) ─────────
        onChipPress: function (oEvent) {
            this.byId("askInput").setValue(oEvent.getSource().getText());
            this.onAskSend();
        },

        onClearChat: function () {
            this.getView().getModel("chat").setProperty("/messages", []);
        },

        onAskSend: function () {
            var oInput = this.byId("askInput");
            var sQuestion = oInput.getValue().trim();
            if (!sQuestion) { return; }

            var oChatModel = this.getView().getModel("chat");
            var aMessages = oChatModel.getProperty("/messages") || [];
            aMessages.push({ sender: "You", text: sQuestion, time: this._now(), initials: "ME" });
            oChatModel.setProperty("/messages", aMessages);
            oChatModel.setProperty("/busy", true);
            oInput.setValue("");

            // Step 1: Fetch REAL database data live from all OData service endpoints
            this._fetchRealDatabaseData().then(function (oDatabaseData) {
                // Step 2: Pass real database data into Groq AI
                return this._callGroqAIWithDatabase(sQuestion, oDatabaseData);
            }.bind(this)).then(function (sAnswer) {
                this._appendAnswer(sAnswer);
            }.bind(this)).catch(function (err) {
                this._appendAnswer("Error fetching from database: " + err.message);
            }.bind(this));
        },

        _appendAnswer: function (sText) {
            var oChatModel = this.getView().getModel("chat");
            var aMessages = oChatModel.getProperty("/messages") || [];
            aMessages.push({ sender: "One Answer AI", text: sText, time: this._now(), initials: "OA" });
            oChatModel.setProperty("/messages", aMessages);
            oChatModel.setProperty("/busy", false);
        },

        /**
         * Fetch live real entities directly from the backend OData service endpoints.
         * NO dummy data!
         */
        _fetchRealDatabaseData: function () {
            var pRequests = fetch(SERVICE_BASE_URL + "Request").then(function (r) { return r.json(); }).catch(function () { return { value: [] }; });
            var pAlerts = fetch(SERVICE_BASE_URL + "Alert").then(function (r) { return r.json(); }).catch(function () { return { value: [] }; });
            var pEvents = fetch(SERVICE_BASE_URL + "EventsHolidays").then(function (r) { return r.json(); }).catch(function () { return { value: [] }; });
            var pAuthorities = fetch(SERVICE_BASE_URL + "Authority").then(function (r) { return r.json(); }).catch(function () { return { value: [] }; });

            return Promise.all([pRequests, pAlerts, pEvents, pAuthorities]).then(function (aResults) {
                var aRequests = (aResults[0] && aResults[0].value) ? aResults[0].value : [];
                var aAlerts = (aResults[1] && aResults[1].value) ? aResults[1].value : [];
                var aEvents = (aResults[2] && aResults[2].value) ? aResults[2].value : [];
                var aAuthorities = (aResults[3] && aResults[3].value) ? aResults[3].value : [];

                // Filter out technical OData draft control fields to pass clean database payload to AI
                var cleanRequests = aRequests.map(function (req) {
                    return {
                        topic: req.Topic,
                        topic_text: req.TopicText,
                        title: req.Title,
                        event_date: req.EventDate,
                        description: req.Description,
                        status: req.Status,
                        status_text: req.StatusText,
                        authority_role: req.AuthorityRole,
                        decide_by: req.DecideBy,
                        decision_reason: req.DecisionReason,
                        urgent: req.Urgent,
                        priority: req.PriorityText,
                        created_by: req.CreatedBy
                    };
                });

                var cleanAlerts = aAlerts.map(function (al) {
                    return {
                        alert_date: al.AlertDate,
                        alert_text: al.AlertText
                    };
                });

                var cleanEvents = aEvents.map(function (ev) {
                    return {
                        title: ev.Title,
                        topic: ev.Topic,
                        event_date: ev.EventDate,
                        reason: ev.Reason
                    };
                });

                var cleanAuthorities = aAuthorities.map(function (au) {
                    return {
                        topic: au.Topic,
                        topic_text: au.TopicText,
                        authority_role: au.AuthorityRole
                    };
                });

                return {
                    database_service: SERVICE_BASE_URL,
                    live_requests: cleanRequests,
                    live_alerts: cleanAlerts,
                    live_events: cleanEvents,
                    live_authorities: cleanAuthorities
                };
            });
        },

        _callGroqAIWithDatabase: function (sQuestion, oDatabaseData) {
            var sSystemPrompt =
                "You are the official 'One Answer' Student AI Assistant for the ZOA College Portal.\n" +
                "You are directly provided with REAL LIVE DATA fetched from the SAP ABAP RAP database tables (ZOA_OA_REQUEST, ZOA_OA_ALERT, ZOA_OA_AUTH).\n" +
                "Answer student questions accurately and strictly according to this live database state and the ABAP backend rules:\n\n" +
                "=== BACKEND BUSINESS RULES ===\n" +
                "1. Status 'C' (Confirmed): The request is approved and officially happening. Provide Title, Event Date, and Decision Reason.\n" +
                "2. Status 'N' (Not happening): The request was rejected/cancelled by authority. Provide Title, Event Date, and Decision Reason.\n" +
                "3. Status 'P' (Pending): The request is awaiting decision. State clearly: 'This request is currently pending with the [AuthorityRole] and is not yet official.' Mention the DecideBy deadline date.\n" +
                "4. 7-Day Rule (DecideBy): DecideBy is Event Date minus 7 days. If the event is within 7 days, it is marked as 'Urgent' (Priority = Urgent).\n" +
                "5. Authorities: HOLIDAY is decided by DIRECTOR; EVENT is decided by HOD; TRIP is decided by TEACHER.\n" +
                "6. Attendance Rule: Minimum 75% attendance is compulsory for semester exams.\n" +
                "7. If a date has already passed: 'This date has already passed and no decision was recorded.'\n" +
                "8. If an event/request is not in the live database: State that no record was found in the database and advise checking with the department.\n\n" +
                "=== LIVE DATABASE STATE (REAL DATA) ===\n" +
                JSON.stringify(oDatabaseData, null, 2) + "\n\n" +
                "IMPORTANT: Always respond in clear, professional English. Be direct, helpful, and concise.";

            return fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": "Bearer " + GROQ_API_KEY,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: GROQ_MODEL,
                    temperature: 0.2,
                    messages: [
                        { role: "system", content: sSystemPrompt },
                        { role: "user", content: sQuestion }
                    ]
                })
            })
            .then(function (res) {
                return res.json();
            })
            .then(function (data) {
                if (data.choices && data.choices[0] && data.choices[0].message) {
                    return data.choices[0].message.content;
                } else if (data.error) {
                    throw new Error(data.error.message);
                } else {
                    return "Maaf kijiye, AI se jawab nahi mil paya.";
                }
            });
        },

        _now: function () {
            return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        }
    });
});
