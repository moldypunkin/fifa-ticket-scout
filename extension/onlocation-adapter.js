// On Location adapter for FIFA Ticket Scout
//
// Capture strategy is NOT settled. This ships for the discovery round: the
// probe in injected.js (DISCOVERY_SITE = "OL") reports what the page actually
// fetches, and until a capture names the inventory endpoint this adapter only
// resolves event identity.
//
// What two HAR captures already established, so the next round does not
// re-derive it:
//
//   - onlocationexp.com is a Next.js site embedding TicketNetwork's Seatics
//     map widget (mapwidget3.seatics.com, /seatics/seaticsApiFramework.js,
//     feature flags from growthbookproxy.tn-apis.com).
//   - GET /api/seaticMap?websiteConfigId=…&eventId=…&consumerKey=…&
//     callback=callbackApiResponse carries the venue geometry AND the event's
//     identity, but no tickets. It is JSONP, fetched with
//     jsonpCallbackFunction "callbackApiResponse", and the tail of the body is
//     callbackApiResponse([{event}, Seatics.mapData], ''). The event object is
//     worth having on its own:
//
//       eventID 8075575, eventName "2027 NCAA Baseball College World Series -
//       Game 1", eventDate new Date(2027, 5, 18, 12, 0) (0-based month),
//       venueName "Charles Schwab Field Omaha", venueID, venueConfigID,
//       GAOnly false, emptyEvent false
//
//     Note eventName is the EVENT, not the package title in the url, and
//     venueName is current where the map file's name is not. The body is not
//     valid JSON — `new Date(...)` is a JS expression — so it cannot simply be
//     JSON.parse'd.
//   - The whole first-party API surface, from the strings in the app bundle,
//     is four paths: /api/seaticMap, **/api/event/details**, /api/logger and
//     /api/checkout. /api/event/details is the prime suspect for the tickets
//     and was never called during either capture.
//   - The app holds tickets in a Redux store (`getTicketsList`,
//     `getTicketsDetails`) and reads `.price` off each one, and the Seatics
//     MapSectionClicked event hands it `e.tickets`. So a ticket record has at
//     least a price and a ticket-group id.
//   - The listings are NOT fetched on page load. A full hard-refresh capture
//     (263 requests, nothing cached that could hold them) had no ticket data
//     and the widget initialised with `Seatics.mapData = null`. An earlier
//     mid-session capture showed the widget reporting `tgc:52` — its ticket
//     group count — so 52 listings do load, on an interaction.
//
// So the endpoint to find is a sibling of /api/seaticMap that fires when the
// ticket view opens, and it is likely JSONP like its sibling rather than plain
// JSON. The probe unwraps a JSONP body for exactly that reason.
//
// Passive capture, like every other source here: the page fetches its own
// inventory and the response is read. Nothing is re-requested.

(function() {
  if (window.__onlocationAdapterLoaded) return;
  window.__onlocationAdapterLoaded = true;
  console.log("[FIFA Ticket Scout] On Location adapter loaded");

  function isOnLocationSite() {
    return window.location.hostname.includes('onlocationexp.com');
  }

  // Observed live:
  //   /e/sports/ncaa-mens-college-world-series-ticket-(game-1)-and-tailgate-
  //     experience/charles-schwab-field-omaha/june-18-2027-1001555732
  //
  // The id is the trailing number of the LAST segment, behind a date that is
  // itself full of numbers ("june-18-2027") — so this anchors on the end of
  // the string rather than taking the first number it finds.
  //
  // NOTE: there are two event ids on this site and they do not match. The url
  // carries 1001555732 while /api/seaticMap is called with eventId=8075575,
  // which is TicketNetwork's. This returns the URL one, because that is the
  // only id the popup can read back off the address bar to find the stored
  // game. If the listings endpoint turns out to key on the TicketNetwork id,
  // the parser has to map between them rather than store under whichever it
  // happens to see.
  function getOnLocationEventId() {
    try {
      const path = window.location.pathname.replace(/\/+$/, "");
      const last = path.split("/").pop() || "";

      const trailing = last.match(/-(\d{6,})$/);
      if (trailing) return trailing[1];

      // A bare numeric segment, in case another page shape omits the slug.
      if (/^\d{6,}$/.test(last)) return last;

      const qs = new URLSearchParams(window.location.search);
      const fromQuery = qs.get("eventId") || qs.get("event_id");
      if (fromQuery && /^\d{4,}$/.test(fromQuery)) return fromQuery;

      return null;
    } catch (e) {
      console.log("[OL] Error extracting event ID:", e.message);
      return null;
    }
  }

  // Shared with the other adapters — see event-info.js, which manifest.json
  // loads first.
  function getOnLocationEventInfo() {
    if (!window.__eventInfo) {
      console.log("[OL] event-info.js not loaded — no event name/date");
      return { name: null, date: null, venue: null };
    }
    return window.__eventInfo.read("OL");
  }

  // One record's primitive fields only.
  //
  // The ticket objects cannot be JSON.stringify'd: a ticket points at its
  // section and the section points back at its tickets, so the whole thing is
  // circular and the first dump reported "(not serialisable)" for every row.
  // Everything a parser needs — section, row, quantity, price, fees — is a
  // string or a number on the record itself, so taking just those sheds the
  // cycles and loses nothing.
  function olFlatten(rec) {
    const out = {};
    for (const k of Object.keys(rec)) {
      let v;
      try { v = rec[k]; } catch (e) { continue; }
      const t = typeof v;
      if (v === null || t === "string" || t === "number" || t === "boolean") {
        out[k] = v;
      } else if (Array.isArray(v)) {
        // Arrays of primitives are worth keeping — `splits` is the purchasable
        // lot sizes, and that is a field, not a back-reference.
        const prim = v.filter((x) => x === null || typeof x !== "object");
        if (prim.length === v.length && v.length <= 24) out[k] = v;
        else out[k] = "[" + v.length + " items]";
      } else if (t === "object") {
        out[k] = "{" + Object.keys(v).slice(0, 6).join(",") + "}";
      }
    }
    return out;
  }

  // The path the collected listings are posted under.
  //
  // Every other source here captures a network response, so background.js
  // dispatches on (site, url, body). On Location has no response to capture:
  // the listings only ever exist as page state. Posting them under a synthetic
  // path reuses that whole pipeline — the content-script relay, the event
  // info, the merge and the logging — rather than adding a parallel one. It is
  // not a url the site serves, and nothing ever requests it.
  const OL_STATE_PATH = "/__scout/seatics-tickets";

  // Read the listings out of Seatics' own state.
  //
  // `TicketConnector.SectionsByName` holds every section TWICE: once under its
  // bare number ("102") and once under its prefixed name ("LOWER LEVEL 102",
  // "CLUB 210"), both pointing at the SAME ticket array. A census counted 104
  // tickets across 32 entries on an event holding 52 — exactly double — and
  // the widget's own ticket-group count in an earlier capture was 52. So this
  // dedupes by tgID.
  //
  // The duplication is useful, though: the prefixed key is the only place the
  // level appears, and the level is the Area column. `tgUserSec` is the bare
  // section, so the prefix is whatever the key carries in front of it.
  function olCollectTickets() {
    const tc = window.Seatics && window.Seatics.TicketConnector;
    const byName = tc && tc.SectionsByName;
    if (!byName || typeof byName !== "object") return null;

    const byId = {};
    const levelOf = {};
    let dupes = 0;

    for (const key of Object.keys(byName)) {
      let sec;
      try { sec = byName[key]; } catch (e) { continue; }
      const list = sec && sec.tickets;
      if (!Array.isArray(list) || !list.length) continue;

      for (const rec of list) {
        if (!rec) continue;
        const id = String(rec.tgID == null ? "" : rec.tgID);
        if (!id) continue;
        const bare = String(rec.tgUserSec == null ? "" : rec.tgUserSec);

        // "LOWER LEVEL 102" for a record whose own section is "102".
        if (bare && key !== bare && key.length > bare.length &&
            key.slice(-bare.length) === bare) {
          const prefix = key.slice(0, key.length - bare.length).trim();
          if (prefix) levelOf[bare] = prefix;
        }

        if (byId[id]) { dupes++; continue; }
        byId[id] = {
          tgID: id,
          tgUserSec: bare,
          tgUserRow: String(rec.tgUserRow == null ? "" : rec.tgUserRow),
          // Always empty on every record seen: TicketNetwork publishes no seat
          // numbers, like TickPick, Vivid and AXS resale.
          tgUserSeats: String(rec.tgUserSeats == null ? "" : rec.tgUserSeats),
          tgQty: Number(rec.tgQty),
          tgPrice: Number(rec.tgPrice),
          // The page's own all-in figure, so no fee formula has to be fitted.
          tgAllInPrice: Number(rec.tgAllInPrice),
          tgServiceFee: Number(rec.tgServiceFee),
          tgDeliveryFee: Number(rec.tgDeliveryFee),
          tgFaceValue: Number(rec.tgFaceValue),
          tgNotes: String(rec.tgNotes == null ? "" : rec.tgNotes),
          tgCType: String(rec.tgCType == null ? "" : rec.tgCType),
          tgIsZoneTicket: rec.tgIsZoneTicket === true,
          // Purchasable lot sizes, NOT a count — reading these as quantity
          // would turn one listing into six phantom seats, which is the
          // mistake every other adapter here carries a comment about.
          splits: Array.isArray(rec.splits)
            ? rec.splits.filter((n) => typeof n === "number").slice(0, 24)
            : [],
        };
      }
    }

    const tickets = Object.keys(byId).map((k) => byId[k]);
    for (const t of tickets) t.level = levelOf[t.tgUserSec] || "";
    if (dupes) {
      console.log(`[OL] ${tickets.length} listing(s), ${dupes} duplicate row(s) ` +
        `dropped — Seatics indexes each section twice`);
    }
    return tickets;
  }

  // Post what was read, but only when it has changed.
  //
  // The listings appear when the ticket view opens and change as the page
  // filters, so this runs more than once; sending an unchanged set would churn
  // storage and reset the merge for nothing.
  let olLastSignature = "";

  function olPushTickets(reason) {
    let tickets;
    try {
      tickets = olCollectTickets();
    } catch (e) {
      console.log("[OL] could not read ticket state: " + (e && e.message));
      return false;
    }
    if (!tickets || !tickets.length) return false;

    const eventId = getOnLocationEventId();
    if (!eventId) {
      console.log("[OL] listings are in the page but the url has no event id");
      return false;
    }

    // Count and total, not the whole set: enough to notice a change without
    // stringifying a few hundred records on every poll.
    let total = 0;
    for (const t of tickets) total += (isFinite(t.tgAllInPrice) ? t.tgAllInPrice : 0);
    const signature = tickets.length + ":" + total;
    if (signature === olLastSignature) return false;
    olLastSignature = signature;

    console.log(`[OL] ${tickets.length} listing(s) read from page state (${reason})`);
    try {
      window.postMessage({
        type: "FIFA_TICKET_SCOUT",
        url: window.location.origin + OL_STATE_PATH,
        body: { eventId: eventId, tickets: tickets },
        eventInfo: getOnLocationEventInfo(),
      }, "*");
    } catch (e) {
      console.log("[OL] could not post the listings: " + (e && e.message));
      return false;
    }
    return true;
  }

  // Two triggers, for the same reason the other adapters have belt and braces.
  //
  // processTickets() is Seatics' own "I have just taken in a ticket set" call,
  // so wrapping it is the exact moment the state becomes readable. But it is
  // only on the object once the framework has loaded, and a build that renames
  // it would go quiet with nothing said — so a slow poll backs it up and
  // catches later changes either way.
  function olWatchTickets() {
    let wrapped = false;
    const tryWrap = () => {
      if (wrapped) return;
      const tc = window.Seatics && window.Seatics.TicketConnector;
      if (!tc || typeof tc.processTickets !== "function") return;
      const original = tc.processTickets;
      tc.processTickets = function () {
        const out = original.apply(this, arguments);
        // After, not before: the state is only populated once it returns.
        try { olPushTickets("processTickets"); } catch (e) { /* never break the page */ }
        return out;
      };
      wrapped = true;
      console.log("[OL] watching Seatics.TicketConnector.processTickets");
    };

    tryWrap();
    setInterval(() => {
      tryWrap();
      olPushTickets("poll");
    }, 4000);
  }

  // Read the ticket state out of the page, on demand.
  //
  // Discovery rounds showed the tickets never arrive over fetch, XHR,
  // WebSocket or JSONP, and are not in the server-rendered html either. The
  // Seatics framework does not fetch them: it reads `Seatics.config.tickets`,
  // which the app fills from its own Redux store. So when the prices are on
  // screen the data IS in the page, and this prints it.
  //
  // Called by hand from the console — __olDump() — because there is no event
  // to hang it on: the state appears whenever the ticket view is opened.
  // window.__fifaEvenueScan() exists for the same reason.
  function olDumpTickets() {
    const tag = "[OL-DUMP]";
    const S = window.Seatics;
    if (!S) {
      console.log(`${tag} window.Seatics is not there — the map has not loaded. ` +
        `Open the ticket/seat view first.`);
      return;
    }

    console.log(`${tag} Seatics keys: ${Object.keys(S).join(",").slice(0, 300)}`);

    // Every array of objects hanging off Seatics, with its path, length and
    // the first record's keys. The ticket list is whichever one carries
    // prices; naming them all beats guessing which property it is this time.
    const found = [];
    const seen = new Set();
    const walk = (v, where, depth) => {
      if (!v || typeof v !== "object" || depth > 5 || found.length > 60) return;
      if (seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v)) {
        const first = v.find((x) => x && typeof x === "object" && !Array.isArray(x));
        if (first) found.push({ where: where, len: v.length, first: first, arr: v });
        v.slice(0, 2).forEach((x, i) => walk(x, where + "[" + i + "]", depth + 1));
        return;
      }
      for (const k of Object.keys(v)) {
        // Base64 map images and svg geometry would bury the output and hold
        // nothing to price.
        if (/^(svgData|venueMapImage|mapImage|mapStatic)$/.test(k)) continue;
        let child;
        try { child = v[k]; } catch (e) { continue; }
        if (typeof child === "function") continue;
        walk(child, where + "." + k, depth + 1);
      }
    };
    try { walk(S, "Seatics", 0); } catch (e) {
      console.log(`${tag} walk failed: ${e && e.message}`);
    }

    if (!found.length) {
      console.log(`${tag} no array of records anywhere under Seatics. If the ` +
        `prices ARE on screen, say so — it means they live somewhere else.`);
      return;
    }

    const PRICEY = /price|amount|cost|total|fee/i;
    const hasPrice = (rec) => Object.keys(rec).some((k) => PRICEY.test(k));
    found.sort((a, b) => b.len - a.len);
    console.log(`${tag} ${found.length} array(s) of records, largest first:`);
    found.slice(0, 20).forEach((f) => {
      const keys = Object.keys(f.first).join(",").slice(0, 220);
      console.log(`${tag}   ${f.len} @ ${f.where} :: ${keys}` +
        (hasPrice(f.first) ? "  <<< HAS A PRICE FIELD" : ""));
    });

    // The most promising one in full: the biggest array carrying a price.
    const best = found.find((f) => hasPrice(f.first)) || found[0];
    console.log(`${tag} --- ${best.where}, ${best.len} record(s) ---`);

    // Every key seen anywhere in the array, not just on the first record: a
    // field that only some listings carry would otherwise go unnoticed.
    const allKeys = new Set();
    for (const r of best.arr) {
      if (r && typeof r === "object") Object.keys(r).forEach((k) => allKeys.add(k));
    }
    console.log(`${tag}   ALL KEYS: ${[...allKeys].join(",").slice(0, 600)}`);

    // What the prices actually span, which is the quickest check that this is
    // the listings and not some lookup table.
    const priceKey = [...allKeys].find((k) => PRICEY.test(k));
    if (priceKey) {
      const nums = best.arr
        .map((r) => Number(r && r[priceKey]))
        .filter((n) => isFinite(n));
      if (nums.length) {
        console.log(`${tag}   ${priceKey}: ${nums.length} value(s), ` +
          `${Math.min.apply(null, nums)} to ${Math.max.apply(null, nums)}`);
      }
    }

    // Three records rather than one: the first, the middle and the last catch
    // a field that is only populated for part of the list.
    const pick = [0, Math.floor(best.arr.length / 2), best.arr.length - 1];
    pick.forEach((idx, n) => {
      const rec = best.arr[idx];
      if (!rec || typeof rec !== "object") return;
      let text;
      try { text = JSON.stringify(olFlatten(rec)); } catch (e) { text = "(failed)"; }
      const label = ["first", "middle", "last"][n];
      for (let i = 0; i < text.length && i < 2400; i += 600) {
        console.log(`${tag}   ${label}[${i}]: ${text.slice(i, i + 600)}`);
      }
    });

    olDumpConnector(tag);
  }

  // The whole inventory, not one section of it.
  //
  // Seatics keys its tickets by section — TicketConnector.SectionsByName[name]
  // .tickets — so the listing count, the price span and whether a flat list
  // exists anywhere are the three things a parser has to be written against.
  function olDumpConnector(tag) {
    const tc = window.Seatics && window.Seatics.TicketConnector;
    if (!tc) {
      console.log(`${tag} no Seatics.TicketConnector`);
      return;
    }
    console.log(`${tag} TicketConnector keys: ${Object.keys(tc).join(",").slice(0, 400)}`);

    // A flat list would be far better to parse than 37 per-section ones, so
    // say outright whether there is one.
    for (const k of Object.keys(tc)) {
      let v;
      try { v = tc[k]; } catch (e) { continue; }
      if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object" &&
          ("tgPrice" in v[0] || "tgID" in v[0])) {
        console.log(`${tag} FLAT LIST: TicketConnector.${k} holds ${v.length} ticket(s)`);
      }
    }

    const byName = tc.SectionsByName;
    if (!byName || typeof byName !== "object") {
      console.log(`${tag} no SectionsByName`);
      return;
    }

    const names = Object.keys(byName);
    let sectionsWithTickets = 0;
    let total = 0;
    const prices = [];
    const allIn = [];
    const perSection = [];
    for (const name of names) {
      let sec;
      try { sec = byName[name]; } catch (e) { continue; }
      const t = sec && sec.tickets;
      if (!Array.isArray(t) || !t.length) continue;
      sectionsWithTickets++;
      total += t.length;
      perSection.push(name + "\u00d7" + t.length);
      for (const rec of t) {
        const p = Number(rec && rec.tgPrice);
        if (isFinite(p)) prices.push(p);
        const a = Number(rec && rec.tgAllInPrice);
        if (isFinite(a)) allIn.push(a);
      }
    }

    const span = (arr) => arr.length
      ? Math.min.apply(null, arr) + " to " + Math.max.apply(null, arr)
      : "(none)";
    console.log(`${tag} ${total} ticket(s) across ${sectionsWithTickets} section(s) ` +
      `of ${names.length} on the map`);
    console.log(`${tag}   tgPrice ${span(prices)} | tgAllInPrice ${span(allIn)}`);
    // tgAllInPrice is what settles pricing without deriving a fee formula —
    // the lesson from AXS, where a fitted formula would have mispriced every
    // seat while looking right. Say plainly whether the page gives it.
    console.log(`${tag}   all-in present on ${allIn.length} of ${total} ticket(s)` +
      (allIn.length === total ? " — no fee maths needed" : " — some rows lack it"));
    console.log(`${tag}   per section: ${perSection.join(" ").slice(0, 700)}`);
  }

  try {
    window.__olDump = olDumpTickets;
  } catch (e) { /* frozen window */ }

  window.__onlocationAdapter = {
    isOnLocationSite,
    getEventId: getOnLocationEventId,
    getEventInfo: getOnLocationEventInfo,
    // The state read and the post, exposed so tests can drive them without
    // waiting on a timer, and so they can be called by hand while debugging a
    // page whose ticket view behaves differently.
    collectTickets: olCollectTickets,
    pushTickets: olPushTickets,
  };

  if (isOnLocationSite()) {
    console.log('[OL] On Location site detected, waiting for page load...');

    let attempts = 0;
    const MAX_ATTEMPTS = 40; // ~20s
    const checkReady = setInterval(() => {
      const eventId = getOnLocationEventId();
      if (eventId) {
        clearInterval(checkReady);
        console.log(`[OL] Event ID found: ${eventId}`);
        console.log(`[OL] Page url: ${window.location.href}`);
        // Said out loud because the inventory is known to arrive on an
        // interaction rather than on load: a quiet probe does not mean the
        // endpoint is missing, it means the ticket view was never opened.
        console.log('[OL] Inventory loads on interaction — open the ticket/seat ' +
          'view and let the prices render, or the probe has nothing to report');
        // Three rounds showed the tickets never cross the network in a form any
        // hook can see, so reading them out of the page is the way in.
        console.log('[OL] With the prices on screen, run __olDump() in this console');
        olWatchTickets();
        window.postMessage({
          type: 'FIFA_TICKET_SCOUT_ADAPTER_READY',
          site: 'onlocation',
          eventId: eventId,
        }, '*');
        return;
      }
      if (++attempts >= MAX_ATTEMPTS) {
        clearInterval(checkReady);
        console.log(`[OL] No event ID resolved — url was: ${window.location.href}`);
      }
    }, 500);
  }

})();
