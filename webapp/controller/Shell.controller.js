/* eslint-disable */
sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/Dialog",
    "sap/m/Button",
    "sap/m/VBox",
    "sap/m/Label",
    "sap/m/Input",
    "sap/m/TextArea",
    "sap/m/Select",
    "sap/ui/core/Item",
    "sap/m/DatePicker"
], function (
    Controller,
    JSONModel,
    MessageToast,
    MessageBox,
    Filter,
    FilterOperator,
    Dialog,
    Button,
    VBox,
    Label,
    Input,
    TextArea,
    Select,
    Item,
    DatePicker
) {
    "use strict";

    // ─────────────────────────────────────────────────────────────
    // BACKEND ENTITY SETS & FIELD MAPPING
    // IMPORTANT: Verify and adjust these with $metadata at:
    // /sap/opu/odata4/sap/zoa_ui_oa_request_o4/srvd/sap/zoa_ui_oa_request/0001/$metadata
    // ─────────────────────────────────────────────────────────────
    var ENTITY_SETS = {
        request: "Request",          // Main RAP entity: Create, Update, Delete, Actions
        event: "EventsHolidays",
        alert: "Alert",              // Student Alerts/Notifications
        authority: "Authority"       // Approval authority mapping
    };

    var FIELD_MAP = {
        request: {
            uuid: "RequestUuid",
            topic: "Topic",
            title: "Title",
            eventDate: "EventDate",
            description: "Description",
            status: "Status",
            statusText: "StatusText",
            statusCriticality: "StatusCriticality",
            authorityRole: "AuthorityRole",
            decideBy: "DecideBy",
            decisionReason: "DecisionReason",
            urgent: "Urgent",
            createdBy: "CreatedBy"
        },
        event: {
            id: "EventId",
            title: "Title",
            topic: "Topic",
            eventDate: "EventDate",
            reason: "Reason"
        },
        alert: {
            id: "AlertId",
            date: "AlertDate",
            text: "AlertText"
        },
        authority: {
            topic: "Topic",
            text: "TopicText",
            role: "AuthorityRole",
            days: "DecideDays"
        }
    };

    var GROQ_API_KEY = (window.ONE_ANSWER_CONFIG && window.ONE_ANSWER_CONFIG.GROQ_API_KEY) || "";
    var GROQ_MODEL = (window.ONE_ANSWER_CONFIG && window.ONE_ANSWER_CONFIG.GROQ_MODEL) || "qwen/qwen3.8-27b";
    var SERVICE_BASE_URL = "/sap/opu/odata4/sap/zoa_ui_oa_request_o4/srvd/sap/zoa_ui_oa_request/0001/";

    var TOPIC_TO_ROLE = {
        HOLIDAY: "DIRECTOR",
        EVENT: "HOD",
        TRIP: "TEACHER"
    };

    var ROLE_TO_TOPIC = {
        DIRECTOR: "HOLIDAY",
        HOD: "EVENT",
        TEACHER: "TRIP"
    };

    function normalizeStatusCode(sStatus, sStatusText) {
        var sRaw = String(sStatus || "").trim().toUpperCase();
        var sTxt = String(sStatusText || "").trim().toUpperCase();
        if (sRaw === "C" || sRaw === "CONFIRMED" || sRaw === "APPROVED" || sTxt === "CONFIRMED" || sTxt === "APPROVED") {
            return "C";
        }
        if (sRaw === "N" || sRaw === "REJECTED" || sRaw === "DECLINED" || sRaw === "NOT HAPPENING" ||
            sTxt === "NOT HAPPENING" || sTxt === "REJECTED" || sTxt === "DECLINED") {
            return "N";
        }
        if (sRaw === "P" || sRaw === "PENDING" || sTxt === "PENDING" || (!sRaw && !sTxt)) {
            return "P";
        }
        return sRaw;
    }

    function resolveAuthorityRole(sTopic, sAuthorityRole) {
        var sRole = String(sAuthorityRole || "").trim().toUpperCase();
        if (sRole) {
            return sRole;
        }
        var sUpperTopic = String(sTopic || "").trim().toUpperCase();
        return TOPIC_TO_ROLE[sUpperTopic] || "";
    }

    function extractTaggedStudentId(sDescription) {
        var m = String(sDescription || "").match(/\[Student:\s*([^\]]+)\]/i);
        return m ? String(m[1]).trim().toUpperCase() : "";
    }

    function isRequestCreator(oReq, sViewerUserId) {
        var sViewer = String(sViewerUserId || "").trim().toUpperCase();
        if (!sViewer) {
            return false;
        }
        var sTagged = extractTaggedStudentId(oReq && oReq.Description);
        if (sTagged) {
            return sTagged === sViewer;
        }
        var sCreatedBy = String((oReq && oReq.CreatedBy) || "").trim().toUpperCase();
        return !!sCreatedBy && sCreatedBy === sViewer;
    }

    function canViewRequest(oReq, bIsStudent, sViewerRole, sViewerUserId) {
        var st = normalizeStatusCode(oReq && oReq.Status, oReq && oReq.StatusText);
        if (st !== "P") {
            return true;
        }
        if (isRequestCreator(oReq, sViewerUserId)) {
            return true;
        }
        if (!bIsStudent) {
            var sTargetRole = resolveAuthorityRole(oReq && oReq.Topic, oReq && oReq.AuthorityRole);
            if (sTargetRole && sTargetRole === String(sViewerRole || "").trim().toUpperCase()) {
                return true;
            }
        }
        return false;
    }

    function isApprovedForAuthorityRole(oReq, bIsStudent, sViewerRole) {
        if (bIsStudent) {
            return true;
        }
        var sRole = String(sViewerRole || "").trim().toUpperCase();
        if (!sRole) {
            return false;
        }
        var sTargetRole = resolveAuthorityRole(oReq && oReq.Topic, oReq && oReq.AuthorityRole);
        return !!sTargetRole && sTargetRole === sRole;
    }

    return Controller.extend("zoa.zoarequestui.controller.Shell", {

        onInit: function () {
            var sUserId = "Student";
            var sRoleTitle = "Student Portal";
            var sRole = "STUDENT";
            var bIsStudent = true;
            try {
                var rawSess = sessionStorage.getItem("zoa_auth_session");
                if (rawSess) {
                    var oSess = JSON.parse(rawSess);
                    if (oSess.userId) { sUserId = oSess.userId; }
                    if (oSess.roleTitle) { sRoleTitle = oSess.roleTitle; }
                    if (oSess.role) { sRole = String(oSess.role).toUpperCase(); }
                    bIsStudent = oSess.isStudent !== undefined ? !!oSess.isStudent : (sRole === "STUDENT");
                }
            } catch (e) { }

            var aInitialMessages = [
                {
                    sender: "One Answer AI",
                    text: "Hello! Ask me about confirmed events, holidays, request status, or approvals.",
                    time: this._now(),
                    initials: "OA"
                }
            ];

            var sInitialStatusFilter = bIsStudent ? "ALL" : "P";
            var sInitialTypeFilter = (!bIsStudent && ROLE_TO_TOPIC[sRole]) ? ROLE_TO_TOPIC[sRole] : "ALL";

            this.getView().setModel(new JSONModel({ messages: aInitialMessages, busy: false }), "chat");
            this.getView().setModel(new JSONModel({
                alertCount: "",
                userSubtitle: sRoleTitle.indexOf(sUserId) !== -1 ? sRoleTitle : (sRoleTitle + " (" + sUserId + ")"),
                userId: sUserId,
                role: sRole,
                isStudent: bIsStudent,
                statusFilter: sInitialStatusFilter,
                typeFilter: sInitialTypeFilter,
                searchQuery: "",
                counts: { all: 0, pending: 0, approved: 0, declined: 0 }
            }), "shellModel");

            if (!bIsStudent) {
                var oTabBar = this.byId("mainTabBar");
                if (oTabBar) {
                    oTabBar.setSelectedKey("requests");
                }
            }

            this._bInitialFilterApplied = false;
            this._syncFilterButtonStyles();
            this._refreshRequestCounts();

            // Setup polling for alerts & live request counts every 30 seconds
            this._startAlertsPolling();
        },

        onAfterRendering: function () {
            if (!this._bInitialFilterApplied) {
                var oRequestsList = this.byId("requestsList");
                if (oRequestsList && oRequestsList.getBinding("items")) {
                    this._bInitialFilterApplied = true;
                    this._applyRequestFilters();
                }
            }
        },

        onLogoutPress: function () {
            if (typeof window.zoaConfirmLogout === "function") {
                window.zoaConfirmLogout();
                return;
            }
            sessionStorage.removeItem("zoa_auth_session");
            fetch("/auth/logout", { method: "POST", credentials: "same-origin" })
                .catch(function () {})
                .finally(function () {
                    window.location.href = "login.html";
                });
        },

        onSwitchToAuthority: function () {
            var bIsStudent = true;
            try {
                var rawSess = sessionStorage.getItem("zoa_auth_session");
                if (rawSess) {
                    var oSess = JSON.parse(rawSess);
                    bIsStudent = !!oSess.isStudent || (String(oSess.role || "").toUpperCase() === "STUDENT");
                }
            } catch (e) {}

            if (bIsStudent) {
                window.location.href = "login.html";
            } else {
                window.location.href = "index.html";
            }
        },

        onExit: function () {
            if (this._iAlertTimer) {
                clearInterval(this._iAlertTimer);
                this._iAlertTimer = null;
            }
            if (this._oCreateDialog) {
                this._oCreateDialog.destroy();
                this._oCreateDialog = null;
            }
            if (this._oDecisionDialog) {
                this._oDecisionDialog.destroy();
                this._oDecisionDialog = null;
            }
        },

        // ─────────────────────────────────────────────────────────────
        // LIVE ODATA V4 DATA RETRIEVAL (NO MOCK / NO DUMMY DATA)
        // ─────────────────────────────────────────────────────────────

        /**
         * Generic helper to fetch objects from any OData V4 entity set using ODataModel
         * @param {string} sEntityPath - e.g. "/Request", "/Alert", "/EventsHolidays"
         * @param {sap.ui.model.Filter[]} [aFilters] - optional filters
         * @returns {Promise<Array<object>>}
         */
        _fetchODataEntity: function (sEntityPath, aFilters) {
            var oModel = this.getView().getModel();
            if (!oModel || typeof oModel.bindList !== "function") {
                return Promise.reject(new Error("ODataModel V4 is not available on view."));
            }

            var oListBinding = oModel.bindList(sEntityPath, null, null, aFilters, {
                $$groupId: "$auto"
            });

            return oListBinding.requestContexts(0, 200).then(function (aContexts) {
                return aContexts.map(function (oContext) {
                    return oContext.getObject();
                });
            }).catch(function (oError) {
                console.error("[OneAnswer] OData request failed for " + sEntityPath + ":", oError);
                throw oError;
            });
        },

        /**
         * Fetch complete live context across all entities for Groq AI.
         * Exclusively pulls from live OData V4 model. No mock data.
         */
        _getLiveContext: function () {
            var that = this;
            return Promise.all([
                that._fetchODataEntity("/" + ENTITY_SETS.request).catch(function (err) {
                    return { _error: that._formatError(err) };
                }),
                that._fetchODataEntity("/" + ENTITY_SETS.alert).catch(function (err) {
                    return { _error: that._formatError(err) };
                }),
                that._fetchODataEntity("/" + ENTITY_SETS.event).catch(function (err) {
                    return { _error: that._formatError(err) };
                }),
                that._fetchODataEntity("/" + ENTITY_SETS.authority).catch(function (err) {
                    return { _error: that._formatError(err) };
                })
            ]).then(function (aResults) {
                var aRequests = Array.isArray(aResults[0]) ? aResults[0] : [];
                var aAlerts = Array.isArray(aResults[1]) ? aResults[1] : [];
                var aEvents = Array.isArray(aResults[2]) ? aResults[2] : [];
                var aAuthorities = Array.isArray(aResults[3]) ? aResults[3] : [];

                var oErrors = {};
                if (aResults[0]._error) { oErrors.requests = aResults[0]._error; }
                if (aResults[1]._error) { oErrors.alerts = aResults[1]._error; }
                if (aResults[2]._error) { oErrors.events = aResults[2]._error; }
                if (aResults[3]._error) { oErrors.authorities = aResults[3]._error; }

                var oViewerModel = that.getView().getModel("shellModel");
                var bViewerIsStudent = oViewerModel ? !!oViewerModel.getProperty("/isStudent") : true;
                var sViewerRole = oViewerModel ? oViewerModel.getProperty("/role") : "STUDENT";
                var sViewerUserId = oViewerModel ? oViewerModel.getProperty("/userId") : "";

                // Clean draft control internal fields before passing to AI (respecting PENDING visibility)
                var cleanRequests = aRequests.filter(function (req) {
                    return canViewRequest(req, bViewerIsStudent, sViewerRole, sViewerUserId);
                }).map(function (req) {
                    return {
                        topic: req[FIELD_MAP.request.topic] || req.Topic,
                        title: req[FIELD_MAP.request.title] || req.Title,
                        event_date: req[FIELD_MAP.request.eventDate] || req.EventDate,
                        description: req[FIELD_MAP.request.description] || req.Description,
                        status: req[FIELD_MAP.request.status] || req.Status,
                        status_text: req[FIELD_MAP.request.statusText] || req.StatusText,
                        authority_role: req[FIELD_MAP.request.authorityRole] || req.AuthorityRole,
                        decide_by: req[FIELD_MAP.request.decideBy] || req.DecideBy,
                        decision_reason: req[FIELD_MAP.request.decisionReason] || req.DecisionReason,
                        urgent: req[FIELD_MAP.request.urgent] || req.Urgent,
                        created_by: req[FIELD_MAP.request.createdBy] || req.CreatedBy
                    };
                });

                var cleanAlerts = aAlerts.map(function (al) {
                    return {
                        alert_date: al[FIELD_MAP.alert.date] || al.AlertDate,
                        alert_text: al[FIELD_MAP.alert.text] || al.AlertText
                    };
                });

                var cleanEvents = aEvents.map(function (ev) {
                    return {
                        title: ev[FIELD_MAP.event.title] || ev.Title,
                        topic: ev[FIELD_MAP.event.topic] || ev.Topic,
                        event_date: ev[FIELD_MAP.event.eventDate] || ev.EventDate,
                        reason: ev[FIELD_MAP.event.reason] || ev.Reason
                    };
                });

                var cleanAuthorities = aAuthorities.map(function (au) {
                    return {
                        topic: au[FIELD_MAP.authority.topic] || au.Topic,
                        topic_text: au[FIELD_MAP.authority.text] || au.TopicText,
                        authority_role: au[FIELD_MAP.authority.role] || au.AuthorityRole
                    };
                });

                return {
                    database_service: SERVICE_BASE_URL,
                    live_requests: cleanRequests,
                    live_alerts: cleanAlerts,
                    live_events: cleanEvents,
                    live_authorities: cleanAuthorities,
                    connection_errors: Object.keys(oErrors).length > 0 ? oErrors : null,
                    total_records: cleanRequests.length + cleanAlerts.length + cleanEvents.length
                };
            });
        },

        _formatError: function (oError) {
            var sMsg = (oError && oError.message) || String(oError);
            var iStatus = (oError && oError.status) || 0;
            if (sMsg.indexOf("401") !== -1 || iStatus === 401) {
                return "SAP Authentication Required (HTTP 401). Please verify credentials in .env or login prompt.";
            }
            if (sMsg.indexOf("403") !== -1 || iStatus === 403) {
                return "SAP Access Forbidden (HTTP 403). Your SAP user lacks permissions for service ZOA_UI_OA_REQUEST_O4.";
            }
            if (sMsg.indexOf("404") !== -1 || iStatus === 404) {
                return "SAP Service Not Found (HTTP 404). Verify service binding ZOA_UI_OA_REQUEST_O4 is published.";
            }
            return sMsg;
        },

        // ─────────────────────────────────────────────────────────────
        // ALERTS POLLING
        // ─────────────────────────────────────────────────────────────
        _startAlertsPolling: function () {
            this._refreshAlertsCount();
            this._iAlertTimer = setInterval(this._refreshAlertsCount.bind(this), 30000);
        },

        _refreshAlertsCount: function () {
            var that = this;
            this._fetchODataEntity("/" + ENTITY_SETS.alert)
                .then(function (aAlerts) {
                    var sCount = aAlerts.length > 0 ? String(aAlerts.length) : "";
                    that.getView().getModel("shellModel").setProperty("/alertCount", sCount);
                    var oTab = that.byId("tabAlerts");
                    if (oTab) { oTab.setCount(sCount); }
                })
                .catch(function () { });
        },

        // ─────────────────────────────────────────────────────────────
        // CRUD: CREATE REQUEST (RAP DRAFT ACTIVATION SUPPORT)
        // ─────────────────────────────────────────────────────────────

        onOpenCreateDialog: function () {
            if (!this._oCreateDialog) {
                var oView = this.getView();
                var oFormVBox = new VBox({
                    width: "100%",
                    items: [
                        new Label({ text: "Topic", required: true }),
                        new Select("dlgTopicSelect", {
                            width: "100%",
                            items: [
                                new Item({ key: "HOLIDAY", text: "Holiday (Decided by DIRECTOR)" }),
                                new Item({ key: "EVENT", text: "College Event (Decided by HOD)" }),
                                new Item({ key: "TRIP", text: "Class Trip (Decided by TEACHER)" })
                            ]
                        }),
                        new Label({ text: "Title", required: true }).addStyleClass("sapUiSmallMarginTop"),
                        new Input("dlgTitleInput", {
                            placeholder: "e.g. Annual Sports Day or Local Holiday",
                            width: "100%"
                        }),
                        new Label({ text: "Event Date", required: true }).addStyleClass("sapUiSmallMarginTop"),
                        new DatePicker("dlgEventDatePicker", {
                            valueFormat: "yyyy-MM-dd",
                            displayFormat: "yyyy-MM-dd",
                            width: "100%"
                        }),
                        new Label({ text: "Description / Reason" }).addStyleClass("sapUiSmallMarginTop"),
                        new TextArea("dlgDescInput", {
                            rows: 4,
                            placeholder: "Provide brief description...",
                            width: "100%"
                        })
                    ]
                });

                this._oCreateDialog = new Dialog({
                    title: "Create New Request",
                    contentWidth: "560px",
                    content: [oFormVBox],
                    beginButton: new Button({
                        text: "Submit",
                        type: "Emphasized",
                        press: this.onCreateRequestSubmit.bind(this)
                    }),
                    endButton: new Button({
                        text: "Cancel",
                        press: function () {
                            this._oCreateDialog.close();
                        }.bind(this)
                    })
                }).addStyleClass("sapUiContentPadding");
                oView.addDependent(this._oCreateDialog);
            }

            // Clear previous values
            sap.ui.getCore().byId("dlgTitleInput").setValue("");
            sap.ui.getCore().byId("dlgDescInput").setValue("");
            sap.ui.getCore().byId("dlgEventDatePicker").setValue("");

            this._oCreateDialog.open();
        },

        onCreateRequestSubmit: function () {
            var sTopic = sap.ui.getCore().byId("dlgTopicSelect").getSelectedKey();
            var sTitle = sap.ui.getCore().byId("dlgTitleInput").getValue().trim();
            var sDate = sap.ui.getCore().byId("dlgEventDatePicker").getValue();
            var sDesc = sap.ui.getCore().byId("dlgDescInput").getValue().trim();

            if (!sTitle || !sDate) {
                MessageBox.warning("Please fill in both Title and Event Date.");
                return;
            }

            this._oCreateDialog.close();
            this.createRequest({
                Topic: sTopic,
                Title: sTitle,
                EventDate: sDate,
                Description: sDesc
            });
        },

        /**
         * Create a new student request in SAP RAP database.
         * Supports draft activation for RAP behavior definitions.
         */
        createRequest: function (oData) {
            var that = this;
            var oModel = this.getView().getModel();
            if (!oModel) {
                MessageBox.error("OData model not connected.");
                return;
            }

            var oShellModel = this.getView().getModel("shellModel");
            var bIsStudent = oShellModel && oShellModel.getProperty("/isStudent");
            var sUserId = (oShellModel && oShellModel.getProperty("/userId")) || "";
            var sTopic = String(oData.Topic || "EVENT").trim().toUpperCase();
            var sDescription = String(oData.Description || "").trim();

            if (bIsStudent && sUserId) {
                var sTag = "[Student: " + String(sUserId).toUpperCase() + "]";
                if (sDescription.indexOf(sTag) === -1) {
                    sDescription = sDescription ? (sTag + " " + sDescription) : sTag;
                }
                if (sDescription.length > 255) {
                    sDescription = sDescription.slice(0, 255);
                }
            }

            var oListBinding = oModel.bindList("/" + ENTITY_SETS.request, null, null, null, {
                $$updateGroupId: "$auto"
            });

            var oContext = oListBinding.create({
                Topic: sTopic,
                Title: oData.Title,
                EventDate: oData.EventDate,
                Description: sDescription
            });

            sap.ui.core.BusyIndicator.show(0);

            oModel.submitBatch("$auto")
                .then(function () {
                    return oContext.created();
                })
                .then(function () {
                    var oCreatedObj = oContext.getObject() || {};
                    if (oCreatedObj.IsActiveEntity === true) {
                        return oCreatedObj;
                    }
                    // Activate RAP draft so the request becomes visible in Authority queues
                    var oAction = oModel.bindContext(
                        "com.sap.gateway.srvd.zoa_ui_oa_request.v0001.Activate(...)",
                        oContext
                    );
                    return oAction.execute().then(function () {
                        return oContext.requestObject().catch(function () {
                            return oContext.getObject() || {};
                        });
                    });
                })
                .then(function (oSavedObj) {
                    sap.ui.core.BusyIndicator.hide();
                    var sSavedStatus = normalizeStatusCode(oSavedObj && oSavedObj.Status, oSavedObj && oSavedObj.StatusText);
                    if (bIsStudent && sSavedStatus !== "P") {
                        console.warn("[OneAnswer] Student request did not land in Pending state (check SAP transport user in .env):", oSavedObj);
                    }
                    MessageToast.show("Request successfully created in SAP database!");
                    that._refreshAllLists();
                })
                .catch(function (oError) {
                    sap.ui.core.BusyIndicator.hide();
                    var sDetail = that._formatError(oError);
                    console.error("[OneAnswer] Create request failed:", oError);
                    MessageBox.error("Failed to create request in SAP: " + sDetail);
                });
        },

        // ─────────────────────────────────────────────────────────────
        // CRUD: DELETE REQUEST
        // ─────────────────────────────────────────────────────────────

        onDeleteRequestPress: function (oEvent) {
            var oContext = oEvent.getSource().getBindingContext();
            if (!oContext) {
                var oItem = oEvent.getSource().getParent().getParent();
                oContext = oItem && oItem.getBindingContext();
            }
            if (!oContext) { return; }

            var oObj = oContext.getObject() || {};
            if (normalizeStatusCode(oObj.Status, oObj.StatusText) === "P") {
                MessageBox.error("Pending requests cannot be edited or deleted.");
                return;
            }

            var that = this;
            MessageBox.confirm("Are you sure you want to delete this request from SAP?", {
                title: "Confirm Deletion",
                onClose: function (sAction) {
                    if (sAction === MessageBox.Action.OK) {
                        that.deleteRequest(oContext);
                    }
                }
            });
        },

        onFilterEventsByTopic: function (oEvent) {
            var sTopic = oEvent.getParameter("item").getKey();
            var oEventsList = this.byId("eventsList");
            if (!oEventsList || !oEventsList.getBinding("items")) {
                return;
            }
            var aFilters = [new Filter("Status", FilterOperator.EQ, "C")];
            if (sTopic && sTopic !== "ALL") {
                aFilters.push(new Filter("Topic", FilterOperator.EQ, sTopic));
            }
            oEventsList.getBinding("items").filter(aFilters);
        },

        onSelectStatusFilter: function (sStatusKey) {
            this.getView().getModel("shellModel").setProperty("/statusFilter", sStatusKey || "ALL");
            this._syncFilterButtonStyles();
            this._applyRequestFilters();
        },

        onSelectTypeFilter: function (sTypeKey) {
            this.getView().getModel("shellModel").setProperty("/typeFilter", sTypeKey || "ALL");
            this._syncFilterButtonStyles();
            this._applyRequestFilters();
        },

        onSearchRequests: function (oEvent) {
            var sVal = oEvent.getParameter("newValue");
            if (sVal === undefined) {
                sVal = oEvent.getParameter("query") || "";
            }
            this.getView().getModel("shellModel").setProperty("/searchQuery", String(sVal).trim());
            this._applySearchVisibility();
        },

        onRequestsLoaded: function () {
            if (!this._bInitialFilterApplied) {
                this._bInitialFilterApplied = true;
                var oModel = this.getView().getModel("shellModel");
                var sStatus = oModel && oModel.getProperty("/statusFilter");
                var sType = oModel && oModel.getProperty("/typeFilter");
                if ((sStatus && sStatus !== "ALL") || (sType && sType !== "ALL")) {
                    this._applyRequestFilters();
                    return;
                }
            }
            this._applySearchVisibility();
            this._refreshRequestCounts();
        },

        _syncFilterButtonStyles: function () {
            var oModel = this.getView().getModel("shellModel");
            if (!oModel) { return; }
            var sStatus = oModel.getProperty("/statusFilter");
            var sType = oModel.getProperty("/typeFilter");

            var mStatusBtns = {
                ALL: "btnStatusAll",
                P: "btnStatusPending",
                C: "btnStatusApproved",
                N: "btnStatusDeclined"
            };
            Object.keys(mStatusBtns).forEach(function (k) {
                var oBtn = this.byId(mStatusBtns[k]);
                if (oBtn) {
                    oBtn.toggleStyleClass("zoaStatusTabActive", k === sStatus);
                }
            }.bind(this));

            var mTypeBtns = {
                ALL: "btnTypeAll",
                TRIP: "btnTypeTrip",
                EVENT: "btnTypeEvent",
                HOLIDAY: "btnTypeHoliday"
            };
            Object.keys(mTypeBtns).forEach(function (k) {
                var oBtn = this.byId(mTypeBtns[k]);
                if (oBtn) {
                    oBtn.toggleStyleClass("zoaTypePillActive", k === sType);
                }
            }.bind(this));
        },

        _applyRequestFilters: function () {
            var oRequestsList = this.byId("requestsList");
            if (!oRequestsList || !oRequestsList.getBinding("items")) {
                return;
            }
            var oModel = this.getView().getModel("shellModel");
            var sStatus = oModel.getProperty("/statusFilter");
            var sType = oModel.getProperty("/typeFilter");
            var aFilters = [];
            if (sStatus && sStatus !== "ALL") {
                aFilters.push(new Filter("Status", FilterOperator.EQ, sStatus));
            }
            if (sType && sType !== "ALL") {
                aFilters.push(new Filter("Topic", FilterOperator.EQ, sType));
            }
            oRequestsList.getBinding("items").filter(aFilters);
            this._applySearchVisibility();
        },

        _applySearchVisibility: function () {
            var oRequestsList = this.byId("requestsList");
            var oModel = this.getView().getModel("shellModel");
            if (!oRequestsList || !oModel) {
                return;
            }
            var bIsStudent = !!oModel.getProperty("/isStudent");
            var sViewerRole = oModel.getProperty("/role");
            var sViewerUserId = oModel.getProperty("/userId");
            var sStatusFilter = String(oModel.getProperty("/statusFilter") || "ALL").trim().toUpperCase();
            var sQuery = String(oModel.getProperty("/searchQuery") || "").toLowerCase();
            oRequestsList.getItems().forEach(function (oItem) {
                var oCtx = oItem.getBindingContext();
                var oObj = oCtx ? oCtx.getObject() : {};
                if (!canViewRequest(oObj, bIsStudent, sViewerRole, sViewerUserId)) {
                    oItem.setVisible(false);
                    return;
                }
                if (sStatusFilter === "C" && !isApprovedForAuthorityRole(oObj, bIsStudent, sViewerRole)) {
                    oItem.setVisible(false);
                    return;
                }
                if (!sQuery) {
                    oItem.setVisible(true);
                    return;
                }
                var sHaystack = [
                    oObj.Title,
                    oObj.CreatedBy,
                    oObj.Topic,
                    oObj.Description,
                    oObj.AuthorityRole
                ].join(" ").toLowerCase();
                oItem.setVisible(sHaystack.indexOf(sQuery) !== -1);
            });
        },

        _refreshRequestCounts: function () {
            var that = this;
            this._fetchODataEntity("/" + ENTITY_SETS.request)
                .then(function (aRequests) {
                    var oModel = that.getView().getModel("shellModel");
                    var bIsStudent = oModel ? !!oModel.getProperty("/isStudent") : true;
                    var sViewerRole = oModel ? oModel.getProperty("/role") : "STUDENT";
                    var sViewerUserId = oModel ? oModel.getProperty("/userId") : "";

                    var aVisible = aRequests.filter(function (r) {
                        return canViewRequest(r, bIsStudent, sViewerRole, sViewerUserId);
                    });

                    var oCounts = { all: aVisible.length, pending: 0, approved: 0, declined: 0 };
                    aVisible.forEach(function (r) {
                        var st = normalizeStatusCode(r.Status, r.StatusText);
                        if (st === "P") {
                            oCounts.pending++;
                        } else if (st === "C") {
                            if (isApprovedForAuthorityRole(r, bIsStudent, sViewerRole)) {
                                oCounts.approved++;
                            }
                        } else if (st === "N") {
                            oCounts.declined++;
                        }
                    });
                    oModel.setProperty("/counts", oCounts);
                })
                .catch(function () { });
        },

        formatStatusText: function (sStatus, sStatusText) {
            var st = normalizeStatusCode(sStatus, sStatusText);
            if (st === "C") { return "Confirmed"; }
            if (st === "N") { return "Not happening"; }
            if (st === "P") { return "Pending"; }
            return sStatusText || sStatus || "Pending";
        },

        formatStatusState: function (sStatus, sStatusText) {
            var st = normalizeStatusCode(sStatus, sStatusText);
            if (st === "C") { return "Success"; }
            if (st === "N") { return "Error"; }
            return "Warning";
        },

        formatStatusIcon: function (sStatus, sStatusText) {
            var st = normalizeStatusCode(sStatus, sStatusText);
            if (st === "C") { return "sap-icon://accept"; }
            if (st === "N") { return "sap-icon://decline"; }
            return "sap-icon://pending";
        },

        formatStatusCssKey: function (sStatus, sStatusText) {
            var st = normalizeStatusCode(sStatus, sStatusText);
            if (st === "C") { return "confirmed"; }
            if (st === "N") { return "rejected"; }
            return "pending";
        },

        formatTargetAuthority: function (sTopic, sAuthorityRole) {
            return resolveAuthorityRole(sTopic, sAuthorityRole);
        },

        formatCanDecide: function (bIsStudent, sUserRole, sStatus, sStatusText, sTopic, sAuthorityRole, vOpAllowed) {
            if (bIsStudent) {
                return false;
            }
            var st = normalizeStatusCode(sStatus, sStatusText);
            if (st !== "P") {
                return false;
            }
            if (vOpAllowed === false) {
                return false;
            }
            if (vOpAllowed === true) {
                return true;
            }
            // Fallback (e.g. mock data without __OperationControl) routes strictly by Topic -> AuthorityRole
            var sTargetRole = resolveAuthorityRole(sTopic, sAuthorityRole);
            return !!sTargetRole && sTargetRole === String(sUserRole || "").trim().toUpperCase();
        },

        formatCanDelete: function (sStatus, sStatusText, vEntityDeletable) {
            if (normalizeStatusCode(sStatus, sStatusText) === "P") {
                return false;
            }
            return vEntityDeletable !== false;
        },

        _formatShortDate: function (vDate) {
            if (!vDate) { return ""; }
            var sDate = vDate instanceof Date ? vDate.toISOString().slice(0, 10) : String(vDate);
            var m = sDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
            if (!m) { return sDate; }
            var aMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            var iM = parseInt(m[2], 10);
            if (iM < 1 || iM > 12) { return sDate; }
            return aMonths[iM - 1] + " " + parseInt(m[3], 10) + ", " + m[1];
        },

        formatCleanDescription: function (sDescription) {
            return String(sDescription || "").replace(/^\[Student:\s*[^\]]+\]\s*/i, "").trim();
        },

        formatEventMeta: function (sAuthorityRole, sDecisionReason) {
            var aParts = [];
            var sRole = String(sAuthorityRole || "").trim().toUpperCase();
            if (sRole) { aParts.push("Approved by " + sRole); }
            var sReason = String(sDecisionReason || "").trim();
            if (sReason) { aParts.push(sReason); }
            return aParts.join(" · ");
        },

        formatCardMeta: function (sEventDate, sTopic, sAuthorityRole, sDecideBy, sStatus, sStatusText, sCreatedBy, sDescription, bIsStudent) {
            var aParts = [];
            var sEvDate = this._formatShortDate(sEventDate);
            if (sEvDate) { aParts.push(sEvDate); }
            var sRole = resolveAuthorityRole(sTopic, sAuthorityRole);
            if (sRole) { aParts.push(sRole); }
            var st = normalizeStatusCode(sStatus, sStatusText);
            if (st === "P") {
                var sDecide = this._formatShortDate(sDecideBy);
                if (sDecide) { aParts.push("Decide by " + sDecide); }
            }
            if (!bIsStudent) {
                var sTagged = extractTaggedStudentId(sDescription);
                var sCreator = sTagged || String(sCreatedBy || "").trim().toUpperCase();
                if (sCreator) { aParts.push("By " + sCreator); }
            }
            return aParts.join(" · ");
        },

        formatSubInfo: function (sDescription, sDecisionReason) {
            var sDesc = this.formatCleanDescription(sDescription);
            var sReason = String(sDecisionReason || "").trim();
            if (sReason && sDesc) {
                return sDesc + " · Decision: " + sReason;
            }
            if (sReason) {
                return "Decision: " + sReason;
            }
            return sDesc;
        },

        onOpenClassicTable: function () {
            window.location.href = "fiori-table.html";
        },

        onConfirmRequestPress: function (oEvent) {
            var oContext = oEvent.getSource().getBindingContext();
            if (!oContext) { return; }
            this._openDecisionDialog(oContext, true);
        },

        onRejectRequestPress: function (oEvent) {
            var oContext = oEvent.getSource().getBindingContext();
            if (!oContext) { return; }
            this._openDecisionDialog(oContext, false);
        },

        _openDecisionDialog: function (oContext, bConfirm) {
            if (this.getView().getModel("shellModel").getProperty("/isStudent")) {
                MessageBox.error("Students are not authorized to approve or reject requests.");
                return;
            }
            this._oPendingDecisionContext = oContext;
            this._bPendingDecisionConfirm = bConfirm;

            if (!this._oDecisionDialog) {
                var oReasonBox = new VBox({
                    width: "100%",
                    items: [
                        new Label({ text: "Decision Reason", required: true }),
                        new TextArea("dlgDecisionReasonInput", {
                            rows: 3,
                            width: "100%",
                            placeholder: "Enter reason for your decision..."
                        })
                    ]
                });
                this._oDecisionDialog = new Dialog({
                    title: "Decision",
                    contentWidth: "480px",
                    content: [oReasonBox],
                    beginButton: new Button("dlgDecisionSubmitBtn", {
                        text: "Confirm",
                        type: "Emphasized",
                        press: function () {
                            var sReason = sap.ui.getCore().byId("dlgDecisionReasonInput").getValue().trim();
                            if (!sReason) {
                                MessageBox.warning("Please enter a decision reason.");
                                return;
                            }
                            this._oDecisionDialog.close();
                            this._executeDecisionAction(
                                this._oPendingDecisionContext,
                                this._bPendingDecisionConfirm,
                                sReason
                            );
                        }.bind(this)
                    }),
                    endButton: new Button({
                        text: "Cancel",
                        press: function () {
                            this._oDecisionDialog.close();
                        }.bind(this)
                    })
                }).addStyleClass("sapUiContentPadding");
                this.getView().addDependent(this._oDecisionDialog);
            }

            this._oDecisionDialog.setTitle(bConfirm ? "Confirm Request" : "Reject Request (Not happening)");
            var oSubmitBtn = sap.ui.getCore().byId("dlgDecisionSubmitBtn");
            if (oSubmitBtn) {
                oSubmitBtn.setText(bConfirm ? "Confirm" : "Not happening");
                oSubmitBtn.setType(bConfirm ? "Accept" : "Reject");
            }
            var oReasonInp = sap.ui.getCore().byId("dlgDecisionReasonInput");
            if (oReasonInp) {
                oReasonInp.setValue("");
            }
            this._oDecisionDialog.open();
        },

        _executeDecisionAction: function (oContext, bConfirm, sReason) {
            var oModel = this.getView().getModel();
            if (!oModel || !oContext) {
                return;
            }
            var sActionName = bConfirm
                ? "com.sap.gateway.srvd.zoa_ui_oa_request.v0001.confirmRequest(...)"
                : "com.sap.gateway.srvd.zoa_ui_oa_request.v0001.rejectRequest(...)";
            var oAction = oModel.bindContext(sActionName, oContext);
            oAction.setParameter("Reason", sReason);

            var that = this;
            sap.ui.core.BusyIndicator.show(0);
            oAction.execute().then(function () {
                sap.ui.core.BusyIndicator.hide();
                MessageToast.show(bConfirm ? "Request confirmed." : "Request marked as Not happening.");
                that._refreshAllLists();
            }).catch(function (oError) {
                sap.ui.core.BusyIndicator.hide();
                var sDetail = that._formatError(oError);
                console.error("[OneAnswer] Decision action failed:", oError);
                MessageBox.error("Failed to update request in SAP: " + sDetail);
            });
        },

        deleteRequest: function (oContext) {
            var that = this;
            sap.ui.core.BusyIndicator.show(0);

            oContext.delete("$auto").then(function () {
                sap.ui.core.BusyIndicator.hide();
                MessageToast.show("Request deleted from SAP database.");
                that._refreshAllLists();
            }).catch(function (oError) {
                sap.ui.core.BusyIndicator.hide();
                var sDetail = that._formatError(oError);
                console.error("[OneAnswer] Delete request failed:", oError);
                MessageBox.error("Failed to delete request from SAP: " + sDetail);
            });
        },

        onRefreshPress: function () {
            this._refreshAllLists();
            MessageToast.show("Refreshing data from SAP database...");
        },

        _refreshAllLists: function () {
            var oEventsList = this.byId("eventsList");
            if (oEventsList && oEventsList.getBinding("items")) {
                oEventsList.getBinding("items").refresh();
            }
            var oAlertsList = this.byId("alertsList");
            if (oAlertsList && oAlertsList.getBinding("items")) {
                oAlertsList.getBinding("items").refresh();
            }
            var oRequestsList = this.byId("requestsList");
            if (oRequestsList && oRequestsList.getBinding("items")) {
                oRequestsList.getBinding("items").refresh();
            }
            this._refreshAlertsCount();
            this._refreshRequestCounts();
        },

        // ─────────────────────────────────────────────────────────────
        // UI EVENT HANDLERS
        // ─────────────────────────────────────────────────────────────

        onEventPress: function (oEvent) {
            var oItem = oEvent.getSource();
            MessageToast.show(oItem.getTitle());
        },

        onAlertsLoaded: function (oEvent) {
            var iCount = oEvent.getParameter("total");
            var sCount = iCount > 0 ? String(iCount) : "";
            this.getView().getModel("shellModel").setProperty("/alertCount", sCount);
            var oTab = this.byId("tabAlerts");
            if (oTab) { oTab.setCount(sCount); }
        },

        onAlertClose: function (oEvent) {
            var oItem = oEvent.getSource();
            var oContext = oItem.getBindingContext();
            if (oContext) {
                // If Alert has delete capability
                oContext.delete("$auto").catch(function () { });
            }
            oItem.getParent().removeItem(oItem);
            var iCount = parseInt(this.getView().getModel("shellModel").getProperty("/alertCount") || "0", 10);
            var sNew = iCount > 1 ? String(iCount - 1) : "";
            this.getView().getModel("shellModel").setProperty("/alertCount", sNew);
            var oTab = this.byId("tabAlerts");
            if (oTab) { oTab.setCount(sNew); }
        },

        onDismissAllAlerts: function () {
            var oAlertsList = this.byId("alertsList");
            if (!oAlertsList) { return; }
            var aItems = oAlertsList.getItems().slice();
            aItems.forEach(function (oItem) {
                var oCtx = oItem.getBindingContext();
                if (oCtx) {
                    oCtx.delete("$auto").catch(function () { });
                }
                oAlertsList.removeItem(oItem);
            });
            this.getView().getModel("shellModel").setProperty("/alertCount", "");
            var oTab = this.byId("tabAlerts");
            if (oTab) { oTab.setCount(""); }
            MessageToast.show("All alerts dismissed.");
        },

        onNotificationsPress: function () {
            this.byId("mainTabBar").setSelectedKey("alerts");
        },

        // ─────────────────────────────────────────────────────────────
        // ASK AI (POWERED BY LIVE ODATA DATABASE STATE)
        // ─────────────────────────────────────────────────────────────

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

            // Step 1: Fetch LIVE database state via ODataModel V4 (NO dummy data)
            this._getLiveContext().then(function (oDatabaseData) {
                if (oDatabaseData.connection_errors && oDatabaseData.connection_errors.requests) {
                    this._appendAnswer("Could not retrieve live request records from SAP: " +
                        oDatabaseData.connection_errors.requests);
                    return;
                }

                var sLiveHolidayAnswer = this._getLiveHolidayAnswer(sQuestion, oDatabaseData);
                if (sLiveHolidayAnswer !== null) {
                    this._appendAnswer(sLiveHolidayAnswer);
                    return;
                }

                // Step 2: Call Groq AI with real database state
                return this._callGroqAIWithDatabase(sQuestion, oDatabaseData).then(function (sAnswer) {
                    this._appendAnswer(sAnswer);
                }.bind(this), function (err) {
                    this._appendAnswer("Error communicating with Groq AI: " + this._formatError(err));
                }.bind(this));
            }.bind(this)).catch(function (err) {
                var sErrorFormatted = this._formatError(err);
                this._appendAnswer("Error communicating with SAP backend: " + sErrorFormatted);
            }.bind(this));
        },

        _getLiveHolidayAnswer: function (sQuestion, oDatabaseData) {
            if (!/\bholidays?\b|chhutti|chutti|avakash/i.test(sQuestion)) {
                return null;
            }

            if (oDatabaseData.connection_errors && oDatabaseData.connection_errors.requests) {
                return "I could not retrieve holiday requests from the live SAP backend: " +
                    oDatabaseData.connection_errors.requests;
            }

            var oToday = new Date();
            var iTodayMonth = oToday.getMonth() + 1;
            var sToday = oToday.getFullYear() + "-" +
                (iTodayMonth < 10 ? "0" : "") + iTodayMonth + "-" +
                (oToday.getDate() < 10 ? "0" : "") + oToday.getDate();
            var aMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            var aUpcomingHolidays = (oDatabaseData.live_requests || []).filter(function (oRequest) {
                var sTopic = String(oRequest.topic || "").toUpperCase();
                var sStatus = String(oRequest.status || "").toUpperCase();
                var sStatusText = String(oRequest.status_text || "").toUpperCase();
                return sTopic === "HOLIDAY" &&
                    (sStatus === "C" || sStatusText === "CONFIRMED");
            }).map(function (oRequest) {
                var sDate = "";
                if (oRequest.event_date instanceof Date) {
                    var oEventDate = oRequest.event_date;
                    var iEventMonth = oEventDate.getMonth() + 1;
                    sDate = oEventDate.getFullYear() + "-" +
                        (iEventMonth < 10 ? "0" : "") + iEventMonth + "-" +
                        (oEventDate.getDate() < 10 ? "0" : "") + oEventDate.getDate();
                } else {
                    sDate = String(oRequest.event_date || "");
                }
                var aDateParts = sDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
                if (!aDateParts) {
                    return null;
                }
                var iMonth = parseInt(aDateParts[2], 10);
                if (iMonth < 1 || iMonth > 12) {
                    return null;
                }
                return {
                    request: oRequest,
                    date: aDateParts[0],
                    displayDate: parseInt(aDateParts[3], 10) + " " +
                        aMonths[iMonth - 1] + " " + aDateParts[1]
                };
            }).filter(function (oHoliday) {
                return oHoliday && oHoliday.date >= sToday;
            }).sort(function (oHolidayA, oHolidayB) {
                return oHolidayA.date.localeCompare(oHolidayB.date);
            });

            if (aUpcomingHolidays.length === 0) {
                return "No confirmed upcoming holidays were found in the live SAP request records.";
            }

            var aAnswer = ["Confirmed upcoming holidays from live SAP data:"];
            aUpcomingHolidays.forEach(function (oHoliday, iIndex) {
                var oRequest = oHoliday.request;
                aAnswer.push(
                    "",
                    (iIndex + 1) + ". " + (oRequest.title || "Holiday"),
                    "- Date: " + oHoliday.displayDate,
                    "- Status: " + (oRequest.status_text || "Confirmed")
                );
                if (oRequest.decision_reason) {
                    aAnswer.push("- Reason: " + oRequest.decision_reason);
                }
                if (oRequest.authority_role) {
                    aAnswer.push("- Decided by: " + oRequest.authority_role);
                }
            });
            return aAnswer.join("\n");
        },

        _appendAnswer: function (sText) {
            var oChatModel = this.getView().getModel("chat");
            var aMessages = oChatModel.getProperty("/messages") || [];
            aMessages.push({ sender: "One Answer AI", text: sText, time: this._now(), initials: "OA" });
            oChatModel.setProperty("/messages", aMessages);
            oChatModel.setProperty("/busy", false);
        },

        _callGroqAIWithDatabase: function (sQuestion, oDatabaseData) {
            if (!GROQ_API_KEY || GROQ_API_KEY === "YOUR_GROQ_API_KEY_HERE") {
                return Promise.reject(new Error("Groq API key is not configured. Set GROQ_API_KEY in webapp/config.js."));
            }

            var sDatabaseNotice = "";
            if (!oDatabaseData.connection_errors && oDatabaseData.total_records === 0) {
                sDatabaseNotice = "\nNOTICE: The SAP database currently contains 0 records. If the user asks about events, holidays, or requests, state politely that no records currently exist in the database and advise checking with the department.";
            }
            var oAvailableDatabaseData = {
                database_service: oDatabaseData.database_service,
                live_requests: oDatabaseData.live_requests,
                live_alerts: oDatabaseData.live_alerts,
                live_events: oDatabaseData.live_events,
                live_authorities: oDatabaseData.live_authorities,
                total_records: oDatabaseData.total_records
            };

            var sSystemPrompt =
                "You are the official 'One Answer' Student AI Assistant for the ZOA College Portal.\n" +
                "You are provided with REAL LIVE DATA fetched directly from the SAP ABAP RAP database tables (ZOA_OA_REQUEST, ZOA_OA_ALERT, ZOA_OA_AUTH).\n" +
                "Answer student questions accurately and strictly according to this live database state and the ABAP backend rules:\n\n" +
                "Never add notes about connection errors or unavailable auxiliary entity sets. Never invent a record or field value; only state details present in the provided live records.\n" +
                "=== BACKEND BUSINESS RULES ===\n" +
                "1. Status 'C' (Confirmed): The request is approved and officially happening. Provide Title, Event Date, and Decision Reason.\n" +
                "2. Status 'N' (Not happening): The request was rejected/cancelled by authority. Provide Title, Event Date, and Decision Reason.\n" +
                "3. Status 'P' (Pending): The request is awaiting decision. State clearly: 'This request is currently pending with the [AuthorityRole] and is not yet official.' Mention the DecideBy deadline date.\n" +
                "4. 7-Day Rule (DecideBy): DecideBy is Event Date minus 7 days. If the event is within 7 days, it is marked as 'Urgent' (Priority = Urgent).\n" +
                "5. Authorities: HOLIDAY is decided by DIRECTOR; EVENT is decided by HOD; TRIP is decided by TEACHER.\n" +
                "6. Attendance Rule: Minimum 75% attendance is compulsory for semester exams.\n" +
                "7. If a date has already passed: 'This date has already passed and no decision was recorded.'\n" +
                "8. If an event/request is not in the live database: State that no record was found in the database and advise checking with the department.\n" +
                sDatabaseNotice + "\n\n" +
                "=== SEQUENCE & FORMATTING INSTRUCTIONS (STRICT) ===\n" +
                "- Structure your answer in a clean, professional, readable sequence.\n" +
                "- When listing events, holidays, or requests, NEVER put them together in one continuous paragraph.\n" +
                "- List each event/holiday as a distinct numbered item (1., 2., 3., etc.).\n" +
                "- For each item, put its properties on separate lines with clean bullets:\n" +
                "  1. [Event/Holiday Title]\n" +
                "     - Date: [Event Date]\n" +
                "     - Status: [Confirmed / Pending / Not happening]\n" +
                "     - Reason: [Decision Reason]\n" +
                "     - Decided by: [Authority]\n" +
                "- Add a blank line between each item so they are neatly separated.\n\n" +
                "=== LIVE DATABASE STATE (REAL DATA) ===\n" +
                JSON.stringify(oAvailableDatabaseData, null, 2) + "\n\n" +
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
                        return "Sorry, I could not generate an answer at this time.";
                    }
                });
        },

        formatDateMonth: function (sDate) {
            if (!sDate) { return ""; }
            var oDate = new Date(sDate);
            if (isNaN(oDate.getTime())) { return ""; }
            var aMonths = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
            return aMonths[oDate.getMonth()];
        },

        formatDateDay: function (sDate) {
            if (!sDate) { return ""; }
            var oDate = new Date(sDate);
            if (isNaN(oDate.getTime())) { return ""; }
            return String(oDate.getDate());
        },

        formatAiResponse: function (sText) {
            if (!sText) { return ""; }

            var s = sText.replace(/\s*\.\.\.\s*(MORE|LESS)/gi, "");

            // 1. Separate inline numbered sequences if collapsed into one line
            s = s.replace(/([^\n])\s+(\d+[\.\)]\s+)/g, "$1\n\n$2");

            // 2. Separate inline bullet properties: " * **Date:**"
            s = s.replace(/(?:^|\s+)[\*\-•]\s*(\*\*[a-zA-Z\s]+:?\*\*)/g, "\n   - $1");

            // 3. Markdown headers
            s = s.replace(/^### (.*$)/gim, "<h4>$1</h4>");
            s = s.replace(/^## (.*$)/gim, "<h3>$1</h3>");

            // 4. Markdown bold and italic
            s = s.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
            s = s.replace(/(^|[^\*])\*([^\*]+)\*([^\*]|$)/g, "$1<em>$2</em>$3");

            var aMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            var aLines = s.split("\n");
            var aProcessed = [];

            for (var i = 0; i < aLines.length; i++) {
                var sLine = aLines[i].trim();
                if (!sLine) {
                    continue;
                }

                // Dedicated Note Callout (ONLY if the line starts with Note:)
                var noteMatch = sLine.match(/^(?:<strong>)?(?:ℹ️\s*)?Note:\s*(?:<\/strong>)?(.*)/i);
                if (noteMatch) {
                    aProcessed.push(
                        "<p style=\"background:#F8FAFC; border-left:3px solid #0070F2; padding:6px 10px; margin:10px 0 4px 0; border-radius:0 6px 6px 0; color:#334155; font-size:0.88rem;\">" +
                        "<strong style=\"color:#0070F2;\">ℹ️ Note: </strong>" + noteMatch[1].trim() +
                        "</p>"
                    );
                    continue;
                }

                // Numbered Sequence Heading: e.g. "1. Holiday on 24 nov"
                var numMatch = sLine.match(/^(\d+[\.\)])\s*(.*)/);
                if (numMatch) {
                    aProcessed.push(
                        "<p style=\"margin:10px 0 2px 0; font-size:0.95rem; color:#0F172A;\">" +
                        "<span style=\"color:#0070F2; font-weight:700; margin-right:4px;\">" + numMatch[1] + "</span> " +
                        "<strong>" + numMatch[2].replace(/^<strong>|<\/strong>$/g, "") + "</strong>" +
                        "</p>"
                    );
                    continue;
                }

                // Bullet point detail: "- Date: ..."
                var bulletMatch = sLine.match(/^[\*\-•]\s*(.*)/);
                if (bulletMatch) {
                    var sContent = bulletMatch[1];
                    // Format dates like 2026-11-24 to 24 Nov 2026
                    sContent = sContent.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, function (m, y, mo, d) {
                        var iM = parseInt(mo, 10) - 1;
                        return parseInt(d, 10) + " " + (aMonths[iM] || mo) + " " + y;
                    });
                    // Highlight Confirmed or Pending nicely
                    sContent = sContent.replace(/\b(Confirmed)\b/gi, "<span style=\"color:#16A34A; font-weight:600;\">Confirmed</span>");
                    sContent = sContent.replace(/\b(Pending)\b/gi, "<span style=\"color:#D97706; font-weight:600;\">Pending</span>");
                    sContent = sContent.replace(/\b(Rejected|Cancelled)\b/gi, "<span style=\"color:#DC2626; font-weight:600;\">Not happening</span>");

                    aProcessed.push(
                        "<p style=\"margin:1px 0 1px 16px; color:#475569; font-size:0.88rem; line-height:1.45;\">" +
                        "<span style=\"color:#0070F2; font-weight:bold; margin-right:6px;\">•</span>" + sContent +
                        "</p>"
                    );
                    continue;
                }

                // Regular conversational line
                aProcessed.push("<p style=\"margin:4px 0; line-height:1.5; color:#1E293B;\">" + sLine + "</p>");
            }

            return aProcessed.join("");
        },

        _now: function () {
            return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        }
    });
});
