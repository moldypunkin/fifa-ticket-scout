// StubHub-specific adapter for FIFA Ticket Scout
//
// Which capture strategy this site needs is not settled yet — SeatGeek turned
// out to be passive (the page fetches its own inventory), Ticketmaster active
// (the extension calls the API itself). Until a real capture says which,
// this adapter only resolves event identity, and the discovery probe in
// injected.js reports what the page actually requests.

(function() {
  if (window.__stubhubAdapterLoaded) return;
  window.__stubhubAdapterLoaded = true;
  console.log("[FIFA Ticket Scout] StubHub adapter loaded");

  function isStubHubSite() {
    return window.location.hostname.includes('stubhub.com');
  }

  // StubHub event urls put the id after /event/:
  //   /denver-broncos-kansas-city-chiefs-tickets-9-14-2026/event/158234567/
  //   /event/158234567
  // A trailing numeric segment and an ?eventId= param are accepted as
  // fallbacks. Verify against a real url before trusting the fallbacks.
  function getStubHubEventId() {
    try {
      const path = window.location.pathname;

      const eventMatch = path.match(/\/event\/(\d+)/i);
      if (eventMatch) return eventMatch[1];

      // Require 5+ digits so a date fragment in the slug can't win.
      const tailMatch = path.match(/\/(\d{5,})\/?$/);
      if (tailMatch) return tailMatch[1];

      const qs = new URLSearchParams(window.location.search);
      const fromQuery = qs.get("eventId") || qs.get("event_id");
      if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;

      return null;
    } catch (e) {
      console.log("[SH] Error extracting event ID:", e.message);
      return null;
    }
  }

  // Shared with the Ticketmaster and SeatGeek adapters — see event-info.js,
  // which manifest.json loads first.
  function getStubHubEventInfo() {
    if (!window.__eventInfo) {
      console.log("[SH] event-info.js not loaded — no event name/date");
      return { name: null, date: null, venue: null };
    }
    return window.__eventInfo.read("SH");
  }

  window.__stubhubAdapter = {
    isStubHubSite,
    getEventId: getStubHubEventId,
    getEventInfo: getStubHubEventInfo,
  };

  // Announce readiness once the event id resolves. The adapter is injected on
  // every stubhub.com page, most of which are not event pages, so the poll
  // gives up rather than running forever.
  if (isStubHubSite()) {
    console.log('[SH] StubHub site detected, waiting for page load...');

    let attempts = 0;
    const MAX_ATTEMPTS = 40; // ~20s
    const checkReady = setInterval(() => {
      const eventId = getStubHubEventId();
      if (eventId) {
        clearInterval(checkReady);
        console.log(`[SH] Event ID found: ${eventId}`);
        window.postMessage({
          type: 'FIFA_TICKET_SCOUT_ADAPTER_READY',
          site: 'stubhub',
          eventId: eventId,
        }, '*');
        return;
      }
      if (++attempts >= MAX_ATTEMPTS) {
        clearInterval(checkReady);
        console.log('[SH] No event ID on this page — adapter idle');
      }
    }, 500);
  }

})();
