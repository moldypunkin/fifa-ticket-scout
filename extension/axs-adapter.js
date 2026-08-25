// AXS-specific adapter for FIFA Ticket Scout
//
// Capture strategy is NOT settled. AXS's inventory endpoint has not been
// observed, so this adapter resolves event identity only and injected.js
// captures broadly; the candidate-endpoint report in injected.js names what the
// page actually fetches on the first load where nothing matches.
//
// Passive capture on purpose, like SeatGeek and StubHub: AXS fronts its
// purchase flow with a queue (q.axs.com) and bot protection, and issuing our
// own inventory request would mean forging session state.

(function() {
  if (window.__axsAdapterLoaded) return;
  window.__axsAdapterLoaded = true;
  console.log("[FIFA Ticket Scout] AXS adapter loaded");

  function isAxsSite() {
    return window.location.hostname.includes('axs.com');
  }

  // AXS has two url shapes, and the buying flow uses the second one.
  //
  // Browse pages carry the id in the path:
  //   www.axs.com/events/1234567/some-event-tickets
  //
  // The ticket flow runs on tix.axs.com, where the path is an opaque encoded
  // blob and the event id is the `e` query param:
  //   tix.axs.com/nZA9NwAAAAABIj1H...?c=axs&e=92678159754876303&rt=AfterEvent
  //
  // Confirmed against a live T-Mobile Center event. `e` is a one-letter
  // parameter name, so it is only accepted with 6+ digits — enough that a
  // pagination or flag value cannot be mistaken for an event id.
  function getAxsEventId() {
    try {
      const path = window.location.pathname;

      // 4+ digits so a date fragment or page number in a slug cannot win.
      const pathMatch = path.match(/\/events?\/(\d{4,})/i);
      if (pathMatch) return pathMatch[1];

      const qs = new URLSearchParams(window.location.search);
      for (const key of ["eventId", "event_id", "eid", "skinId"]) {
        const value = qs.get(key);
        if (value && /^\d{4,}$/.test(value)) return value;
      }
      const short = qs.get("e");
      if (short && /^\d{6,}$/.test(short)) return short;

      // Trailing numeric segment, last resort.
      const tail = path.match(/\/(\d{5,})\/?$/);
      if (tail) return tail[1];

      return null;
    } catch (e) {
      console.log("[AXS] Error extracting event ID:", e.message);
      return null;
    }
  }

  // Shared with the other adapters — see event-info.js, which manifest.json
  // loads first.
  function getAxsEventInfo() {
    if (!window.__eventInfo) {
      console.log("[AXS] event-info.js not loaded — no event name/date");
      return { name: null, date: null, venue: null };
    }
    return window.__eventInfo.read("AXS");
  }

  window.__axsAdapter = {
    isAxsSite,
    getEventId: getAxsEventId,
    getEventInfo: getAxsEventInfo,
  };

  // Announce readiness once the event id resolves. The adapter is injected on
  // every axs.com page, most of which are not event pages, so the poll gives
  // up rather than running forever.
  if (isAxsSite()) {
    console.log('[AXS] AXS site detected, waiting for page load...');

    let attempts = 0;
    const MAX_ATTEMPTS = 40; // ~20s
    const checkReady = setInterval(() => {
      const eventId = getAxsEventId();
      if (eventId) {
        clearInterval(checkReady);
        console.log(`[AXS] Event ID found: ${eventId}`);
        console.log(`[AXS] Page url: ${window.location.href}`);
        window.postMessage({
          type: 'FIFA_TICKET_SCOUT_ADAPTER_READY',
          site: 'axs',
          eventId: eventId,
        }, '*');
        return;
      }
      if (++attempts >= MAX_ATTEMPTS) {
        clearInterval(checkReady);
        console.log(`[AXS] No event ID resolved — url was: ${window.location.href}`);
      }
    }, 500);
  }

})();
