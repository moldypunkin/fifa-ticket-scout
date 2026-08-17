// Shared event identity reader for the resale-site adapters.
//
// Ticket APIs return seats and prices but not what event they belong to, so
// every adapter needs the same thing: pull name/date/venue off the page. This
// runs in the MAIN world and must be listed before the adapters in
// manifest.json so `window.__eventInfo` exists when they load.

(function() {
  if (window.__eventInfo) return;

  // "2026-06-15T19:00:00-04:00" -> "15-06-2026 - 19:00", the format
  // formatDate() in the popup already parses (it returns its input untouched
  // on anything else, so a miss degrades to a raw string rather than a crash).
  //
  // The wall-clock components are taken verbatim rather than via `new Date()`:
  // ticket sites publish venue-local time, and converting into the viewer's
  // timezone would misstate kickoff for anyone not in the venue's zone.
  function normalizeEventDate(iso) {
    if (typeof iso !== "string") return null;
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
    if (!m) return null;
    const [, year, month, day, hh, mm] = m;
    return `${day}-${month}-${year}` + (hh ? ` - ${hh}:${mm}` : "");
  }

  // "Portugal vs. Spain Tickets | Ticketmaster" -> "Portugal vs. Spain"
  function cleanTitle(raw) {
    if (typeof raw !== "string") return null;
    const cleaned = raw
      .split("|")[0]
      .replace(/\s+Tickets\b.*$/i, "")
      .trim();
    return cleaned || null;
  }

  // JSON-LD first — it is structured and unambiguous. og:title and
  // document.title are lossy fallbacks for when the markup shifts.
  function readEventInfo(tag) {
    const info = { name: null, date: null, venue: null };

    try {
      for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
        let parsed;
        try {
          parsed = JSON.parse(el.textContent);
        } catch (e) {
          continue; // one malformed block shouldn't sink the rest
        }

        // A block may be a single node, an array, or wrapped in @graph.
        const nodes = [].concat(parsed && parsed["@graph"] ? parsed["@graph"] : parsed || []);
        for (const node of nodes) {
          // "Event", but also "SportsEvent", "MusicEvent", …
          const types = [].concat((node && node["@type"]) || []);
          if (!types.some((t) => typeof t === "string" && t.endsWith("Event"))) continue;

          if (!info.name && node.name) info.name = String(node.name).trim();
          if (!info.date) info.date = normalizeEventDate(node.startDate);
          const loc = Array.isArray(node.location) ? node.location[0] : node.location;
          if (!info.venue && loc && loc.name) info.venue = String(loc.name).trim();
        }
      }
    } catch (e) {
      console.log(`[${tag}] Error reading JSON-LD:`, e.message);
    }

    if (!info.name) {
      const og = document.querySelector('meta[property="og:title"]');
      if (og && og.content) info.name = cleanTitle(og.content);
    }
    if (!info.name) info.name = cleanTitle(document.title);

    console.log(`[${tag}] Event info: name=${info.name || "?"} date=${info.date || "?"} venue=${info.venue || "?"}`);
    return info;
  }

  window.__eventInfo = { read: readEventInfo, normalizeEventDate, cleanTitle };
})();
