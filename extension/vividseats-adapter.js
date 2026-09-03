// Vivid Seats adapter for FIFA Ticket Scout
//
// Capture strategy is not settled yet: the discovery probe in injected.js
// reports what the page actually fetches. Until a real capture says which
// endpoint carries inventory, this adapter only resolves event identity.
//
// Every previous resale site turned out to be passive capture — the page
// fetches its own listings and we read the response — so that is the expected
// shape here too, but it is not assumed.

(function() {
  if (window.__vividseatsAdapterLoaded) return;
  window.__vividseatsAdapterLoaded = true;
  console.log("[FIFA Ticket Scout] Vivid Seats adapter loaded");

  function isVividSeatsSite() {
    return window.location.hostname.includes('vividseats.com');
  }

  // Vivid Seats production urls put a numeric production id at the end of the
  // path, e.g.
  //   /nfl/kansas-city-chiefs-tickets/.../production/5432109
  //   /production/5432109
  // NOT yet verified against a real url — the "Page url" line logged below is
  // what to check when this fails to resolve.
  function getVividSeatsEventId() {
    try {
      const path = window.location.pathname;

      const production = path.match(/\/production[s]?\/(\d+)/i);
      if (production) return production[1];

      // Require 5+ digits so a date fragment or page number in the slug
      // cannot be mistaken for an id.
      const tail = path.match(/\/(\d{5,})\/?$/);
      if (tail) return tail[1];

      const qs = new URLSearchParams(window.location.search);
      const fromQuery = qs.get("productionId") || qs.get("production_id")
        || qs.get("eventId") || qs.get("event_id");
      if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;

      return null;
    } catch (e) {
      console.log("[VS] Error extracting event ID:", e.message);
      return null;
    }
  }

  // Shared with the other adapters — see event-info.js, which manifest.json
  // loads first.
  function getVividSeatsEventInfo() {
    if (!window.__eventInfo) {
      console.log("[VS] event-info.js not loaded — no event name/date");
      return { name: null, date: null, venue: null };
    }
    return window.__eventInfo.read("VS");
  }

  window.__vividseatsAdapter = {
    isVividSeatsSite,
    getEventId: getVividSeatsEventId,
    getEventInfo: getVividSeatsEventInfo,
  };

  if (isVividSeatsSite()) {
    console.log('[VS] Vivid Seats site detected, waiting for page load...');

    let attempts = 0;
    const MAX_ATTEMPTS = 40; // ~20s
    const checkReady = setInterval(() => {
      const eventId = getVividSeatsEventId();
      if (eventId) {
        clearInterval(checkReady);
        console.log(`[VS] Event ID found: ${eventId}`);
        console.log(`[VS] Page url: ${window.location.href}`);
        window.postMessage({
          type: 'FIFA_TICKET_SCOUT_ADAPTER_READY',
          site: 'vividseats',
          eventId: eventId,
        }, '*');
        return;
      }
      if (++attempts >= MAX_ATTEMPTS) {
        clearInterval(checkReady);
        console.log(`[VS] No event ID resolved — url was: ${window.location.href}`);
      }
    }, 500);
  }

})();
