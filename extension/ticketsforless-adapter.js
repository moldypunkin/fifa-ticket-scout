// TicketsForLess adapter for FIFA Ticket Scout
//
// Capture strategy is not settled yet: the discovery probe in injected.js
// reports what the page actually fetches. Until a real capture says which
// endpoint carries inventory, this adapter only resolves event identity.
//
// Written before any TicketsForLess url had been seen, so both the host and
// the event-id shape are assumptions. The page url is logged on every load —
// resolved or not — and that line is what confirms or corrects them.

(function() {
  if (window.__ticketsforlessAdapterLoaded) return;
  window.__ticketsforlessAdapterLoaded = true;
  console.log("[FIFA Ticket Scout] TicketsForLess adapter loaded");

  function isTicketsForLessSite() {
    return window.location.hostname.includes('ticketsforless');
  }

  // Tried in order, most specific first:
  //   1. an explicit query parameter (eventId, event_id, evtid, pid, id)
  //   2. a path segment that is entirely a 5+ digit number   …/1234567/…
  //   3. a 5+ digit number at the end of a slug              …/some-event-1234567
  // Five digits minimum, so a year ("2026") or a date fragment in a slug
  // ("12-29-2026") can never be taken for the id.
  function getTicketsForLessEventId() {
    try {
      const qs = new URLSearchParams(window.location.search);
      for (const key of ["eventId", "event_id", "evtid", "EventID", "pid", "id"]) {
        const v = qs.get(key);
        if (v && /^\d{5,}$/.test(v)) return v;
      }

      const path = window.location.pathname;
      const segment = path.match(/\/(\d{5,})(?=[/?#]|$)/);
      if (segment) return segment[1];

      const slugTail = path.match(/-(\d{5,})(?=[/?#.]|$)/);
      if (slugTail) return slugTail[1];

      return null;
    } catch (e) {
      console.log("[TFL] Error extracting event ID:", e.message);
      return null;
    }
  }

  // Shared with the other adapters — see event-info.js, which manifest.json
  // loads first.
  function getTicketsForLessEventInfo() {
    if (!window.__eventInfo) {
      console.log("[TFL] event-info.js not loaded — no event name/date");
      return { name: null, date: null, venue: null };
    }
    return window.__eventInfo.read("TFL");
  }

  window.__ticketsforlessAdapter = {
    isTicketsForLessSite,
    getEventId: getTicketsForLessEventId,
    getEventInfo: getTicketsForLessEventInfo,
  };

  if (isTicketsForLessSite()) {
    console.log('[TFL] TicketsForLess site detected, waiting for page load...');
    // Logged up front, not only on success: the id shape is a guess, and a
    // miss is exactly when this line is needed.
    console.log(`[TFL] Page url: ${window.location.href}`);

    let attempts = 0;
    const MAX_ATTEMPTS = 40; // ~20s
    const checkReady = setInterval(() => {
      const eventId = getTicketsForLessEventId();
      if (eventId) {
        clearInterval(checkReady);
        console.log(`[TFL] Event ID found: ${eventId}`);
        window.postMessage({
          type: 'FIFA_TICKET_SCOUT_ADAPTER_READY',
          site: 'ticketsforless',
          eventId: eventId,
        }, '*');
        return;
      }
      if (++attempts >= MAX_ATTEMPTS) {
        clearInterval(checkReady);
        console.log(`[TFL] No event ID resolved — url was: ${window.location.href}`);
      }
    }, 500);
  }

})();
