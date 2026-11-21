/**
 * Single source of truth for backend entity/field names.
 * Update here when $metadata is finalised by the backend colleague.
 */
sap.ui.define([], function () {
    "use strict";

    return {
        // OData entity set names
        ENTITY: {
            ALERT: "Alert",
            EVENTS: "EventsHolidays"
        },

        // Alert fields
        ALERT: {
            DATE: "AlertDate",
            TEXT: "AlertText"
        },

        // EventsHolidays fields
        EVENTS: {
            TITLE: "Title",
            TOPIC: "Topic",
            DATE: "EventDate",
            REASON: "Reason"
        },

        // Ask – unbound action name (update when backend confirms exact path)
        ASK_ACTION: "/Ask(...)"
    };
});
