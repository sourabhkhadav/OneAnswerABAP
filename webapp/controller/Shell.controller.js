sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast"
], function (Controller, JSONModel, MessageToast) {
    "use strict";

    return Controller.extend("zoa.zoarequestui.controller.Shell", {

        onInit: function () {
            this.getView().setModel(new JSONModel({ messages: [], busy: false }), "chat");
            this.getView().setModel(new JSONModel({ alertCount: "" }), "shellModel");
        },

        // ── Events ───────────────────────────────────────────────
        onEventPress: function (oEvent) {
            var oItem = oEvent.getSource();
            MessageToast.show(oItem.getTitle());
        },

        onEventTilePress: function () {},

        // ── Alerts ───────────────────────────────────────────────
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

        // ── Ask ──────────────────────────────────────────────────
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
            var aMessages = oChatModel.getProperty("/messages");
            aMessages.push({ sender: "You", text: sQuestion, time: this._now(), initials: "ME" });
            oChatModel.setProperty("/messages", aMessages);
            oChatModel.setProperty("/busy", true);
            oInput.setValue("");

            var oModel = this.getView().getModel();
            var oAction = oModel.bindContext("/Ask(...)");
            oAction.setParameter("Question", sQuestion);
            oAction.execute().then(function () {
                var sAnswer = oAction.getBoundContext().getProperty("Answer") || "No answer returned.";
                this._appendAnswer(sAnswer);
            }.bind(this)).catch(function () {
                this._appendAnswer("(Demo) Backend Ask action not yet available. Question received: \"" + sQuestion + "\"");
            }.bind(this));
        },

        _appendAnswer: function (sText) {
            var oChatModel = this.getView().getModel("chat");
            var aMessages = oChatModel.getProperty("/messages");
            aMessages.push({ sender: "One Answer", text: sText, time: this._now(), initials: "OA" });
            oChatModel.setProperty("/messages", aMessages);
            oChatModel.setProperty("/busy", false);
        },

        _now: function () {
            return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        }
    });
});
