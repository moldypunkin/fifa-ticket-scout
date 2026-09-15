// GoTickets adapter for FIFA Ticket Scout
//
// Capture strategy is not settled yet: the discovery probe in injected.js
// reports what the page actually fetches. Until a real capture says which
// endpoint carries inventory, this adapter only resolves event identity.
//
// Every resale source solved so far turned out to be passive capture — the page
// fetches its own listings and we read the response — so that is the
// expectation here, not the assumption.
//
// The event url observed live carries a quantity filter
// (…?orderBy=Price%3A+Low+to+High&quantity=2). Gametime behaved the same way
// and a single capture saw only one lot size, so once the endpoint is known the
// plan is to sweep every quantity rather than keep the page's one.

(function() {
  if (window.__goticketsAdapterLoaded) return;
  window.__goticketsAdapterLoaded = true;
  console.log("[FIFA Ticket Scout] GoTickets adapter loaded");

  function isGoTicketsSite() {
    return window.location.hostname.includes('gotickets.com');
  }

  // Observed live:
  //   /tickets/1984079/trans-siberian-orchestra-tickets/t-mobile-center-kansas-city-mo-12-29-2026
  // The numeric segment straight after /tickets/ is the event id. The slug that
  // follows carries a date ("12-29-2026"), so a looser "any number" match could
  // pick up a date fragment — the /tickets/ anchor comes first for that reason.
  function getGoTicketsEventId() {
    try {
      const path = window.location.pathname;

      const tickets = path.match(/\/tickets\/(\d{4,})(?:[/?#]|$)/i);
      if (tickets) return tickets[1];

      const qs = new URLSearchParams(window.location.search);
      const fromQuery = qs.get("eventId") || qs.get("event_id") || qs.get("productionId");
      if (fromQuery && /^\d{4,}$/.test(fromQuery)) return fromQuery;

      return null;
    } catch (e) {
      console.log("[GOT] Error extracting event ID:", e.message);
      return null;
    }
  }

  // Shared with the other adapters — see event-info.js, which manifest.json
  // loads first.
  function getGoTicketsEventInfo() {
    if (!window.__eventInfo) {
      console.log("[GOT] event-info.js not loaded — no event name/date");
      return { name: null, date: null, venue: null };
    }
    return window.__eventInfo.read("GOT");
  }

  window.__goticketsAdapter = {
    isGoTicketsSite,
    getEventId: getGoTicketsEventId,
    getEventInfo: getGoTicketsEventInfo,
  };

  if (isGoTicketsSite()) {
    console.log('[GOT] GoTickets site detected, waiting for page load...');

    let attempts = 0;
    const MAX_ATTEMPTS = 40; // ~20s
    const checkReady = setInterval(() => {
      const eventId = getGoTicketsEventId();
      if (eventId) {
        clearInterval(checkReady);
        console.log(`[GOT] Event ID found: ${eventId}`);
        console.log(`[GOT] Page url: ${window.location.href}`);
        window.postMessage({
          type: 'FIFA_TICKET_SCOUT_ADAPTER_READY',
          site: 'gotickets',
          eventId: eventId,
        }, '*');
        return;
      }
      if (++attempts >= MAX_ATTEMPTS) {
        clearInterval(checkReady);
        console.log(`[GOT] No event ID resolved — url was: ${window.location.href}`);
      }
    }, 500);
  }

})();
