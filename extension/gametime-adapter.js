// Gametime adapter for FIFA Ticket Scout
//
// Capture strategy is not settled yet: the discovery probe in injected.js
// reports what the page actually fetches. Until a real capture says which
// endpoint carries inventory, this adapter only resolves event identity.
//
// All five resale sites solved so far turned out to be passive capture — the
// page fetches its own listings and we read the response. Gametime is the
// least web-first of them, so that is the expectation, not the assumption:
// it may well sign or auth its inventory calls, which the probe will show.

(function() {
  if (window.__gametimeAdapterLoaded) return;
  window.__gametimeAdapterLoaded = true;
  console.log("[FIFA Ticket Scout] Gametime adapter loaded");

  function isGametimeSite() {
    return window.location.hostname.includes('gametime.co');
  }

  // Gametime event urls are NOT verified yet. The observed shape elsewhere is
  //   /<category>/<slug>-tickets/<date>-<city>-<venue>/events/<token>
  // and the token is opaque — long hex on some listings, shorter base62 on
  // others — so the id is taken as a token rather than parsed.
  //
  // Vivid Seats resolved on the first capture because this function logged the
  // page url next to whatever it found; the same two lines are logged below.
  function getGametimeEventId() {
    try {
      const path = window.location.pathname;

      // Primary: the /events/<token> segment.
      const events = path.match(/\/events?\/([A-Za-z0-9][A-Za-z0-9_-]{5,})/i);
      if (events) return events[1];

      // A 24-character hex id anywhere in the path — the ObjectId-ish shape
      // Gametime uses in its own api urls.
      const hex = path.match(/\/([0-9a-f]{24})(?:[/?#]|$)/i);
      if (hex) return hex[1];

      const qs = new URLSearchParams(window.location.search);
      const fromQuery = qs.get("eventId") || qs.get("event_id") || qs.get("id");
      if (fromQuery && /^[A-Za-z0-9_-]{6,}$/.test(fromQuery)) return fromQuery;

      return null;
    } catch (e) {
      console.log("[GT] Error extracting event ID:", e.message);
      return null;
    }
  }

  // Shared with the other adapters — see event-info.js, which manifest.json
  // loads first.
  function getGametimeEventInfo() {
    if (!window.__eventInfo) {
      console.log("[GT] event-info.js not loaded — no event name/date");
      return { name: null, date: null, venue: null };
    }
    return window.__eventInfo.read("GT");
  }

  window.__gametimeAdapter = {
    isGametimeSite,
    getEventId: getGametimeEventId,
    getEventInfo: getGametimeEventInfo,
  };

  if (isGametimeSite()) {
    console.log('[GT] Gametime site detected, waiting for page load...');

    let attempts = 0;
    const MAX_ATTEMPTS = 40; // ~20s
    const checkReady = setInterval(() => {
      const eventId = getGametimeEventId();
      if (eventId) {
        clearInterval(checkReady);
        console.log(`[GT] Event ID found: ${eventId}`);
        console.log(`[GT] Page url: ${window.location.href}`);
        window.postMessage({
          type: 'FIFA_TICKET_SCOUT_ADAPTER_READY',
          site: 'gametime',
          eventId: eventId,
        }, '*');
        return;
      }
      if (++attempts >= MAX_ATTEMPTS) {
        clearInterval(checkReady);
        console.log(`[GT] No event ID resolved — url was: ${window.location.href}`);
      }
    }, 500);
  }

})();
