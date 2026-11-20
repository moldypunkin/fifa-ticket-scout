// Starlight Theatre adapter for FIFA Ticket Scout
//
// Tessitura, the same family as Ruth Eckerd Hall — so the SYOS parser in
// background.js is shared rather than rewritten, and this file only resolves
// event identity.
//
// How the platform was identified without a capture: the ticket url answers
// 302 to a Queue-it waiting room whose own parameters name it —
//
//   https://kcstarlight.queue-it.net/?c=kcstarlight&e=safetynetlive
//     &man=Send%20to%20TNEW%20Live%20Safety%20Net%20Queue
//
// TNEW is Tessitura Network Express Web. The seat picker inside it is SYOS
// ("select your own seat"), which serves /api/syos/GetInitData and
// /api/syos/GetSeatList — already parsed here for Ruth Eckerd, and keyed on
// the performanceId the request itself carries rather than on anything read
// off the page url.
//
// The url observed live:
//   https://tickets.kcstarlight.com/gruffalo/5426?queueittoken=e_safetynetlive~…
//
// A production slug then a number. Ruth Eckerd's is two numbers
// ("/33733/33816") where the second is the performance; here the slug stands
// in for the first, which leaves exactly one number to take.
//
// `queueittoken` is Queue-it, the virtual waiting room. It is a session token,
// not part of the event's identity, and must never reach the storage key: it
// changes on every visit and would scatter one event across many keys. It
// lives in the query string, so taking the id from the PATH keeps it out by
// construction.
//
// STILL UNCONFIRMED, and the thing to check first on a live capture: that 5426
// is the same number SYOS puts in `performanceId`. The parser stores under the
// id the API reports; the popup looks up the id in the address bar. Ruth
// Eckerd was keyed on the wrong one of its two numbers to begin with, and that
// presents as capturing nothing, with no error anywhere.

(function() {
  if (window.__starlightAdapterLoaded) return;
  window.__starlightAdapterLoaded = true;
  console.log("[FIFA Ticket Scout] Starlight Theatre adapter loaded");

  function isStarlightSite() {
    return window.location.hostname.includes('kcstarlight.com');
  }

  // "/gruffalo/5426" -> "5426". The LAST numeric path segment, so a url that
  // grows another segment in front of it still resolves.
  function getStarlightEventId() {
    try {
      const path = window.location.pathname.replace(/\/+$/, "");
      const numeric = path.split("/").filter((s) => /^\d{2,}$/.test(s));
      if (numeric.length) return numeric[numeric.length - 1];

      // Some Tessitura builds carry it as a parameter instead. Deliberately
      // NOT any number in the query string: queueittoken is full of digits.
      const qs = new URLSearchParams(window.location.search);
      const fromQuery = qs.get("performanceId") || qs.get("performanceid");
      if (fromQuery && /^\d{2,}$/.test(fromQuery)) return fromQuery;

      return null;
    } catch (e) {
      console.log("[STAR] Error extracting event ID:", e.message);
      return null;
    }
  }

  // Shared with the other adapters — see event-info.js, which manifest.json
  // loads first.
  function getStarlightEventInfo() {
    if (!window.__eventInfo) {
      console.log("[STAR] event-info.js not loaded — no event name/date");
      return { name: null, date: null, venue: null };
    }
    return window.__eventInfo.read("STAR");
  }

  window.__starlightAdapter = {
    isStarlightSite,
    getEventId: getStarlightEventId,
    getEventInfo: getStarlightEventInfo,
  };

  if (isStarlightSite()) {
    console.log('[STAR] Starlight Theatre site detected, waiting for page load...');

    let attempts = 0;
    const MAX_ATTEMPTS = 40; // ~20s
    const checkReady = setInterval(() => {
      const eventId = getStarlightEventId();
      if (eventId) {
        clearInterval(checkReady);
        console.log(`[STAR] Event ID found: ${eventId}`);
        console.log(`[STAR] Page url: ${window.location.href}`);
        // The one number worth comparing by eye on a first capture: the
        // service worker logs the performanceId SYOS actually uses, and if it
        // is not this one the seats land under a key the dashboard never
        // looks up — silently.
        console.log(`[STAR] Seats will be stored under performanceId — check the ` +
          `worker's "SYOS: storing under" line still says ${eventId}`);
        window.postMessage({
          type: 'FIFA_TICKET_SCOUT_ADAPTER_READY',
          site: 'starlight',
          eventId: eventId,
        }, '*');
        return;
      }
      if (++attempts >= MAX_ATTEMPTS) {
        clearInterval(checkReady);
        console.log(`[STAR] No event ID resolved — url was: ${window.location.href}`);
      }
    }, 500);
  }

})();
