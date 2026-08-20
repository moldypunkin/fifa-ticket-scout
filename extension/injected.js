// Runs in PAGE context — intercepts fetch/XHR responses
// and relays matching ones back to the content script via postMessage

(function () {
  if (window.__fifaTicketScoutLoaded) return;
  window.__fifaTicketScoutLoaded = true;
  
  // Detect which ticketing site we're on
  const isTicketmaster = window.location.hostname.includes('ticketmaster.com');
  const isFifa = window.location.hostname.includes('tickets.fifa.com');
  const isSeatGeek = window.location.hostname.includes('seatgeek.com');
  const isStubHub = window.location.hostname.includes('stubhub.com');
  const isEvenue = window.location.hostname.includes('evenue.net');
  const isTickPick = window.location.hostname.includes('tickpick.com');

  if (isTicketmaster) {
    console.log("[FIFA Ticket Scout] Running on Ticketmaster (will use adapter)");
  } else if (isFifa) {
    console.log("[FIFA Ticket Scout] Running on FIFA (using FIFA logic)");
  } else if (isSeatGeek) {
    console.log("[FIFA Ticket Scout] Running on SeatGeek (passive capture)");
  } else if (isStubHub) {
    console.log("[FIFA Ticket Scout] Running on StubHub (passive capture)");
  } else if (isEvenue) {
    console.log("[FIFA Ticket Scout] Running on Evenue (passive capture)");
  } else if (isTickPick) {
    console.log("[FIFA Ticket Scout] Running on TickPick (endpoint discovery mode)");
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
          ? ["/pac-api/seat-availability/"]
          : isTickPick
            ? ["/listings/internal/event-v2/"]
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
    : isTickPick ? "TP" : isTicketmaster ? "TM" : "FIFA";
  const capStats = { seen: 0, matched: 0, parsed: 0, notJson: 0, posted: 0 };
  let capSummaryTimer = null;

  function scheduleCaptureSummary() {
    if (capSummaryTimer) return;
    capSummaryTimer = setTimeout(() => {
      capSummaryTimer = null;
      console.log(`[${SITE_TAG}] capture: ${capStats.seen} responses seen, ` +
        `${capStats.matched} matched ${JSON.stringify(MATCH_PATTERNS)}, ` +
        `${capStats.parsed} parsed as JSON, ${capStats.notJson} not JSON, ` +
        `${capStats.posted} sent to the service worker`);
      if (capStats.matched === 0) {
        console.log(`[${SITE_TAG}] nothing matched ${JSON.stringify(MATCH_PATTERNS)} — the ` +
          `inventory endpoint is not covered by it.`);
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
  const isPassiveSite = isStubHub || isSeatGeek || isEvenue || isTickPick;
  const MAX_CANDIDATES = 60;
  const CANDIDATE_MIN_CHARS = 2000;
  const candidates = new Map();   // path -> largest byte length seen

  function recordCandidate(url, response) {
    if (!isPassiveSite || capStats.matched > 0) return;
    if (candidates.size >= MAX_CANDIDATES) return;
    const clean = String(url).split("?")[0];
    if (PROBE_SKIP.test(clean)) return;
    const type = (response.headers && response.headers.get("content-type")) || "";
    if (!type.includes("json")) return;
    response.clone().text().then((t) => {
      if (!t || t.length < CANDIDATE_MIN_CHARS) return;
      const prev = candidates.get(clean) || 0;
      if (t.length > prev) candidates.set(clean, t.length);
    }).catch(() => {});
  }

  function reportCandidates() {
    if (!candidates.size) {
      console.log(`[${SITE_TAG}] no JSON responses over ${CANDIDATE_MIN_CHARS} chars were seen ` +
        `either — the page may be serving from cache; try a hard reload.`);
      return;
    }
    const ranked = [...candidates.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`[${SITE_TAG}] largest JSON responses the page fetched (candidate endpoints):`);
    ranked.forEach(([path, len], i) => {
      console.log(`[${SITE_TAG}]   ${i + 1}. ${Math.round(len / 1024)}KB  ${path}`);
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
  const PROBE_SKIP = /google|doubleclick|datadog|forter|riskified|openai|reddit|yimg|adsrvr|boomtrain|iteratehq|datadome|newrelic|segment|branch\.io|qualtrics|vggcdn|cloudfront|akamai|\.geojson|map-sprites|svgnew|sprite|mapbox|\.png|\.jpg|\.svg|\.woff|\.pbf|\.css|field_images|\/glyphs\//i;
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
        : null;
      return adapter ? adapter.getEventInfo() : undefined;
    } catch (e) {
      return undefined;
    }
  }

  // Capture headers from real requests so the scan can reuse them
  let capturedHeaders = null;

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
  const LOG_PREFIXES = ["[FIFA Ticket Scout]", "[FIFA]", "[TM]", "[SG]", "[SH]", "[EV]", "[TP]", "[TP-PROBE]", "[EV-PROBE]", "[SH-PROBE]", "[SG-PROBE]", "[TM-PROBE]"];
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
    if (!willCapture) recordCandidate(url, response);

    if (willCapture) {
      try {
        const clone = response.clone();
        const body = await clone.json();
        noteCapture(url, body, true);
        window.postMessage(
          { type: "FIFA_TICKET_SCOUT", url: toAbsoluteUrl(url), body, eventInfo: pageEventInfo() },
          "*"
        );
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
        console.log("[FIFA Ticket Scout] Ticketmaster facets request returned no data");
        window.postMessage({
          type: "FIFA_TICKET_SCOUT_SCAN_ERROR",
          eventId,
          performanceId: eventId,
          error: "No data returned from Ticketmaster",
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
