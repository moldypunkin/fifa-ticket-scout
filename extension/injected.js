// Runs in PAGE context — intercepts fetch/XHR responses
// and relays matching ones back to the content script via postMessage

(function () {
  if (window.__fifaTicketScoutLoaded) return;
  window.__fifaTicketScoutLoaded = true;
  
  // Detect which ticketing site we're on
  const isTicketmaster = window.location.hostname.includes('ticketmaster.com');
  const isFifa = window.location.hostname.includes('tickets.fifa.com');
  const isSeatGeek = window.location.hostname.includes('seatgeek.com');

  if (isTicketmaster) {
    console.log("[FIFA Ticket Scout] Running on Ticketmaster (will use adapter)");
  } else if (isFifa) {
    console.log("[FIFA Ticket Scout] Running on FIFA (using FIFA logic)");
  } else if (isSeatGeek) {
    console.log("[FIFA Ticket Scout] Running on SeatGeek (endpoint discovery mode)");
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
  const MATCH_PATTERNS = isTicketmaster
    ? []
    : isSeatGeek
      ? ["/api/event_listings_v2"]
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
    // FIFA and SeatGeek both match on their own patterns.
    return MATCH_PATTERNS.some((p) => url.includes(p));
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

  // SeatGeek's inventory response carries no event name/date, so attach what
  // the adapter reads off the page. Undefined elsewhere: the FIFA paths get
  // match info from their own API, and Ticketmaster attaches it at scan time.
  function seatGeekEventInfo() {
    if (!isSeatGeek) return undefined;
    try {
      return window.__seatgeekAdapter
        ? window.__seatgeekAdapter.getEventInfo()
        : undefined;
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
  const LOG_PREFIXES = ["[FIFA Ticket Scout]", "[TM]", "[SG]", "[SG-PROBE]"];
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

    // Capture headers from any seatmap request the page makes
    if (shouldCapture(url) && !capturedHeaders) {
      const init = args[1] || {};
      if (init.headers) {
        capturedHeaders = init.headers instanceof Headers
          ? Object.fromEntries(init.headers.entries())
          : { ...init.headers };
        console.log("[FIFA Ticket Scout] Captured request headers");
      }
    }

    const response = await originalFetch.apply(this, args);

    if (shouldCapture(url)) {
      try {
        const clone = response.clone();
        const body = await clone.json();
        window.postMessage(
          { type: "FIFA_TICKET_SCOUT", url: toAbsoluteUrl(url), body, eventInfo: seatGeekEventInfo() },
          "*"
        );
      } catch {
        // not JSON or parse error
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
    if (this._ftsUrl && shouldCapture(this._ftsUrl)) {
      // Capture headers from real XHR requests
      if (!capturedHeaders && this._ftsHeaders && Object.keys(this._ftsHeaders).length > 0) {
        capturedHeaders = { ...this._ftsHeaders };
        console.log("[FIFA Ticket Scout] Captured XHR headers");
      }

      this.addEventListener("load", function () {
        try {
          const body = JSON.parse(this.responseText);
          window.postMessage(
            { type: "FIFA_TICKET_SCOUT", url: toAbsoluteUrl(this._ftsUrl), body, eventInfo: seatGeekEventInfo() },
            "*"
          );
        } catch {
          // not JSON
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
