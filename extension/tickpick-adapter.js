// TickPick-specific adapter for FIFA Ticket Scout
//
// Capture strategy is not settled yet — the discovery probe in injected.js
// reports what the page actually fetches. Until then this adapter only
// resolves event identity.

(function() {
  if (window.__tickpickAdapterLoaded) return;
  window.__tickpickAdapterLoaded = true;
  console.log("[FIFA Ticket Scout] TickPick adapter loaded");

  function isTickPickSite() {
    return window.location.hostname.includes('tickpick.com');
  }

  // TickPick event urls put a numeric id at the end of the path:
  //   /buy-kansas-city-chiefs-tickets-.../6789012/
  //   /e/6789012
  // NOT yet verified against a real url — the "Page url" line below is what
  // to check if this fails to resolve.
  function getTickPickEventId() {
    try {
      const path = window.location.pathname;

      const shortMatch = path.match(/\/e\/(\d+)/i);
      if (shortMatch) return shortMatch[1];

      // Require 5+ digits so a date fragment in the slug cannot win.
      const tailMatch = path.match(/\/(\d{5,})\/?$/);
      if (tailMatch) return tailMatch[1];

      const qs = new URLSearchParams(window.location.search);
      const fromQuery = qs.get("eventId") || qs.get("event_id") || qs.get("e");
      if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;

      return null;
    } catch (e) {
      console.log("[TP] Error extracting event ID:", e.message);
      return null;
    }
  }

  // Shared with the other adapters — see event-info.js, loaded first.
  function getTickPickEventInfo() {
    if (!window.__eventInfo) {
      console.log("[TP] event-info.js not loaded — no event name/date");
      return { name: null, date: null, venue: null };
    }
    return window.__eventInfo.read("TP");
  }

  window.__tickpickAdapter = {
    isTickPickSite,
    getEventId: getTickPickEventId,
    getEventInfo: getTickPickEventInfo,
  };

  if (isTickPickSite()) {
    console.log('[TP] TickPick site detected, waiting for page load...');

    let attempts = 0;
    const MAX_ATTEMPTS = 40; // ~20s
    const checkReady = setInterval(() => {
      const eventId = getTickPickEventId();
      if (eventId) {
        clearInterval(checkReady);
        console.log(`[TP] Event ID found: ${eventId}`);
        console.log(`[TP] Page url: ${window.location.href}`);
        window.postMessage({
          type: 'FIFA_TICKET_SCOUT_ADAPTER_READY',
          site: 'tickpick',
          eventId: eventId,
        }, '*');
        return;
      }
      if (++attempts >= MAX_ATTEMPTS) {
        clearInterval(checkReady);
        console.log(`[TP] No event ID resolved — url was: ${window.location.href}`);
      }
    }, 500);
  }

})();
