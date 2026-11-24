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

    var oI18nModel = new ResourceModel({
        bundleName: "zoa.zoarequestui.i18n.i18n",
        supportedLocales: ["en"],
        fallbackLocale: "en"
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
        oView.placeAt("content");
        // Force full height after rendering
        oView.addEventDelegate({
            onAfterRendering: function () {
                var oDom = oView.getDomRef();
                if (oDom) { oDom.style.height = "100%"; }
            }
        });
    });
});
