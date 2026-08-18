// Evenue-specific adapter for FIFA Ticket Scout
//
// Evenue (Paciolan) is a legacy CGI platform, not a single-page app, so its
// inventory may arrive as server-rendered HTML rather than JSON. Which it is
// has not been established — the discovery probe in injected.js reports what
// the page actually fetches, and this adapter only resolves event identity
// until then.

(function() {
  if (window.__evenueAdapterLoaded) return;
  window.__evenueAdapterLoaded = true;
  console.log("[FIFA Ticket Scout] Evenue adapter loaded");

  function isEvenueSite() {
    return window.location.hostname.includes('evenue.net');
  }

  // Evenue keys events off query params rather than path segments, e.g.
  //   /cgi-bin/ncommerce3/SEGetEventInfo?ticketCode=ABC123&linkID=xyz
  // The order below is a guess at precedence and is NOT yet verified against a
  // real event url — the console line at the bottom is what to check.
  function getEvenueEventId() {
    try {
      const qs = new URLSearchParams(window.location.search);
      for (const key of ["ticketCode", "eventId", "eventID", "event_id", "performanceId", "linkID"]) {
        const v = qs.get(key);
        if (v && /^[A-Za-z0-9_-]+$/.test(v)) return v;
      }

      // Modern Evenue (Paciolan) uses /event/<season>/<code>, e.g.
      // "/event/F26/02". The API refers to the same event as
      // "977:F26:02" — the leading segment is the venue/distributor, so the
      // last two segments are what actually identify it. Both sides
      // normalise to "F26:02".
      const eventPath = window.location.pathname.match(/\/event\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)/);
      if (eventPath) return `${eventPath[1]}:${eventPath[2]}`;

      // Some deep links put a numeric id in the path. Digits only, on
      // purpose: every legacy Evenue path ends in a CGI script name
      // ("SEGetEventInfo", "EVExecMacro"), and an alphanumeric match would
      // return the script name as the event id on every page.
      const tail = window.location.pathname.match(/\/(\d{5,})\/?$/);
      if (tail) return tail[1];

      return null;
    } catch (e) {
      console.log("[EV] Error extracting event ID:", e.message);
      return null;
    }
  }

  // Shared with the other adapters — see event-info.js, loaded first.
  // Evenue may not publish JSON-LD; if not, this returns nulls and the event
  // name simply stays unknown until we find where the page keeps it.
  function getEvenueEventInfo() {
    if (!window.__eventInfo) {
      console.log("[EV] event-info.js not loaded — no event name/date");
      return { name: null, date: null, venue: null };
    }
    return window.__eventInfo.read("EV");
  }

  window.__evenueAdapter = {
    isEvenueSite,
    getEventId: getEvenueEventId,
    getEventInfo: getEvenueEventInfo,
  };

  if (isEvenueSite()) {
    console.log('[EV] Evenue site detected, waiting for page load...');

    let attempts = 0;
    const MAX_ATTEMPTS = 40; // ~20s
    const checkReady = setInterval(() => {
      const eventId = getEvenueEventId();
      if (eventId) {
        clearInterval(checkReady);
        console.log(`[EV] Event ID found: ${eventId}`);
        console.log(`[EV] Page url: ${window.location.href}`);
        window.postMessage({
          type: 'FIFA_TICKET_SCOUT_ADAPTER_READY',
          site: 'evenue',
          eventId: eventId,
        }, '*');
        return;
      }
      if (++attempts >= MAX_ATTEMPTS) {
        clearInterval(checkReady);
        console.log(`[EV] No event ID resolved — url was: ${window.location.href}`);
      }
    }, 500);
  }

})();
