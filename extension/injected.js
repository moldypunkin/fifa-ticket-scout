// Runs in PAGE context — intercepts fetch/XHR responses
// and relays matching ones back to the content script via postMessage

(function () {
  if (window.__fifaTicketScoutLoaded) return;
  window.__fifaTicketScoutLoaded = true;

  // Stamped by tools/package.py from a hash of the extension's own sources.
  // Three debugging rounds in this project were spent on results produced by a
  // build that had not been reloaded, which is indistinguishable from a change
  // that did not work. Compare this against what package.py prints.
  const BUILD_STAMP = "f0704a95";
  
  // Detect which ticketing site we're on
  const isTicketmaster = window.location.hostname.includes('ticketmaster.com');
  const isFifa = window.location.hostname.includes('tickets.fifa.com');
  const isSeatGeek = window.location.hostname.includes('seatgeek.com');
  const isStubHub = window.location.hostname.includes('stubhub.com');
  const isEvenue = window.location.hostname.includes('evenue.net');
  const isTickPick = window.location.hostname.includes('tickpick.com');
  const isAxs = window.location.hostname.includes('axs.com');

  if (isTicketmaster) {
    console.log("[FIFA Ticket Scout] Running on Ticketmaster (will use adapter) build " + BUILD_STAMP);
  } else if (isFifa) {
    console.log("[FIFA Ticket Scout] Running on FIFA (using FIFA logic) build " + BUILD_STAMP);
  } else if (isSeatGeek) {
    console.log("[FIFA Ticket Scout] Running on SeatGeek (passive capture) build " + BUILD_STAMP);
  } else if (isStubHub) {
    console.log("[FIFA Ticket Scout] Running on StubHub (passive capture) build " + BUILD_STAMP);
  } else if (isEvenue) {
    console.log("[FIFA Ticket Scout] Running on Evenue (passive capture) build " + BUILD_STAMP);
  } else if (isTickPick) {
    console.log("[FIFA Ticket Scout] Running on TickPick (endpoint discovery mode) build " + BUILD_STAMP);
  } else if (isAxs) {
    console.log("[FIFA Ticket Scout] Running on AXS (passive capture, endpoint unconfirmed) build " + BUILD_STAMP);
  } else {
    console.log("[FIFA Ticket Scout] Unknown ticketing site - no action");
    return;
  }

  // For Ticketmaster, only capture requests we explicitly make (during extension scan)
  // NOT the page's own requests - that interferes with inventory display
  // SeatGeek is passive capture: the page fetches its own 880kB inventory on
  // load, so we read that response rather than issuing a request of our own.
  // That keeps us clear of `scrape_uuid`, the Talos anti-tamper layer and
  // DataDome, and avoids having to forge per-session ids like
  // `event_page_view_id` / `sixpack_client_id`.
  // StubHub returns its listings on the event page's OWN path with a query
  // string, so the pattern is the path segment; background.js confirms the
  // body actually carries `items` before parsing.
  const MATCH_PATTERNS = isTicketmaster
    ? []
    : isSeatGeek
      ? ["/api/event_listings_v2"]
      : isStubHub
        ? ["/event/"]
        : isEvenue
          // Any Paciolan API call, not just seat-availability. The exact path
          // was confirmed on one school's instance (Kansas, /event/F26/02) and
          // other schools run different builds — a near-miss like
          // "/pac-api/seat-availability-v2/" would otherwise be invisible.
          // background.js still checks the payload shape before parsing.
          ? ["/pac-api/"]
          : isTickPick
            ? ["/listings/internal/event-v2/"]
            : isAxs
              // Veritix is AXS's ticketing engine, and its start-flow response
              // is the largest JSON the ticket page fetches (611KB on a live
              // T-Mobile Center event) keyed by the same opaque event token as
              // the page url. Note it does NOT contain "/api/", which is why
              // the first broad guess captured only skins and map-viewer
              // tokens and missed the inventory entirely.
              //
              // The 1.2MB map-viewer payload from 3ddvapis.com is deliberately
              // not matched: that is seat-map geometry, not inventory.
              //
              // AXS stays flagged unconfirmed below, so the candidate ranking
              // keeps listing everything the page fetched even now that this
              // matches — narrowing here cannot hide a wrong guess.
              ? ["/veritix/"]
              : ["/seatmap/", "/performance/"];

  // Defense-in-depth: prevent duplicate scans at the page level.
  // injected.js lives as long as the page — survives SW restarts.
  let scanInProgress = false;
  let lastScanPerformanceId = null;
  let lastScanEndTime = 0;
  const SCAN_COOLDOWN_MS = 60000;

  function shouldCapture(url) {
    // For Ticketmaster, never auto-capture page requests
    if (isTicketmaster) return false;
    // FIFA, SeatGeek, StubHub, Evenue and TickPick match on their own patterns.
    return MATCH_PATTERNS.some((p) => url.includes(p));
  }

  // Counted once per response, at the single point each hook decides. Calling
  // this from inside shouldCapture would double-count: the fetch hook asks
  // twice, once for headers and once for the body.
  function countResponse(matched) {
    capStats.seen++;
    if (matched) capStats.matched++;
    scheduleCaptureSummary();
  }

  // ─── Capture diagnostics ─────────────────────────────────────────────────
  // On the passive-capture sites the whole pipeline is silent when it fails:
  // if nothing matches MATCH_PATTERNS nothing is logged, and if a match is not
  // JSON the parse sits in a bare `catch {}`. Both look identical to "the site
  // returned no seats". These counters say which actually happened, and go
  // through console.log so content.js relays them into Download Logs.
  const SITE_TAG = isStubHub ? "SH" : isSeatGeek ? "SG" : isEvenue ? "EV"
    : isTickPick ? "TP" : isAxs ? "AXS" : isTicketmaster ? "TM" : "FIFA";
  const capStats = { seen: 0, matched: 0, parsed: 0, notJson: 0, posted: 0 };
  let capSummaryTimer = null;

  // The summary used to re-arm itself: it fired, cleared its timer, and the
  // next response scheduled another one. Ticket pages poll and beacon
  // continuously, so it repeated every 12 seconds forever — and on an
  // unconfirmed site it reprinted the whole candidate ranking each time.
  //
  // Report twice at most. Once early enough to be useful, then once more only
  // if the page kept loading things worth seeing. Counting continues either
  // way, and each captured response still logs its own line.
  const MAX_SUMMARIES = 2;
  let capSummaryCount = 0;
  let capSummaryMark = "";

  function scheduleCaptureSummary() {
    if (capSummaryTimer || capSummaryCount >= MAX_SUMMARIES) return;
    // Nothing new since the last report means nothing new to say.
    const mark = capStats.seen + ":" + capStats.matched + ":" + candidates.size;
    if (capSummaryCount && mark === capSummaryMark) return;
    capSummaryTimer = setTimeout(() => {
      capSummaryTimer = null;
      capSummaryCount++;
      capSummaryMark = capStats.seen + ":" + capStats.matched + ":" + candidates.size;
      console.log(`[${SITE_TAG}] capture${capSummaryCount >= MAX_SUMMARIES ? " (final)" : ""}: ` +
        `${capStats.seen} responses seen, ` +
        `${capStats.matched} matched ${JSON.stringify(MATCH_PATTERNS)}, ` +
        `${capStats.parsed} parsed as JSON, ${capStats.notJson} not JSON, ` +
        `${capStats.posted} sent to the service worker`);
      if (isTicketmaster) {
        // Ticketmaster is scan-only: MATCH_PATTERNS is deliberately empty and
        // nothing is ever passively captured, so "nothing matched" is the
        // designed behaviour rather than a fault. Saying "the inventory
        // endpoint is not covered" here sent two debugging rounds after a
        // problem that did not exist.
        console.log(`[${SITE_TAG}] passive capture is off on Ticketmaster by design — ` +
          `inventory comes from the scan, not from watching the page.`);
      } else if (capStats.matched === 0) {
        console.log(`[${SITE_TAG}] nothing matched ${JSON.stringify(MATCH_PATTERNS)} — the ` +
          `inventory endpoint is not covered by it.`);
        reportCandidates();
      } else if (isUnconfirmedSite) {
        // Something matched, but nothing here is known to be inventory yet, so
        // the ranking is still the useful output.
        console.log(`[${SITE_TAG}] endpoint not confirmed yet — ranking everything ` +
          `the page fetched, matched or not:`);
        reportCandidates();
      } else if (capStats.posted === 0) {
        console.log(`[${SITE_TAG}] matched but nothing was sent — the response was not ` +
          `JSON, so the endpoint pattern is catching the wrong request.`);
      }
    }, 12000);
  }

  // ─── Candidate endpoints ─────────────────────────────────────────────────
  // When MATCH_PATTERNS catches nothing, the useful question is "then what DID
  // the page fetch?". Recording candidates as they go by answers that on the
  // FIRST run, instead of needing a code edit to set DISCOVERY_SITE and a
  // second reload. Only runs while nothing has matched yet, and only for JSON
  // responses on the passive-capture sites, so the cost disappears the moment
  // capture works.
  const isPassiveSite = isStubHub || isSeatGeek || isEvenue || isTickPick || isAxs;

  // Sites where the inventory endpoint is still unknown. Candidate recording
  // normally stops as soon as MATCH_PATTERNS hits something, which is right
  // once a site works — but on AXS a broad "/api/" matched eight skin, token
  // and cookie-check responses, and that was enough to suppress the report
  // that would have named the real endpoint. While a site is unconfirmed,
  // keep recording regardless of what matched.
  //
  // StubHub is here for a narrower reason: its inventory endpoint IS known and
  // parsed, but it only ever returns the batch the page asked for. The full
  // set of listing ids comes from somewhere that has not been identified yet,
  // so keep ranking every response until it is. Remove once that is settled.
  const isUnconfirmedSite = isAxs || isStubHub;
  const MAX_CANDIDATES = 60;
  const CANDIDATE_MIN_CHARS = 2000;
  const candidates = new Map();   // path -> largest byte length seen

  function recordCandidate(url, response) {
    // Ticketmaster never passively captures — it is scan-only — but on an event
    // where Ticketmaster is the RESELLER rather than the primary seller, the
    // ISMDS facets endpoint 404s and the inventory lives somewhere else
    // entirely (the TMOL/VVS resale system). Recording candidates there costs
    // one clone per response and is the only way to see where.
    if (!isPassiveSite && !isTicketmaster) return;
    if (capStats.matched > 0 && !isUnconfirmedSite) return;
    if (candidates.size >= MAX_CANDIDATES) return;
    const clean = String(url).split("?")[0];
    if (PROBE_SKIP.test(clean)) return;
    // The Ticketmaster facets response is the known-good inventory endpoint and
    // runs to well over a megabyte. Ranking it means cloning and reading all of
    // it on every scan to learn something already known, so skip it: the point
    // of the ranking here is to find where inventory hides when facets fails.
    if (isTicketmaster && /\/facets/.test(clean)) return;
    // Content type is recorded, not required. Evenue (Paciolan) is a legacy CGI
    // platform whose inventory can arrive as server-rendered HTML, so a
    // JSON-only filter would go blind on exactly the site most likely to need
    // this. PROBE_SKIP already drops images, fonts and tiles.
    const type = ((response.headers && response.headers.get("content-type")) || "")
      .split(";")[0].trim() || "unknown";
    response.clone().text().then((t) => {
      if (!t || t.length < CANDIDATE_MIN_CHARS) return;
      const prev = candidates.get(clean);
      if (!prev || t.length > prev.len) candidates.set(clean, { len: t.length, type: type });
    }).catch(() => {});
  }

  function reportCandidates() {
    if (!candidates.size) {
      console.log(`[${SITE_TAG}] no responses over ${CANDIDATE_MIN_CHARS} chars were seen ` +
        `either — the page may be serving from cache, or the seat map may load ` +
        `only after you interact with it. Try a hard reload, then open the map.`);
      return;
    }
    const ranked = [...candidates.entries()].sort((a, b) => b[1].len - a[1].len).slice(0, 10);
    console.log(`[${SITE_TAG}] largest responses the page fetched (candidate endpoints):`);
    ranked.forEach(([path, info], i) => {
      console.log(`[${SITE_TAG}]   ${i + 1}. ${Math.round(info.len / 1024)}KB  ${info.type}  ${path}`);
    });
  }

  // One line per matched response, with the body's top-level shape. That shape
  // is what background.js routes on (StubHub needs `items`, TickPick and
  // SeatGeek need `listings`), so a mismatch is visible here.
  function noteCapture(url, body, ok) {
    const short = String(url).split("?")[0].slice(-90);
    if (!ok) {
      capStats.notJson++;
      console.log(`[${SITE_TAG}] matched but not JSON: ${short}`);
      return;
    }
    capStats.parsed++;
    let shape = typeof body;
    if (Array.isArray(body)) {
      shape = `array(${body.length})`;
    } else if (body && typeof body === "object") {
      const keys = Object.keys(body);
      shape = `{${keys.slice(0, 8).join(",")}${keys.length > 8 ? ",…" : ""}}`;
    }
    capStats.posted++;
    console.log(`[${SITE_TAG}] captured ${short} -> ${shape}`);
  }

  // ─── Endpoint discovery (TEMPORARY, per new site) ────────────────────────
  // Reports any JSON response big enough to be an inventory payload, from
  // document_start — earlier than a console paste can hook, which is the only
  // reason SeatGeek's endpoint was findable at all.
  //
  // Set to a short site tag ("EV", "SH", "SG", …) to hunt a new site's
  // inventory endpoint; null once that site is parsed.
  const DISCOVERY_SITE = null;
  const PROBE_MIN_CHARS = 2000;
  const PROBE_SKIP = /google|doubleclick|datadog|forter|riskified|openai|reddit|yimg|adsrvr|boomtrain|iteratehq|datadome|newrelic|segment|branch\.io|qualtrics|vggcdn|cloudfront|akamai|cookielaw|onetrust|\.geojson|map-sprites|svgnew|sprite|mapbox|\.png|\.jpg|\.svg|\.woff|\.pbf|\.css|field_images|\/glyphs\//i;
  // path -> largest payload already reported for it. StubHub reuses ONE path
  // for both the full inventory and small filtered queries (the query string
  // carries sections/rows/quantity), so deduping on the bare path hides the
  // big response behind whichever small one happened to fire first.
  const probeBest = new Map();

  // Silence is ambiguous — it can mean "no request happened" or "the probe
  // threw and the caller's .catch swallowed it". Count every outcome and
  // report once, so a quiet run still says why.
  const probeStats = { seen: 0, small: 0, skipped: 0, nonJson: 0, dup: 0, reported: 0, errors: 0, htmlReported: 0 };
  let probeSummaryTimer = null;

  function probeSummary() {
    const t = `[${DISCOVERY_SITE}-PROBE]`;
    console.log(`${t} summary: ${probeStats.seen} responses seen, ${probeStats.reported} reported ` +
      `(skipped: ${probeStats.small} too small, ${probeStats.skipped} filtered, ` +
      `${probeStats.nonJson} not JSON, ${probeStats.dup} duplicate, ${probeStats.errors} errored)` +
      (probeStats.htmlReported ? ` [${probeStats.htmlReported} large non-JSON named above]` : ""));
    if (probeStats.seen === 0) {
      console.log(`${t} no responses reached the probe at all — the page may be serving from cache; try a hard reload`);
    }
  }

  function probeResponse(url, text) {
    if (!DISCOVERY_SITE || !url || typeof text !== "string") return;
    probeStats.seen++;
    if (!probeSummaryTimer) probeSummaryTimer = setTimeout(probeSummary, 12000);
    try {
      probeResponseInner(url, text);
    } catch (e) {
      probeStats.errors++;
      // Never silent: the fetch hook's .catch would otherwise hide this.
      console.log(`[${DISCOVERY_SITE}-PROBE] ERROR on ${String(url).slice(0, 120)}: ${e && e.message}`);
    }
  }

  function probeResponseInner(url, text) {
    if (text.length < PROBE_MIN_CHARS) { probeStats.small++; return; }
    if (PROBE_SKIP.test(url)) { probeStats.skipped++; return; }

    const head = text.slice(0, 200).trim();
    if (!head.startsWith("{") && !head.startsWith("[")) {
      probeStats.nonJson++;
      // Evenue (Paciolan) is server-rendered, so its inventory may well be
      // HTML. Name the biggest few so a non-JSON payload is not invisible.
      if (text.length > 20000 && probeStats.htmlReported < 5) {
        probeStats.htmlReported++;
        const key = String(url).split("?")[0];
        if (!probeBest.has("html:" + key)) {
          probeBest.set("html:" + key, text.length);
          console.log(`[${DISCOVERY_SITE}-PROBE] non-JSON ${(text.length / 1024).toFixed(1)}kB ${toAbsoluteUrl(url)}`);
          console.log(`[${DISCOVERY_SITE}-PROBE]   starts: ${head.slice(0, 120).replace(/\s+/g, " ")}`);
          // Tables are how a CGI site lists tickets.
          const tables = (text.match(/<table/gi) || []).length;
          const rows = (text.match(/<tr[\s>]/gi) || []).length;
          console.log(`[${DISCOVERY_SITE}-PROBE]   html: ${tables} tables, ${rows} rows`);
        }
      }
      return;
    }

    // One line per endpoint, not per call — these pages refetch on filtering.
    // But re-report when a substantially larger payload arrives on the same
    // path: that is the full inventory arriving after a filtered query.
    const key = String(url).split("?")[0];
    const prev = probeBest.get(key) || 0;
    if (prev && text.length < prev * 2) { probeStats.dup++; return; }
    probeBest.set(key, Math.max(prev, text.length));
    probeStats.reported++;
    if (prev) {
      console.log(`[${DISCOVERY_SITE}-PROBE] (same path, ` +
        `${(text.length / 1024).toFixed(1)}kB vs ${(prev / 1024).toFixed(1)}kB before — larger, reporting)`);
    }

    const tag = `[${DISCOVERY_SITE}-PROBE]`;
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) {}

    const shape = !parsed ? "(unparsed)"
      : Array.isArray(parsed)
        ? `array[${parsed.length}] of ${Object.keys(parsed[0] || {}).slice(0, 12).join(",")}`
        : Object.keys(parsed).slice(0, 18).join(",");

    const abs = toAbsoluteUrl(url);
    console.log(`${tag} ${(text.length / 1024).toFixed(1)}kB ${abs.split("?")[0]}`);
    const query = abs.split("?")[1];
    // Chopped into chunks the console will not elide mid-line.
    if (query) {
      for (let i = 0; i < query.length; i += 160) {
        console.log(`${tag}   q[${i}]: ${query.slice(i, i + 160)}`);
      }
    }
    console.log(`${tag}   keys: ${shape.slice(0, 300)}`);

    // Dump every parsed JSON payload. An earlier version gated this on
    // key names looking like inventory, which silently skipped Evenue's
    // 2.3MB seat-availability response — it encodes seats POSITIONALLY
    // (arrays of arrays), so no "price"/"section" key ever appears.
    // PROBE_SKIP, the size floor and the dedupe keep the volume sane, and
    // dumpShape caps its own output.
    if (parsed) dumpShape(parsed, tag);
  }

  function dumpShape(parsed, tag) {
    const arrays = [];
    (function walk(node, path, depth) {
      if (!node || typeof node !== "object" || depth > 6) return;
      if (Array.isArray(node)) {
        const first = node.find((v) => v && typeof v === "object");
        arrays.push({
          path: path || "(root)",
          count: node.length,
          keys: first ? Object.keys(first) : [],
          sample: first || null,
          parent: node,
        });
        if (first) walk(first, `${path}[0]`, depth + 1);
        return;
      }
      for (const k of Object.keys(node)) walk(node[k], path ? `${path}.${k}` : k, depth + 1);
    })(parsed, "", 0);

    arrays.sort((a, b) => b.count - a.count);
    console.log(`${tag}   --- ${arrays.length} arrays, largest first ---`);
    for (const a of arrays.slice(0, 10)) {
      console.log(`${tag}   ${a.count} @ ${a.path} :: ${a.keys.slice(0, 22).join(",")}`);
    }

    // The inventory array is not always the biggest — StubHub's `items` (the
    // listings) is smaller than `sellerListingNotes`. Score on element key
    // names instead and sample the best match.
    const score = (a) => {
      const k = a.keys.join(",").toLowerCase();
      let n = 0;
      if (/section/.test(k)) n += 2;
      if (/row|row[A-Z_]|rowid/i.test(a.keys.join(" "))) n += 2;
      if (/seat/.test(k)) n += 1;
      if (/price|amount|fee|cost/.test(k)) n += 3;
      if (/quantity|qty|availabletickets/.test(k)) n += 2;
      return n;
    };
    const ranked = arrays.filter((a) => a.sample).sort((a, b) => score(b) - score(a) || b.count - a.count);

    // Sample the top few arrays. Scoring alone is not enough: Evenue encodes
    // seats POSITIONALLY, so its 49k-row array has keys "0","1","2"… and
    // always scores 0. Print samples regardless, largest first, or the one
    // payload we actually want stays invisible.
    const picks = ranked.slice(0, 3);
    if (!picks.length) {
      console.log(`${tag}   (no arrays with sampleable elements)`);
      return;
    }

    for (const pick of picks) {
      const scored = score(pick);
      console.log(`${tag}   CANDIDATE ${pick.path} (${pick.count} items, score ${scored})`);
      if (pick.keys.length) console.log(`${tag}   ALL KEYS: ${pick.keys.join(",").slice(0, 600)}`);

      // A positional row tells you nothing on its own — you need several to
      // infer what each column means. Print three.
      if (Array.isArray(pick.sample)) {
        console.log(`${tag}   POSITIONAL, ${pick.sample.length} columns; first 3 rows:`);
        const parent = pick.parent || [];
        for (let r = 0; r < Math.min(3, parent.length); r++) {
          console.log(`${tag}   r${r}: ${JSON.stringify(parent[r]).slice(0, 400)}`);
        }
      } else {
        // Sample first / middle / last, not just [0]. Feeds are commonly
        // grouped, so element 0 is often unrepresentative — TickPick sorts
        // parking passes ahead of tickets, and a single sample there would
        // have described the wrong kind of row entirely.
        const parent = pick.parent || [];
        const objs = parent.filter((v) => v && typeof v === "object");
        const picks = [];
        const want = [0, Math.floor(objs.length / 2), objs.length - 1];
        for (const i of want) {
          if (objs[i] !== undefined && !picks.includes(objs[i])) picks.push(objs[i]);
        }
        picks.forEach((obj, n) => {
          const json = JSON.stringify(obj);
          const label = n === 0 ? "first" : n === picks.length - 1 ? "last" : "middle";
          for (let i = 0; i < Math.min(json.length, 1000); i += 500) {
            console.log(`${tag}   ${label}[${i}]: ${json.slice(i, i + 500)}`);
          }
        });
      }
    }
  }

  // Pages may call fetch/XHR with a relative URL — SeatGeek requests
  // "/api/event_listings_v2?…" that way. Everything downstream (siteFromUrl,
  // extractParam) builds a `new URL()`, which throws on a relative string and
  // silently drops the capture, so resolve before posting. Absolute URLs pass
  // through unchanged.
  function toAbsoluteUrl(u) {
    try {
      return new URL(String(u), window.location.href).href;
    } catch (e) {
      return String(u);
    }
  }

  // SeatGeek and StubHub inventory responses carry no event name/date, so
  // attach what the adapter reads off the page. Undefined elsewhere: the FIFA
  // paths get match info from their own API, and Ticketmaster attaches it at
  // scan time.
  function pageEventInfo() {
    try {
      const adapter = isSeatGeek ? window.__seatgeekAdapter
        : isStubHub ? window.__stubhubAdapter
        : isEvenue ? window.__evenueAdapter
        : isTickPick ? window.__tickpickAdapter
        : isAxs ? window.__axsAdapter
        : null;
      return adapter ? adapter.getEventInfo() : undefined;
    } catch (e) {
      return undefined;
    }
  }

  // Capture headers from real requests so the scan can reuse them
  let capturedHeaders = null;

  // The whole request behind the first inventory response: method, url and
  // body. StubHub sends its filters in a POST body rather than the query
  // string — the response echoes `quantity`, `sections` and `sectionIds` back —
  // so broadening by editing query parameters alone can never work there.
  let capturedRequest = null;

  function rememberRequest(url, method, body) {
    if (capturedRequest) return;
    if (typeof body !== "string" || !body) return;
    capturedRequest = { url: String(url), method: String(method || "GET").toUpperCase(), body };
  }

  // ─── Pull the rest of the inventory ──────────────────────────────────────
  // Some sites answer their first inventory request with a FILTERED subset —
  // StubHub's query string carries sections, rows and quantity — so a single
  // capture is a slice of the event. Everything still arrives eventually,
  // because background.js merges each capture into the stored seats, but only
  // as fast as someone clicks around the page, which is far too slow to be
  // useful.
  //
  // So after the page's own request lands, re-issue it broadened. This runs in
  // the page's own context: same origin, same cookies, and the headers the page
  // itself sent, so it is the page's request repeated rather than a forged one.
  // That matters — these endpoints sit behind Talos and DataDome, which is why
  // the adapters never built a request from scratch.
  //
  // Only sites that actually need it are listed. SeatGeek returns the full set
  // on its first request, so it is deliberately absent: extra requests to a
  // bot-protected endpoint for no gain is a bad trade.
  const FOLLOW_UP_SITES = {
    stubhub: {
      tag: "SH",
      listingsKey: "items",
      // Observed live. The request is:
      //   POST /<slug>/event/<id>/?quantity=2
      //   {Method, EventId, Quantity, EstimatedFees, InstantDelivery, ListingIds}
      //
      // It is not "give me the inventory" — it is "give me details for THESE
      // listing ids". The page holds all 591 and asks for ten at a time as you
      // scroll, which is why clicking around slowly fills the dashboard.
      //
      // So the thing to remove is ListingIds, in the hope the endpoint answers
      // with everything when not asked for a specific set. Quantity is NOT
      // removed: doing that returned zero listings. Variants are tried in
      // order and the first that returns more than the page got wins.
      bodyVariants: [
        { drop: ["listingids"], label: "without ListingIds" },
        { drop: ["listingids", "quantity"], label: "without ListingIds or Quantity" },
        { drop: ["listingids"], set: { Quantity: 0 }, label: "without ListingIds, Quantity=0" },
      ],
      // Editing the query string is pointless here and actively harmful:
      // dropping `quantity` from it returns an HTML page, not JSON.
      queryStrategies: false,
      dropParams: [],
      sizeParams: [],
      indexParams: [],
    },
  };

  const FOLLOW_UP_MAX_PAGES = 10;
  // 30 batches of ten covers ~300 listings beyond the first page. Bounded so a
  // huge event cannot turn into hundreds of requests at a protected endpoint.
  const FOLLOW_UP_MAX_BATCHES = 40;
  // Ids per request. Larger than the ten the page uses, because the endpoint
  // takes a list and fewer round trips is both faster and gentler.
  const FOLLOW_UP_BATCH_SIZE = 25;
  const FOLLOW_UP_WIDE_PAGE = 1000;
  let followUpDone = false;

  function followUpConfig() {
    return isStubHub ? FOLLOW_UP_SITES.stubhub : null;
  }

  // The biggest number under a total-looking key, at any depth. Sites move this
  // between response versions, so match on the key name rather than a fixed
  // path — but never on `per_page`, `page_size` or `total_pages`, which look
  // like totals and are not counts of listings.
  function inventoryTotal(node, depth) {
    if (!node || typeof node !== "object" || (depth || 0) > 4) return null;
    let best = null;
    Object.keys(node).forEach((key) => {
      const value = node[key];
      if (typeof value === "number" && value > 0 && /total|count/i.test(key)
          && !/page|per|size/i.test(key)) {
        if (best == null || value > best) best = value;
      } else if (value && typeof value === "object") {
        const inner = inventoryTotal(value, (depth || 0) + 1);
        if (inner != null && (best == null || inner > best)) best = inner;
      }
    });
    return best;
  }

  function postInventory(url, body) {
    window.postMessage(
      { type: "FIFA_TICKET_SCOUT", url: toAbsoluteUrl(url), body, eventInfo: pageEventInfo() },
      "*"
    );
  }

  async function fetchInventory(url) {
    // `originalFetch` is declared further down, with the fetch patch. That is
    // fine because nothing here runs at load time — the first call comes from
    // inside the hook, long after. Do not call this during setup.
    //
    // Same headers the page used, so this is indistinguishable from its own
    // request. `capturedHeaders` is filled by the hooks below on first sight.
    const init = { credentials: "include" };
    if (capturedHeaders) init.headers = capturedHeaders;
    const response = await originalFetch.call(window, url, init);
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response.json();
  }

  // Every listing id anywhere in a response.
  //
  // StubHub's detail endpoint answers only for the ids it is given, and
  // re-posting without ListingIds returns nothing — so the way to get the rest
  // is to find the ids and ask for them. Hovering a section makes the page
  // request that section's listings, which means the page already holds every
  // id; the response that seeds it should carry them too.
  //
  // Matched on key name rather than a fixed path, since the ids may sit under
  // ListingIds, or as `id` on objects inside a listings/sections array.
  function harvestListingIds(node, out, depth) {
    if (!node || typeof node !== "object" || (depth || 0) > 6) return;
    if (Array.isArray(node)) {
      node.forEach((n) => harvestListingIds(n, out, (depth || 0) + 1));
      return;
    }
    Object.keys(node).forEach((key) => {
      const value = node[key];
      if (/^listing_?ids?$/i.test(key)) {
        const list = Array.isArray(value) ? value : [value];
        list.forEach((v) => {
          if (v != null && (typeof v === "number" || typeof v === "string")) out.add(String(v));
        });
        return;
      }
      // An array of listing-shaped objects: take their ids.
      if (Array.isArray(value) && /listing/i.test(key)) {
        value.forEach((entry) => {
          const id = idOf(entry);
          if (id != null) out.add(String(id));
        });
      }
      harvestListingIds(value, out, (depth || 0) + 1);
    });
  }

  // Page-side shape describer. background.js has its own; this one exists so a
  // rejected batch can name what came back instead of failing silently.
  function describeShapeLite(value, depth) {
    if (value === null) return "null";
    if (Array.isArray(value)) {
      return `array(${value.length}` +
        (value.length && depth > 0 ? " of " + describeShapeLite(value[0], depth - 1) : "") + ")";
    }
    if (typeof value === "object") {
      const keys = Object.keys(value);
      const shown = keys.slice(0, 8);
      if (depth <= 0) return `{${shown.join(",")}${keys.length > 8 ? ",…" : ""}}`;
      return `{${shown.map((k) => `${k}:${describeShapeLite(value[k], depth - 1)}`).join(",")}` +
        `${keys.length > 8 ? ",…" : ""}}`;
    }
    if (typeof value === "string") return value.length > 40 ? "string" : JSON.stringify(value);
    return typeof value;
  }


  function listingsOf(body, key) {
    // StubHub answers the page's own request with {items:[...]} but answers a
    // ListingIds request with a BARE ARRAY of the same listing objects. Reading
    // only `items` made a working batch look like an empty one, which is what
    // stopped the sweep on its first pass.
    if (Array.isArray(body)) return body;
    const list = body && body[key];
    return Array.isArray(list) ? list : null;
  }

  function idOf(listing) {
    if (!listing || typeof listing !== "object") return null;
    return listing.id != null ? listing.id
      : listing.listingId != null ? listing.listingId
      : null;
  }

  async function maybeFollowUp(rawUrl, body) {
    const config = followUpConfig();
    if (!config || followUpDone) return;
    const first = listingsOf(body, config.listingsKey);
    if (!first || !first.length) return;

    const tag = config.tag;
    let url;
    try {
      url = new URL(toAbsoluteUrl(rawUrl));
    } catch (e) {
      console.log(`[${tag}] follow-up: could not parse the request url — skipping`);
      followUpDone = true;
      return;
    }
    // Set only once the request is understood. Setting it earlier meant an
    // early return disabled follow-up for the whole page with nothing logged,
    // which is indistinguishable from the code never running at all.
    followUpDone = true;

    const have = first.length;
    const total = inventoryTotal(body, 0);
    const params = [...url.searchParams.keys()];

    // The request is what has to be broadened, so describe it fully: the query
    // string, the method, and the body's field names. noteCapture() strips the
    // query for brevity, which hid exactly this.
    let requestBody = null;
    if (capturedRequest && capturedRequest.method !== "GET") {
      try { requestBody = JSON.parse(capturedRequest.body); } catch (e) { requestBody = null; }
    }
    const bodyKeys = requestBody && typeof requestBody === "object" && !Array.isArray(requestBody)
      ? Object.keys(requestBody) : null;

    console.log(`[${tag}] inventory: ${have} in this response` +
      (total != null ? `, ${total} reported for the event` : ", no total reported"));
    console.log(`[${tag}] request: ${capturedRequest ? capturedRequest.method : "GET"} ` +
      `${url.pathname}${url.search || " (no query)"}` +
      (bodyKeys ? ` | body fields: ${bodyKeys.join(", ")}` : "") +
      (capturedRequest && !bodyKeys && capturedRequest.method !== "GET"
        ? ` | body is not JSON: ${capturedRequest.body.slice(0, 120)}` : ""));

    if (total != null && have >= total) {
      console.log(`[${tag}] first response already holds everything — no follow-up needed`);
      return;
    }

    const seen = new Set();
    first.forEach((l) => { const id = idOf(l); if (id != null) seen.add(id); });

    const send = (href, page) => {
      const list = listingsOf(page, config.listingsKey) || [];
      const fresh = list.filter((l) => { const id = idOf(l); return id == null || !seen.has(id); });
      fresh.forEach((l) => { const id = idOf(l); if (id != null) seen.add(id); });
      if (fresh.length) postInventory(href, page);
      return fresh.length;
    };

    let added = 0;
    try {
      // 0a. Ask for the ids the page already knows about.
      //
      //     This is what hovering a section does by hand: the page requests
      //     that section's listings and they appear in the dashboard. Doing it
      //     in batches gets the whole event without the clicking.
      const idField = bodyKeys && bodyKeys.find((k) => /^listing_?ids?$/i.test(k));
      if (idField && capturedRequest) {
        const known = new Set();
        harvestListingIds(body, known, 0);
        // The ids the page just asked for are already captured.
        (Array.isArray(requestBody[idField]) ? requestBody[idField] : [])
          .forEach((id) => known.delete(String(id)));

        const wanted = [...known].filter((id) => !seen.has(id) && !seen.has(Number(id)));
        if (wanted.length) {
          // The page asks ten at a time, but the endpoint takes a list, so ask
          // for more per request: 351 ids is 36 round trips at ten and 15 at
          // twenty-five. Fewer requests is also gentler on a protected
          // endpoint. If the larger size turns out to be rejected, the retry
          // below falls back to exactly what the page itself uses.
          const pageSize = (Array.isArray(requestBody[idField]) ? requestBody[idField].length : 0) || 10;
          let batchSize = Math.max(pageSize, FOLLOW_UP_BATCH_SIZE);
          console.log(`[${tag}] harvested ${wanted.length} more listing id(s) from the ` +
            `response — sweeping in batches of ${batchSize}, adding any further ids ` +
            `each response turns up`);

          // A queue rather than a fixed list of batches: every response carries
          // listing ids of its own, so ids discovered along the way are added
          // and swept too. That is what reaches listings in sections the page
          // itself never requested — the first response alone only held 280 of
          // an event's 534.
          const queue = wanted.slice();
          const requested = new Set();
          let emptyBatches = 0;
          let batchNo = 0;
          let firstBatch = true;

          while (queue.length && batchNo < FOLLOW_UP_MAX_BATCHES) {
            const batch = queue.splice(0, batchSize);
            batch.forEach((id) => requested.add(id));
            batchNo++;

            const batchBody = {};
            bodyKeys.forEach((k) => { batchBody[k] = requestBody[k]; });
            batchBody[idField] = batch;
            const init = {
              method: capturedRequest.method,
              credentials: "include",
              body: JSON.stringify(batchBody),
            };
            if (capturedHeaders) init.headers = capturedHeaders;

            let page;
            try {
              const response = await originalFetch.call(window, capturedRequest.url, init);
              if (!response.ok) throw new Error("HTTP " + response.status);
              page = await response.json();
            } catch (err) {
              console.log(`[${tag}] batch ${batchNo} failed: ${err && err.message} — stopping`);
              break;
            }

            const got = (listingsOf(page, config.listingsKey) || []).length;
            const fresh = send(capturedRequest.url, page);
            added += fresh;

            if (!got) {
              if (firstBatch && batchSize > pageSize) {
                // The larger batch may simply be more than the endpoint takes.
                // Retry once at exactly the size the page itself uses before
                // concluding anything.
                console.log(`[${tag}] batch 1 empty at ${batchSize} ids ` +
                  `(response ${describeShapeLite(page, 2)}) — retrying at the ` +
                  `page's own size of ${pageSize}`);
                batch.forEach((id) => { requested.delete(id); queue.unshift(id); });
                batchSize = pageSize;
                batchNo = 0;
                firstBatch = false;
                continue;
              }
              console.log(`[${tag}] batch ${batchNo} returned no listings — ` +
                `response was ${describeShapeLite(page, 3)}. Stopping.`);
              break;
            }
            firstBatch = false;

            // Ids this response knows about that nothing has asked for yet.
            const discovered = new Set();
            harvestListingIds(page, discovered, 0);
            let queued = 0;
            discovered.forEach((id) => {
              if (requested.has(id) || seen.has(id) || seen.has(Number(id))) return;
              if (queue.indexOf(id) >= 0) return;
              queue.push(id);
              queued++;
            });
            if (queued) {
              console.log(`[${tag}] batch ${batchNo}: +${fresh} listing(s), ` +
                `${queued} new id(s) discovered (${queue.length} still queued)`);
            }

            if (!fresh) {
              // Real listings, all already captured. Not a failure, and not a
              // reason to abandon the queue.
              if (++emptyBatches >= 3) {
                console.log(`[${tag}] three batches in a row were all duplicates — stopping`);
                break;
              }
              continue;
            }
            emptyBatches = 0;
          }

          if (queue.length) {
            console.log(`[${tag}] stopped with ${queue.length} id(s) still queued ` +
              `(cap is ${FOLLOW_UP_MAX_BATCHES} batches)`);
          }

          console.log(`[${tag}] batches added ${added} listing(s)`);
          if (added) return;
        } else {
          console.log(`[${tag}] the response carries no listing ids beyond the ` +
            `${have} already captured — the full set is held by the page itself, ` +
            `not in this response`);
        }
      }

      // 0b. Broaden the request BODY. Try each variant until one returns more
      //     than the page itself got; stop at the first that does.
      if (bodyKeys && config.bodyVariants) {
        for (let v = 0; v < config.bodyVariants.length; v++) {
          const variant = config.bodyVariants[v];
          const wideBody = {};
          const removed = [];
          bodyKeys.forEach((key) => {
            if (variant.drop.indexOf(key.toLowerCase()) >= 0) { removed.push(key); return; }
            wideBody[key] = requestBody[key];
          });
          if (variant.set) Object.keys(variant.set).forEach((k) => { wideBody[k] = variant.set[k]; });
          if (!removed.length) continue;

          const init = {
            method: capturedRequest.method,
            credentials: "include",
            body: JSON.stringify(wideBody),
          };
          if (capturedHeaders) init.headers = capturedHeaders;

          let page;
          try {
            const response = await originalFetch.call(window, capturedRequest.url, init);
            if (!response.ok) throw new Error("HTTP " + response.status);
            page = await response.json();
          } catch (err) {
            console.log(`[${tag}] ${variant.label}: ${err && err.message}`);
            continue;
          }

          const got = (listingsOf(page, config.listingsKey) || []).length;
          const fresh = send(capturedRequest.url, page);
          added += fresh;
          console.log(`[${tag}] ${variant.label}: ${got} listing(s), ${fresh} new`);
          if (fresh > 0) break;
        }

        if (added) {
          console.log(`[${tag}] follow-up added ${added} listing(s) beyond the ${have} ` +
            `the page fetched itself`);
        } else {
          console.log(`[${tag}] no variant returned more than the page's own request. ` +
            `The full set (${total != null ? total : "unknown"}) is held by the page and ` +
            `requested in batches, so it will still fill in as you scroll.`);
        }
        if (added || !config.queryStrategies) return;
      }

      // 1. Drop the filters from the query string, for sites that put them there.
      if (!config.queryStrategies) return;
      const dropped = params.filter((k) => config.dropParams.indexOf(k.toLowerCase()) >= 0);
      if (dropped.length) {
        const wide = new URL(url.href);
        dropped.forEach((k) => wide.searchParams.delete(k));
        const page = await fetchInventory(wide.href);
        added += send(wide.href, page);
        console.log(`[${tag}] refetched without ${dropped.join(", ")}: ` +
          `${(listingsOf(page, config.listingsKey) || []).length} listing(s), ` +
          `${added} new`);
        if (total != null && have + added >= total) {
          console.log(`[${tag}] follow-up added ${added} listing(s)`);
          return;
        }
      }

      // 2. Widen the page size, if the request carries one.
      const sizeParam = params.find((k) => config.sizeParams.indexOf(k.toLowerCase()) >= 0);
      if (sizeParam) {
        const wide = new URL(url.href);
        config.dropParams.forEach((k) => wide.searchParams.delete(k));
        wide.searchParams.set(sizeParam, String(FOLLOW_UP_WIDE_PAGE));
        const page = await fetchInventory(wide.href);
        added += send(wide.href, page);
        console.log(`[${tag}] refetched with ${sizeParam}=${FOLLOW_UP_WIDE_PAGE}: ${added} new so far`);
        if (total != null && have + added >= total) {
          console.log(`[${tag}] follow-up added ${added} listing(s)`);
          return;
        }
      }

      // 3. Walk pages until one adds nothing.
      const indexParam = params.find((k) => config.indexParams.indexOf(k.toLowerCase()) >= 0);
      if (indexParam) {
        const isOffset = /offset|start/i.test(indexParam);
        for (let i = 1; i <= FOLLOW_UP_MAX_PAGES; i++) {
          const next = new URL(url.href);
          config.dropParams.forEach((k) => next.searchParams.delete(k));
          next.searchParams.set(indexParam, String(isOffset ? have * (i + 1) : i + 1));
          const page = await fetchInventory(next.href);
          const fresh = send(next.href, page);
          if (!fresh) break;
          added += fresh;
          if (total != null && have + added >= total) break;
        }
      }

      if (!dropped.length && !sizeParam && !indexParam && !bodyKeys) {
        console.log(`[${tag}] no filter or paging parameter recognised ` +
          `(saw: ${params.join(", ") || "none"}), so the rest cannot be requested. ` +
          `Listings will still fill in as the page loads them.`);
        return;
      }

      console.log(`[${tag}] follow-up added ${added} listing(s) beyond the ${have} ` +
        `the page fetched itself`);
    } catch (e) {
      // Never break the page, and never retry into a rate limit.
      console.log(`[${tag}] follow-up stopped: ${e && e.message}. ` +
        "Listings will still fill in as the page loads them.");
    }
  }


  // Mirror our own console output to the extension's log buffer.
  //
  // This file runs in the MAIN world, where `chrome.*` does not exist — so we
  // relay each line to content.js (isolated world) via postMessage and let it
  // do the storage write.
  //
  // Two constraints shape this:
  //   1. Only forward lines carrying one of our own prefixes. Patching
  //      console.log catches the host page's logging too, and Ticketmaster is
  //      chatty enough to blow out the buffer in seconds.
  //   2. Guard re-entrancy. Our postMessage is observed by the listener below,
  //      and anything that logs while handling a message would loop forever.
  const LOG_PREFIXES = ["[FIFA Ticket Scout]", "[FIFA]", "[TM]", "[SG]", "[SH]", "[EV]", "[TP]", "[AXS]", "[TP-PROBE]", "[EV-PROBE]", "[SH-PROBE]", "[SG-PROBE]", "[TM-PROBE]", "[AXS-PROBE]"];
  const originalLog = console.log;
  let relayingLog = false;
  console.log = function (...args) {
    originalLog.apply(console, args);
    if (relayingLog) return;

    const msg = args.map((a) => {
      if (typeof a === "object" && a !== null) {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    }).join(" ");

    if (!LOG_PREFIXES.some((p) => msg.startsWith(p))) return;

    relayingLog = true;
    try {
      window.postMessage({
        type: "FIFA_TICKET_SCOUT_LOG",
        line: `[${new Date().toISOString()}] ${msg}`,
      }, "*");
    } finally {
      relayingLog = false;
    }
  };

  // Patch fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";

    const willCapture = shouldCapture(url);

    if (willCapture) {
      const init = args[1] || {};
      rememberRequest(toAbsoluteUrl(url), init.method || "GET", init.body);
    }

    // Capture headers from any seatmap request the page makes
    if (willCapture && !capturedHeaders) {
      const init = args[1] || {};
      if (init.headers) {
        capturedHeaders = init.headers instanceof Headers
          ? Object.fromEntries(init.headers.entries())
          : { ...init.headers };
        console.log("[FIFA Ticket Scout] Captured request headers");
      }
    }

    const response = await originalFetch.apply(this, args);

    if (DISCOVERY_SITE) {
      // Read off a clone so the page's own consumer is untouched.
      response.clone().text().then((t) => probeResponse(url, t)).catch((e) => {
        console.log(`[${DISCOVERY_SITE}-PROBE] could not read ${String(url).slice(0, 100)}: ${e && e.message}`);
      });
    }

    countResponse(willCapture);
    // On an unconfirmed site everything is a candidate, including the
    // responses that did match — the match means nothing until a parser exists.
    if (!willCapture || isUnconfirmedSite || isTicketmaster) recordCandidate(url, response);

    if (willCapture) {
      try {
        const clone = response.clone();
        const body = await clone.json();
        noteCapture(url, body, true);
        window.postMessage(
          { type: "FIFA_TICKET_SCOUT", url: toAbsoluteUrl(url), body, eventInfo: pageEventInfo() },
          "*"
        );
        maybeFollowUp(url, body);
      } catch {
        // Not JSON, or the body was already consumed. Previously silent, which
        // made a wrong endpoint pattern indistinguishable from an empty event.
        noteCapture(url, null, false);
      }
    }

    return response;
  };

  // Patch XMLHttpRequest — also capture headers
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._ftsUrl = url;
    this._ftsMethod = method;
    this._ftsHeaders = {};
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._ftsHeaders) {
      this._ftsHeaders[name] = value;
    }
    return originalSetHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (DISCOVERY_SITE && this._ftsUrl) {
      this.addEventListener("load", function () {
        let body = null;
        try {
          // Reading .responseText throws when responseType is json/blob/etc.
          body = this.responseText;
        } catch (e) {
          try {
            body = typeof this.response === "string"
              ? this.response
              : JSON.stringify(this.response);
          } catch (e2) { body = null; }
        }
        if (typeof body === "string") probeResponse(this._ftsUrl, body);
      });
    }

    const xhrWillCapture = !!this._ftsUrl && shouldCapture(this._ftsUrl);
    if (this._ftsUrl) countResponse(xhrWillCapture);

    if (xhrWillCapture) {
      rememberRequest(toAbsoluteUrl(this._ftsUrl), this._ftsMethod, args[0]);

      // Capture headers from real XHR requests
      if (!capturedHeaders && this._ftsHeaders && Object.keys(this._ftsHeaders).length > 0) {
        capturedHeaders = { ...this._ftsHeaders };
        console.log("[FIFA Ticket Scout] Captured XHR headers");
      }

      this.addEventListener("load", function () {
        try {
          const body = JSON.parse(this.responseText);
          noteCapture(this._ftsUrl, body, true);
          window.postMessage(
            { type: "FIFA_TICKET_SCOUT", url: toAbsoluteUrl(this._ftsUrl), body, eventInfo: pageEventInfo() },
            "*"
          );
          maybeFollowUp(this._ftsUrl, body);
        } catch {
          noteCapture(this._ftsUrl, null, false);
        }
      });
    }
    return originalSend.apply(this, args);
  };

  // Ticketmaster scans are triggered the same way FIFA scans are: popup →
  // background → content.js → postMessage, handled in the listener below.
  // (An earlier version watched chrome.storage.onChanged here, which can never
  // fire — there is no chrome.storage in the MAIN world.)

  let tmScanInProgress = false;

  async function triggerTicketmasterScan(eventId, force) {
    if (tmScanInProgress && !force) {
      console.log("[FIFA Ticket Scout] TM scan already in progress — ignoring");
      return;
    }
    tmScanInProgress = true;
    console.log("[FIFA Ticket Scout] Triggering Ticketmaster scan for:", eventId);

    // `performanceId` is the field name the rest of the pipeline (content.js →
    // background.js → popup) already keys progress on. Send the event id under
    // both names so the Ticketmaster path reuses that plumbing unchanged.
    const progress = (extra) => window.postMessage({
      type: "FIFA_TICKET_SCOUT_SCAN_PROGRESS",
      eventId,
      performanceId: eventId,
      total: 1,
      ...extra,
    }, "*");

    try {
      // Wait for the adapter to load if needed
      let attempts = 0;
      while (!window.__ticketmasterAdapter && attempts < 50) {
        await new Promise((r) => setTimeout(r, 100));
        attempts++;
      }

      if (!window.__ticketmasterAdapter) {
        console.log("[FIFA Ticket Scout] Adapter never loaded");
        window.postMessage({
          type: "FIFA_TICKET_SCOUT_SCAN_ERROR",
          eventId,
          performanceId: eventId,
          error: "Ticketmaster adapter failed to load",
        }, "*");
        return;
      }

      console.log("[FIFA Ticket Scout] Adapter ready, starting scan");

      const token = window.__ticketmasterAdapter.getToken();
      const correlationId = window.__ticketmasterAdapter.generateCorrelationId();

      progress({ completed: 0, status: "scanning", eta: 3 });

      const facetsData = await window.__ticketmasterAdapter.fetchFacets(eventId, token, correlationId);

      if (!facetsData) {
        // A 404 here usually means the event is not served by ISMDS at all
        // rather than that the id is wrong: on events where Ticketmaster is the
        // RESELLER rather than the primary seller, inventory lives in the
        // TMOL/VVS resale system, which this scan does not read. Say that,
        // rather than the flat "no data" that reads like a bug.
        console.log(`[TM] facets returned nothing for ${eventId} (${eventId.length} chars). ` +
          `If the request 404'd, either the id is wrong — compare it against the ` +
          `url logged above — or Ticketmaster is only reselling this event, in ` +
          `which case its inventory is not in ISMDS and the candidate ranking ` +
          `below shows where it actually is.`);
        window.postMessage({
          type: "FIFA_TICKET_SCOUT_SCAN_ERROR",
          eventId,
          performanceId: eventId,
          error: "Ticketmaster returned no inventory for this event — it may be a " +
            "resale-only listing, which is served by a different system.",
        }, "*");
        return;
      }

      // Event name/date come off the page, not the facets response, so they
      // ride alongside the body rather than inside it.
      const eventInfo = window.__ticketmasterAdapter.getEventInfo
        ? window.__ticketmasterAdapter.getEventInfo()
        : null;

      window.postMessage({
        type: "FIFA_TICKET_SCOUT",
        url: `https://services.ticketmaster.com/api/ismds/event/${eventId}/facets`,
        body: facetsData,
        site: "ticketmaster",
        eventInfo,
      }, "*");
      console.log("[FIFA Ticket Scout] Ticketmaster scan complete, sent data to background");

      progress({ completed: 1, status: "complete" });
    } catch (error) {
      console.log("[FIFA Ticket Scout] Ticketmaster scan error:", error.message);
      window.postMessage({
        type: "FIFA_TICKET_SCOUT_SCAN_ERROR",
        eventId,
        performanceId: eventId,
        error: error.message,
      }, "*");
    } finally {
      tmScanInProgress = false;
    }
  }

  // Listen for scan commands from the content script
  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;

    // Handle Ticketmaster scans
    if (isTicketmaster && event.data?.type === "FIFA_TICKET_SCOUT_SCAN_TICKETMASTER") {
      const { eventId, force } = event.data;
      if (!eventId) {
        console.log("[FIFA Ticket Scout] No eventId provided");
        return;
      }

      console.log("[FIFA Ticket Scout] Starting Ticketmaster scan for event:", eventId);
      triggerTicketmasterScan(eventId, force);
      return;
    }

    // Handle FIFA scans (original logic)
    if (event.data?.type !== "FIFA_TICKET_SCOUT_SCAN") return;

    const { productId, performanceId, scanSpeed, scanConfig: cfg, force } = event.data;
    if (!productId || !performanceId) return;

    // Guard: reject duplicate/redundant scans (unless force flag from manual rescan)
    if (!force) {
      if (scanInProgress) {
        console.log("[FIFA Ticket Scout] Scan already in progress — ignoring");
        return;
      }
      if (performanceId === lastScanPerformanceId &&
          (Date.now() - lastScanEndTime) < SCAN_COOLDOWN_MS) {
        console.log("[FIFA Ticket Scout] Scan cooldown active — ignoring");
        return;
      }
    }
    scanInProgress = true;

    console.log("[FIFA Ticket Scout] Scan started for", performanceId, "speed:", scanSpeed || "balanced");

    // Build headers — use captured ones or construct minimal required set
    const headers = capturedHeaders
      ? { ...capturedHeaders }
      : {
          "Accept": "application/json",
          "X-Secutix-Host": window.location.hostname,
          "X-Secutix-SecretKey": "DUMMY",
        };

    // Ensure required headers are present
    if (!headers["X-Secutix-Host"]) {
      headers["X-Secutix-Host"] = window.location.hostname;
    }
    if (!headers["X-Secutix-SecretKey"]) {
      headers["X-Secutix-SecretKey"] = "DUMMY";
    }

    // Also try to get CSRF token from the page if not in headers
    if (!headers["X-CSRF-Token"]) {
      const csrfMeta = document.querySelector('meta[name="csrf-token"]');
      if (csrfMeta) headers["X-CSRF-Token"] = csrfMeta.content;
    }

    console.log("[FIFA Ticket Scout] Using headers:", Object.keys(headers).join(", "));

    // Scan config — remote values from DB, with hardcoded fallbacks
    const SPEED_PROFILES = (cfg && cfg.profiles) || {
      aggressive: { min: 0,    max: 0 },
      balanced:   { min: 600,  max: 1000 },
      cautious:   { min: 1200, max: 1800 },
      stealth:    { min: 1300, max: 2700 },
    };
    const baseUrl = `/tnwr/v1/secure/seatmap/seats/free/ol`;
    const tileSize = (cfg && cfg.tile_size) || 10000;
    const mapMax = (cfg && cfg.map_max) || 40000;
    const MAX_CONSECUTIVE_BLOCKS_CFG = (cfg && cfg.max_consecutive_blocks) || 3;
    const retryCooldown = (cfg && cfg.retry_cooldown_ms) || 3000;

    // Build tile grid
    const tiles = [];
    for (let x = 0; x < mapMax; x += tileSize) {
      for (let y = 0; y < mapMax; y += tileSize) {
        tiles.push({ x, y, w: tileSize, h: tileSize });
      }
    }
    const totalTiles = tiles.length;

    const profile = SPEED_PROFILES[scanSpeed] || SPEED_PROFILES.balanced;
    const DELAY_MIN = profile.min;
    const DELAY_MAX = profile.max;
    const AVG_DELAY = (DELAY_MIN + DELAY_MAX) / 2;

    if (cfg) {
      console.log("[FIFA Ticket Scout] Using remote scan config:", JSON.stringify(cfg).substring(0, 200));
    }

    let completed = 0;
    let foundSeats = 0;
    let consecutiveBlocks = 0;
    let consecutiveEmpties = 0;
    let foundAnySeats = false;
    const MAX_CONSECUTIVE_BLOCKS = MAX_CONSECUTIVE_BLOCKS_CFG;
    const MAX_CONSECUTIVE_EMPTIES = Math.max(Math.floor(totalTiles / 4), 5);

    window.postMessage({
      type: "FIFA_TICKET_SCOUT_SCAN_PROGRESS",
      performanceId,
      completed: 0,
      total: totalTiles,
      status: "scanning",
      eta: Math.round((totalTiles * AVG_DELAY) / 1000),
    }, "*");

    let aborted = false;
    let abortReason = null;

    // Scan a list of tiles, return any that were blocked
    async function scanTiles(tilesToScan) {
      const blocked = [];
      for (const tile of tilesToScan) {
        if (aborted) break;
        if (consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) {
          console.log("[FIFA Ticket Scout] Rate limited — stopping after", MAX_CONSECUTIVE_BLOCKS, "consecutive blocks");
          window.postMessage({
            type: "FIFA_TICKET_SCOUT_SCAN_PROGRESS",
            performanceId,
            completed: totalTiles,
            total: totalTiles,
            status: "captcha",
          }, "*");
          abortReason = "captcha";
          aborted = true;
          break;
        }
        if (foundAnySeats && consecutiveEmpties >= MAX_CONSECUTIVE_EMPTIES) {
          console.log("[FIFA Ticket Scout] Stopping early — no more seats in remaining tiles");
          aborted = true;
          break;
        }

        const bbox = tile.x + "," + tile.y + "," + tile.w + "," + tile.h;
        const url = baseUrl + "?productId=" + productId + "&performanceId=" + performanceId + "&isSeasonTicketMode=false&advantageId=&isModifyAllSeatsMode=false&ppid=&reservationIdx=&crossSellId=&baseOperationIdsString=&bbox=" + bbox + "&isExclusive=true";

        try {
          const resp = await originalFetch(url, {
            credentials: "include",
            headers,
          });
          if (resp.ok) {
            consecutiveBlocks = 0;
            const body = await resp.json();
            const count = body.features ? body.features.length : 0;
            if (count > 0) {
              foundSeats += count;
              foundAnySeats = true;
              consecutiveEmpties = 0;
              console.log("[FIFA Ticket Scout] Tile found", count, "seats (total:", foundSeats + ")");
            } else {
              if (foundAnySeats) consecutiveEmpties++;
            }
            window.postMessage(
              { type: "FIFA_TICKET_SCOUT", url: window.location.origin + url, body },
              "*"
            );
          } else {
            const ct = resp.headers.get("content-type") || "";
            if ((resp.status === 403 || resp.status === 429) && !ct.includes("application/json")) {
              consecutiveBlocks++;
              blocked.push(tile);
              console.log("[FIFA Ticket Scout] Tile blocked (", resp.status, ") —", consecutiveBlocks, "consecutive");
            } else {
              const errText = await resp.text().catch(() => "");
              console.log("[FIFA Ticket Scout] Tile failed:", resp.status, errText.substring(0, 200));
            }
          }
        } catch (err) {
          console.log("[FIFA Ticket Scout] Scan tile error:", err.message);
          blocked.push(tile);
        }

        completed++;
        const remaining = totalTiles - completed;
        const eta = Math.round((remaining * (AVG_DELAY + 500)) / 1000);
        window.postMessage({
          type: "FIFA_TICKET_SCOUT_SCAN_PROGRESS",
          performanceId,
          completed,
          total: totalTiles,
          status: "scanning",
          eta,
        }, "*");

        const jitter = DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN);
        await new Promise((r) => setTimeout(r, jitter));
      }
      return blocked;
    }

    // First pass
    const blockedTiles = await scanTiles(tiles);

    // Retry pass — wait a few seconds then retry blocked tiles
    if (blockedTiles.length > 0 && !aborted) {
      console.log("[FIFA Ticket Scout] Retrying", blockedTiles.length, "blocked tiles in", Math.round(retryCooldown / 1000) + "s...");
      await new Promise((r) => setTimeout(r, retryCooldown));
      consecutiveBlocks = 0;
      completed = totalTiles - blockedTiles.length;
      const stillBlocked = await scanTiles(blockedTiles);
      if (stillBlocked.length > 0) {
        console.log("[FIFA Ticket Scout]", stillBlocked.length, "tiles still blocked after retry");
      }
    }

    // Always send a terminal status — either "done" or "captcha"
    if (abortReason === "captcha") {
      // captcha status already sent inside scanTiles, but ensure progress shows 100%
      window.postMessage({
        type: "FIFA_TICKET_SCOUT_SCAN_PROGRESS",
        performanceId,
        completed: totalTiles,
        total: totalTiles,
        status: "captcha",
      }, "*");
    } else {
      window.postMessage({
        type: "FIFA_TICKET_SCOUT_SCAN_PROGRESS",
        performanceId,
        completed: totalTiles,
        total: totalTiles,
        status: "done",
      }, "*");
    }
    scanInProgress = false;
    lastScanPerformanceId = performanceId;
    lastScanEndTime = Date.now();

    console.log("[FIFA Ticket Scout] Scan", aborted ? "aborted (" + (abortReason || "early stop") + ")" : "complete", ":", foundSeats, "seats found");
  });
})();
