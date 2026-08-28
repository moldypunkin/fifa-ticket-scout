// Background service worker — processes API data and stores it

// Seat-tier mapping. venue-tiers.js defines the data VENUE_TIER_DATA, tiers.js
// the VenueTiers helpers that read it — load order matters. Both are plain
// scripts with no deps, so importScripts is safe at service-worker top level.
// NOTE: VenueTiers is about SEAT tiers; the TIERS constant below is LICENSE
// tiers. Different things.
importScripts("venue-tiers.js", "tiers.js", "venue-import.js");

// The shipped mapping, before any user import overlays it.
const SHIPPED_VENUE_TIER_DATA = self.VENUE_TIER_DATA;

// Categories imported through the popup are layered on here too, so the `tier`
// stamped onto seats at scan time agrees with what the popup renders. The
// service worker restarts often, so this re-reads storage rather than caching.
// Three layers, lowest first: what shipped in the build, the set published to
// the repo, then this browser's own import. A local import therefore wins for
// the venues it names — which keeps the Import button useful for a venue that
// has not been published yet — and the shared set fills in everything else.
async function applyUserCategories() {
  try {
    const shared = await getSharedCategories(false);
    const base = VenueImport.applyShared(SHIPPED_VENUE_TIER_DATA, shared);
    const data = await chrome.storage.local.get("userVenueCategories");
    const rows = (data && data.userVenueCategories && data.userVenueCategories.rows) || [];
    self.VENUE_TIER_DATA = VenueImport.applyOverlay(base, rows);
    return rows.length;
  } catch (e) {
    return 0;
  }
}

// Re-apply when the popup imports or clears, without waiting for a restart.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.userVenueCategories) applyUserCategories();
});

applyUserCategories();

// Say whether a scan picked up a curated venue mapping or fell back to the
// section-text heuristic. Falling back is silent otherwise — the tiers still
// look plausible ("Lower (100s)"), so a venue-name mismatch reads as working.
function logTierMapping(venueName) {
  const d = VenueTiers.diagnose(venueName);
  if (!d.venue) {
    console.log("[tiers] No venue on this event — using the section heuristic. " +
                "Check the adapter's `venue=` line above.");
  } else if (d.matched) {
    console.log(`[tiers] "${d.venue}" -> "${d.key}" (${d.sections} mapped sections)`);
  } else {
    console.log(`[tiers] "${d.venue}" -> "${d.key}" has no mapping — using the ` +
                `section heuristic. Add an alias to tools/fifa_venue_aliases.json ` +
                `if this venue is curated in TicketPortal under another name.`);
  }
}

// ─── Log relay ────────────────────────────────────────────────────────────
// injected.js already mirrors its console output into chrome.storage via
// content.js, so Download Logs shows the page side. The service worker writes
// only to its own console (chrome://extensions -> "service worker"), which is
// a place nobody thinks to look — so a parse that rejects a payload looks
// exactly like a capture that never happened. bgLog puts both sides in one
// file. Batched: a get/set per line would race with itself.
const MAX_LOG_LINES = 1000;
let bgPendingLogs = [];
let bgLogTimer = null;

function bgFlushLogs() {
  bgLogTimer = null;
  if (!bgPendingLogs.length) return;
  const batch = bgPendingLogs;
  bgPendingLogs = [];
  chrome.storage.local.get("extensionLogs", (data) => {
    if (chrome.runtime.lastError) return;
    let logs = (data?.extensionLogs || []).concat(batch);
    if (logs.length > MAX_LOG_LINES) logs = logs.slice(-MAX_LOG_LINES);
    chrome.storage.local.set({ extensionLogs: logs });
  });
}

function bgLog(...args) {
  const msg = args.map((a) => {
    if (typeof a === "object" && a !== null) {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  }).join(" ");
  console.log(msg);
  bgPendingLogs.push(`[${new Date().toISOString()}] ${msg}`);
  mirrorToPage(msg);
  if (bgPendingLogs.length >= 50) {
    clearTimeout(bgLogTimer);
    bgFlushLogs();
  } else if (!bgLogTimer) {
    bgLogTimer = setTimeout(bgFlushLogs, 1000);
  }
}

// Also print into the active tab's console.
//
// The service worker logs to its own DevTools window, behind
// chrome://extensions -> "service worker", which nobody thinks to open — so
// the line that says whether a scan actually parsed anything was invisible to
// the person watching the page console. Mirror it to where they are looking.
// Best-effort: no listener, no tab, or an orphaned content script all fail
// silently, and the line is still in Download Logs either way.
function mirrorToPage(msg) {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      void chrome.runtime.lastError;
      const tab = tabs && tabs[0];
      if (!tab || tab.id == null) return;
      chrome.tabs.sendMessage(tab.id, { type: "BG_LOG", line: msg }, () => {
        void chrome.runtime.lastError;
      });
    });
  } catch (e) { /* never let logging break anything */ }
}

// A compact description of an unknown payload, for the log. Names the shape
// without dumping tens of thousands of rows into storage.
function describeShape(v, depth) {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    const inner = v.length && depth > 0 ? describeShape(v[0], depth - 1) : "";
    return `array(${v.length}${inner ? " of " + inner : ""})`;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v);
    const shown = keys.slice(0, 8);
    if (depth <= 0) {
      return `{${shown.join(",")}${keys.length > 8 ? ",…" : ""}}`;
    }
    const parts = shown.map((k) => `${k}:${describeShape(v[k], depth - 1)}`);
    return `{${parts.join(",")}${keys.length > 8 ? ",…" : ""}}`;
  }
  return typeof v;
}

// --- Site discrimination ---
function siteFromUrl(url) {
  try {
    const h = new URL(url).hostname;
    if (h.includes("ticketmaster")) return "ticketmaster";
    if (h.includes("seatgeek")) return "seatgeek";
    if (h.includes("stubhub")) return "stubhub";
    if (h.includes("evenue")) return "evenue";
    if (h.includes("tickpick")) return "tickpick";
    if (h.includes("axs")) return "axs";
    if (h.includes("-resale-")) return "resale";
    if (h.includes("-shop-"))   return "lms";
  } catch {}
  return "unknown";
}

// --- Tier / License constants ---
const TIERS = { FREE: 0, PRO: 10, PRO_WEB: 20, PRO_WEB_ALERTS: 30 };
const REVERIFY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ============================================================
// LICENSE PROVIDER — swap this section to change providers
// Must export: PRODUCTS array and verifyKey(productId, licenseKey) function
// ============================================================

const PRODUCTS = [
  { productId: "qQRSGWNOL13FKrC3bHvmkA==",  level: 10 },  // Scout Pro ($19.99)
  { productId: "_EOsxJwpud5MDG4IX3a-Ig==",   level: 20 },  // Pro + Web ($29.99)
  { productId: "HEzB2VDD6QMDXaFiynXo5w==",   level: 30 },  // Pro + Web + Alerts ($49.99)
];

// Returns { valid: true, test: bool } or { valid: false }
// Throws on network error
async function verifyKey(productId, licenseKey) {
  const resp = await fetch("https://api.gumroad.com/v2/licenses/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      product_id: productId,
      license_key: licenseKey,
      increment_uses_count: "false",
    }),
  });
  const result = await resp.json();
  return { valid: !!result.success, test: result.purchase?.test || false };
}

// ============================================================
// END LICENSE PROVIDER
// ============================================================

// ============================================================
// SUPABASE SYNC — fire-and-forget data sync after each scan
// ============================================================

// Remote config lives in this repo, fetched at runtime so scan timing, the
// update banner and the venue categories can change without a store release.
//
// This pointed at the UPSTREAM repo, not this fork: `version.json` there read
// 2.2.0, which is below every version shipped here, so the update banner could
// never fire — and upstream controlled this fork's scan timing. Anyone forking
// again changes this one line.
const CONFIG_REPO = "https://raw.githubusercontent.com/moldypunkin/fifa-ticket-scout/main";

// How long a fetched category set is trusted before refetching. Venue mappings
// change rarely and raw.githubusercontent caches for about five minutes
// anyway, so hourly is already far more often than the data moves.
const SHARED_CATEGORIES_TTL_MS = 60 * 60 * 1000;

// Fetch the published category set, or return the cached copy. Never throws:
// a failure just means the shipped mapping stays in use.
async function getSharedCategories(force) {
  try {
    const cached = (await chrome.storage.local.get("sharedVenueCategories"))
      .sharedVenueCategories;
    const fresh = cached && cached.fetchedAt &&
      (Date.now() - cached.fetchedAt) < SHARED_CATEGORIES_TTL_MS;
    if (cached && fresh && !force) return cached.data;

    const resp = await fetch(`${CONFIG_REPO}/venue_categories.json`, { cache: "no-cache" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (!data || !data.sections) throw new Error("no sections in the published file");

    await chrome.storage.local.set({
      sharedVenueCategories: { data, fetchedAt: Date.now() },
    });
    bgLog(`[background] shared categories: ${Object.keys(data.sections).length} venue(s) ` +
      `fetched from the repo`);
    return data;
  } catch (e) {
    // Fall back to whatever was cached, then to the shipped mapping.
    try {
      const cached = (await chrome.storage.local.get("sharedVenueCategories"))
        .sharedVenueCategories;
      if (cached && cached.data) return cached.data;
    } catch (inner) { /* nothing cached */ }
    bgLog("[background] shared categories unavailable:", e && e.message);
    return null;
  }
}

const SUPABASE_URL = "https://yaydpahqlqwesqdddgfi.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlheWRwYWhxbHF3ZXNxZGRkZ2ZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5MDg1NDEsImV4cCI6MjA5MTQ4NDU0MX0.QQJuKz9Fnb_schlS6FEioMtyRvrJVBwAL71dzitZU-g";

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getOrCreateVisitorId() {
  const data = await getStorage();
  if (data.visitorId) return data.visitorId;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const visitorId = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  await chrome.storage.local.set({ visitorId });
  return visitorId;
}

function syncToSupabase(gameKey, durationMs) {
  getStorage().then(async (data) => {
    const game = data.games?.[gameKey];
    if (!game) return;
    // Allow LMS zero-seat scans to sync (records "we checked, nothing there")
    if (Object.keys(game.seats || {}).length === 0 && game.site !== "lms") return;

    const visitorId = await getOrCreateVisitorId();
    const license = data.license;
    const licenseHash = license?.key ? await sha256(license.key) : null;

    const performanceId = game.match?.performanceId || gameKey.split(":").pop();
    const payload = {
      visitorId,
      licenseHash,
      site: game.site || "resale",
      performanceId,
      match: game.match || {},
      seats: game.seats,
      scanDurationMs: durationMs,
    };

    fetch(`${SUPABASE_URL}/functions/v1/ingest-scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "apikey": SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(payload),
    }).catch((err) => {
      console.log("[FIFA Ticket Scout] Supabase sync failed (non-blocking):", err.message);
    });
  }).catch((err) => {
    console.log("[FIFA Ticket Scout] Sync prep failed:", err.message);
  });
}

async function fetchAlerts() {
  // Cloud rehydrate path. Returns { ok: true, email, games, savedAt, updatedAt }
  // on success, or { ok: false, error } on failure. Does NOT write to
  // chrome.storage.local — the caller decides whether to cache the result
  // (so an offline fallback path can't accidentally clobber the canonical copy).
  try {
    const data = await getStorage();
    const license = data.license;
    if (!license?.key) {
      return { ok: false, error: "No license found." };
    }
    if ((license.level || 0) < TIERS.PRO_WEB_ALERTS) {
      return { ok: false, error: "Alerts requires Pro + Web + Alerts tier." };
    }

    const resp = await fetch(`${SUPABASE_URL}/functions/v1/get-alerts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "apikey": SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ licenseKey: license.key }),
    });

    const result = await resp.json();
    if (!resp.ok || !result.ok) {
      return { ok: false, error: result.error || "Fetch failed." };
    }
    return result;
  } catch (err) {
    console.log("[FIFA Ticket Scout] fetchAlerts error:", err.message);
    return { ok: false, error: "Could not reach server. Check your connection." };
  }
}

async function fetchInsights() {
  try {
    const data = await getStorage();
    const license = data.license;
    if (!license?.key) {
      return { ok: false, error: "No license found." };
    }
    if ((license.level || 0) < TIERS.PRO_WEB) {
      return { ok: false, error: "Insights requires Pro + Web tier." };
    }

    const resp = await fetch(`${SUPABASE_URL}/functions/v1/get-insights`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "apikey": SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ licenseKey: license.key }),
    });

    const result = await resp.json();
    if (!resp.ok || !result.ok) {
      return { ok: false, error: result.error || "Fetch failed." };
    }
    return result;
  } catch (err) {
    console.log("[FIFA Ticket Scout] fetchInsights error:", err.message);
    return { ok: false, error: "Could not reach server. Check your connection." };
  }
}

async function saveAlerts(payload) {
  try {
    const data = await getStorage();
    const license = data.license;
    if (!license?.key) {
      return { ok: false, error: "No license found." };
    }
    if ((license.level || 0) < TIERS.PRO_WEB_ALERTS) {
      return { ok: false, error: "Alerts requires Pro + Web + Alerts tier." };
    }

    const body = {
      licenseKey: license.key,  // raw key, Edge Function will verify + hash
      email: payload.email,
      games: payload.games,
    };

    const resp = await fetch(`${SUPABASE_URL}/functions/v1/save-alerts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "apikey": SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(body),
    });

    const result = await resp.json();
    if (!resp.ok || !result.ok) {
      return { ok: false, error: result.error || "Save failed." };
    }

    // Persist locally
    await chrome.storage.local.set({
      alertConfigs: {
        email: payload.email,
        games: payload.games,
        savedAt: Date.now(),
      },
    });

    return { ok: true };
  } catch (err) {
    console.log("[FIFA Ticket Scout] saveAlerts error:", err.message);
    return { ok: false, error: "Could not reach server. Check your connection." };
  }
}

// ============================================================
// END SUPABASE SYNC
// ============================================================

// --- Re-verify license on alarm ---
chrome.alarms.create("reverify-license", { periodInMinutes: 1440 });
// --- Refresh remote scan config every 60 minutes ---
chrome.alarms.create("refresh-scan-config", { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "reverify-license") reverifyLicense();
  if (alarm.name === "refresh-scan-config") fetchScanConfig();
});

async function fetchScanConfig() {
  try {
    const resp = await fetch(
      `${CONFIG_REPO}/scan_config.json`
    );
    if (!resp.ok) return;
    const config = await resp.json();
    if (config && config.profiles) {
      await chrome.storage.local.set({ scanConfig: config });
    }
  } catch (err) {
    console.log("[FIFA Ticket Scout] Scan config fetch failed (non-blocking):", err.message);
  }
}

// Fetch scan config + re-verify license on service worker startup
fetchScanConfig();
getStorage().then((data) => {
  if (data.license && Date.now() - data.license.verifiedAt > REVERIFY_INTERVAL_MS) {
    reverifyLicense();
  }
  // One-shot migration: rewrite bare perfId keys → resale:perfId
  const games = data.games;
  if (games) {
    let changed = false;
    for (const key of Object.keys(games)) {
      if (!key.includes(":")) {
        games[key].site = "resale";
        games[`resale:${key}`] = games[key];
        delete games[key];
        changed = true;
      }
    }
    if (changed) chrome.storage.local.set({ games });
  }
});

async function activateLicense(licenseKey) {
  const trimmed = licenseKey.trim();
  if (!trimmed) return { ok: false, error: "Please enter a license key." };

  // Try each product, highest tier first
  const sorted = [...PRODUCTS].sort((a, b) => b.level - a.level);

  for (const product of sorted) {
    try {
      const result = await verifyKey(product.productId, trimmed);

      if (result.valid) {
        const license = {
          key: trimmed,
          level: product.level,
          productId: product.productId,
          verifiedAt: Date.now(),
          test: result.test,
        };
        await chrome.storage.local.set({ license });
        return { ok: true, level: product.level };
      }
    } catch (err) {
      console.log("[FIFA Ticket Scout] License verify error:", err.message);
      return { ok: false, error: "Could not verify license. Check your connection and try again." };
    }
  }

  return { ok: false, error: "Invalid license key. Please check and try again." };
}

async function reverifyLicense() {
  const data = await getStorage();
  if (!data.license?.key) return;

  const product = PRODUCTS.find((p) => p.productId === data.license.productId);
  if (!product) return;

  try {
    const result = await verifyKey(product.productId, data.license.key);

    if (result.valid) {
      data.license.verifiedAt = Date.now();
      await chrome.storage.local.set({ license: data.license });
    } else {
      await chrome.storage.local.remove("license");
      chrome.runtime.sendMessage({ type: "LICENSE_CHANGED" }).catch(() => {});
    }
  } catch {
    // Network error — keep cached license, retry next cycle
  }
}

function emptyGame() {
  return { match: null, seats: {}, availability: null };
}

let dataUpdatedTimer = null;
function notifyDataUpdated() {
  clearTimeout(dataUpdatedTimer);
  dataUpdatedTimer = setTimeout(() => {
    chrome.runtime.sendMessage({ type: "DATA_UPDATED" }).catch(() => {});
  }, 500);
}

// Track which tab is showing which game
const tabGameMap = {};
const scanStartTimes = {};

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabGameMap[tabId];
  removeScannedGamesForTab(tabId);
});

// On page refresh/navigation, clear scanned state so auto-scan fires again
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    delete tabGameMap[tabId];
    removeScannedGamesForTab(tabId);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender?.tab?.id;

  if (message.type === "API_RESPONSE") {
    processApiResponse(message.url, message.body, tabId, message.eventInfo);
  }
  if (message.type === "CLEAR_DATA") {
    chrome.storage.session.remove("scannedGames");
    // Surgical: only wipe the captured-scan data. Everything else
    // (alertConfigs, license, visitorId, scanSpeed, filters) survives by
    // default. Avoids the historical "restore the things I forgot to wipe"
    // footgun where each new top-level storage key had to be added to a
    // rescue whitelist.
    chrome.storage.local.remove(["games", "extensionLogs"], () => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === "ACTIVATE_LICENSE") {
    activateLicense(message.licenseKey).then(sendResponse);
    return true;
  }
  if (message.type === "DEACTIVATE_LICENSE") {
    chrome.storage.local.remove("license", () => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === "GET_LICENSE") {
    chrome.storage.local.get("license", (data) => {
      sendResponse({ license: data.license || null });
    });
    return true;
  }
  if (message.type === "FETCH_ALERTS") {
    fetchAlerts().then(sendResponse);
    return true;
  }
  if (message.type === "FETCH_INSIGHTS") {
    fetchInsights().then(sendResponse);
    return true;
  }
  if (message.type === "SAVE_ALERTS") {
    saveAlerts(message.payload).then(sendResponse);
    return true;
  }
  if (message.type === "START_SCAN") {
    // Clear existing seats for this game so the scan gives a fresh snapshot
    const perfId = message.performanceId;
    const site = message.site || "resale";
    const gameKey = `${site}:${perfId}`;
    if (perfId) {
      getStorage().then((data) => {
        const games = data.games || {};
        if (games[gameKey]) {
          games[gameKey].seats = {};
          chrome.storage.local.set({ games }, () => {
            notifyDataUpdated();
          });
        }
      });
    }
    sendScanToTab(message.productId, message.performanceId, tabId, true);
  }
  if (message.type === "START_TICKETMASTER_SCAN") {
    const eventId = message.eventId;
    if (!eventId) return;
    const gameKey = `ticketmaster:${eventId}`;
    // Clear existing seats so the scan gives a fresh snapshot, matching the
    // FIFA START_SCAN path above.
    getStorage().then((data) => {
      const games = data.games || {};
      if (games[gameKey]) {
        games[gameKey].seats = {};
        chrome.storage.local.set({ games }, () => notifyDataUpdated());
      }
    });
    const msg = {
      type: "START_TICKETMASTER_SCAN",
      eventId,
      force: !!message.force,
    };
    if (tabId) {
      chrome.tabs.sendMessage(tabId, msg);
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, msg);
      });
    }
  }
  if (message.type === "SCAN_PROGRESS") {
    // Forward progress to popup immediately (non-blocking)
    chrome.runtime.sendMessage({
      type: "SCAN_PROGRESS",
      performanceId: message.performanceId,
      completed: message.completed,
      total: message.total,
      status: message.status,
      eta: message.eta,
    }).catch(() => {});

    // Resolve gameKey — may need async storage lookup
    const resolveGameKey = () => {
      const cached = tabId ? tabGameMap[tabId] : null;
      if (cached) return Promise.resolve(cached);
      if (!message.performanceId) return Promise.resolve(null);
      // Fallback: check storage for which site has this perfId
      return getStorage().then((data) => {
        const games = data.games || {};
        const lmsKey = `lms:${message.performanceId}`;
        const resaleKey = `resale:${message.performanceId}`;
        const resolved = games[lmsKey] ? lmsKey : games[resaleKey] ? resaleKey : null;
        if (resolved && tabId) tabGameMap[tabId] = resolved;
        return resolved;
      });
    };

    resolveGameKey().then((gameKey) => {
      if (!gameKey) return;

      // Track scan timing
      if (message.completed === 0 && message.status === "scanning") {
        scanStartTimes[gameKey] = Date.now();
      }

      // Sync to Supabase when scan completes
      if (message.status === "done") {
        const startTime = scanStartTimes[gameKey];
        const durationMs = startTime ? Date.now() - startTime : null;
        delete scanStartTimes[gameKey];
        chrome.storage.local.set({ lastScanTime: Date.now() });
        syncToSupabase(gameKey, durationMs);
      }
    });
  }
});

async function processApiResponse(url, body, tabId, eventInfo) {
  if (!body) return;

  const site = siteFromUrl(url);

  // Match info
  if (url.includes("google-ecommerce-detail") && body.ecommerceViewProduct) {
    const perfId = String(body.ecommerceViewProduct.performanceId);
    await enforceGameLimit(`${site}:${perfId}`);
    await saveMatchInfo(body.ecommerceViewProduct, tabId, site);
  }

  // Availability / price ranges
  if (url.includes("seatmap/availability") && body.priceRangeCategories) {
    const perfId = extractParam(url, "perfId");
    if (perfId) {
      await enforceGameLimit(`${site}:${perfId}`);
      await saveAvailability(perfId, body, tabId, site);
    }
  }

  // Individual seats
  if (url.includes("seats/free") && body.features) {
    const perfId = extractParam(url, "performanceId");
    const prodId = extractParam(url, "productId");
    if (perfId) {
      await enforceGameLimit(`${site}:${perfId}`);
      await saveSeats(perfId, body.features, tabId, site);
      if (prodId) {
        await saveProductId(perfId, prodId, site);
      }
    }
  }

  // Config — also has productId — auto-trigger scan
  if (url.includes("seatmap/config")) {
    const perfId = extractParam(url, "performanceId");
    const prodId = extractParam(url, "productId");
    if (perfId && prodId) {
      await enforceGameLimit(`${site}:${perfId}`);
      await saveProductId(perfId, prodId, site);
      autoScan(perfId, prodId, tabId, site);
    }
  }

  // Ticketmaster facets
  if (site === "ticketmaster" && url.includes("/api/ismds/event/")) {
    // Same id rule as the adapter and the popup. This was [A-F0-9]+, which
    // matches nothing in "Z7r9jZ1A7-3jg" — so eventId came back null, the
    // branch did nothing, and because every log lives inside the save function
    // the service worker console stayed completely empty. A silent skip is the
    // worst possible failure: it looks identical to the message never arriving.
    const eventIdMatch = url.match(/\/event\/([A-Za-z0-9_-]{8,})/);
    const eventId = eventIdMatch ? eventIdMatch[1] : null;

    // hal+json nests the payload, so accept either shape.
    const facets = body && (Array.isArray(body.facets) ? body.facets
      : (body._embedded && Array.isArray(body._embedded.facets) ? body._embedded.facets : null));

    if (eventId && facets) {
      await enforceGameLimit(`${site}:${eventId}`);
      await saveTicketmasterSeats(eventId, Object.assign({}, body, { facets }),
        tabId, site, eventInfo);
    } else {
      // Never skip in silence again: say which half was missing, and what the
      // payload actually looked like.
      bgLog(`[background] Ticketmaster: not parsed — ` +
        `${eventId ? `id ${eventId}` : "NO event id from " + url.split("?")[0]}, ` +
        `${facets ? `${facets.length} facets` : "NO facets array"}. ` +
        `Payload was ${describeShape(body, 3)}`);
    }
  }

  // TickPick listings — captured passively from the page's own API call.
  if (site === "tickpick" && url.includes("/listings/internal/event-v2/") && Array.isArray(body.listings)) {
    const m = url.match(/event-v2\/(\d+)/);
    const eventId = m ? m[1] : String((body.listings[0] || {}).eid || "");
    if (eventId) {
      await enforceGameLimit(`${site}:${eventId}`);
      await saveTickPickSeats(eventId, body, tabId, site, eventInfo);
    }
  }

  // AXS — bring-up only. No parser yet: the inventory payload has not been
  // observed, and inventing field names for a shape nobody has seen is how the
  // Evenue integration lost several rounds. Report what arrives, once per
  // distinct shape, so one load names the endpoint and its structure.
  if (site === "axs") {
    const path = url.split("?")[0];
    // The start-flow payload is ~611KB; a five-level shape of it is long but
    // bounded (eight keys per level), and truncating keeps one response from
    // eating the whole 1000-line log buffer.
    const shape = describeShape(body, 5).slice(0, 2000);
    const seen = path + " " + shape;
    if (!axsSeenShapes.has(seen)) {
      axsSeenShapes.add(seen);
      const size = (() => {
        try { return Math.round(JSON.stringify(body).length / 1024) + "KB"; }
        catch (e) { return "?"; }
      })();
      bgLog(`[background] AXS: ${path} (${size}) -> ${shape}`);
    }
  }

  // Evenue seat availability — captured passively. Matched on the payload
  // shape rather than an exact path: the endpoint was confirmed on one
  // school's instance and Paciolan builds differ between schools, so pinning
  // the full path made a near-miss look like an event with no seats.
  if (site === "evenue" && url.includes("/pac-api/") && Array.isArray(body)) {
    const eventId = evenueEventIdFromUrl(url);
    if (eventId) {
      await enforceGameLimit(`${site}:${eventId}`);
      await saveEvenueSeats(eventId, body, tabId, site, eventInfo);
    } else {
      bgLog(`[background] Evenue: array payload on ${url.split("?")[0]} but no ` +
        `event id in the url — add its shape to evenueEventIdFromUrl()`);
    }
  } else if (site === "evenue" && url.includes("/pac-api/")
             && evenueFindEventDetails(body).length) {
    await saveEvenuePriceLevels(evenueFindEventDetails(body), tabId, site, eventInfo);
  } else if (site === "evenue" && url.includes("/pac-api/")) {
    // Not an array, so not the seat payload. Name it once per path: on a school
    // whose inventory arrives some other way this is the only breadcrumb, but
    // Paciolan's page makes ~18 GraphQL calls to /pac-api/consumer/gql and
    // logging each would bury everything else.
    // Dedupe on path + shape, not path alone: Paciolan sends every GraphQL
    // query to the same /pac-api/consumer/gql, so keying on the path would
    // report the first operation and hide the rest — including, possibly, the
    // price-level table a school uses instead of an inline price.
    const path = url.split("?")[0];
    // "TIERED FEES" is the per-ticket fee table. It arrives as a string, so the
    // shape dump only ever says "string" — print the value itself, once, so the
    // provisional FEE_FLAT_BY_SITE constant in popup.js can be replaced by the
    // real per-event figure.
    evenueLogFeeTable(body);
    const shape = describeShape(body, 5);
    const seen = path + " " + shape;
    if (!evenueIgnoredPaths.has(seen)) {
      evenueIgnoredPaths.add(seen);
      bgLog(`[background] Evenue: ignoring ${path} -> ${shape} ` +
        `(not the seat array; repeats of this shape stay quiet)`);
    }
  }

  // StubHub: report what every captured response actually holds.
  //
  // The page reports 591 listings for the event but the detail endpoint only
  // ever answers with the ten it was asked for, and re-posting without
  // ListingIds returns nothing. One response on this path is 215KB, which is
  // far more than ten listings should need — so the rest may be present under
  // a key nobody is reading. Count every top-level array so that is visible
  // instead of inferred.
  if (site === "stubhub" && body && typeof body === "object" && !Array.isArray(body)) {
    const arrays = Object.keys(body)
      .filter((k) => Array.isArray(body[k]))
      .map((k) => `${k}=${body[k].length}`);
    const numbers = Object.keys(body)
      .filter((k) => typeof body[k] === "number" && /total|count|available/i.test(k))
      .map((k) => `${k}=${body[k]}`);
    const signature = arrays.join(",") + "|" + numbers.join(",");
    if (arrays.length && !stubhubSeenShapes.has(signature)) {
      stubhubSeenShapes.add(signature);
      let size = "?";
      try { size = Math.round(JSON.stringify(body).length / 1024) + "KB"; } catch (e) {}
      bgLog(`[background] StubHub: response (${size}) arrays: ${arrays.join(", ")}` +
        (numbers.length ? ` | counts: ${numbers.join(", ")}` : ""));
      // Name the shape of the biggest array that is not `items` — if the full
      // set is hiding anywhere, it is there.
      const biggest = Object.keys(body)
        .filter((k) => Array.isArray(body[k]) && k !== "items")
        .sort((a, b) => body[b].length - body[a].length)[0];
      if (biggest && body[biggest].length) {
        bgLog(`[background] StubHub: ${biggest}[0] -> ${describeShape(body[biggest][0], 3)}`);
      }
    }
  }

  // StubHub listings — captured passively. The response comes back on the
  // event page's own path with a query string, so the body shape is what
  // identifies it, not the url.
  // Two shapes from the same endpoint: the page's own request answers with
  // {items:[...]}, a ListingIds request answers with a bare array of the same
  // listing objects. Accept either.
  const stubHubListings = site === "stubhub"
    ? (Array.isArray(body) ? body : (Array.isArray(body.items) ? body.items : null))
    : null;

  if (stubHubListings && stubHubListings.length) {
    const eventId = extractParam(url, "eventId")
      || (url.match(/\/event\/(\d+)/i) || [])[1]
      || String(stubHubListings[0].eventId || "");
    if (eventId) {
      await enforceGameLimit(`${site}:${eventId}`);
      await saveStubHubSeats(eventId, { items: stubHubListings }, tabId, site, eventInfo);
    }
  }

  // SeatGeek listings — captured passively from the page's own request.
  if (site === "seatgeek" && url.includes("/api/event_listings_v2") && Array.isArray(body.listings)) {
    // The event id is the `id` query param; fall back to the `e` field the
    // listings themselves carry.
    const eventId = extractParam(url, "id") || String(body.listings[0]?.e || "");
    if (eventId) {
      await enforceGameLimit(`${site}:${eventId}`);
      await saveSeatGeekSeats(eventId, body, tabId, site, eventInfo);
    }
  }

  notifyDataUpdated();
}

// ─── Ticketmaster place decoding ──────────────────────────────────────────
// The facets endpoint returns one entry per (section, offer, attribute) group,
// with its seats packed into a `places` string under `compress=places`. Two
// layers have to come off before we have individual seats:
//
//   1. Bracket expansion. "A[B,C]" is A+B and A+C, and groups nest
//      arbitrarily: "GEYDCORUGA5D[C[NY,O[A,I]],EMA]" is 4 places.
//   2. Base32 (RFC 4648, unpadded). Each expanded id decodes to the string
//      "<section>:<row>:<seat>" — e.g. "GEYDAORTGE5DEMY" -> "100:31:23".
//
// Verified against this event's own response: every facet's expanded place
// count matched its reported `count`.
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function expandPlaces(str) {
  if (typeof str !== "string" || str === "") return [];
  let i = 0;

  function parseSeq(nested) {
    let results = [""];
    let lit = "";
    const flush = () => {
      if (lit) { results = results.map((r) => r + lit); lit = ""; }
    };
    while (i < str.length) {
      const c = str[i];
      if (nested && (c === "]" || c === ",")) break;
      if (c === "[") {
        flush();
        i++; // consume "["
        const alts = [];
        for (;;) {
          alts.push(...parseSeq(true));
          if (str[i] === ",") { i++; continue; }
          if (str[i] === "]") { i++; }
          break;
        }
        const combined = [];
        for (const r of results) for (const a of alts) combined.push(r + a);
        results = combined;
        continue;
      }
      lit += c;
      i++;
    }
    flush();
    return results;
  }

  return parseSeq(false);
}

function decodeBase32(s) {
  let bits = "";
  for (const c of s) {
    const idx = B32_ALPHABET.indexOf(c);
    if (idx < 0) return null;
    bits += idx.toString(2).padStart(5, "0");
  }
  let out = "";
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    out += String.fromCharCode(parseInt(bits.slice(i, i + 8), 2));
  }
  return out;
}

// "GEYDAORTGE5DEMY" -> { section: "100", row: "31", seat: "23" }
function decodePlaceId(placeId) {
  const decoded = decodeBase32(placeId);
  if (!decoded) return null;
  const parts = decoded.split(":");
  if (parts.length < 3) return null;
  return { section: parts[0], row: parts[1], seat: parts[2] };
}

// Price comes off the facet itself: `listPriceRange` is an array of
// { currency, min, max } in whole currency units (dollars, not cents) —
// e.g. [{ "currency": "USD", "min": 371.00, "max": 371.00 }]. A facet groups
// identically-priced listings, so min and max are usually equal; we take min.
//
// Confirmed against a live 2026-08-13 capture of event 0700646BCF6088AD.
function facetListPrice(facet, currency = "USD") {
  const ranges = facet?.listPriceRange;
  if (!Array.isArray(ranges) || ranges.length === 0) return null;
  // Prefer the requested currency; fall back to the first entry if the event
  // is priced in something else entirely.
  const match = ranges.find((r) => r?.currency === currency) || ranges[0];
  const n = match?.min ?? match?.max;
  return typeof n === "number" && isFinite(n) && n > 0 ? n : null;
}

// Fallback for responses where the facet carries no listPriceRange: prices may
// also appear in _embedded.offer, keyed by the ids in each facet's `offers`.
// Field naming there is not pinned down, so probe the plausible spellings and
// fall back to the first numeric value that looks like a price.
function buildOfferPriceMap(facetsData) {
  const map = {};
  const offers = facetsData?._embedded?.offer;
  if (!Array.isArray(offers)) return map;

  const pick = (o) => {
    const candidates = [
      o?.totalPrice, o?.total, o?.faceValue,
      o?.listPrice, o?.price, o?.amount,
      o?.prices?.total, o?.prices?.listPrice,
    ];
    for (const c of candidates) {
      const n = typeof c === "object" && c !== null ? c.value ?? c.amount : c;
      if (typeof n === "number" && isFinite(n) && n > 0) return n;
    }
    return null;
  };

  for (const o of offers) {
    const id = o?.offerId || o?.id;
    if (!id) continue;
    const p = pick(o);
    if (p != null) map[id] = p;
  }
  return map;
}

// Save Ticketmaster seat data from facets
async function saveTicketmasterSeats(eventId, facetsData, tabId, site, eventInfo) {
  if (!facetsData || !Array.isArray(facetsData.facets)) return;

  const gameKey = `${site}:${eventId}`;
  const data = await getStorage();
  const games = data.games || {};

  if (!games[gameKey]) games[gameKey] = emptyGame();

  // Same shape saveMatchInfo() builds for FIFA, so the popup header and the
  // CSV export read it without caring which site it came from. Only overwrite
  // when the page actually yielded a name — a later scan that failed to read
  // the DOM shouldn't wipe a good value.
  if (eventInfo && eventInfo.name) {
    // Merge rather than replace. The DOM read can come back with a name but no
    // date or venue — that is exactly what happens after an in-page navigation,
    // when stale JSON-LD is skipped and the name falls back to document.title.
    // Overwriting outright would null the venue and silently drop this event
    // back to heuristic tiers. gameKey is per-event, so what is already stored
    // belongs to this same event and is safe to keep.
    const prev = games[gameKey].match || {};
    games[gameKey].match = {
      name: eventInfo.name,
      date: eventInfo.date || prev.date || null,
      venue: eventInfo.venue || prev.venue || null,
      currency: "USD",
      performanceId: eventId,
    };
  }

  // Venue for seat tiering. Read it back off the game rather than eventInfo so a
  // scan whose DOM read failed still tiers using the venue an earlier scan got.
  // Null is fine — tierFor() falls back to the section-text heuristic.
  const venueName = games[gameKey].match && games[gameKey].match.venue;
  logTierMapping(venueName);

  // descriptionId -> human text ("Lower level of stadium")
  const descriptions = {};
  for (const d of facetsData?._embedded?.description || []) {
    if (d?.descriptionId) {
      descriptions[d.descriptionId] = (d.descriptions || []).join(", ");
    }
  }
  const offerPrices = buildOfferPriceMap(facetsData);

  // Expand every facet into individual seats matching the shape the dashboard
  // already consumes: { block, row, seat, area, category, price, exclusive }.
  // block/row/seat must be strings — the cluster sort calls localeCompare.
  const seats = {};
  let missingPrice = 0;
  const offerSpread = [];
  try {
    for (const facet of facetsData.facets) {
      if (facet.available === false) continue;

      const area = descriptions[facet.description] || "";
      const category = (facet.inventoryTypes || [])[0] || "standard";
      // A facet can carry several offers — primary and resale, different
      // delivery or quantity rules — at different prices, and taking
      // `offers[0]` picked one arbitrarily. Use the DEAREST instead: these are
      // all-in prices, so the higher figure is what someone actually pays, and
      // reading low is the more misleading error for a buyer. `offerSpread`
      // below counts how often they disagree — on a live event it never fired,
      // so this rarely changes the number.
      const offerIds = Array.isArray(facet.offers) ? facet.offers : [];
      const offerCandidates = offerIds
        .map((id) => offerPrices[id])
        .filter((n) => typeof n === "number" && isFinite(n) && n > 0);
      if (offerCandidates.length > 1) {
        const lo = Math.min.apply(null, offerCandidates);
        const hi = Math.max.apply(null, offerCandidates);
        if (lo !== hi) {
          offerSpread.push(`${offerCandidates.length} offers ${lo}-${hi}`);
        }
      }
      const dollars = facetListPrice(facet)
        ?? (offerCandidates.length ? Math.max.apply(null, offerCandidates) : null);
      // Stored in thousandths to match centsToUSD() in the popup.
      const price = dollars != null ? Math.round(dollars * 1000) : null;
      if (price == null) missingPrice++;

      for (const compressed of facet.places || []) {
        for (const placeId of expandPlaces(compressed)) {
          const parsed = decodePlaceId(placeId);
          if (!parsed) continue;
          const block = String(parsed.section || facet.section || "");
          const row = String(parsed.row || "");
          seats[placeId] = {
            block,
            row,
            seat: String(parsed.seat || ""),
            area,
            category,
            // Parallel to `category`, which is the constant "standard" here.
            tier: VenueTiers.tierFor(venueName, block, row),
            price,
            exclusive: true,
            site: "ticketmaster",
            accessible: (facet.accessibility || []).length > 0,
            attributes: facet.attributes || [],
          };
        }
      }
    }
  } catch (error) {
    bgLog("[background] Error parsing Ticketmaster facets:", error.message);
  }

  const total = Object.keys(seats).length;
  // Why a price can be wrong, reported once per scan.
  //
  // Two candidates, and only the payload distinguishes them: `listPriceRange`
  // may be the LIST price while the site shows an all-in price, and a facet
  // whose range has min != max gets `min` applied to every seat in it.
  try {
    const priced = (facetsData.facets || []).filter((f) => Array.isArray(f.listPriceRange) && f.listPriceRange.length);
    const spread = priced.filter((f) => {
      const r = f.listPriceRange.find((x) => x && x.currency === "USD") || f.listPriceRange[0];
      return r && r.min != null && r.max != null && r.min !== r.max;
    });
    if (offerSpread.length) {
      bgLog(`[background] Ticketmaster prices: ${offerSpread.length} facet(s) carry offers ` +
        `at DIFFERENT prices — the dearest is used, so a seat sold under a cheaper ` +
        `offer will read high. e.g. ${offerSpread.slice(0, 3).join("; ")}`);
    }

    if (!priced.length) {
      // No facet carries a listPriceRange, so every price came from the offer
      // map — which picks the first plausibly-named numeric field it finds.
      // That is exactly how a price ends up close but wrong. Name the fields
      // that actually exist so the right one can be chosen instead of guessed.
      const offers = (facetsData._embedded && facetsData._embedded.offer) || [];
      bgLog(`[background] Ticketmaster prices: NO facet has listPriceRange — ` +
        `all prices came from the offer map (${offers.length} offer(s) embedded), ` +
        `which guesses at field names.`);
      const offer = offers[0];
      if (offer) {
        const numeric = Object.keys(offer).filter((k) => typeof offer[k] === "number");
        const nested = Object.keys(offer).filter((k) => offer[k] && typeof offer[k] === "object");
        bgLog(`[background] Ticketmaster prices: offer numeric fields: ` +
          numeric.map((k) => `${k}=${offer[k]}`).join(", ") || "(none)");
        nested.forEach((k) => {
          bgLog(`[background] Ticketmaster prices: offer.${k} = ` +
            JSON.stringify(offer[k]).slice(0, 300));
        });
      }
    }

    const sample = priced[0];
    if (sample) {
      const priceKeys = Object.keys(sample).filter((k) => /price|amount|fee|total/i.test(k));
      bgLog(`[background] Ticketmaster prices: ${priced.length} facet(s) with a range, ` +
        `${spread.length} where min != max (those get min applied to every seat). ` +
        `Price-ish fields on a facet: ${priceKeys.join(", ") || "(none)"}`);
      priceKeys.forEach((k) => {
        bgLog(`[background] Ticketmaster prices: sample ${k} = ` +
          `${JSON.stringify(sample[k]).slice(0, 300)}`);
      });
    }
  } catch (e) { /* diagnostics must never break a scan */ }

  bgLog(`[background] Ticketmaster: ${total} seats parsed` +
    (missingPrice ? `, ${missingPrice} facets had no resolvable price` : ""));

  games[gameKey].seats = { ...games[gameKey].seats, ...seats };
  games[gameKey].site = site;
  games[gameKey].lastScanned = Date.now();

  // tabGameMap is the module-level in-memory map every other save path uses;
  // it is deliberately not persisted to storage.
  if (tabId) tabGameMap[tabId] = gameKey;
  await chrome.storage.local.set({ games });
}

// ─── SeatGeek listings ────────────────────────────────────────────────────
// One entry per listing, with short field names. Confirmed against a live
// capture of event 18014270 (979 listings):
//
//   s/sf/sr  section — "242" / "Section 242" / "242"
//   r/rf/rr  row     — "2"   / "Row 2"       / "2"
//   ss       seat numbers, e.g. ["3","4"] (present because the page requests
//            `_include_seats=1`; absent on listings that don't expose seats)
//   q        quantity
//   p        base price per ticket   (850)
//   f        fees per ticket         (145.25)
//   pf       all-in price per ticket (995.25 = p + f)
//
// `pf` is what we store: it matches the all-in convention Ticketmaster uses,
// which is why FEE_MULTIPLIER_BY_SITE leaves seatgeek at 1.0.
function seatGeekPrice(listing) {
  const candidates = [listing.pf, listing.p != null && listing.f != null ? listing.p + listing.f : null, listing.p];
  for (const c of candidates) {
    if (typeof c === "number" && isFinite(c) && c > 0) return c;
  }
  return null;
}

async function saveSeatGeekSeats(eventId, body, tabId, site, eventInfo) {
  if (!body || !Array.isArray(body.listings)) return;

  const gameKey = `${site}:${eventId}`;
  const data = await getStorage();
  const games = data.games || {};

  if (!games[gameKey]) games[gameKey] = emptyGame();

  if (eventInfo && eventInfo.name) {
    // Merge rather than replace. The DOM read can come back with a name but no
    // date or venue — that is exactly what happens after an in-page navigation,
    // when stale JSON-LD is skipped and the name falls back to document.title.
    // Overwriting outright would null the venue and silently drop this event
    // back to heuristic tiers. gameKey is per-event, so what is already stored
    // belongs to this same event and is safe to keep.
    const prev = games[gameKey].match || {};
    games[gameKey].match = {
      name: eventInfo.name,
      date: eventInfo.date || prev.date || null,
      venue: eventInfo.venue || prev.venue || null,
      currency: body.currency || "USD",
      performanceId: eventId,
    };
  }

  // Venue for seat tiering. Read it back off the game rather than eventInfo so a
  // scan whose DOM read failed still tiers using the venue an earlier scan got.
  // Null is fine — tierFor() falls back to the section-text heuristic.
  const venueName = games[gameKey].match && games[gameKey].match.venue;
  logTierMapping(venueName);

  const seats = {};
  let missingPrice = 0;
  let seatless = 0;

  try {
    for (const listing of body.listings) {
      const dollars = seatGeekPrice(listing);
      if (dollars == null) { missingPrice++; continue; }
      // Stored in thousandths to match centsToUSD() in the popup.
      const price = Math.round(dollars * 1000);

      const block = String(listing.s ?? listing.sr ?? "");
      const row = String(listing.r ?? listing.rr ?? "");
      const qty = Number(listing.q) || 1;

      // `ss` gives real seat numbers. Without it we still know how many seats
      // the listing holds, so emit that many rows with a blank seat rather
      // than dropping inventory the dashboard should be counting.
      const seatNumbers = Array.isArray(listing.ss) && listing.ss.length
        ? listing.ss.map(String)
        : (seatless++, Array.from({ length: qty }, () => ""));

      seatNumbers.forEach((seatNo, i) => {
        // Listing ids are unique; index disambiguates seats within one.
        const key = `${listing.id || `${block}-${row}`}-${seatNo || i}`;
        seats[key] = {
          block,
          row,
          seat: String(seatNo),
          area: listing.sf || "",
          category: listing.m || "resale",
          // Parallel to `category`, which is a marketplace constant here.
          tier: VenueTiers.tierFor(venueName, block, row),
          price,
          exclusive: true,
          site: "seatgeek",
          accessible: false,
          attributes: [],
        };
      });
    }
  } catch (error) {
    bgLog("[background] Error parsing SeatGeek listings:", error.message);
  }

  const total = Object.keys(seats).length;
  bgLog(`[background] SeatGeek: ${total} seats from ${body.listings.length} listings` +
    (missingPrice ? `, ${missingPrice} had no price` : "") +
    (seatless ? `, ${seatless} had no seat numbers` : ""));

  games[gameKey].seats = { ...games[gameKey].seats, ...seats };
  games[gameKey].site = site;
  games[gameKey].lastScanned = Date.now();

  if (tabId) tabGameMap[tabId] = gameKey;
  await chrome.storage.local.set({ games });
}

// ─── StubHub listings ─────────────────────────────────────────────────────
// One entry per listing under `items`. Confirmed against a live capture of
// event 160425133:
//
//   section        "319"      block
//   row            "14"       row
//   seatFrom/To    "13"/"13"  seat range (inclusive); `seat` is "13_13"
//   availableTickets 1        how many tickets the listing holds
//   rawPrice       152.16     numeric per-ticket price
//   price          "$152"     rawPrice floored, display only
//   formattedTotalPrice "$153" rawPrice ceiled, display only
//   ticketClassName "Upper"   zone label
//
// `rawPrice` is the only numeric price, so it is what we store. It is
// fee-inclusive (confirmed against the site 2026-08-18), which is why
// FEE_MULTIPLIER_BY_SITE leaves stubhub at 1.0 — the empty `formattedFees`
// on the captured listing is not evidence of missing fees.
function stubHubPrice(item) {
  const candidates = [item.rawPrice, item.faceValue];
  for (const c of candidates) {
    const n = typeof c === "string" ? parseFloat(c) : c;
    if (typeof n === "number" && isFinite(n) && n > 0) return n;
  }
  return null;
}

// Seat numbering is only trustworthy when the range agrees with the ticket
// count. Three real cases, confirmed against live listings:
//
//   13..16, 4 tickets  -> contiguous:      13,14,15,16
//   13..17, 3 tickets  -> odd/even seats:  13,15,17   (step 2)
//   13..18, 3 tickets  -> neither fits; do NOT invent numbers. Keep the seats
//                         blank and carry "13-18" through as a range instead.
//
// Many StubHub listings expose no seat numbers at all, which is normal and
// also lands in the blank case.
function stubHubSeatNumbers(item) {
  const count = Number(item.availableTickets) || 1;
  const from = parseInt(item.seatFrom, 10);
  const to = parseInt(item.seatTo, 10);
  const blanks = Array.from({ length: count }, () => "");

  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return blanks;

  const span = to - from;
  if (span + 1 === count) {
    const out = [];
    for (let n = from; n <= to; n++) out.push(String(n));
    return out;
  }
  // Odd/even seating: same side of the aisle, every other seat.
  if (count > 1 && span === 2 * (count - 1)) {
    const out = [];
    for (let n = from; n <= to; n += 2) out.push(String(n));
    return out;
  }
  return blanks;
}

// "13-18" when the seats could not be enumerated, so the range still reaches
// the dashboard and the CSV instead of being dropped.
function stubHubSeatRange(item) {
  const from = parseInt(item.seatFrom, 10);
  const to = parseInt(item.seatTo, 10);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return "";
  return from === to ? String(from) : `${from}-${to}`;
}

async function saveStubHubSeats(eventId, body, tabId, site, eventInfo) {
  if (!body || !Array.isArray(body.items)) return;

  const gameKey = `${site}:${eventId}`;
  const data = await getStorage();
  const games = data.games || {};

  if (!games[gameKey]) games[gameKey] = emptyGame();

  if (eventInfo && eventInfo.name) {
    // Merge rather than replace. The DOM read can come back with a name but no
    // date or venue — that is exactly what happens after an in-page navigation,
    // when stale JSON-LD is skipped and the name falls back to document.title.
    // Overwriting outright would null the venue and silently drop this event
    // back to heuristic tiers. gameKey is per-event, so what is already stored
    // belongs to this same event and is safe to keep.
    const prev = games[gameKey].match || {};
    games[gameKey].match = {
      name: eventInfo.name,
      date: eventInfo.date || prev.date || null,
      venue: eventInfo.venue || prev.venue || null,
      currency: (body.items[0] && body.items[0].buyerCurrencyCode) || "USD",
      performanceId: eventId,
    };
  }

  // Venue for seat tiering. Read it back off the game rather than eventInfo so a
  // scan whose DOM read failed still tiers using the venue an earlier scan got.
  // Null is fine — tierFor() falls back to the section-text heuristic.
  const venueName = games[gameKey].match && games[gameKey].match.venue;
  logTierMapping(venueName);

  const seats = {};
  let missingPrice = 0;
  let seatless = 0;

  try {
    for (const item of body.items) {
      const dollars = stubHubPrice(item);
      if (dollars == null) { missingPrice++; continue; }
      // Stored in thousandths to match centsToUSD() in the popup.
      const price = Math.round(dollars * 1000);

      const block = String(item.section != null ? item.section : item.sectionMapName || "");
      const row = String(item.row != null ? item.row : "");
      const nums = stubHubSeatNumbers(item);
      const range = stubHubSeatRange(item);
      if (!nums[0]) seatless++;

      nums.forEach((seatNo, i) => {
        const key = `${item.listingId || item.id || `${block}-${row}`}-${seatNo || i}`;
        seats[key] = {
          block,
          row,
          seat: String(seatNo),
          // Only meaningful when `seat` is blank; harmless duplication when not.
          seatRange: seatNo ? "" : range,
          area: item.ticketClassName || "",
          category: "resale",
          // Parallel to `category`, which is a marketplace constant here.
          tier: VenueTiers.tierFor(venueName, block, row),
          price,
          exclusive: true,
          site: "stubhub",
          accessible: false,
          attributes: [],
        };
      });
    }
  } catch (error) {
    bgLog("[background] Error parsing StubHub listings:", error.message);
  }

  const total = Object.keys(seats).length;
  bgLog(`[background] StubHub: ${total} seats from ${body.items.length} listings` +
    (missingPrice ? `, ${missingPrice} had no price` : "") +
    (seatless ? `, ${seatless} had no seat numbers` : ""));

  games[gameKey].seats = { ...games[gameKey].seats, ...seats };
  games[gameKey].site = site;
  games[gameKey].lastScanned = Date.now();

  if (tabId) tabGameMap[tabId] = gameKey;
  await chrome.storage.local.set({ games });
}

// The event id out of a Paciolan api url. Several shapes because schools run
// different builds; all normalise to the "<season>:<code>" the adapter and the
// popup both use, dropping any leading venue/distributor segment
// ("977:F26:02" -> "F26:02").
function evenueEventIdFromUrl(url) {
  const path = String(url || "");

  const tagged = path.match(/event-id\/([^/?]+)/)
    || path.match(/[?&]event-?[iI]d=([^&]+)/);
  if (tagged) {
    return decodeURIComponent(tagged[1]).split(":").slice(-2).join(":");
  }

  // Colon-joined id sitting bare in the path, url-encoded or not.
  const bare = decodeURIComponent(path).match(/\/(\w+:\w+(?::\w+)?)(?:[/?]|$)/);
  if (bare) return bare[1].split(":").slice(-2).join(":");

  return "";
}

// Is this row's AVAILABLE value a yes?
//
// Numeric values keep the original rule exactly — only 1 counts — so this
// cannot change the school this was built against. The string tokens are for
// builds that spell the flag out; treating "Y" as NaN made every seat read as
// unavailable, which is indistinguishable from a sold-out event.
const EVENUE_AVAILABLE_TOKENS = new Set(["Y", "YES", "TRUE", "T", "A", "AVAILABLE", "O", "OPEN"]);

function evenueIsAvailable(value) {
  if (value === true) return true;
  const s = String(value == null ? "" : value).trim().toUpperCase();
  if (!s) return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s) === 1;
  return EVENUE_AVAILABLE_TOKENS.has(s);
}

// ─── Evenue price levels ──────────────────────────────────────────────────
// Some Paciolan builds leave SLP_PRICE null on every seat row and carry price
// in a separate GraphQL payload keyed by price level — Virginia Tech does,
// Kansas does not. `PRICELEVELCD` on the seat row is the join key.
//
// The container is data.discovery.eventDetailMPT[]. Its inner shape is not
// documented anywhere we can see, so the walk below accepts whatever it finds
// and the raw shape is logged when nothing usable comes out.

// Seat payloads held in memory so prices arriving AFTER the seats can still be
// applied. Best-effort: the service worker may be evicted, in which case a
// reload re-sends both. Keyed by gameKey, one entry each, so a long session
// cannot grow this without bound.
const evenuePendingSeats = new Map();

// Collect priceLevel -> price from an arbitrarily nested structure. Prices are
// whatever positive numbers sit alongside a price-level-looking key.
function evenueCollectPrices(node, out, depth) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    node.forEach((n) => evenueCollectPrices(n, out, depth + 1));
    return;
  }
  if (typeof node !== "object") return;

  // Shape A: a row carrying both the level and the price as fields.
  const levelField = ["PRICELEVELCD", "PRICE_LEVEL", "PL", "PRICELEVEL", "PLCD"]
    .find((k) => node[k] !== undefined && node[k] !== null);
  if (levelField) {
    const level = String(node[levelField]).trim();
    const priceField = ["PRICE", "AMOUNT", "AMT", "PRICE_AMT", "TICKET_PRICE", "PT_PRICE"]
      .find((k) => isFinite(Number(node[k])) && Number(node[k]) > 0);
    if (level && priceField) {
      const n = Number(node[priceField]);
      if (!out.has(level) || n < out.get(level)) out.set(level, n);
      return;
    }
  }

  // Shape B: keyed by price level -> price, or -> { priceType: price }.
  Object.keys(node).forEach((key) => {
    const value = node[key];
    const level = String(key).trim();
    // Paciolan price-level codes are short — "1", "12", "A", "AA". Anything
    // longer is a container name, and treating one as a level both invents a
    // bogus level and stops the walk before the real ones.
    const looksLikeLevel = /^[A-Za-z0-9]{1,3}$/.test(level);
    if (looksLikeLevel && isFinite(Number(value)) && Number(value) > 0) {
      const n = Number(value);
      if (!out.has(level) || n < out.get(level)) out.set(level, n);
      return;
    }
    if (looksLikeLevel && value && typeof value === "object" && !Array.isArray(value)) {
      // price-type map: take the cheapest price offered at this level. Every
      // value must be a price — a mixed object is a container, not a level.
      const inner = Object.keys(value);
      const nums = inner.map((k) => Number(value[k])).filter((n) => isFinite(n) && n > 0);
      if (inner.length && nums.length === inner.length) {
        const n = Math.min.apply(null, nums);
        if (!out.has(level) || n < out.get(level)) out.set(level, n);
        return;
      }
    }
    evenueCollectPrices(value, out, depth + 1);
  });
}

// Paciolan quotes some fields in cents and others in dollars, and getting it
// wrong is a 100x error on screen. Decide once for the whole map, from the
// shape of the numbers, and say which way it went.
function evenuePriceScale(values) {
  if (!values.length) return { divisor: 1, note: "no values" };
  const anyDecimal = values.some((n) => !Number.isInteger(n));
  if (anyDecimal) return { divisor: 1, note: "decimals present -> dollars" };
  const max = Math.max.apply(null, values);
  if (max >= 2000) return { divisor: 100, note: `max ${max} >= 2000 -> cents` };
  return { divisor: 1, note: `max ${max} < 2000 -> dollars` };
}

// Find the price-carrying rows anywhere in a GraphQL body.
//
// Matched on CONTENT, not on a path. Paciolan names its GraphQL result keys
// with a space in them — the container is literally `data["discovery
// eventDetailMPT"]`, not `data.discovery.eventDetailMPT` — so walking a fixed
// path silently found nothing and the payload was logged as unrecognised.
function evenueFindEventDetails(body) {
  const found = [];
  const seen = new Set();

  const carriesPrices = (e) => e && typeof e === "object" && !Array.isArray(e)
    && (e.PL_PT_PRICES !== undefined
        || (e.SEASONCD !== undefined && e.ITEMCD !== undefined));

  (function walk(node, depth) {
    if (!node || typeof node !== "object" || depth > 6) return;
    if (Array.isArray(node)) {
      if (node.length && node.some(carriesPrices)) {
        node.forEach((e) => {
          if (carriesPrices(e) && !seen.has(e)) { seen.add(e); found.push(e); }
        });
        return;
      }
      node.forEach((n) => walk(n, depth + 1));
      return;
    }
    if (carriesPrices(node) && !seen.has(node)) { seen.add(node); found.push(node); return; }
    Object.keys(node).forEach((k) => walk(node[k], depth + 1));
  })(body, 0);

  return found;
}

// eventId out of the GraphQL payload itself: "F26" + "01" -> "F26:01", the
// same id the seat url and the adapter produce.
function evenueEventIdFromDetail(detail) {
  const season = detail && (detail.SEASONCD || detail.seasoncd);
  const item = detail && (detail.ITEMCD || detail.itemcd);
  if (!season || !item) return "";
  return `${String(season).trim()}:${String(item).trim()}`;
}

// Print any fee-looking field once, whatever it is nested under. Paciolan keys
// its GraphQL results with spaces ("maps eventMap"), so this matches on the key
// name containing "FEE" rather than on a path.
const evenueFeeSeen = new Set();

function evenueLogFeeTable(node, depth) {
  if (!node || typeof node !== "object" || (depth || 0) > 6) return;
  if (Array.isArray(node)) {
    node.forEach((n) => evenueLogFeeTable(n, (depth || 0) + 1));
    return;
  }
  Object.keys(node).forEach((key) => {
    const value = node[key];
    if (/FEE/i.test(key) && (typeof value === "string" || typeof value === "number")) {
      const line = `${key} = ${String(value).slice(0, 800)}`;
      if (!evenueFeeSeen.has(line)) {
        evenueFeeSeen.add(line);
        bgLog(`[background] Evenue: fee field ${line}`);
      }
      return;
    }
    evenueLogFeeTable(value, (depth || 0) + 1);
  });
}

// AXS payload shapes already reported, so bring-up logs each once rather than
// once per response.
const axsSeenShapes = new Set();

// Same, for the StubHub array census.
const stubhubSeenShapes = new Set();

// Paths already reported as "not the seat array", so the log names each once.
const evenueIgnoredPaths = new Set();

async function saveEvenuePriceLevels(details, tabId, site, eventInfo) {
  for (const detail of details) {
    const eventId = evenueEventIdFromDetail(detail);
    if (!eventId) continue;

    const collected = new Map();
    evenueCollectPrices(detail.PL_PT_PRICES !== undefined ? detail.PL_PT_PRICES : detail,
                        collected, 0);
    if (!collected.size) {
      bgLog(`[background] Evenue: ${eventId} price payload yielded no levels — ` +
        `shape was ${describeShape(detail.PL_PT_PRICES, 4)}`);
      continue;
    }

    const scale = evenuePriceScale([...collected.values()]);
    const levels = {};
    collected.forEach((n, level) => {
      // Storage is thousandths of a dollar, matching centsToUSD() in the popup.
      levels[level] = Math.round((n / scale.divisor) * 1000);
    });

    const gameKey = `${site}:${eventId}`;
    await enforceGameLimit(gameKey);
    const data = await getStorage();
    const games = data.games || {};
    if (!games[gameKey]) games[gameKey] = emptyGame();
    games[gameKey].priceLevels = Object.assign({}, games[gameKey].priceLevels, levels);
    games[gameKey].site = site;
    await chrome.storage.local.set({ games });

    const preview = Object.keys(levels).sort().slice(0, 8)
      .map((k) => `${k}=$${(levels[k] / 1000).toFixed(2)}`).join(" ");
    bgLog(`[background] Evenue: ${eventId} price levels (${Object.keys(levels).length}) ` +
      `[${scale.note}] ${preview}`);

    // Seats may already have arrived and been parked for want of a price.
    const pending = evenuePendingSeats.get(gameKey);
    if (pending) {
      evenuePendingSeats.delete(gameKey);
      bgLog(`[background] Evenue: re-parsing held seat payload for ${eventId} now prices are known`);
      await saveEvenueSeats(eventId, pending.body, pending.tabId, site, pending.eventInfo);
    }
  }
}

// ─── Evenue seat availability ─────────────────────────────────────────────
// The payload is [rows, headerNames] — 49,233 rows for KU event F26:02, each
// a positional array described by the trailing header row:
//
//   LEVELSECTIONCD  "KU:101"  section, prefixed by level
//   ROWCD           "10"      row
//   SEATCD          "1"       seat
//   PRICELEVELCD    "4"       price tier
//   SEATSTATUS      "O"/"%"   O = open; other codes are holds/sold
//   SLP_PRICE       32039     price in CENTS -> $320.39 (confirmed
//                             against the site 2026-08-18)
//   AVAILABLE       0/1       the authoritative flag
//   HIDDEN          0/1
//
// Columns are located BY NAME from the header row rather than by index, so a
// reordering upstream cannot silently shift prices into the wrong field.
function evenueColumnIndex(headers) {
  const idx = {};
  if (!Array.isArray(headers)) return idx;
  headers.forEach((h, i) => {
    if (typeof h === "string") idx[h.trim().toUpperCase()] = i;
  });
  return idx;
}

// Evenue ships the header row alongside the data, but which element it is has
// not been guaranteed, so identify it by content rather than position.
function evenueSplitPayload(body) {
  if (!Array.isArray(body)) return { rows: null, headers: null };
  const isHeader = (a) => Array.isArray(a) && a.length
    && a.every((v) => typeof v === "string")
    && a.some((v) => /^(SEATCD|ROWCD|LEVELSECTIONCD|SLP_PRICE|AVAILABLE)$/i.test(v));
  const headers = body.find(isHeader) || null;
  const rows = body.find((a) => Array.isArray(a) && a.length && Array.isArray(a[0])) || null;
  return { rows, headers };
}

async function saveEvenueSeats(eventId, body, tabId, site, eventInfo) {
  const split = evenueSplitPayload(body);
  const rows = split.rows;
  const headers = split.headers;
  if (!rows || !headers) {
    // Name what arrived. The header row is found by sniffing for known column
    // names, so a school whose columns are named differently lands here and
    // the shape is the only way to tell that from an empty event.
    bgLog(`[background] Evenue: could not find rows + header row in the payload. ` +
      `Got ${describeShape(body, 2)}; elements: ` +
      (Array.isArray(body) ? body.map((e) => describeShape(e, 1)).join(" | ") : "n/a") +
      `. rows=${rows ? "found" : "MISSING"} headers=${headers ? "found" : "MISSING"}`);
    if (Array.isArray(body)) {
      body.forEach((e, i) => {
        if (Array.isArray(e) && e.length && e.every((v) => typeof v === "string")) {
          bgLog(`[background] Evenue: element ${i} looks like column names: ` +
            e.slice(0, 20).join(", ") + (e.length > 20 ? ` …(${e.length} total)` : ""));
        }
      });
    }
    return;
  }

  const idx = evenueColumnIndex(headers);
  for (const required of ["LEVELSECTIONCD", "ROWCD", "SEATCD", "SLP_PRICE", "AVAILABLE"]) {
    if (idx[required] === undefined) {
      bgLog(`[background] Evenue: header row has no ${required} — not parsing. ` +
        `Columns present: ${Object.keys(idx).slice(0, 30).join(", ")}` +
        `${Object.keys(idx).length > 30 ? ` …(${Object.keys(idx).length} total)` : ""}`);
      return;
    }
  }

  const gameKey = `${site}:${eventId}`;
  const data = await getStorage();
  const games = data.games || {};
  if (!games[gameKey]) games[gameKey] = emptyGame();

  if (eventInfo && eventInfo.name) {
    // Merge rather than replace. The DOM read can come back with a name but no
    // date or venue — that is exactly what happens after an in-page navigation,
    // when stale JSON-LD is skipped and the name falls back to document.title.
    // Overwriting outright would null the venue and silently drop this event
    // back to heuristic tiers. gameKey is per-event, so what is already stored
    // belongs to this same event and is safe to keep.
    const prev = games[gameKey].match || {};
    games[gameKey].match = {
      name: eventInfo.name,
      date: eventInfo.date || prev.date || null,
      venue: eventInfo.venue || prev.venue || null,
      currency: "USD",
      performanceId: eventId,
    };
  }

  // Venue for seat tiering. Read it back off the game rather than eventInfo so a
  // scan whose DOM read failed still tiers using the venue an earlier scan got.
  // Null is fine — tierFor() falls back to the section-text heuristic.
  const venueName = games[gameKey].match && games[gameKey].match.venue;
  logTierMapping(venueName);

  const seats = {};
  let unavailable = 0;
  let missingPrice = 0;
  let fromPriceLevel = 0;
  const priceLevels = games[gameKey].priceLevels || {};

  // Sampled only to explain a zero-seat result: the counters say how many rows
  // were dropped but not why, and "every available seat had no price" is a
  // schema difference between schools, not an empty event.
  const availableValues = new Map();
  const pricelessSamples = [];
  const statusValues = new Map();
  let withPrice = 0;
  const pricedSamples = [];
  const pricedByAvailable = new Map();

  try {
    for (const row of rows) {
      if (!Array.isArray(row)) continue;

      const availRaw = row[idx.AVAILABLE];
      if (availableValues.size < 12) {
        const k = JSON.stringify(availRaw);
        availableValues.set(k, (availableValues.get(k) || 0) + 1);
      }
      if (idx.SEATSTATUS !== undefined && statusValues.size < 16) {
        const k = JSON.stringify(row[idx.SEATSTATUS]);
        statusValues.set(k, (statusValues.get(k) || 0) + 1);
      }
      // Which rows carry a price at all, regardless of the availability flag.
      // If sellable seats sit on AVAILABLE=0, this is what shows it.
      const rawPrice = row[idx.SLP_PRICE];
      if (rawPrice !== null && rawPrice !== undefined && rawPrice !== ""
          && isFinite(Number(rawPrice)) && Number(rawPrice) > 0) {
        withPrice++;
        const k = JSON.stringify(availRaw);
        pricedByAvailable.set(k, (pricedByAvailable.get(k) || 0) + 1);
        if (pricedSamples.length < 2) pricedSamples.push(row);
      }

      // AVAILABLE is the authoritative flag; SEATSTATUS "O" agrees with it but
      // also carries hold codes we do not need to enumerate.
      if (!evenueIsAvailable(availRaw)) { unavailable++; continue; }
      if (idx.HIDDEN !== undefined && Number(row[idx.HIDDEN]) === 1) { unavailable++; continue; }

      const cents = Number(row[idx.SLP_PRICE]);
      let price = null;
      if (isFinite(cents) && cents > 0) {
        // SLP_PRICE is cents; storage is thousandths of a dollar.
        price = Math.round((cents / 100) * 1000);
      } else if (idx.PRICELEVELCD !== undefined) {
        // No inline price on this build — join the GraphQL price-level table.
        const level = String(row[idx.PRICELEVELCD] == null ? "" : row[idx.PRICELEVELCD]).trim();
        if (level && priceLevels[level] != null) {
          price = priceLevels[level];
          fromPriceLevel++;
        }
      }
      if (price == null) {
        missingPrice++;
        if (pricelessSamples.length < 2) pricelessSamples.push(row);
        continue;
      }

      // "KU:101" -> "101". The prefix is the level, repeated on every row.
      const rawSection = String(row[idx.LEVELSECTIONCD] || "");
      const block = rawSection.includes(":") ? rawSection.split(":").pop() : rawSection;
      const rowCd = String(row[idx.ROWCD] || "");
      const seatCd = String(row[idx.SEATCD] || "");

      seats[`${block}-${rowCd}-${seatCd}`] = {
        block,
        row: rowCd,
        seat: seatCd,
        area: idx.PRICELEVELCD !== undefined ? `Price level ${row[idx.PRICELEVELCD]}` : "",
        category: "primary",
        // Parallel to `category`, which is a marketplace constant here.
        tier: VenueTiers.tierFor(venueName, block, rowCd),
        price,
        exclusive: true,
        site: "evenue",
        accessible: false,
        attributes: [],
      };
    }
  } catch (error) {
    bgLog("[background] Error parsing Evenue seats:", error.message);
  }

  const total = Object.keys(seats).length;
  if (rows.length && (!total || missingPrice)) {
    const names = Object.keys(idx);
    bgLog(`[background] Evenue: ${total ? "some rows dropped" : "no seats survived"}. ` +
      `Columns (${names.length}): ` + names.join(", "));
    bgLog(`[background] Evenue: AVAILABLE values seen: ` +
      [...availableValues.entries()].map(([v, n]) => `${v}×${n}`).join(", ") +
      ` (only 1 counts as available)`);
    if (idx.SEATSTATUS !== undefined) {
      bgLog(`[background] Evenue: SEATSTATUS values seen: ` +
        [...statusValues.entries()].map(([v, n]) => `${v}×${n}`).join(", "));
    }
    bgLog(`[background] Evenue: rows carrying a usable SLP_PRICE: ${withPrice}` +
      (withPrice
        ? ` — by AVAILABLE: ` + [...pricedByAvailable.entries()].map(([v, n]) => `${v}×${n}`).join(", ")
        : ` — the price is NOT in this payload; PRICELEVELCD is the join key`));
    pricedSamples.forEach((row, i) => {
      const pairs = names.map((nm) => `${nm}=${JSON.stringify(row[idx[nm]])}`).join(" ");
      bgLog(`[background] Evenue: priced row ${i + 1}: ` + pairs.slice(0, 1200));
    });
    pricelessSamples.forEach((row, i) => {
      const pairs = names
        .map((nm) => `${nm}=${JSON.stringify(row[idx[nm]])}`)
        .join(" ");
      bgLog(`[background] Evenue: available-but-priceless row ${i + 1}: ` +
        pairs.slice(0, 1200));
    });
  }

  // Seats arrived before the price table. Hold the payload so the GraphQL
  // response can trigger a re-parse instead of the user reloading; on this
  // build the prices normally come first, but the order is not guaranteed.
  if (!total && missingPrice && !Object.keys(priceLevels).length) {
    evenuePendingSeats.set(gameKey, { body, tabId, eventInfo });
    bgLog(`[background] Evenue: holding ${rows.length}-row payload for ${eventId} ` +
      `until the price-level table arrives`);
  }

  bgLog(`[background] Evenue: ${total} available seats from ${rows.length} rows` +
    (unavailable ? `, ${unavailable} unavailable/hidden` : "") +
    (missingPrice ? `, ${missingPrice} had no price` : "") +
    (fromPriceLevel ? `, ${fromPriceLevel} priced from the level table` : ""));

  games[gameKey].seats = { ...games[gameKey].seats, ...seats };
  games[gameKey].site = site;
  games[gameKey].lastScanned = Date.now();

  if (tabId) tabGameMap[tabId] = gameKey;
  await chrome.storage.local.set({ games });
}

// ─── TickPick listings ────────────────────────────────────────────────────
// GET api.tickpick.com/1.0/listings/internal/event-v2/<eventId>
// Confirmed against event 7730191 (3,009 listings):
//
//   sid   "307"        section
//   r     "4"          row (ri is the same value numeric)
//   lid   "300s"       level / zone label
//   q     4            tickets in the listing
//   p     517          price per ticket, in DOLLARS
//   fv    320          face value
//   sp    [4,3,2,1]    permitted split sizes
//   sd    [83]         seat_details ids -> disclosures ("ObstructedView")
//   is_pk true         PARKING, not a seat — excluded
//
// TickPick exposes no seat numbers, so a listing becomes `q` rows with a
// blank seat, the same shape StubHub uses for its seatless listings.
function tickPickPrice(listing) {
  const candidates = [listing.p, listing.fv];
  for (const c of candidates) {
    const n = typeof c === "string" ? parseFloat(c) : c;
    if (typeof n === "number" && isFinite(n) && n > 0) return n;
  }
  return null;
}

// Parking passes and other non-seat inventory. `is_pk` is the flag; the
// "PARKING LOTS" section name is a belt-and-braces fallback in case a feed
// omits it.
function tickPickIsParking(listing) {
  if (listing.is_pk === true) return true;
  return /parking/i.test(String(listing.sid || ""));
}

// sd -> ["ObstructedView", …] via the payload's seat_details lookup, so a
// disclosure that matters to a buyer is not silently dropped.
function tickPickDisclosures(listing, seatDetails) {
  const ids = Array.isArray(listing.sd) ? listing.sd : [];
  if (!ids.length || !seatDetails) return [];
  const out = [];
  for (const id of ids) {
    const entry = seatDetails[String(id)];
    const md = entry && Array.isArray(entry.md) ? entry.md : [];
    for (const item of md) {
      if (item && item.val) out.push(String(item.val));
    }
  }
  return out;
}

async function saveTickPickSeats(eventId, body, tabId, site, eventInfo) {
  if (!body || !Array.isArray(body.listings)) return;

  const gameKey = `${site}:${eventId}`;
  const data = await getStorage();
  const games = data.games || {};
  if (!games[gameKey]) games[gameKey] = emptyGame();

  if (eventInfo && eventInfo.name) {
    // Merge rather than replace. The DOM read can come back with a name but no
    // date or venue — that is exactly what happens after an in-page navigation,
    // when stale JSON-LD is skipped and the name falls back to document.title.
    // Overwriting outright would null the venue and silently drop this event
    // back to heuristic tiers. gameKey is per-event, so what is already stored
    // belongs to this same event and is safe to keep.
    const prev = games[gameKey].match || {};
    games[gameKey].match = {
      name: eventInfo.name,
      date: eventInfo.date || prev.date || null,
      venue: eventInfo.venue || prev.venue || null,
      currency: "USD",
      performanceId: eventId,
    };
  }

  // Venue for seat tiering. Read it back off the game rather than eventInfo so a
  // scan whose DOM read failed still tiers using the venue an earlier scan got.
  // Null is fine — tierFor() falls back to the section-text heuristic.
  const venueName = games[gameKey].match && games[gameKey].match.venue;
  logTierMapping(venueName);

  const seatDetails = body.seat_details || null;
  const seats = {};
  let parking = 0;
  let missingPrice = 0;

  try {
    for (const listing of body.listings) {
      if (!listing) continue;
      if (tickPickIsParking(listing)) { parking++; continue; }

      const dollars = tickPickPrice(listing);
      if (dollars == null) { missingPrice++; continue; }
      // Stored in thousandths to match centsToUSD() in the popup.
      const price = Math.round(dollars * 1000);

      const block = String(listing.sid != null ? listing.sid : "");
      const row = String(listing.r != null ? listing.r : "");
      const qty = Number(listing.q) || 1;
      const disclosures = tickPickDisclosures(listing, seatDetails);

      for (let i = 0; i < qty; i++) {
        seats[`${listing.id || `${block}-${row}`}-${i}`] = {
          block,
          row,
          seat: "",
          area: String(listing.lid || ""),
          category: "resale",
          // Parallel to `category`, which is a marketplace constant here.
          tier: VenueTiers.tierFor(venueName, block, row),
          price,
          exclusive: true,
          site: "tickpick",
          accessible: false,
          attributes: disclosures,
        };
      }
    }
  } catch (error) {
    bgLog("[background] Error parsing TickPick listings:", error.message);
  }

  const total = Object.keys(seats).length;
  bgLog(`[background] TickPick: ${total} seats from ${body.listings.length} listings` +
    (parking ? `, ${parking} parking excluded` : "") +
    (missingPrice ? `, ${missingPrice} had no price` : ""));

  games[gameKey].seats = { ...games[gameKey].seats, ...seats };
  games[gameKey].site = site;
  games[gameKey].lastScanned = Date.now();

  if (tabId) tabGameMap[tabId] = gameKey;
  await chrome.storage.local.set({ games });
}

function extractParam(url, param) {
  try {
    const u = new URL(url);
    return u.searchParams.get(param);
  } catch {
    const match = url.match(new RegExp(`[?&]${param}=([^&]+)`));
    return match ? match[1] : null;
  }
}

async function saveMatchInfo(product, tabId, site) {
  const perfId = String(product.performanceId);
  const gameKey = `${site}:${perfId}`;
  const data = await getStorage();
  const games = data.games || {};

  if (!games[gameKey]) games[gameKey] = emptyGame();

  games[gameKey].site = site;
  games[gameKey].match = {
    name: product.name,
    date: product.date,
    currency: product.currency,
    performanceId: perfId,
    imgUrl: product.imgUrl,
  };

  if (tabId) tabGameMap[tabId] = gameKey;
  await chrome.storage.local.set({ games });
}

async function saveAvailability(perfId, body, tabId, site) {
  const gameKey = `${site}:${perfId}`;
  const data = await getStorage();
  const games = data.games || {};

  if (!games[gameKey]) {
    games[gameKey] = emptyGame();
  }

  games[gameKey].site = site;
  games[gameKey].availability = {
    categories: body.priceRangeCategories.map((c) => ({
      id: c.id,
      name: c.name?.en || "Unknown",
      rank: c.rank,
      minPrice: c.minPrice,
      maxPrice: c.maxPrice,
      bgColor: c.bgColor,
      textColor: c.textColor,
    })),
    globalMin: body.seatMapPriceRanges?.min || null,
    globalMax: body.seatMapPriceRanges?.max || null,
    lastUpdated: body.seatMapPriceRanges?.lastUpdated || null,
  };

  // Backfill seat prices from category prices (handles seats arriving before availability)
  const seats = games[gameKey].seats || {};
  const catPrices = {};
  for (const c of games[gameKey].availability.categories) {
    catPrices[c.id] = c.minPrice;
  }
  for (const s of Object.values(seats)) {
    if (s.price == null && s.categoryId && catPrices[s.categoryId]) {
      s.price = catPrices[s.categoryId];
    }
  }

  if (tabId) tabGameMap[tabId] = gameKey;
  await chrome.storage.local.set({ games });
}

// Bounding box of any nested coordinate array (Point, Polygon, MultiPolygon).
// Returns [minX, minY, maxX, maxY] or undefined if no numeric pairs found.
function bboxOf(coords) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  (function walk(c) {
    if (!Array.isArray(c) || c.length === 0) return;
    if (typeof c[0] === "number") {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
      return;
    }
    for (const child of c) walk(child);
  })(coords);
  return isFinite(minX) ? [minX, minY, maxX, maxY] : undefined;
}

async function saveSeats(perfId, features, tabId, site) {
  const gameKey = `${site}:${perfId}`;
  const data = await getStorage();
  const games = data.games || {};

  if (!games[gameKey]) {
    games[gameKey] = emptyGame();
  }

  games[gameKey].site = site;
  const seats = games[gameKey].seats || {};

  // Build category price lookup from availability (if already loaded).
  // LMS seats often lack per-seat pricing — price comes from the category.
  const catPrices = {};
  if (games[gameKey].availability?.categories) {
    for (const c of games[gameKey].availability.categories) {
      catPrices[c.id] = c.minPrice;
    }
  }

  for (const f of features) {
    const p = f.properties;
    if (!p) continue;

    const seatId = String(p.id);
    const rawPrice = p.amount != null ? p.amount
      : p.seatBasedPriceAmount != null ? p.seatBasedPriceAmount
      : catPrices[p.seatCategoryId] ?? null;
    seats[seatId] = {
      block: p.block?.name?.en || "",
      area: p.area?.name?.en || "",
      row: p.row || "",
      seat: p.number || "",
      category: p.seatCategory || "",
      categoryId: p.seatCategoryId,
      price: rawPrice,
      color: p.color || "",
      exclusive: p.exclusive || false,
      blockId: p.block?.id,
      areaId: p.area?.id,
      tariffId: p.tariffId ?? p.tariff?.id,
      advantageId: p.advantageId ?? p.advantage?.id,
      movementId: p.movementId ?? p.resaleMovementId,
      contingentId: p.contingentId,
      seatQuality: p.seatQuality,
      extent: bboxOf(f.geometry?.coordinates),
      ticketType: p.resaleMovementId ? "resale"
        : (p.seatBasedPriceAmount != null ? "face_value" : "unknown"),
    };
  }

  games[gameKey].seats = seats;
  if (tabId) tabGameMap[tabId] = gameKey;
  await chrome.storage.local.set({ games });
}

async function saveProductId(perfId, productId, site) {
  const gameKey = `${site}:${perfId}`;
  const data = await getStorage();
  const games = data.games || {};
  if (!games[gameKey]) {
    games[gameKey] = emptyGame();
  }
  games[gameKey].site = site;
  games[gameKey].productId = productId;
  await chrome.storage.local.set({ games });
}

// Track which tab+game combos we've already auto-scanned.
// Persisted in chrome.storage.session so state survives SW restarts
// but clears on browser close. Stored as { "tabId:site:perfId": timestamp }.
async function getScannedGames() {
  const data = await chrome.storage.session.get("scannedGames");
  return data.scannedGames || {};
}

async function addScannedGame(key) {
  const sg = await getScannedGames();
  sg[key] = Date.now();
  await chrome.storage.session.set({ scannedGames: sg });
}

async function removeScannedGamesForTab(tabId) {
  const sg = await getScannedGames();
  const prefix = tabId + ":";
  let changed = false;
  for (const k of Object.keys(sg)) {
    if (k.startsWith(prefix)) { delete sg[k]; changed = true; }
  }
  if (changed) await chrome.storage.session.set({ scannedGames: sg });
}

async function autoScan(performanceId, productId, tabId, site) {
  const key = tabId ? `${tabId}:${site}:${performanceId}` : `${site}:${performanceId}`;
  const sg = await getScannedGames();
  if (sg[key]) return;
  await addScannedGame(key);

  const gameKey = `${site}:${performanceId}`;
  // Clear old seats for a fresh snapshot before scanning
  const data = await getStorage();
  const games = data.games || {};
  if (games[gameKey]) {
    games[gameKey].seats = {};
    await chrome.storage.local.set({ games });
  }
  sendScanToTab(productId, performanceId, tabId);
}

// Free tier: only one game at a time — clear old game when switching
// Licensed users kept every event they ever opened. Each capture rewrites the
// whole `games` object, and one StubHub sweep produces a dozen or more
// captures, so by roughly the thirteenth event the popup was serialising
// megabytes of seat data on every response and froze. chrome.storage.local is
// a 10MB quota without the `unlimitedStorage` permission, which this extension
// does not request.
//
// Keep the most recently scanned events and drop the rest. Eight is far more
// than anyone compares at once and keeps the payload small.
const MAX_STORED_GAMES = 8;

async function enforceGameLimit(gameKey) {
  const data = await getStorage();
  const level = data.license?.level || 0;
  const games = data.games || {};
  const existingKeys = Object.keys(games);

  if (level < TIERS.PRO) {
    // Free tier: one event at a time, as before.
    if (existingKeys.length > 0 && !existingKeys.includes(gameKey)) {
      await chrome.storage.local.set({ games: {} });
    }
    return;
  }

  if (existingKeys.length <= MAX_STORED_GAMES) return;

  // The event being written always survives; the rest are ranked by when they
  // were last scanned, oldest evicted first.
  const ranked = existingKeys
    .filter((key) => key !== gameKey)
    .sort((a, b) => (games[b]?.lastScanned || 0) - (games[a]?.lastScanned || 0));
  const keep = new Set([gameKey].concat(ranked.slice(0, MAX_STORED_GAMES - 1)));

  const dropped = existingKeys.filter((key) => !keep.has(key));
  if (!dropped.length) return;
  dropped.forEach((key) => { delete games[key]; });
  await chrome.storage.local.set({ games });
  bgLog(`[background] evicted ${dropped.length} least-recently-scanned event(s) ` +
    `to stay under ${MAX_STORED_GAMES}: ${dropped.join(", ")}`);
}

function sendScanToTab(productId, performanceId, tabId, force) {
  chrome.storage.local.get(["scanSpeed", "license", "scanConfig"], (data) => {
    let speed = data.scanSpeed || "balanced";
    const level = data.license?.level || 0;
    // Enforce: non-balanced speeds require Pro
    if (speed !== "balanced" && level < TIERS.PRO) {
      speed = "balanced";
    }
    const msg = {
      type: "START_SCAN",
      productId,
      performanceId,
      scanSpeed: speed,
      scanConfig: data.scanConfig || null,
      force: !!force,
    };
    if (tabId) {
      chrome.tabs.sendMessage(tabId, msg);
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, msg);
        }
      });
    }
  });
}

function getStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (data) => resolve(data || {}));
  });
}
