// SeatGeek-specific adapter for FIFA Ticket Scout
// Mirrors ticketmaster-adapter.js: detect the event page, resolve its id and
// name, then fetch listings on demand. The extension never captures the page's
// own traffic here — it makes its own request when the user starts a scan.

(function() {
  if (window.__seatgeekAdapterLoaded) return;
  window.__seatgeekAdapterLoaded = true;
  console.log("[FIFA Ticket Scout] SeatGeek adapter loaded");

  function isSeatGeekSite() {
    return window.location.hostname.includes('seatgeek.com');
  }

  // Event ids are numeric and sit at the end of the path:
  //   /fifa-world-cup-group-a-tickets/soccer/2026-06-15/6789012
  // `/e/<id>` is also accepted since SeatGeek short links use it.
  //
  // NOTE: confirmed only against the URL shapes above. If an event page fails
  // to resolve here, the console line below is the thing to check.
  function getSeatGeekEventId() {
    try {
      const path = window.location.pathname;

      const shortMatch = path.match(/\/e\/(\d+)/);
      if (shortMatch) return shortMatch[1];

      // Trailing numeric segment. Require 5+ digits so a date fragment or a
      // page number can't masquerade as an event id.
      const tailMatch = path.match(/\/(\d{5,})\/?$/);
      if (tailMatch) return tailMatch[1];

      // Some routes carry it as a query param instead.
      const qs = new URLSearchParams(window.location.search);
      const fromQuery = qs.get("event_id") || qs.get("eid");
      if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;

      return null;
    } catch (e) {
      console.log("[SG] Error extracting event ID:", e.message);
      return null;
    }
  }

  // Shared with the Ticketmaster adapter — see event-info.js, which
  // manifest.json loads first.
  function getSeatGeekEventInfo() {
    if (!window.__eventInfo) {
      console.log("[SG] event-info.js not loaded — no event name/date");
      return { name: null, date: null, venue: null };
    }
    return window.__eventInfo.read("SG");
  }

  // ─── Listings ─────────────────────────────────────────────────────────────
  // There is deliberately no fetch here. SeatGeek's own page requests
  // /api/event_listings_v2 on load (~880kB, 979 listings for event 18014270),
  // and injected.js captures that response passively.
  //
  // Issuing our own request would mean forging per-session ids
  // (`event_page_view_id`, `sixpack_client_id`) and walking into `scrape_uuid`,
  // the Talos anti-tamper layer and DataDome. Reading the page's own traffic
  // avoids all of it.

  window.__seatgeekAdapter = {
    isSeatGeekSite,
    getEventId: getSeatGeekEventId,
    getEventInfo: getSeatGeekEventInfo,
  };

  // Announce readiness once the event id resolves. The adapter is injected on
  // every seatgeek.com page, most of which are not event pages, so the poll
  // gives up rather than running forever.
  if (isSeatGeekSite()) {
    console.log('[SG] SeatGeek site detected, waiting for page load...');

    let attempts = 0;
    const MAX_ATTEMPTS = 40; // ~20s
    const checkReady = setInterval(() => {
      const eventId = getSeatGeekEventId();
      if (eventId) {
        clearInterval(checkReady);
        console.log(`[SG] Event ID found: ${eventId}`);
        window.postMessage({
          type: 'FIFA_TICKET_SCOUT_ADAPTER_READY',
          site: 'seatgeek',
          eventId: eventId,
        }, '*');
        return;
      }
      if (++attempts >= MAX_ATTEMPTS) {
        clearInterval(checkReady);
        console.log('[SG] No event ID on this page — adapter idle');
      }
    }, 500);
  }

})();
