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

  // Which event a url points at, reduced to something comparable.
  //
  // Path plus the event-identifying query params, since Evenue keys events off
  // the query string while everyone else puts the id in the path. Trailing
  // slashes and case are normalized so cosmetic differences do not read as a
  // different event.
  const EVENT_PARAMS = ["eventid", "event_id", "eid", "id", "ticketcode",
                        "performanceid", "linkid"];

  function pageIdentity(url) {
    const raw = String(url == null ? "" : url);
    if (!raw) return "";
    try {
      const u = new URL(raw, "https://relative.invalid/");
      const extra = [];
      u.searchParams.forEach((value, key) => {
        if (EVENT_PARAMS.indexOf(key.toLowerCase()) >= 0) {
          extra.push(key.toLowerCase() + "=" + String(value).toLowerCase());
        }
      });
      const path = u.pathname.replace(/\/+$/, "").toLowerCase();
      return path + (extra.length ? "?" + extra.sort().join("&") : "");
    } catch (e) {
      return raw.toLowerCase();
    }
  }

  // True when a JSON-LD node describes a DIFFERENT event than the page we are
  // on. Sites render this block server-side and client-side routing usually
  // does not replace it, so after an in-page navigation to another event the
  // stale block still names the previous one — and the popup header keeps
  // showing it while the seats underneath are the new event's.
  //
  // A node with no url of its own cannot be checked; those are kept, since
  // rejecting them would throw away the only source on pages that work fine.
  function ldNodeIsStale(node, pageUrl) {
    if (!node) return false;
    const meta = node.mainEntityOfPage;
    const own = node.url
      || (typeof meta === "string" ? meta : (meta && meta.url))
      || null;
    if (typeof own !== "string" || !own) return false;
    const nodeId = pageIdentity(own);
    const pageId = pageIdentity(pageUrl);
    if (!nodeId || !pageId) return false;
    return nodeId !== pageId;
  }

  // JSON-LD first — it is structured and unambiguous. og:title and
  // document.title are lossy fallbacks for when the markup shifts.
  function readEventInfo(tag) {
    const info = { name: null, date: null, venue: null };
    const pageUrl = window.location.href;
    let sawStale = false;
    let staleExample = null;

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

          if (ldNodeIsStale(node, pageUrl)) {
            sawStale = true;
            if (!staleExample) staleExample = String(node.name || node.url || "?");
            continue;
          }

          if (!info.name && node.name) info.name = String(node.name).trim();
          if (!info.date) info.date = normalizeEventDate(node.startDate);
          const loc = Array.isArray(node.location) ? node.location[0] : node.location;
          if (!info.venue && loc && loc.name) info.venue = String(loc.name).trim();
        }
      }
    } catch (e) {
      console.log(`[${tag}] Error reading JSON-LD:`, e.message);
    }

    if (sawStale) {
      // Two things look the same here: a block left over from an in-page
      // navigation, and a page that legitimately lists related events. Report
      // what was observed rather than asserting which one it was.
      console.log(`[${tag}] skipped JSON-LD describing a different event ` +
        `("${staleExample}")${info.name ? "" : " — read the title instead"}. ` +
        `After an in-page navigation the server-rendered block is the old event.`);
    }

    // og:title is rendered server-side alongside JSON-LD, so it goes stale the
    // same way. Once we know the page navigated in place, document.title is
    // the only source the client-side router actually keeps current.
    if (!info.name && !sawStale) {
      const og = document.querySelector('meta[property="og:title"]');
      if (og && og.content) info.name = cleanTitle(og.content);
    }
    if (!info.name) info.name = cleanTitle(document.title);

    console.log(`[${tag}] Event info: name=${info.name || "?"} date=${info.date || "?"} venue=${info.venue || "?"}`);
    return info;
  }

  window.__eventInfo = {
    read: readEventInfo,
    normalizeEventDate,
    cleanTitle,
    pageIdentity,
    ldNodeIsStale,
  };
})();
