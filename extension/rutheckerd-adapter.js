// Ruth Eckerd Hall adapter for FIFA Ticket Scout
//
// Bring-up only: this resolves event identity so the dashboard has somewhere to
// store seats. Which request carries the inventory is NOT known yet — the
// discovery probe in injected.js reports what the page actually fetches, and
// the parser is written from that capture rather than guessed at.
//
// Every venue source solved so far turned out to be passive capture (the page
// fetches its own inventory and we read the response), so that is the
// expectation here, not the assumption.
//
// The url observed live:
//   https://secure.rutheckerdhall.com/33733/33816?_gl=…&queueittoken=…
//
// Two numeric path segments. On the ticketing platforms seen so far that
// pairing is production/season then performance — the second being the actual
// dated event — but that is unconfirmed, so BOTH are kept in the id. A wrong
// guess about which one identifies the event would store seats under a key the
// dashboard never looks up, and that presents as capturing nothing with no
// error anywhere.
//
// `queueittoken` is Queue-it, the virtual waiting room. It is a session token,
// not part of the event's identity, and must never reach the storage key: it
// changes on every visit and would scatter one event across many keys.

(function() {
  if (window.__rutheckerdAdapterLoaded) return;
  window.__rutheckerdAdapterLoaded = true;
  console.log("[FIFA Ticket Scout] Ruth Eckerd Hall adapter loaded");

  function isRuthEckerdSite() {
    return window.location.hostname.includes('rutheckerdhall.com');
  }

  // "/33733/33816" -> "33816".
  //
  // The SECOND number. Confirmed by the API: every SYOS request carries
  // performanceId=33816, and the first number is the production season
  // (ProductionSeasonId 33733 in GetInitData). Keying on the pair stored seats
  // under "33733:33816" while the parser used "33816", and the dashboard
  // looked up a key nothing had written — a capture that worked and a popup
  // that showed nothing.
  function getRuthEckerdEventId() {
    try {
      const path = window.location.pathname;

      const pair = path.match(/^\/(\d{3,})\/(\d{3,})(?:[/?#]|$)/);
      if (pair) return pair[2];

      // Some links carry only the performance.
      const single = path.match(/^\/(\d{4,})(?:[/?#]|$)/);
      if (single) return single[1];

      // Query forms, in case a deep link spells it out. Checked AFTER the path
      // so a tracking parameter cannot outrank the url the user is looking at.
      const qs = new URLSearchParams(window.location.search);
      for (const key of ["performanceId", "performance_id", "eventId", "event_id", "perfNo"]) {
        const v = qs.get(key);
        if (v && /^\d{3,}$/.test(v)) return v;
      }

      return null;
    } catch (e) {
      console.log("[REH] Error extracting event ID:", e.message);
      return null;
    }
  }

  // Shared with the other adapters — see event-info.js, loaded first. Whether
  // this page publishes usable JSON-LD is unknown; the log line below says what
  // came back, so the first capture settles it.
  function getRuthEckerdEventInfo() {
    if (!window.__eventInfo) {
      console.log("[REH] event-info.js not loaded — no event name/date");
      return { name: null, date: null, venue: null };
    }
    const info = window.__eventInfo.read("REH") || {};
    // The venue is in the hostname here, and a page that names no venue would
    // otherwise fall back to the section-text heuristic for tiers.
    if (!info.venue) info.venue = "Ruth Eckerd Hall";
    return info;
  }

  window.__rutheckerdAdapter = {
    isRuthEckerdSite,
    getEventId: getRuthEckerdEventId,
    getEventInfo: getRuthEckerdEventInfo,
  };

  if (isRuthEckerdSite()) {
    console.log('[REH] Ruth Eckerd Hall site detected, waiting for page load...');

    let attempts = 0;
    const MAX_ATTEMPTS = 40; // ~20s
    const checkReady = setInterval(() => {
      const eventId = getRuthEckerdEventId();
      if (eventId) {
        clearInterval(checkReady);
        console.log(`[REH] Event ID found: ${eventId}`);
        // The url too: an id that looks plausible but came from the wrong part
        // of the url is otherwise indistinguishable from a good one.
        console.log(`[REH] Page url: ${window.location.href}`);
      } else if (++attempts >= MAX_ATTEMPTS) {
        clearInterval(checkReady);
        console.log('[REH] No event ID on this page — adapter idle. Url was: ' +
          window.location.href);
      }
    }, 500);
  }
})();
