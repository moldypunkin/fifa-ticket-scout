// Content script — bridges page context (injected.js) and extension (background.js)
// injected.js runs in MAIN world via manifest, no manual injection needed.

// ─── Seat preselect bridge (?fts_seats=A,B,C) ─────────────────────────────
// When the user clicks a "View these seats" link from an alert email, the
// URL carries an ?fts_seats=<comma-separated seat_ids> param. We need to
// transplant that into Secutix's sessionStorage *before* the seat-picker
// bundle reads it on init, so the picker boots up with our seats already
// selected.
//
// Storage shape (reverse-engineered from stx2js-all.js):
//   sessionStorage["seatMapSelection_<perfId>"] = JSON.stringify({
//     contactNumber: null,
//     data: {
//       selectedSeats: [
//         { seatData: { data: { id, seatId, areaId, area, block, row, number, ... } },
//           numbered: true }
//       ],
//       nonSeatData: {}
//     }
//   })
//
// Seat metadata comes from chrome.storage.local where background.js caches
// every scan as games[<perfId>].seats[<seat_id>]. If a requested seat isn't
// in the cache (user hasn't scanned this match recently), we silently skip
// it and let the picker open without preselect — fail-soft, never break.

// ─── Orphaned-context guard ───────────────────────────────────────────────
// Reloading the extension leaves the OLD content script running in every tab
// that was already open, with a dead chrome.runtime behind it. Every call then
// throws "Extension context invalidated" — unhandled, once per captured
// response, from inside a listener the page's own fetch chain runs through.
//
// There is nothing to recover: this script is orphaned until the tab reloads.
// Go quiet instead of throwing, and say so once.
let extensionGone = false;

function extensionAlive() {
  if (extensionGone) return false;
  try {
    if (chrome.runtime && chrome.runtime.id) return true;
  } catch (e) { /* accessing runtime.id can itself throw */ }
  extensionGone = true;
  console.log("[FIFA Ticket Scout] Extension was reloaded — this tab's content " +
    "script is orphaned and has stopped relaying. Refresh the page to reconnect.");
  return false;
}

(function preselectSeatsFromUrl() {
  const SEAT_PICKER_RE = /\/secure\/selection\/event\/seat\/performance\/(\d+)/;
  const m = location.pathname.match(SEAT_PICKER_RE);
  if (!m) return;
  const perfId = m[1];

  const params = new URLSearchParams(location.search);
  const raw = params.get("fts_seats");
  if (!raw) return;
  const wantedSeatIds = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (wantedSeatIds.length === 0) return;

  if (!extensionAlive()) return;
  chrome.storage.local.get("games", (data) => {
    try {
      const seats = data?.games?.[perfId]?.seats || {};
      const selectedSeats = [];

      for (const sid of wantedSeatIds) {
        const seat = seats[sid];
        if (!seat) continue; // not in cache — skip silently

        // Build a `data` blob shaped like what Secutix's own seat features
        // carry. Numeric `id` / `seatId` matter — Secutix uses === comparisons.
        const seatIdNum = Number(sid);
        /** @type {Record<string, any>} */
        const data = {
          id: seatIdNum,
          seatId: seatIdNum,
          area: seat.area || "",
          block: seat.block || "",
          row: seat.row || "",
          number: seat.seat || "",
          seatCategory: seat.category || "",
          seatCategoryId: seat.categoryId ?? null,
          amount: seat.price || 0,
          color: seat.color || "",
          exclusive: seat.exclusive !== false,
        };
        // Only set these when we actually captured them — Secutix tolerates
        // missing keys but rejects mismatched ones in some code paths.
        if (seat.areaId != null) data.areaId = seat.areaId;
        if (seat.blockId != null) data.blockId = seat.blockId;
        if (seat.tariffId != null) data.tariffId = seat.tariffId;
        if (seat.advantageId != null) data.advantageId = seat.advantageId;
        if (seat.movementId != null) data.movementId = seat.movementId;

        selectedSeats.push({ seatData: { data }, numbered: true });
      }

      if (selectedSeats.length === 0) return;

      const entry = {
        contactNumber: null,
        data: {
          selectedSeats,
          nonSeatData: {},
        },
      };
      sessionStorage.setItem(
        "seatMapSelection_" + perfId,
        JSON.stringify(entry)
      );

      // Strip the param from the visible URL so reloads / bookmarks don't
      // re-trigger the bridge and so the URL stays clean.
      params.delete("fts_seats");
      const newSearch = params.toString();
      const newUrl = location.pathname + (newSearch ? "?" + newSearch : "") + location.hash;
      history.replaceState(null, "", newUrl);
    } catch (e) {
      // Never break the page — log and move on.
      console.warn("[FIFA Ticket Scout] preselect bridge error:", e);
    }
  });
})();

// ─── Debug log buffer ─────────────────────────────────────────────────────
// injected.js runs in the MAIN world and has no `chrome.*`, so it relays its
// log lines here. Batch them: a get/set round-trip per line would race with
// itself and lose entries under bursty logging.
const MAX_LOG_LINES = 1000;
let pendingLogs = [];
let logFlushTimer = null;

function flushLogs() {
  logFlushTimer = null;
  if (pendingLogs.length === 0) return;
  const batch = pendingLogs;
  pendingLogs = [];
  if (!extensionAlive()) return;
  chrome.storage.local.get("extensionLogs", (data) => {
    if (chrome.runtime.lastError) return;
    let logs = (data?.extensionLogs || []).concat(batch);
    if (logs.length > MAX_LOG_LINES) logs = logs.slice(-MAX_LOG_LINES);
    chrome.storage.local.set({ extensionLogs: logs });
  });
}

function queueLog(line) {
  if (typeof line !== "string") return;
  pendingLogs.push(line);
  if (pendingLogs.length >= 50) {
    clearTimeout(logFlushTimer);
    flushLogs();
  } else if (!logFlushTimer) {
    logFlushTimer = setTimeout(flushLogs, 1000);
  }
}

function safeSendMessage(message) {
  if (!extensionAlive()) return;
  try {
    chrome.runtime.sendMessage(message, () => {
      // Reading lastError is what suppresses "Unchecked runtime.lastError".
      void chrome.runtime.lastError;
    });
  } catch (e) {
    extensionGone = true;
  }
}

// Listen for messages from injected code
window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  if (event.data?.type === "FIFA_TICKET_SCOUT") {
    safeSendMessage({
      type: "API_RESPONSE",
      url: event.data.url,
      body: event.data.body,
      // Ticketmaster only; undefined on the FIFA paths, which carry match
      // info in the API response itself.
      eventInfo: event.data.eventInfo,
    });
  }

  if (event.data?.type === "FIFA_TICKET_SCOUT_LOG") {
    queueLog(event.data.line);
  }

  if (event.data?.type === "FIFA_TICKET_SCOUT_SCAN_PROGRESS") {
    safeSendMessage({
      type: "SCAN_PROGRESS",
      // Ticketmaster sends `eventId`; FIFA sends `performanceId`.
      performanceId: event.data.performanceId || event.data.eventId,
      completed: event.data.completed,
      total: event.data.total,
      status: event.data.status,
      eta: event.data.eta,
    });
  }

  if (event.data?.type === "FIFA_TICKET_SCOUT_SCAN_ERROR") {
    queueLog(`[${new Date().toISOString()}] [scan error] ${event.data.error}`);
    safeSendMessage({
      type: "SCAN_PROGRESS",
      performanceId: event.data.performanceId || event.data.eventId,
      status: "error",
      error: event.data.error,
    });
  }
});

// Listen for scan commands from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "START_SCAN") {
    window.postMessage({
      type: "FIFA_TICKET_SCOUT_SCAN",
      productId: message.productId,
      performanceId: message.performanceId,
      scanSpeed: message.scanSpeed,
      scanConfig: message.scanConfig || null,
      force: message.force || false,
    }, "*");
  }
  
  if (message.type === "START_TICKETMASTER_SCAN") {
    window.postMessage({
      type: "FIFA_TICKET_SCOUT_SCAN_TICKETMASTER",
      eventId: message.eventId,
      force: message.force || false,
    }, "*");
  }
});
