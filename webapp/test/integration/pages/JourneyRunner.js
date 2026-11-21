sap.ui.define([
    "sap/fe/test/JourneyRunner",
	"zoa/zoarequestui/test/integration/pages/RequestList.gen",
	"zoa/zoarequestui/test/integration/pages/RequestObjectPage.gen"
], function (JourneyRunner, RequestListGenerated, RequestObjectPageGenerated) {
    'use strict';

    const runner = new JourneyRunner({
        launchUrl: sap.ui.require.toUrl('zoa/zoarequestui') + '/test/flp.html#app-preview',
        pages: {
			onTheRequestListGenerated: RequestListGenerated,
			onTheRequestObjectPageGenerated: RequestObjectPageGenerated
        },
        async: true
    });

    return runner;
});

