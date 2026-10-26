// Background service worker — processes API data and stores it

// Seat-tier mapping. venue-tiers.js defines the data VENUE_TIER_DATA, tiers.js
// the VenueTiers helpers that read it — load order matters. Both are plain
// scripts with no deps, so importScripts is safe at service-worker top level.
// NOTE: VenueTiers is about SEAT tiers; the TIERS constant below is LICENSE
// tiers. Different things.
importScripts("venue-tiers.js", "tiers.js", "venue-import.js", "csv-export.js");

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
    if (h.includes("vividseats")) return "vividseats";
    if (h.includes("gametime")) return "gametime";
    if (h.includes("gotickets")) return "gotickets";
    if (h.includes("ticketsforless")) return "ticketsforless";
    if (h.includes("rutheckerdhall")) return "rutheckerd";
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

// ==== auto-pull (TicketPortal "⇣ Pull") — BEGIN ===========================
// A person clicks ⇣ Pull in TicketPortal; the portal opens the marketplace page
// with "#ts-auto" on the address. content.js sees the marker and arms this tab.
// We then wait until the page's listings have FINISHED arriving, write the same
// CSV the popup's Download button writes, and close the tab. The portal is
// watching the downloads folder and opens its import from there.
//
// Deliberately one human click per page: nothing here opens tabs, loops over
// events or runs on a timer of its own. The marker only arms a tab a person
// just opened.
//
// THE RULE THAT MATTERS: never download a file that might be partial. The
// portal treats a file as the whole picture for that source and showtime, so a
// half-loaded page would wipe real listings off its board. "Finished" means:
// listings captured SINCE this tab was armed, a non-zero count, no scan in
// progress, and the count unchanged for AUTO_STABLE_MS. If that never happens
// within AUTO_MAX_MS we give up, leave the tab open and badge it "!" — the
// person clicks Download CSV themselves, exactly as before.
const AUTO_STABLE_MS = 6000;
const AUTO_MAX_MS = 120000;
const AUTO_POLL_MS = 1500;
const AUTO_TM_SETTLE_MS = 2000;   // after the TM page reports loaded, before its scan starts
const autoPull = {};              // tabId -> job; in memory, like tabGameMap

// Seats merge across visits (every save path does {...old, ...new}), so a
// stored event still holds listings seen on an EARLIER visit, some long sold.
// An auto-pull must export only what THIS page load showed, so the first save
// for its event after arming REPLACES the stored seats instead of merging.
function mergeSeats(prev, seats, tabId, gameKey) {
  const job = tabId != null ? autoPull[tabId] : null;
  if (job && !job.done && job.freshFor !== gameKey) {
    job.freshFor = gameKey;
    return { ...seats };
  }
  return { ...prev, ...seats };
}

// Copies of popup.js's fee tables, file tags, price maths and TM event-id
// parser: the service worker cannot load popup.js. tests/auto-pull-check.js
// fails if any copy differs from the popup's, so edit both together.
const FEE_MULTIPLIER_BY_SITE = { resale: 1.15, lms: 1.0, ticketmaster: 1.0, seatgeek: 1.0, stubhub: 1.0, evenue: 1.0, tickpick: 1.0, axs: 1.0, vividseats: 1.0, gametime: 1.0, gotickets: 1.0, ticketsforless: 1.0, rutheckerd: 1.0 };
const FEE_FLAT_BY_SITE = { resale: 0, lms: 0, ticketmaster: 0, seatgeek: 0, stubhub: 0, evenue: 5.00, tickpick: 0, axs: 0 };
const SITE_FILE_TAGS = {
  resale: "fifa-resale",
  lms: "fifa-lms",
  ticketmaster: "ticketmaster",
  seatgeek: "seatgeek",
  stubhub: "stubhub",
  evenue: "evenue",
  tickpick: "tickpick",
  axs: "axs",
  vividseats: "vividseats",
  gametime: "gametime",
  gotickets: "gotickets",
  ticketsforless: "ticketsforless",
  rutheckerd: "ruth-eckerd-hall",
};

function siteFileTag(site) {
  const known = SITE_FILE_TAGS[site];
  if (known) return known;
  // An unrecognised site still names itself rather than going anonymous.
  const cleaned = String(site || "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return cleaned || "unknown-site";
}

// popup.js's centsToUSD, with the site and the event's own fee table passed in
// instead of read from the popup's currentSite / currentFees.
function feeUSD(cents, site, fees) {
  const multiplier = FEE_MULTIPLIER_BY_SITE[site] ?? 1.15;
  const base = cents / 1000;
  if (fees && typeof fees === "object") return base * (1 + (fees.pct || 0) / 100) + (fees.flat || 0);
  const flat = FEE_FLAT_BY_SITE[site] ?? 0;
  return base * multiplier + flat;
}

const TM_EVENT_ID_RE = /\/event\/([A-Za-z0-9_-]{8,})/;
const TM_AM_EVENT_ID_RE = /\/buy\/[a-z]+\/([A-Za-z0-9+=_%-]{6,})/i;
function ticketmasterEventIdFromUrl(url) {
  if (!/ticketmaster\.com/.test(url)) return null;
  const path = url.match(TM_EVENT_ID_RE);
  if (path) return path[1];
  if (/(^|\/\/|\.)am\.ticketmaster\.com/i.test(url)) {
    const am = url.match(TM_AM_EVENT_ID_RE);
    if (am) return decodeURIComponent(am[1]);
  }
  for (const key of ["eventId", "event_id", "eventid", "id", "event"]) {
    const m = url.match(new RegExp("[?&]" + key + "=([A-Za-z0-9_-]{8,})(?:[&#]|$)", "i"));
    if (m) return m[1];
  }
  return null;
}

// Is the page done? Pure, so tests/auto-pull-check.js can pin every gate.
// job: { armedAt, freshFor, scanStatus, lastCount, stableSince }
// Returns "wait", "export" or the reason to give up.
function autoPullVerdict(job, gameKey, count, now) {
  if (now - job.armedAt > AUTO_MAX_MS) {
    return count > 0 ? "the page never settled" : "no listings were captured";
  }
  if (job.scanStatus === "error") return "the scan reported an error";
  if (!gameKey || job.freshFor !== gameKey) return "wait";   // nothing from THIS load yet
  if (job.scanStatus === "scanning") return "wait";
  if (!(count > 0)) return "wait";
  if (job.lastCount !== count) return "wait";
  if (now - job.stableSince < AUTO_STABLE_MS) return "wait";
  return "export";
}

// Which stored event is this pull collecting? The one this page's seats were
// first saved under (mergeSeats records it), NOT tabGameMap alone: that entry
// is wiped on every tabs.onUpdated "loading", and Chrome reports one for a
// same-page address tidy-up too. SeatGeek strips "?dd_referrer=" after its
// bot check that way, two seconds AFTER its listings landed, so a pull reading
// tabGameMap lost its event and waited for ever (2026-10-26). Pure, tested.
function autoPullGameKey(job, mapped) {
  return (job && job.freshFor) || mapped || null;
}

function exportableCount(game) {
  if (!game) return 0;
  return Object.values(game.seats || {}).filter((s) => s.exclusive !== false && s.price != null).length;
}

function autoBadge(tabId, text, title) {
  try {
    chrome.action.setBadgeText({ tabId, text });
    chrome.action.setBadgeBackgroundColor({ tabId, color: text === "!" ? "#b45309" : "#475569" });
    if (title) chrome.action.setTitle({ tabId, title });
  } catch (e) { /* a badge must never break the pull */ }
}

function autoPullArm(tabId, url) {
  if (tabId == null) return;
  autoPull[tabId] = {
    armedAt: Date.now(), url: url || "", freshFor: null, scanStatus: null,
    lastCount: -1, stableSince: Date.now(), scanStarted: false, loadedAt: null, done: false,
  };
  bgLog(`[auto-pull] armed tab ${tabId}: ${url}`);
  autoBadge(tabId, "⇣", "Ticket Scout: waiting for the listings to finish loading, then downloading the CSV");
  setTimeout(() => autoPullTick(tabId), AUTO_POLL_MS);
}

function autoPullGiveUp(tabId, why) {
  const job = autoPull[tabId];
  if (job) job.done = true;
  bgLog(`[auto-pull] tab ${tabId}: stopped — ${why}`);
  autoBadge(tabId, "!", `Ticket Scout did not download automatically (${why}). Open the popup and click Download CSV.`);
}

async function autoPullTick(tabId) {
  const job = autoPull[tabId];
  if (!job || job.done) return;
  try {
    // Ticketmaster only lists seats once a scan is asked for — the popup's Scan
    // button does it by hand. Ask for exactly ONE, once the page has loaded.
    if (!job.scanStarted) {
      const tab = await chrome.tabs.get(tabId);
      const eventId = tab && ticketmasterEventIdFromUrl(tab.url || "");
      if (eventId && !/am\.ticketmaster\.com/i.test(tab.url || "")) {
        if (tab.status === "complete" && !job.loadedAt) job.loadedAt = Date.now();
        if (job.loadedAt && Date.now() - job.loadedAt >= AUTO_TM_SETTLE_MS) {
          job.scanStarted = true;
          job.scanStatus = "scanning";   // busy until the scan reports back
          startTicketmasterScan(eventId, tabId, true);
          bgLog(`[auto-pull] tab ${tabId}: started the Ticketmaster scan for ${eventId}`);
        }
      } else {
        job.scanStarted = true;          // passive site: the page's own traffic is the data
      }
    }

    const gameKey = autoPullGameKey(job, tabGameMap[tabId]);
    const data = await chrome.storage.local.get("games");
    const game = gameKey && data.games ? data.games[gameKey] : null;
    const count = exportableCount(game);
    const now = Date.now();
    if (count !== job.lastCount) { job.lastCount = count; job.stableSince = now; }

    const verdict = autoPullVerdict(job, gameKey, count, now);
    if (verdict === "export") { await autoPullExport(tabId, gameKey, game); return; }
    if (verdict !== "wait") { autoPullGiveUp(tabId, verdict); return; }
  } catch (e) {
    // The tab was closed, or a read failed. Closed: nothing to do. Anything
    // else: say so rather than spin silently.
    if (autoPull[tabId]) autoPullGiveUp(tabId, "error: " + (e && e.message ? e.message : e));
    return;
  }
  setTimeout(() => autoPullTick(tabId), AUTO_POLL_MS);
}

async function autoPullExport(tabId, gameKey, game) {
  const job = autoPull[tabId];
  if (!job || job.done) return;
  job.done = true;
  const out = buildScoutCsv(game, {
    gameKey,
    now: new Date(),
    priceUSD: (c) => feeUSD(c, game.site, game.fees),
    tierFor: VenueTiers.tierFor,
    fileTag: siteFileTag,
    auto: true,
  });
  if (!out) { autoPullGiveUp(tabId, "nothing to export"); return; }
  // A service worker has no URL.createObjectURL, so the file goes as a data:
  // URL. No folder in the name: it lands in Chrome's download folder, which is
  // the folder the portal watches.
  const url = "data:text/csv;charset=utf-8," + encodeURIComponent(out.csv);
  await chrome.downloads.download({ url, filename: out.filename, conflictAction: "uniquify", saveAs: false });
  bgLog(`[auto-pull] tab ${tabId}: downloaded ${out.filename} (${out.count} seats) — closing the tab`);
  delete autoPull[tabId];
  chrome.tabs.remove(tabId).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => { delete autoPull[tabId]; });
// ==== auto-pull — END =====================================================

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
    processApiResponse(message.url, message.body, tabId, message.eventInfo, message.amEventId);
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
  if (message.type === "AUTO_PULL_ARM") {
    autoPullArm(tabId, message.url);
  }
  if (message.type === "START_TICKETMASTER_SCAN") {
    if (!message.eventId) return;
    startTicketmasterScan(message.eventId, tabId, message.force);
  }
  if (message.type === "SCAN_PROGRESS") {
    // An auto-pull must not call a page finished while its scan is running.
    if (tabId != null && autoPull[tabId]) autoPull[tabId].scanStatus = message.status;
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

// Ask the tab's content script for a Ticketmaster scan. The popup's Scan button
// reaches it through START_TICKETMASTER_SCAN; an auto-pull calls it directly.
function startTicketmasterScan(eventId, tabId, force) {
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
    force: !!force,
  };
  if (tabId) {
    chrome.tabs.sendMessage(tabId, msg);
  } else {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, msg);
    });
  }
}

async function processApiResponse(url, body, tabId, eventInfo, amEventId) {
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

  // Vivid Seats listings — captured passively from the page's own API call.
  // GET www.vividseats.com/hermes/api/v1/listings?productionId=<id>&currency=USD
  // Note the near-miss: /hermes/api/v1/badging/productions/<id>/sold/listings
  // also ends in "listings" and carries an empty array, so the path is matched
  // in full rather than on the word alone.
  if (site === "vividseats" && url.includes("/hermes/api/v1/listings") &&
      body && Array.isArray(body.tickets)) {
    const m = url.match(/[?&]productionId=(\d+)/i);
    const eventId = m ? m[1]
      : String((body.global && body.global.productionId) || "");
    if (eventId) {
      await enforceGameLimit(`${site}:${eventId}`);
      await saveVividSeatsSeats(eventId, body, tabId, site, eventInfo);
    } else {
      bgLog("[background] Vivid Seats: no production id in " + url.split("?")[0]);
    }
  }

  // Gametime. Two endpoints, both captured passively:
  //
  //   mobile.gametime.co/v1/events?...        who is playing, where, when
  //   mobile.gametime.co/v3/listings/<id>?... the inventory
  //
  // Only the listings payload carries seats, and it carries NO event name,
  // date or venue — so /v1/events is indexed as it arrives and read back by
  // event id. Order is not assumed: the events call fired first on the
  // observed page, but the index is keyed so either order works, and a scan
  // with neither still stores seats and falls back to JSON-LD for identity.
  if (site === "gametime" && /\/v\d+\/events(\?|$)/.test(url) && body &&
      Array.isArray(body.events)) {
    gametimeIndexEvents(body);
  }

  if (site === "gametime" && url.includes("/v3/listings/") && body &&
      Array.isArray(body.listings)) {
    const m = url.match(/\/v3\/listings\/([A-Za-z0-9]+)/);
    const eventId = m ? m[1]
      : String(((body.listings[0] || {}).event_id) || "");
    if (eventId) {
      await enforceGameLimit(`${site}:${eventId}`);
      await saveGametimeSeats(eventId, body, tabId, site, eventInfo, url);
    } else {
      bgLog("[background] Gametime: no event id in " + url.split("?")[0]);
    }
  }

  // AXS. Three payloads, all captured passively:
  //
  //   /axsmarketplace/eventinfo group and section names aside, the ONLY
  //                             payload with a date: name, localDate, venue
  //   /axsmarketplace/mapinfo   group and section names, for the Area column
  //   /axsmarketplace/offers    the inventory
  //   /veritix/start-flow/v1    name and venue again, as a fallback
  //
  // mapinfo is indexed first when it arrives first; when it does not, the Area
  // falls back to the section name's own prefix, so ordering is not load
  // bearing. All three are keyed by the onsale token from the request url.
  if (site === "axs" && url.includes("/axsmarketplace/mapinfo") && body) {
    axsIndexMap(axsOnsaleToken(url), body);
  }

  if (site === "axs" && url.includes("/axsmarketplace/eventinfo") && body) {
    axsIndexEventInfo(axsOnsaleToken(url), body);
  }

  if (site === "axs" && url.includes("/veritix/start-flow/") && body) {
    axsIndexEvent(axsOnsaleToken(url), body);
  }

  if (site === "axs" && url.includes("/axsmarketplace/offers") &&
      body && Array.isArray(body.listings)) {
    const eventId = axsOnsaleToken(url);
    if (eventId) {
      await enforceGameLimit(`${site}:${eventId}`);
      await saveAxsSeats(eventId, body, tabId, site, eventInfo);
    } else {
      bgLog("[background] AXS: no onsale token in " + url.split("?")[0]);
    }
  }

  // AXS Veritix inventory. Three payloads on the shop pages, all passive:
  //
  //   /veritix/inventory/v4/<token>/price         price per offer + price level
  //   /veritix/inventory/V2/<token>/sections      per-section availability counts
  //   /veritix/inventory/V2/<token>/offer/search  THE SEATS (592 on one event)
  //
  // This family went unseen for three rounds of captures because the patterns
  // named start-flow and pre-flow specifically. start-flow is 1.3MB of offers,
  // fees and parking upsells and holds no inventory at all; the seats were
  // always one directory over.
  if (site === "axs" && url.includes("/veritix/inventory/")) {
    const token = axsVeritixToken(url);
    if (!token) {
      bgLog("[background] AXS Veritix: no token in " + url.split("?")[0]);
    } else if (/\/price(\?|$)/i.test(url) && body && Array.isArray(body.offerPrices)) {
      axsIndexVeritixPrices(token, body);
    } else if (/offer\/search/i.test(url) && body && Array.isArray(body.offers)) {
      await enforceGameLimit(`${site}:${token}`);
      await saveAxsVeritixSeats(token, body, tabId, site, eventInfo);
    }
  }

  // TicketsForLess. One payload, captured passively:
  //
  //   GET www.ticketsforless.com/api/tickets/tfl?EventID=<id>
  //
  // The id is read off the RAW query string, like AXS's onsale token, so it is
  // the same number the page url ends in and the popup looks up.
  if (site === "ticketsforless" && url.includes("/api/tickets/") && body &&
      Array.isArray(body.tickets)) {
    const m = String(url).match(/[?&]eventid=(\d+)/i);
    const eventId = m ? m[1]
      : String((body.event && (body.event.id || body.event.eventId || body.event.EventID)) || "");
    if (eventId) {
      await enforceGameLimit(`${site}:${eventId}`);
      await saveTicketsForLessSeats(eventId, body, tabId, site, eventInfo);
    } else {
      bgLog("[background] TicketsForLess: no EventID in " + url.split("?")[0]);
    }
  }

  // Ruth Eckerd Hall - Tessitura SYOS. Two payloads, both captured passively:
  //
  //   /api/syos/GetInitData?performanceId=<id>   price zones, fees, screen list
  //   /api/syos/GetSeatList?...&screenId=<n>     the seats for ONE screen
  //
  // Seats arrive a screen at a time: the page fetches only the screen the user
  // opens. Each capture merges into the same event, so opening every screen
  // builds the full picture, and the summary says how many screens are still
  // unseen rather than letting a partial capture look complete.
  if (site === "rutheckerd" && url.includes("/api/syos/") && body) {
    const eventId = syosPerformanceId(url, body);
    if (!eventId) {
      bgLog("[background] SYOS: no performanceId in " + url.split("?")[0]);
    } else if (url.includes("GetInitData")) {
      syosIndexInit(eventId, body);
    } else if (Array.isArray(body.seats)) {
      await enforceGameLimit(`${site}:${eventId}`);
      await saveSyosSeats(eventId, body, tabId, site, eventInfo, url);
    }
  }

  // GoTickets. Two payloads, both captured passively:
  //
  //   /rest/listing-attributes        id -> name for listing attributes
  //   /rest/events/<eventId>/listings the inventory, the event, and the venue
  //                                   groups — everything else in one response
  //
  // The attribute table is indexed when it arrives; it came BEFORE the listings
  // on the observed page, but a missing name only costs the attribute text,
  // never a seat.
  if (site === "gotickets" && url.includes("/rest/listing-attributes") &&
      Array.isArray(body)) {
    goTicketsIndexAttributes(body);
  }

  if (site === "gotickets" && body && Array.isArray(body.listings)) {
    const m = url.match(/\/rest\/events\/(\d+)\/listings/);
    const eventId = m ? m[1]
      : String((body.event && body.event.id) || (body.listings[0] || {}).eventId || "");
    if (m && eventId) {
      await enforceGameLimit(`${site}:${eventId}`);
      await saveGoTicketsSeats(eventId, body, tabId, site, eventInfo);
    } else if (!m) {
      bgLog("[background] GoTickets: listings array at an unexpected url, not parsed: " +
        url.split("?")[0]);
    }
  }

  // Bring-up shape reporting, kept for the payloads that are NOT parsed. The
  // offers endpoint was found this way after "/veritix/" turned out to be the
  // session rather than the inventory.
  if (site === "axs" && !/\/axsmarketplace\/(offers|mapinfo|eventinfo)/.test(url)) {
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
      // The shape above stops at eight keys a level, which hid everything
      // useful in the Veritix payloads. List where the arrays of records are.
      if (/\/veritix\//.test(path)) {
        axsLogArrays(path, body);
        axsLogOnsale(path, body);
      }
    }
  }

  // Account Manager (ISM v810). The two payloads arrive as separate
  // responses in either order, so hold whichever comes first and parse once
  // both are in. Keyed by event so two open tabs cannot cross-contaminate.
  if (amEventId && /\/v810\/(venueAvailability|priceData)\//.test(url)) {
    const pending = amPending[amEventId] || (amPending[amEventId] = {});
    if (url.includes("/venueAvailability/")) pending.availability = body;
    if (url.includes("/priceData/")) pending.priceData = body;
    pending.eventInfo = eventInfo || pending.eventInfo;

    if (pending.availability && pending.priceData) {
      await enforceGameLimit(`ticketmaster:${amEventId}`);
      await saveAmSeats(amEventId, pending.availability, pending.priceData,
        tabId, "ticketmaster", pending.eventInfo);
      delete amPending[amEventId];
    } else {
      const waiting = pending.availability ? "priceData" : "venueAvailability";
      bgLog(`[background] AM: have ${pending.availability ? "availability" : "prices"} ` +
        `for ${amEventId}, waiting on ${waiting}`);
    }
    notifyDataUpdated();
    return;
  }

  // Evenue seat availability — captured passively. Matched on the payload
  // shape rather than an exact path: the endpoint was confirmed on one
  // school's instance and Paciolan builds differ between schools, so pinning
  // the full path made a near-miss look like an event with no seats.
  if (site === "evenue" && url.includes("/pac-api/") && Array.isArray(body)) {
    const eventId = evenueEventIdFromUrl(url);
    if (eventId) {
      await enforceGameLimit(`${site}:${eventId}`);
      await saveEvenueSeats(eventId, body, tabId, site, eventInfo, url);
    } else {
      bgLog(`[background] Evenue: array payload on ${url.split("?")[0]} but no ` +
        `event id in the url — add its shape to evenueEventIdFromUrl()`);
    }
  } else if (site === "evenue" && url.includes("/pac-api/")
             && evenueFindEventDetails(body).length) {
    await saveEvenuePriceLevels(evenueFindEventDetails(body), tabId, site, eventInfo, url);
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
    // Same payload, but kept rather than only printed: the popup needs it to
    // quote what a buyer pays.
    const feeProfile = evenueProfile(url);
    const feeSource = body && body.data && body.data.maps_eventMap
      ? body.data.maps_eventMap : null;
    if (feeSource) {
      for (const key of feeProfile.feeKeys || EVENUE_DEFAULT.feeKeys) {
        const raw = feeSource[key];
        if (raw === null || raw === undefined) continue;
        const rule = await evenueRecordFeeRule(tabId, raw, feeProfile, key);
        // The first key that yields a rule wins; an empty table IS a rule
        // (Colorado charges nothing), so a null here means unparseable.
        if (rule) break;
      }
    }
    const shape = describeShape(body, 5);
    const seen = path + " " + shape;
    if (!evenueIgnoredPaths.has(seen)) {
      evenueIgnoredPaths.add(seen);
      bgLog(`[background] Evenue: ignoring ${path} -> ${shape} ` +
        `(not the seat array; repeats of this shape stay quiet)`);
    }
    // OUTSIDE the shape dedupe above: the response carrying the price may
    // repeat a shape already reported, and skipping it is how it stayed
    // invisible for a round. Both of these dedupe on their own findings.
    evenueLogPriceCandidates(path, body);
    evenueHuntValue(path, body);
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
  // id -> the raw offer, for the cheapest-seat audit below.
  const offerById = {};
  for (const o of (facetsData?._embedded?.offer || [])) {
    const id = o?.offerId || o?.id;
    if (id) offerById[id] = o;
  }
  // What each facet's price was built from, so the cheapest can be explained.
  const priceAudit = [];

  // Expand every facet into individual seats matching the shape the dashboard
  // already consumes: { block, row, seat, area, category, price, exclusive }.
  // block/row/seat must be strings — the cluster sort calls localeCompare.
  const seats = {};
  let missingPrice = 0;
  const offerSpread = [];
  // Listings with a count but no published places — see the block below.
  let unplacedSeats = 0;
  let unplacedSeq = 0;
  const unplacedSections = new Set();
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
      if (dollars != null) {
        // Which offer supplied the figure we used.
        let usedOfferId = null;
        for (const id of offerIds) {
          if (offerPrices[id] === dollars) { usedOfferId = id; break; }
        }
        priceAudit.push({
          dollars,
          source: facetListPrice(facet) != null ? "facet.listPriceRange" : "offer map",
          offerId: usedOfferId,
          section: String(facet.section || ""),
          offerCount: offerIds.length,
        });
      }
      // Stored in thousandths to match centsToUSD() in the popup.
      const price = dollars != null ? Math.round(dollars * 1000) : null;
      if (price == null) missingPrice++;

      let placedHere = 0;
      for (const compressed of facet.places || []) {
        for (const placeId of expandPlaces(compressed)) {
          const parsed = decodePlaceId(placeId);
          if (!parsed) continue;
          const block = String(parsed.section || facet.section || "");
          const row = String(parsed.row || "");
          placedHere++;
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

      // Resale listings publish a section and a count and nothing else:
      //
      //   {"available":true,"inventoryTypes":["resale"],"seating":"reserved",
      //    "section":"3","count":2,"places":[]}
      //
      // 867 of them on one Nebraska event, which is why section 206 was on the
      // map with a $1,005.70 listing and absent from the dashboard. Store the
      // count as seats with no row or seat number rather than dropping them:
      // unnumbered seats already group as "N together, adjacency unknown"
      // everywhere else in the popup.
      if (!placedHere) {
        const block = String(facet.section || "");
        const count = Math.max(1, Math.min(Number(facet.count) || 1, 200));
        if (block) {
          // The offer id keeps two listings in the same section apart; without
          // it the second would overwrite the first.
          const offerKey = (Array.isArray(facet.offers) && facet.offers[0]) || `f${unplacedSeq++}`;
          for (let i = 0; i < count; i++) {
            seats[`unplaced:${block}:${offerKey}:${i}`] = {
              block,
              row: "",
              seat: "",
              area,
              category,
              tier: VenueTiers.tierFor(venueName, block, ""),
              price,
              exclusive: true,
              site: "ticketmaster",
              accessible: (facet.accessibility || []).length > 0,
              attributes: facet.attributes || [],
            };
          }
          unplacedSeats += count;
          unplacedSections.add(block);
        }
      }
    }
  } catch (error) {
    bgLog("[background] Error parsing Ticketmaster facets:", error.message);
  }

  const total = Object.keys(seats).length;

  // Which sections actually made it through, and which facets produced no seat
  // at all. A facet only becomes seats via its `places` list, so one with no
  // places — or places that do not decode — vanishes without a word. That is
  // how a Nebraska resale event showed 1,739 seats while section 206, plainly
  // on the map, was missing from the dashboard.
  try {
    const sectionsIn = new Set();
    const emptyFacets = [];
    for (const f of facetsData.facets) {
      if (f && f.section != null && f.section !== "") sectionsIn.add(String(f.section));
      const places = Array.isArray(f && f.places) ? f.places : [];
      let decoded = 0;
      for (const compressed of places) {
        for (const placeId of expandPlaces(compressed)) {
          if (decodePlaceId(placeId)) decoded++;
        }
      }
      if (!decoded) emptyFacets.push(f);
    }
    const sectionsOut = new Set(Object.values(seats).map((x) => x.block).filter(Boolean));
    const missing = [...sectionsIn].filter((x) => !sectionsOut.has(x)).sort();
    bgLog(`[background] Ticketmaster sections: ${sectionsIn.size} in the response, ` +
      `${sectionsOut.size} produced seats` +
      (missing.length ? `, ${missing.length} produced none: ${missing.slice(0, 40).join(", ")}` : ""));
    if (emptyFacets.length) {
      bgLog(`[background] Ticketmaster: ${emptyFacets.length} listing(s) published no seat ` +
        `places — ${unplacedSeats} seat(s) across ${unplacedSections.size} section(s) kept ` +
        `from their counts instead, with no row or seat number`);
      // A listing with no section at all cannot be filed anywhere, so it stays
      // dropped — but it is still inventory the dashboard is not showing.
      const stillMissing = emptyFacets
        .filter((f) => !String((f && f.section) || ""));
      if (stillMissing.length) {
        bgLog(`[background] Ticketmaster: ${stillMissing.length} listing(s) had no section ` +
          `either and are still dropped`);
      }
    }
  } catch (e) {
    bgLog("[background] Ticketmaster: section census failed: " + (e && e.message));
  }

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

    // The cheapest seats are what a user compares against the site, so dump
    // the offers behind them in full rather than a sample from the top of the
    // list. Reading LOW is the error that matters: it advertises a price that
    // does not exist.
    if (priceAudit.length) {
      const cheapest = priceAudit.slice().sort((a, b) => a.dollars - b.dollars).slice(0, 3);
      bgLog(`[background] Ticketmaster prices: cheapest ${cheapest.length} facet price(s) ` +
        `and the offers behind them —`);
      cheapest.forEach((entry, i) => {
        bgLog(`[background]   #${i + 1} $${entry.dollars} section=${entry.section || "?"} ` +
          `via ${entry.source}, ${entry.offerCount} offer(s) on the facet`);
        const offer = entry.offerId ? offerById[entry.offerId] : null;
        if (!offer) {
          bgLog(`[background]      (no offer object — price came from the facet)`);
          return;
        }
        const nums = Object.keys(offer)
          .filter((k) => typeof offer[k] === "number")
          .map((k) => `${k}=${offer[k]}`).join(", ");
        bgLog(`[background]      numeric: ${nums || "(none)"}`);
        if (offer.charges) {
          const sum = (offer.charges || []).reduce((t, c) => t + (Number(c && c.amount) || 0), 0);
          bgLog(`[background]      charges sum=${sum.toFixed(2)} :: ` +
            JSON.stringify(offer.charges).slice(0, 240));
        }
        for (const k of ["sellableQuantities", "name", "description", "offerType", "type", "currency"]) {
          if (offer[k] !== undefined) {
            bgLog(`[background]      ${k}=${JSON.stringify(offer[k]).slice(0, 160)}`);
          }
        }
      });
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

  games[gameKey].seats = mergeSeats(games[gameKey].seats, seats, tabId, gameKey);
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

  games[gameKey].seats = mergeSeats(games[gameKey].seats, seats, tabId, gameKey);
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

  games[gameKey].seats = mergeSeats(games[gameKey].seats, seats, tabId, gameKey);
  games[gameKey].site = site;
  games[gameKey].lastScanned = Date.now();

  if (tabId) tabGameMap[tabId] = gameKey;
  await chrome.storage.local.set({ games });
}

// The event id out of a Paciolan api url. Several shapes because schools run
// different builds; all normalise to the "<season>:<code>" the adapter and the
// popup both use, dropping any leading venue/distributor segment
// ("977:F26:02" -> "F26:02").
// ─── Evenue school profiles ───────────────────────────────────────────────
// Evenue is Paciolan, and every school runs its own build of it. Three seen so
// far, and each contradicts the others:
//
//   kuathletics  seats carry SLP_PRICE inline; the price table arrives over the
//                network; the page names the event
//   huskers      only SOLD seats carry a price, the seats on sale carry none,
//                and no price table arrives at all; charges 7%
//   cubuffs      seats carry no price and the table is server-rendered into the
//                page; charges nothing; the page names only the opponent
//
// Each fix for one school used to widen a shared guess, which is how fixing one
// kept denting another. A school now gets its own entry, and anything it does
// not state falls back to EVENUE_DEFAULT — the generic behaviour, which is what
// a school nobody has opened yet still gets.
//
// Keys are matched against the hostname, so "huskers" matches
// huskers.evenue.net. Adding a school is an entry here plus a fixture in
// tests/evenue-schools-check.js, which locks every other school's behaviour
// at the same time.
const EVENUE_DEFAULT = {
  label: null,
  // Where a seat's price comes from: "inline" (SLP_PRICE on the row),
  // "levels" (join PRICELEVELCD against the price table), or null for "try
  // inline, then levels", which is what an unknown school gets.
  priceSource: null,
  // Field names in the event detail object, best first.
  nameKeys: ["SSEVENTNAME", "EVENTNAME", "EVENT_NAME", "TITLE", "EVENT_TITLE", "NAME",
    "DESCRIPTION", "EVENT_DESC", "LONG_DESC", "SHORT_DESC", "ITEMNAME"],
  dateKeys: ["EVENTDTFAC", "EVENTDT", "EVENT_DATE", "EVENTDATE", "PERF_DATE",
    "START_DATE", "EVENT_DT", "STARTDT", "PERF_DT", "DATE"],
  venueKeys: ["FAC_TITLE", "FAC_SSTITLE", "VENUE_NAME", "VENUENAME", "FACILITY_NAME", "VENUE"],
  // Join the host school from the page title onto a payload name that gives
  // only the visitor.
  hostFromTitle: true,
  // Fee fields to read, in order. The first that parses wins.
  feeKeys: ["TIERED_FEES", "ITEM_FEES"],
};

const EVENUE_SCHOOLS = {
  kuathletics: {
    label: "Kansas",
    // Confirmed on F26:02: 49,233 rows, SLP_PRICE on the row itself.
    priceSource: "inline",
    hostFromTitle: false,
  },
  huskers: {
    label: "Nebraska",
    // Confirmed on F26:06: 88,349 rows, 186 on sale, every one priceless, and
    // the detail object carries MIN_PRICE/MAX_PRICE but no PL_PT_PRICES. Until
    // a price table turns up this school reports seats it cannot price, which
    // the summary line says out loud.
    priceSource: "levels",
    hostFromTitle: false,
  },
  hokiesports: {
    label: "Virginia Tech",
    // Confirmed on F26:06 (Lane Stadium): 63,225 rows, 165 on sale, all priced
    // from the 7-level table, $107.00-$199.00.
    priceSource: "levels",
    // The reverse of Colorado: here SSEVENTNAME is the long form ("Football v.
    // Virginia") and EVENTNAME is the clean opponent ("Virginia"). Reading them
    // in the default order gives "Virginia Tech vs Football v. Virginia".
    nameKeys: ["EVENTNAME", "ITEMNAME", "SSEVENTNAME", "TITLE", "EVENT_NAME"],
    // Title reads "Football v. Virginia | Virginia Tech".
    hostFromTitle: true,
  },
  cubuffs: {
    label: "Colorado",
    // Confirmed on F26:F02: 51,539 rows, 4,195 on sale, all priced from the
    // 7-level table in the page. Charges nothing, and the page publishes only
    // "TT (FB)", so the host school comes from its title.
    priceSource: "levels",
    hostFromTitle: true,
  },
};

function evenueProfile(url) {
  let host = "";
  try { host = new URL(String(url || "")).hostname.toLowerCase(); } catch (e) { host = ""; }
  for (const key of Object.keys(EVENUE_SCHOOLS)) {
    if (host.indexOf(key) !== -1) {
      return Object.assign({}, EVENUE_DEFAULT, EVENUE_SCHOOLS[key], { key });
    }
  }
  return Object.assign({}, EVENUE_DEFAULT, { key: host.split(".")[0] || "unknown" });
}

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

// Every price-looking field in a payload, once per path+field. Strings that
// hold JSON are parsed and walked too: Paciolan ships TIERED_FEES and
// SEAT_AVAILABILITY as encoded strings, so a plain walk reports "string" and
// stops exactly where the interesting numbers are.
// Values to hunt for by VALUE rather than by field name, for when a price
// arrives under a name nothing would guess. Empty in a release: set it to what
// the site quotes for a seat while bringing a school up. This is how Nebraska's
// $102.00 was chased through the network traffic before it turned out to be
// server-rendered into the page instead (see evenueScanPageData in injected.js).
const EVENUE_HUNT_VALUES = [];
const evenueHuntSeen = new Set();

function evenueHuntValue(path, body) {
  if (!EVENUE_HUNT_VALUES.length) return;
  const wanted = new Set(EVENUE_HUNT_VALUES.map(String));
  const hits = [];
  const walk = (node, where, depth) => {
    if (node == null || depth > 9 || hits.length > 40) return;
    if (typeof node === "number" || typeof node === "boolean") {
      if (wanted.has(String(node))) hits.push(where + "=" + node);
      return;
    }
    if (typeof node === "string") {
      if (wanted.has(node.trim())) { hits.push(where + '="' + node + '"'); return; }
      const t = node.trim();
      if ((t.startsWith("{") || t.startsWith("[")) && t.length < 400000) {
        try { walk(JSON.parse(t), where + "(json)", depth + 1); } catch (e) { /* not json */ }
      }
      return;
    }
    if (typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => { if (i < 400) walk(v, where + "[" + i + "]", depth + 1); });
      return;
    }
    for (const k of Object.keys(node)) walk(node[k], where + "." + k, depth + 1);
  };
  walk(body, "", 0);
  if (!hits.length) return;
  const key = path + "|" + hits.join(",").slice(0, 300);
  if (evenueHuntSeen.has(key)) return;
  evenueHuntSeen.add(key);
  bgLog(`[background] Evenue FOUND ${EVENUE_HUNT_VALUES.join("/")} in ` +
    `${path.split("/").slice(-2).join("/")}: ${hits.slice(0, 20).join(" ")}`);
}

const evenuePriceSeen = new Set();

function evenueLogPriceCandidates(path, body) {
  const PRICEY = /price|amount|amt|cost|total|charge|value|fee/i;
  const hits = [];
  const walk = (node, where, depth) => {
    if (node == null || depth > 8 || hits.length > 60) return;
    if (typeof node === "string") {
      // Only bother when it plausibly holds structure.
      const t = node.trim();
      if ((t.startsWith("{") || t.startsWith("[")) && t.length < 400000) {
        try { walk(JSON.parse(t), where + "(json)", depth + 1); } catch (e) { /* not json */ }
      }
      return;
    }
    if (typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.slice(0, 3).forEach((v, i) => walk(v, where + "[" + i + "]", depth + 1));
      return;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      const at = where + "." + k;
      if (PRICEY.test(k) && (typeof v === "number" || typeof v === "string") &&
          String(v).length < 80) {
        hits.push(at + "=" + JSON.stringify(v));
      }
      walk(v, at, depth + 1);
    }
  };
  walk(body, "", 0);
  // Long text fields are where Paciolan hides structure that is not JSON
  // (SEAT_AVAILABILITY). Print the head of each one once so its encoding is
  // readable; a price per seat would show up here.
  const blobs = [];
  const blobWalk = (node, where, depth) => {
    if (node == null || depth > 6 || blobs.length > 6) return;
    if (typeof node === "string") {
      if (node.length > 200) blobs.push(where + " (" + node.length + " chars): " +
        node.slice(0, 220).replace(/\s+/g, " "));
      return;
    }
    if (typeof node !== "object") return;
    if (Array.isArray(node)) { node.slice(0, 2).forEach((v, i) => blobWalk(v, where + "[" + i + "]", depth + 1)); return; }
    for (const k of Object.keys(node)) blobWalk(node[k], where + "." + k, depth + 1);
  };
  blobWalk(body, "", 0);
  blobs.forEach((b) => {
    const bk = path + "|blob|" + b.slice(0, 80);
    if (evenuePriceSeen.has(bk)) return;
    evenuePriceSeen.add(bk);
    bgLog(`[background] Evenue text field ${b}`);
  });
  if (!hits.length) return;
  const key = path + "|" + hits.join(",").slice(0, 300);
  if (evenuePriceSeen.has(key)) return;
  evenuePriceSeen.add(key);
  bgLog(`[background] Evenue price candidates in ${path.split("/").slice(-2).join("/")}: ` +
    hits.slice(0, 25).join(" "));
}

// The per-ticket fee this event actually charges, out of Paciolan's
// TIERED_FEES. Observed:
//
//   Nebraska F26:06  {"tiers":{"0-Infinity":{"feeAmount":0,"feePercentages":[7],
//                     "facFeeAmt":0,"facFeePct":0,"ticketFeeAmt":0,
//                     "ticketFeePct":7}},"roundingAmount":100,...}
//   Colorado F26:F02 {}      - this event charges nothing
//
// feePercentages/feeAmount repeat the ticket+facility figures as a total, so
// only the ticket and facility parts are summed or the fee doubles. Amounts are
// cents, like every other money field on this platform.
//
// One tier is read: "0-Infinity" covers every price at both schools seen so
// far. A genuinely tiered school would need the seat's price to choose, which
// the popup does not have when it converts.
function evenueFeeRule(raw) {
  let table = raw;
  if (typeof table === "string") {
    try { table = JSON.parse(table); } catch (e) { return null; }
  }
  if (!table || typeof table !== "object") return null;
  const tiers = table.tiers && typeof table.tiers === "object" ? table.tiers : null;
  if (!tiers) return { pct: 0, flat: 0, tiers: 0 };
  const keys = Object.keys(tiers);
  if (!keys.length) return { pct: 0, flat: 0, tiers: 0 };
  const tier = tiers[keys[0]] || {};
  const num = (v) => (isFinite(Number(v)) ? Number(v) : 0);
  const pct = num(tier.ticketFeePct) + num(tier.facFeePct);
  const flatCents = num(tier.ticketFeeAmt) + num(tier.facFeeAmt);
  return { pct, flat: flatCents / 100, tiers: keys.length };
}

// tabId -> the fee rule seen on that tab, held because TIERED_FEES arrives in a
// GraphQL response that names no event.
const evenuePendingFees = new Map();

async function evenueRecordFeeRule(tabId, raw, profile, fieldName) {
  const rule = evenueFeeRule(raw);
  if (!rule) return null;
  const school = profile ? (profile.label || profile.key) : "?";
  if (tabId != null) evenuePendingFees.set(tabId, rule);
  const gameKey = tabId != null ? tabGameMap[tabId] : null;
  if (!gameKey) return rule;
  const data = await getStorage();
  const games = data.games || {};
  if (!games[gameKey]) return rule;
  const prev = games[gameKey].fees || {};
  if (prev.pct === rule.pct && prev.flat === rule.flat) return rule;
  games[gameKey].fees = rule;
  await chrome.storage.local.set({ games });
  bgLog(`[background] Evenue (${school}): ${gameKey} fee rule ${rule.pct}% + ` +
    `$${rule.flat.toFixed(2)} per ticket, from ${fieldName || "the fee table"} ` +
    `(${rule.tiers} tier(s) published)`);
  return rule;
}

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

// Name, date and venue out of the event detail object. The ticket page itself
// publishes only the school's internal code — Colorado F26:F02 reads as
// "TT (FB)" with no date at all — so this object is the better source when it
// carries one. Field names differ between schools, so the candidates are tried
// in turn and the whole key list is logged once for whoever meets the next
// school.
const evenueDetailKeysLogged = new Set();

function evenueDetailIdentity(detail, eventId, hostName, profile) {
  const prof = profile || EVENUE_DEFAULT;
  if (!detail || typeof detail !== "object") return {};
  if (!evenueDetailKeysLogged.has(eventId)) {
    evenueDetailKeysLogged.add(eventId);
    bgLog(`[background] Evenue: ${eventId} detail fields: ` +
      Object.keys(detail).join(",").slice(0, 600));
    // Colorado publishes an empty TIERED_FEES but carries this as well; print it
    // once so a fee hiding here cannot be missed the way the $5 constant was.
    // Every field that might name the event, with its value: EVENTNAME on
    // Colorado reads "Texas Tech (FB)" — the opponent only — so the home team
    // has to come from one of the others or from the page.
    const nameBits = ["EVENTNAME", "TITLE", "SSEVENTNAME", "ITEMNAME", "SEASON_NAME",
      "SEO_MESSAGE", "EVENT_MESSAGE", "TYPE", "FAC_TITLE", "FAC_SSTITLE"]
      .filter((k) => detail[k] != null && detail[k] !== "" && typeof detail[k] !== "object")
      .map((k) => `${k}=${JSON.stringify(String(detail[k]).slice(0, 80))}`);
    if (nameBits.length) {
      bgLog(`[background] Evenue: ${eventId} name fields: ${nameBits.join(" ")}`);
    }
    if (detail.ITEM_FEES !== undefined) {
      let shown;
      try { shown = JSON.stringify(detail.ITEM_FEES); } catch (e) { shown = "?"; }
      bgLog(`[background] Evenue: ${eventId} ITEM_FEES = ${String(shown).slice(0, 400)}`);
    }
  }
  const pick = (...keys) => {
    for (const k of keys) {
      const v = detail[k];
      if (v != null && v !== "" && typeof v !== "object") return String(v).trim();
    }
    return null;
  };
  // A name that is only a code ("TT (FB)", "F26") is worse than nothing: the
  // longer description is what a person recognises.
  // Confirmed against Colorado F26:F02, whose detail object holds EVENTNAME,
  // TITLE, SSEVENTNAME and ITEMNAME for the name; EVENTDT, EVENTDTFAC and
  // STARTDT for the date; FAC_TITLE and FAC_SSTITLE for the venue. The older
  // spellings stay after them for schools on a different build.
  // SSEVENTNAME is the clean opponent ("Texas Tech"); EVENTNAME carries the
  // sport code after it ("Texas Tech (FB)"); ITEMNAME is an abbreviation
  // ("TT (FB)"). Prefer the clean one, then fall back down the list.
  const opponent = pick.apply(null, prof.nameKeys || EVENUE_DEFAULT.nameKeys);
  // The payload names only the visiting side, so the host comes from the page.
  // "University of Colorado vs Texas Tech" beats "Texas Tech (FB)".
  const host = (prof.hostFromTitle !== false && hostName) ? String(hostName).trim() : null;
  const name = opponent && host && opponent.toLowerCase() !== host.toLowerCase()
    && opponent.toLowerCase().indexOf(host.toLowerCase()) === -1
    ? `${host} vs ${opponent}`
    : opponent;
  // EVENTDTFAC is the facility's own clock where the two differ, which is what a
  // ticket shows; EVENTDT is the fallback, then the on-sale start.
  const rawDate = pick.apply(null, prof.dateKeys || EVENUE_DEFAULT.dateKeys);
  return {
    name: name || null,
    date: rawDate ? (isoToDisplayDate(rawDate) || rawDate) : null,
    venue: pick.apply(null, prof.venueKeys || EVENUE_DEFAULT.venueKeys) || null,
  };
}

async function saveEvenuePriceLevels(details, tabId, site, eventInfo, url) {
  const profile = evenueProfile(url);
  for (const detail of details) {
    const eventId = evenueEventIdFromDetail(detail);
    if (!eventId) continue;

    const collected = new Map();
    evenueCollectPrices(detail.PL_PT_PRICES !== undefined ? detail.PL_PT_PRICES : detail,
                        collected, 0);
    if (!collected.size) {
      bgLog(`[background] Evenue: ${eventId} price payload yielded no levels — ` +
        `shape was ${describeShape(detail.PL_PT_PRICES, 4)}; the detail object ` +
        `holds: ${Object.keys(detail).join(",").slice(0, 600)}`);
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
    // Fill in identity this object knows and the page does not. Never overwrite
    // a value already stored: the page read wins when it produced something.
    const ident = evenueDetailIdentity(detail, eventId, eventInfo && eventInfo.host, profile);
    const prev = games[gameKey].match || {};
    const pageName = (eventInfo && eventInfo.name) || prev.name || null;
    // "TT (FB)", "F26" and friends are internal codes, not event names.
    const isCode = (v) => !v || v.length <= 12 || /^[A-Z0-9 ()._-]+$/.test(v);
    games[gameKey].match = {
      name: (isCode(pageName) && ident.name) ? ident.name : (pageName || ident.name),
      date: (eventInfo && eventInfo.date) || prev.date || ident.date || null,
      venue: (eventInfo && eventInfo.venue) || prev.venue || ident.venue || null,
      currency: prev.currency || "USD",
      performanceId: prev.performanceId || eventId,
    };
    await chrome.storage.local.set({ games });

    // MIN_PRICE/MAX_PRICE are what the site advertises for the event. When they
    // sit above the cheapest and priciest levels, the difference is a fee this
    // school charges without publishing it in TIERED_FEES — Virginia Tech
    // advertises $112.00-$207.00 against a $107.00-$199.00 table. Reported, not
    // applied: the two gaps here are $5 and $8, so no single rule explains them
    // and a guess would misprice every seat.
    const values = Object.keys(levels).map((k) => levels[k]);
    const lo = Math.min.apply(null, values), hi = Math.max.apply(null, values);
    const advLo = Number(detail.MIN_PRICE), advHi = Number(detail.MAX_PRICE);
    if (isFinite(advLo) && isFinite(advHi) && advLo > 0) {
      const gapLo = Math.round(advLo * 10) - lo, gapHi = Math.round(advHi * 10) - hi;
      if (gapLo > 0 || gapHi > 0) {
        bgLog(`[background] Evenue (${profile.label || profile.key}): ${eventId} advertises ` +
          `$${(advLo / 100).toFixed(2)}-$${(advHi / 100).toFixed(2)} but its level table is ` +
          `$${(lo / 1000).toFixed(2)}-$${(hi / 1000).toFixed(2)} — a gap of ` +
          `$${(gapLo / 1000).toFixed(2)}/$${(gapHi / 1000).toFixed(2)} per ticket, ` +
          `charged but not published in TIERED_FEES`);
      }
    }

    const preview = Object.keys(levels).sort().slice(0, 8)
      .map((k) => `${k}=$${(levels[k] / 1000).toFixed(2)}`).join(" ");
    bgLog(`[background] Evenue: ${eventId} price levels (${Object.keys(levels).length}) ` +
      `[${scale.note}] ${preview}`);

    // Seats may already have arrived and been parked for want of a price.
    const pending = evenuePendingSeats.get(gameKey);
    if (pending) {
      evenuePendingSeats.delete(gameKey);
      bgLog(`[background] Evenue: re-parsing held seat payload for ${eventId} now prices are known`);
      await saveEvenueSeats(eventId, pending.body, pending.tabId, site, pending.eventInfo,
        pending.url);
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

async function saveEvenueSeats(eventId, body, tabId, site, eventInfo, url) {
  const profile = evenueProfile(url);
  const split = evenueSplitPayload(body);
  const rows = split.rows;
  const headers = split.headers;
  if (!rows || !headers) {
    // Name what arrived. The header row is found by sniffing for known column
    // names, so a school whose columns are named differently lands here and
    // the shape is the only way to tell that from an empty event.
    bgLog(`[background] Evenue (${profile.label || profile.key}): could not find rows + ` +
      `header row in the payload. ` +
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
    // A stored name that came from the event payload beats the page's, when
    // the page's is only an internal code. Colorado publishes "TT (FB)";
    // whether that or "University of Colorado vs Texas Tech" survived used to
    // depend on whether the price table arrived before the seats or after.
    const isCode = (v) => !v || v.length <= 12 || /^[A-Z0-9 ()._-]+$/.test(v);
    const keptName = (isCode(eventInfo.name) && prev.name && !isCode(prev.name))
      ? prev.name : eventInfo.name;
    games[gameKey].match = {
      name: keptName,
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
  // NOT derived from the sold rows on the same PRICELEVELCD. Nebraska F26:06
  // prices its sold level-1 seats at $220 while the site quotes $102 for an
  // available level-1 seat (NS:34 row 48), so SLP_PRICE on a sold row is a
  // different product — a season or plan price — and copying it across would
  // put a wrong price in front of a buyer. The single-game price comes from
  // elsewhere in the GraphQL traffic; evenueLogPriceCandidates hunts for it.

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
    evenuePendingSeats.set(gameKey, { body, tabId, eventInfo, url });
    bgLog(`[background] Evenue: holding ${rows.length}-row payload for ${eventId} ` +
      `until the price-level table arrives`);
  }

  const school = profile.label || profile.key;
  const fromInline = total - fromPriceLevel;
  bgLog(`[background] Evenue (${school}): ${total} available seats from ${rows.length} rows` +
    (unavailable ? `, ${unavailable} unavailable/hidden` : "") +
    (missingPrice ? `, ${missingPrice} had no price` : "") +
    (fromPriceLevel ? `, ${fromPriceLevel} priced from the level table` : "") +
    (fromInline ? `, ${fromInline} priced inline` : ""));
  // A school that stops behaving like its profile is the thing that used to go
  // unnoticed until someone looked at a popup. Say it here instead.
  if (total) {
    const actual = fromPriceLevel && !fromInline ? "levels"
      : fromInline && !fromPriceLevel ? "inline" : "mixed";
    if (profile.priceSource && actual !== profile.priceSource) {
      bgLog(`[background] Evenue (${school}): prices came from ${actual}, but this school ` +
        `is recorded as ${profile.priceSource} — update EVENUE_SCHOOLS if the site changed`);
    }
  }

  games[gameKey].seats = mergeSeats(games[gameKey].seats, seats, tabId, gameKey);
  games[gameKey].site = site;
  games[gameKey].lastScanned = Date.now();
  // The fee table usually arrives before the seats and names no event, so it is
  // held per tab until there is a game to attach it to.
  if (tabId != null && evenuePendingFees.has(tabId)) {
    games[gameKey].fees = evenuePendingFees.get(tabId);
  }

  if (tabId) tabGameMap[tabId] = gameKey;
  await chrome.storage.local.set({ games });
}

// --- Ruth Eckerd Hall / Tessitura SYOS -----------------------------------
// Confirmed on performance 33816 (secure.rutheckerdhall.com/33733/33816):
// GetSeatList returned 728 seats for screen 7 alone.
//
//   seat_num         "34"           the seat
//   seat_row         "T"            the row, lettered here rather than numbered
//   section          11             an id, named by the payload's `sections`
//   zone_no          5152           the price zone
//   seat_status_desc "Unavailable"
//
// The price is per ZONE and arrives in a different payload. GetInitData's
// Pricing gives price 83 + PerSeatFee 21 for zone 5152, and ZoneColorList
// independently prices that zone at 104 - the two agree, so the all-in figure
// is what gets stored rather than the base.
//
// Availability is read from seat_status_desc, the words, not seat_status, the
// codes: the first capture showed -1 and 13 BOTH meaning "Unavailable", so the
// numbers are not a two-value flag and guessing at them would either hide every
// seat or offer sold ones.

// performanceId -> { zonePrice, screens, facilityId, seenScreens }
const syosEvents = {};

function syosPerformanceId(url, body) {
  const m = String(url).match(/[?&]performanceId=(\d+)/i);
  if (m) return m[1];
  const fromBody = body && (body.PerformanceId || body.performanceId);
  return fromBody ? String(fromBody) : "";
}

// All-in price per zone. ZoneColorList already carries the summed figure;
// Pricing carries the parts. Having both is how the sum was confirmed rather
// than assumed, and either alone is enough to price a seat.
function syosZonePrices(body) {
  const out = {};
  for (const z of (body && body.ZoneColorList) || []) {
    if (!z || z.zone_no == null) continue;
    const n = Number(z.price);
    if (isFinite(n) && n > 0) out[String(z.zone_no)] = n;
  }
  for (const p of (body && body.Pricing) || []) {
    if (!p || p.zone_no == null) continue;
    const key = String(p.zone_no);
    if (out[key] != null) continue;
    const base = Number(p.price);
    const fee = Number(p.PerSeatFee);
    if (!isFinite(base) || base <= 0) continue;
    out[key] = base + (isFinite(fee) ? fee : 0);
  }
  return out;
}

function syosIndexInit(eventId, body) {
  const prices = syosZonePrices(body);
  const screens = ((body && body.Screens) || [])
    .filter((x) => x && x.IsAvailable !== false)
    .map((x) => ({ id: x.ScreenId, name: String(x.ScreenDescription || "") }));
  const prev = syosEvents[eventId] || {};
  syosEvents[eventId] = {
    zonePrice: Object.assign({}, prev.zonePrice, prices),
    screens: screens.length ? screens : prev.screens || [],
    facilityId: (body && body.FacilityId) || prev.facilityId || null,
    seenScreens: prev.seenScreens || new Set(),
  };
  const preview = Object.keys(prices).sort()
    .map((z) => `${z}=$${prices[z].toFixed(2)}`).join(" ");
  bgLog(`[background] SYOS: ${eventId} ${Object.keys(prices).length} price zone(s) ` +
    `[${preview}], ${screens.length} screen(s) on sale: ` +
    screens.map((x) => `${x.id} ${x.name}`).join(", "));
}

// "Available" and nothing else. Tessitura ships a 46-row hold-code table and
// the descriptions spell out why a seat is gone; anything not plainly available
// is left out rather than interpreted.
function syosIsAvailable(seat) {
  const desc = String((seat && seat.seat_status_desc) || "").trim().toLowerCase();
  return desc === "available";
}

async function saveSyosSeats(eventId, body, tabId, site, eventInfo, url) {
  if (!body || !Array.isArray(body.seats)) return;

  const gameKey = `${site}:${eventId}`;
  const data = await getStorage();
  const games = data.games || {};
  if (!games[gameKey]) games[gameKey] = emptyGame();

  if (eventInfo && eventInfo.name) {
    const prev = games[gameKey].match || {};
    games[gameKey].match = {
      name: eventInfo.name,
      date: eventInfo.date || prev.date || null,
      venue: eventInfo.venue || prev.venue || "Ruth Eckerd Hall",
      currency: "USD",
      performanceId: eventId,
    };
  }

  const venueName = games[gameKey].match && games[gameKey].match.venue;
  logTierMapping(venueName);

  // This payload prices its own zones too, so a screen opened before
  // GetInitData arrives is still priced.
  const indexed = syosEvents[eventId] ||
    { zonePrice: {}, screens: [], seenScreens: new Set() };
  indexed.zonePrice = Object.assign({}, indexed.zonePrice, syosZonePrices(body));
  if (!indexed.seenScreens) indexed.seenScreens = new Set();
  syosEvents[eventId] = indexed;
  const zonePrice = indexed.zonePrice;

  // section id -> "Upper Orchestra West". The bare ids would tier as "Other".
  const sectionNames = {};
  for (const sec of body.sections || []) {
    if (sec && sec.section != null) {
      sectionNames[String(sec.section)] = String(sec.section_desc || "");
    }
  }

  const screenId = (String(url || "").match(/[?&]screenId=(\d+)/i) || [])[1] || null;
  if (screenId) indexed.seenScreens.add(String(screenId));

  const seats = {};
  let unavailable = 0;
  let missingPrice = 0;
  const statusSeen = new Map();

  for (const seat of body.seats) {
    if (!seat) continue;
    const desc = String(seat.seat_status_desc || "").trim();
    if (statusSeen.size < 12) statusSeen.set(desc, (statusSeen.get(desc) || 0) + 1);
    if (!syosIsAvailable(seat)) { unavailable++; continue; }

    const dollars = zonePrice[String(seat.zone_no)];
    if (dollars == null) { missingPrice++; continue; }

    const block = sectionNames[String(seat.section)] ||
      String(seat.ZoneLabel || seat.section || "");
    const row = String(seat.seat_row || "");
    // seat_no is Tessitura's own id, unique across the venue: two screens
    // cannot collide, and re-opening a screen replaces rather than doubles.
    seats[`syos:${seat.seat_no}`] = {
      block,
      row,
      seat: String(seat.seat_num || ""),
      area: String(seat.ZoneLabel || ""),
      category: "standard",
      tier: VenueTiers.tierFor(venueName, block, row),
      price: Math.round(dollars * 1000),
      exclusive: true,
      site: "rutheckerd",
      accessible: false,
      attributes: [],
    };
  }

  const total = Object.keys(seats).length;
  const screens = indexed.screens || [];
  const unseen = screens.filter((x) => !indexed.seenScreens.has(String(x.id)));
  bgLog(`[background] SYOS: ${total} available seats from ${body.seats.length} on ` +
    `screen ${screenId || "?"}` +
    (unavailable ? `, ${unavailable} unavailable` : "") +
    (missingPrice ? `, ${missingPrice} in a zone with no price` : ""));
  if (statusSeen.size) {
    bgLog(`[background] SYOS: seat_status_desc values seen: ` +
      [...statusSeen.entries()].map((e) => `"${e[0]}"x${e[1]}`).join(", "));
  }
  // A partial capture that looks complete is the thing to avoid here.
  if (unseen.length) {
    bgLog(`[background] SYOS: ${unseen.length} screen(s) not captured yet - ` +
      unseen.map((x) => `${x.id} ${x.name}`).join(", ") +
      `. Open each one on the page to add its seats.`);
  } else if (screens.length) {
    bgLog(`[background] SYOS: all ${screens.length} screen(s) captured`);
  }

  // mergeSeats, not a raw spread: an auto-pull must export this capture
  // alone rather than whatever an earlier screen left behind.
  games[gameKey].seats = mergeSeats(games[gameKey].seats, seats, tabId, gameKey);
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

  games[gameKey].seats = mergeSeats(games[gameKey].seats, seats, tabId, gameKey);
  games[gameKey].site = site;
  games[gameKey].lastScanned = Date.now();

  if (tabId) tabGameMap[tabId] = gameKey;
  await chrome.storage.local.set({ games });
}

// ─── Vivid Seats ──────────────────────────────────────────────────────────
// GET www.vividseats.com/hermes/api/v1/listings?productionId=<id>&currency=USD
//
// Top level: { global, tickets, groups, sections, i18n }. `tickets` is the
// inventory — 455 listings on the Kacey Musgraves capture, against a stated
// listingCount of 455 and ticketCount of 1607.
//
// Every field below was read off that capture, not guessed. Each listing
// carries the same value twice, once short and once spelled out:
//
//   s / sectionName           "Section 208"
//   r / row                   "G"
//   q / quantity              "1"      seats in this listing
//   p                         "33.15"  price per ticket, before fees
//   aip / allInPricePerTicket "47.00"  price per ticket, fees included
//   i                         "VB17016531865"  listing id
//   d                         "208"    section id  -> sections[].i
//   c                         "408358" group id    -> sections[].g
//   m                         "1,2,3,4,5,6"  purchasable splits, NOT quantity
//   n                         delivery/entry note
//   badges / perks            ["Lowest Price in Section"], ["Seated Together"]
//   stp                       "Ticketmaster Transfer"
//
// The long and short names held identical values in all three sampled rows,
// so the long name is preferred and the short one is the fallback.

// Vivid quotes two prices and the page has a toggle between them. `aip` is
// what the buyer actually pays, which is the number the other marketplaces in
// this extension already report, so it wins. FEE_MULTIPLIER_BY_SITE stays 1.0
// because the fee is already inside this figure — do not stack another on it.
function vividSeatsPrice(listing) {
  const candidates = [listing.allInPricePerTicket, listing.aip, listing.p];
  for (const c of candidates) {
    const n = typeof c === "string" ? parseFloat(c) : c;
    if (typeof n === "number" && isFinite(n) && n > 0) return n;
  }
  return null;
}

// No is-parking flag was present on any sampled listing, so this reads the
// section name.
function vividSeatsIsParking(listing) {
  const name = String(listing.sectionName || listing.s || "");
  return /\bparking\b|\blot\s*[0-9]+\b/i.test(name);
}

// Anything a buyer would want to see before committing: the badges Vivid
// shows on the listing, its perks, and how the ticket is delivered.
function vividSeatsAttributes(listing) {
  const out = [];
  if (Array.isArray(listing.badges)) {
    for (const b of listing.badges) {
      const t = b && (b.title || b.category);
      if (t) out.push(String(t));
    }
  }
  if (Array.isArray(listing.perks)) {
    for (const perk of listing.perks) if (perk) out.push(String(perk));
  }
  const delivery = String(listing.stp || "").trim();
  if (delivery) out.push(delivery);
  return out;
}

// Group id -> group name, for the Area column.
//
// `sections[].g` is the group a section belongs to (both "Section 102" and
// "Section 104" sat under 408357), and a listing's `c` is that same id. Which
// field on a `groups` row carries the id was NOT observable — the probe
// printed the group key list but no sample row — so every plausible id field
// is indexed. An unresolved id leaves Area blank, which is what the other
// resale parsers do anyway.
function vividSeatsGroupNames(body) {
  const byId = {};
  const groups = Array.isArray(body.groups) ? body.groups : [];
  for (const g of groups) {
    if (!g) continue;
    const name = g.n != null ? String(g.n) : "";
    if (!name) continue;
    for (const idField of [g.i, g.g, g.c]) {
      if (idField != null && idField !== "") byId[String(idField)] = name;
    }
  }
  return byId;
}

async function saveVividSeatsSeats(eventId, body, tabId, site, eventInfo) {
  if (!body || !Array.isArray(body.tickets)) return;

  const gameKey = `${site}:${eventId}`;
  const data = await getStorage();
  const games = data.games || {};
  if (!games[gameKey]) games[gameKey] = emptyGame();

  // The payload names the event and the venue itself, so a failed JSON-LD read
  // is not fatal here the way it is on sites that publish nothing. JSON-LD
  // still wins when present: it carries the date, which this payload does not
  // expose in any field whose meaning was confirmed.
  const globalInfo = body.global || {};
  const payloadName = globalInfo.productionName ? String(globalInfo.productionName) : null;
  const payloadVenue = globalInfo.mapTitle ? String(globalInfo.mapTitle) : null;
  const name = (eventInfo && eventInfo.name) || payloadName;

  if (name) {
    const prev = games[gameKey].match || {};
    games[gameKey].match = {
      name,
      date: (eventInfo && eventInfo.date) || prev.date || null,
      venue: (eventInfo && eventInfo.venue) || payloadVenue || prev.venue || null,
      currency: "USD",
      performanceId: eventId,
    };
  }

  const venueName = games[gameKey].match && games[gameKey].match.venue;
  logTierMapping(venueName);

  const groupNames = vividSeatsGroupNames(body);
  const seats = {};
  let parking = 0;
  let missingPrice = 0;

  try {
    for (const listing of body.tickets) {
      if (!listing) continue;
      if (vividSeatsIsParking(listing)) { parking++; continue; }

      const dollars = vividSeatsPrice(listing);
      if (dollars == null) { missingPrice++; continue; }
      // Stored in thousandths to match centsToUSD() in the popup.
      const price = Math.round(dollars * 1000);

      const block = String(listing.sectionName || listing.s || "");
      const row = String(listing.row || listing.r || "");
      // `m` is the split list, not the count — reading it here would turn a
      // one-seat listing that sells in 1,2,3,4,5,6 into six phantom seats.
      const qty = Number(listing.quantity || listing.q) || 1;
      const area = groupNames[String(listing.c)] || "";
      const attributes = vividSeatsAttributes(listing);
      const note = String(listing.n || "");
      const accessible = /\b(ada|accessible|wheelchair)\b/i.test(block + " " + note);
      const listingId = String(listing.i || (block + "-" + row));

      // Vivid publishes no seat numbers on resale listings — only section, row
      // and how many are available — so a listing of N becomes N seats with an
      // empty seat field, exactly as TickPick does.
      for (let i = 0; i < qty; i++) {
        seats[`${listingId}-${i}`] = {
          block,
          row,
          seat: "",
          area,
          category: "resale",
          tier: VenueTiers.tierFor(venueName, block, row),
          price,
          exclusive: true,
          site: "vividseats",
          accessible,
          attributes,
        };
      }
    }
  } catch (error) {
    bgLog("[background] Error parsing Vivid Seats listings:", error.message);
  }

  const total = Object.keys(seats).length;
  bgLog(`[background] Vivid Seats: ${total} seats from ${body.tickets.length} listings` +
    (parking ? `, ${parking} parking excluded` : "") +
    (missingPrice ? `, ${missingPrice} had no price` : "") +
    (globalInfo.ticketCount ? `, page states ${globalInfo.ticketCount}` : ""));

  games[gameKey].seats = mergeSeats(games[gameKey].seats, seats, tabId, gameKey);
  games[gameKey].site = site;
  games[gameKey].lastScanned = Date.now();

  if (tabId) tabGameMap[tabId] = gameKey;
  await chrome.storage.local.set({ games });
}

// ─── TicketsForLess ───────────────────────────────────────────────────────
// GET www.ticketsforless.com/api/tickets/tfl?EventID=<id>
//
// Top level: { siteConfig, event, cartItems, tickets }. 538 tickets on event
// 7730195 (Kansas City Chiefs vs Indianapolis Colts, 2026-09-20). A ticket,
// read off that capture:
//
//   id          "4301087"
//   sec         "334"              already the bare section number
//   row         "14"
//   qty         1                  seats in the listing
//   splits      1 / 23 / 2         a CODE, not a count — a 5-seat listing
//                                  carried 23
//   seats       "21" / "15-19" / "29-30"
//                                  seat NUMBERS, as a single seat or a range
//   price       98                 dollars
//   faceValue   87
//   serviceFee  0
//   delivery    ["M"]
//   notes       "Uppers XFER"
//   mapSection  "334" / "PENTHOUSE"
//
// The request carries only EventID — no quantity, page or filter.

// `price`, in dollars. serviceFee was 0 on every sampled ticket while price
// sat above faceValue (98 against 87), which reads as a price that already
// includes the markup. That is inferred, not confirmed: the parser logs the
// siteConfig keys once so a fee setting there can be checked.
function tflPrice(listing) {
  const n = typeof listing.price === "string" ? parseFloat(listing.price) : listing.price;
  return typeof n === "number" && isFinite(n) && n > 0 ? n : null;
}

function tflIsParking(listing) {
  return /\bparking\b|\blot\s*[0-9]+\b/i.test(String(listing.sec || "") + " " +
    String(listing.mapSection || ""));
}

// "15-19" -> [15..19], "21" -> [21], "1,3,5" -> [1,3,5].
//
// Only returned when the seats named match the listing's quantity exactly. A
// range that disagrees with qty cannot say WHICH seats are for sale, and
// guessing would print specific seat numbers the seller never offered — so a
// mismatch yields [] and the seats stay unnumbered.
function tflSeatNumbers(listing) {
  const raw = String(listing.seats == null ? "" : listing.seats).trim();
  const qty = Number(listing.qty) || 0;
  if (!raw || !qty) return [];
  const out = [];
  for (const part of raw.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const range = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const a = Number(range[1]), b = Number(range[2]);
      if (b < a || b - a > 60) return [];
      for (let i = a; i <= b; i++) out.push(String(i));
    } else if (/^\d+$/.test(p)) {
      out.push(String(Number(p)));
    } else {
      return [];
    }
  }
  return out.length === qty ? out : [];
}

function tflAttributes(listing) {
  const out = [];
  const notes = String(listing.notes || "").trim();
  if (notes) out.push(notes);
  if (Array.isArray(listing.features)) {
    for (const f of listing.features) {
      const name = f && typeof f === "object" ? (f.name || f.title) : f;
      if (name) out.push(String(name));
    }
  }
  return out;
}

// The event object's field names were not visible in the capture — only its
// performers array was sampled — so the common names are tried and the real
// key list is logged once.
function tflEventIdentity(event) {
  if (!event || typeof event !== "object") return {};
  const pick = (...keys) => {
    for (const k of keys) {
      const v = event[k];
      if (v != null && v !== "" && typeof v !== "object") return String(v);
    }
    return null;
  };
  const venueObj = event.venue && typeof event.venue === "object" ? event.venue : null;
  return {
    name: pick("name", "title", "eventName", "displayName"),
    date: isoToDisplayDate(pick("dateLocal", "localDate", "eventDateLocal", "date",
      "eventDate", "startDate", "dateTime", "datetime")),
    venue: (venueObj && venueObj.name ? String(venueObj.name) : null) ||
      pick("venueName", "venue"),
  };
}

let tflShapeLogged = false;

async function saveTicketsForLessSeats(eventId, body, tabId, site, eventInfo) {
  if (!body || !Array.isArray(body.tickets)) return;

  const gameKey = `${site}:${eventId}`;
  const data = await getStorage();
  const games = data.games || {};
  if (!games[gameKey]) games[gameKey] = emptyGame();

  if (!tflShapeLogged) {
    tflShapeLogged = true;
    bgLog("[background] TicketsForLess: event keys = " +
      (body.event ? Object.keys(body.event).join(",") : "(no event)") +
      " | siteConfig keys = " +
      (body.siteConfig ? Object.keys(body.siteConfig).join(",") : "(no siteConfig)"));
    // Whether price is what the buyer pays at checkout hangs on these.
    if (body.siteConfig) {
      const feeBits = ["noFees", "tax", "deliveryAmount"].map((k) => {
        let v;
        try { v = JSON.stringify(body.siteConfig[k]); } catch (e) { v = "?"; }
        return k + "=" + String(v).slice(0, 200);
      });
      bgLog("[background] TicketsForLess: fee settings " + feeBits.join(" | "));
    }
  }

  const fromPayload = tflEventIdentity(body.event);
  const name = (eventInfo && eventInfo.name) || fromPayload.name;
  if (name) {
    const prev = games[gameKey].match || {};
    games[gameKey].match = {
      name,
      date: (eventInfo && eventInfo.date) || fromPayload.date || prev.date || null,
      venue: (eventInfo && eventInfo.venue) || fromPayload.venue || prev.venue || null,
      currency: "USD",
      performanceId: eventId,
    };
  }

  const venueName = games[gameKey].match && games[gameKey].match.venue;
  logTierMapping(venueName);

  const seats = {};
  let parking = 0;
  let missingPrice = 0;
  let numbered = 0;
  let rangeMismatch = 0;

  try {
    for (const listing of body.tickets) {
      if (!listing) continue;
      if (tflIsParking(listing)) { parking++; continue; }

      const dollars = tflPrice(listing);
      if (dollars == null) { missingPrice++; continue; }
      // Stored in thousandths to match centsToUSD() in the popup.
      const price = Math.round(dollars * 1000);

      const block = String(listing.sec || listing.mapSection || "");
      const row = String(listing.row != null ? listing.row : "");
      // `splits` is a code, never a count — a five-seat listing carried 23.
      const qty = Number(listing.qty) || 1;
      const numbers = tflSeatNumbers(listing);
      if (numbers.length) numbered++;
      else if (String(listing.seats || "").trim()) rangeMismatch++;
      const attributes = tflAttributes(listing);
      const listingId = String(listing.id != null ? listing.id : `${block}-${row}`);
      const accessible = /\b(ada|accessible|wheelchair)\b/i.test(block + " " + attributes.join(" "));

      for (let i = 0; i < qty; i++) {
        seats[`${listingId}-${i}`] = {
          block,
          row,
          seat: numbers[i] != null ? numbers[i] : "",
          area: "",
          category: "resale",
          tier: VenueTiers.tierFor(venueName, block, row),
          price,
          exclusive: true,
          site: "ticketsforless",
          accessible,
          attributes,
        };
      }
    }
  } catch (error) {
    bgLog("[background] Error parsing TicketsForLess tickets:", error.message);
  }

  const total = Object.keys(seats).length;
  bgLog(`[background] TicketsForLess: ${total} seats from ${body.tickets.length} listings, ` +
    `${numbered} with seat numbers` +
    (rangeMismatch ? `, ${rangeMismatch} whose seat range did not match the quantity (left unnumbered)` : "") +
    (parking ? `, ${parking} parking excluded` : "") +
    (missingPrice ? `, ${missingPrice} had no price` : ""));

  games[gameKey].seats = mergeSeats(games[gameKey].seats, seats, tabId, gameKey);
  games[gameKey].site = site;
  games[gameKey].lastScanned = Date.now();

  if (tabId) tabGameMap[tabId] = gameKey;
  await chrome.storage.local.set({ games });
}

// ─── GoTickets ────────────────────────────────────────────────────────────
// GET gotickets.com/rest/events/<eventId>/listings
//
// Top level: { listings, event, venueConfiguration, redirect }. 57 listings on
// event 1984079 (Trans-Siberian Orchestra, T-Mobile Center, 12-29-2026). Read
// off that capture:
//
//   id                    7255422774
//   section               "Lower 101"       level + section, like AXS
//   sectionId             1891434           -> venueConfiguration.sections[].id
//   row                   "31"
//   quantity              2                 seats in the listing
//   validSplitQuantities  [2] / [1,2,3,4,6] purchasable lot sizes, NOT a count
//   displayPrice          298               before fees, DOLLARS
//   serviceFee            29
//   allInPrice            330               what the buyer pays
//   deliveryMethods       [{ displayName: "Mobile Transfer", price: 6 }]
//   attributes            [26]              ids -> /rest/listing-attributes
//   generalAdmission      false
//   notes                 "Delivery Delay"
//
// Section -> group is resolved inside the same payload
// (venueConfiguration.sections[].groupId -> venueConfiguration.groups[].name),
// so the Area column has no ordering dependency on a second request.
//
// No seat numbers are published.

// allInPrice, never the parts summed. Base price, service fee and the delivery
// charge together matched allInPrice on two sampled listings (148/14/6 -> 168,
// 865/87/6 -> 958) and missed on the third (298/29/6 add to 333, against 330),
// so the breakdown is not a reliable way to rebuild the total.
function goTicketsPrice(listing) {
  const candidates = [listing && listing.allInPrice, listing && listing.displayPrice];
  for (const c of candidates) {
    const n = typeof c === "string" ? parseFloat(c) : c;
    if (typeof n === "number" && isFinite(n) && n > 0) return n;
  }
  return null;
}

// "Lower 101" -> "101". The level is the Area column already, and the curated
// tier maps are keyed by the bare number. Names without a trailing number
// ("VIP Packages") are kept whole — there is nothing to shorten them to.
function goTicketsBlockName(listing) {
  const full = String((listing && listing.section) || "");
  const tail = full.match(/([0-9]{1,4}[A-Za-z]?)\s*$/);
  return tail ? tail[1] : full;
}

function goTicketsIsParking(listing) {
  return /\bparking\b|\blot\s*[0-9]+\b/i.test(String((listing && listing.section) || ""));
}

// id -> name, from /rest/listing-attributes (68 entries: "Mobile Transfer",
// "Female Ticket", "Wheelchair Accessible", …).
const goTicketsAttributeNames = {};

function goTicketsIndexAttributes(rows) {
  let added = 0;
  for (const r of rows) {
    if (r && r.id != null && r.name) {
      goTicketsAttributeNames[String(r.id)] = String(r.name);
      added++;
    }
  }
  if (added) bgLog(`[background] GoTickets: indexed ${added} listing attribute name(s)`);
}

function goTicketsAttributes(listing) {
  const out = [];
  if (Array.isArray(listing.attributes)) {
    for (const id of listing.attributes) {
      if (id == null) continue;
      // An unindexed id is still worth keeping visible rather than dropping.
      out.push(goTicketsAttributeNames[String(id)] || ("attribute " + id));
    }
  }
  if (Array.isArray(listing.deliveryMethods)) {
    for (const d of listing.deliveryMethods) {
      const name = d && (d.displayName || d.retailDisplayName || d.enumName);
      if (name) out.push(String(name));
    }
  }
  if (listing.generalAdmission === true) out.push("General admission");
  const notes = String(listing.notes || "").trim();
  if (notes) out.push(notes);
  return out;
}

// The event object's field names were NOT visible in the capture — the probe
// only named its eventPerformers array. So this tries the common names and the
// parser logs the real key list once, which is what to read if the name or
// date comes back empty.
function goTicketsEventIdentity(event) {
  if (!event || typeof event !== "object") return {};
  const pick = (...keys) => {
    for (const k of keys) {
      const v = event[k];
      if (v != null && v !== "" && typeof v !== "object") return String(v);
    }
    return null;
  };
  const venueObj = event.venue && typeof event.venue === "object" ? event.venue : null;
  return {
    name: pick("name", "title", "eventName", "displayName"),
    // eventTimeLocal is the real field, from the live event's key list; the
    // venue clock is what a ticket shows, so it wins over eventTimeUtc, which
    // can fall on the next calendar day for an evening show.
    date: isoToDisplayDate(pick("eventTimeLocal", "localDate", "eventDateLocal",
      "dateLocal", "eventDate", "date", "startDate", "dateTime", "eventTimeUtc")),
    venue: (venueObj && venueObj.name ? String(venueObj.name) : null) ||
      pick("venueName", "venue"),
  };
}

let goTicketsEventKeysLogged = false;

async function saveGoTicketsSeats(eventId, body, tabId, site, eventInfo) {
  if (!body || !Array.isArray(body.listings)) return;

  const gameKey = `${site}:${eventId}`;
  const data = await getStorage();
  const games = data.games || {};
  if (!games[gameKey]) games[gameKey] = emptyGame();

  if (body.event && !goTicketsEventKeysLogged) {
    goTicketsEventKeysLogged = true;
    bgLog("[background] GoTickets: event keys = " + Object.keys(body.event).join(","));
  }

  // JSON-LD first, then the payload's own event object.
  const fromPayload = goTicketsEventIdentity(body.event);
  const name = (eventInfo && eventInfo.name) || fromPayload.name;
  if (name) {
    const prev = games[gameKey].match || {};
    games[gameKey].match = {
      name,
      date: (eventInfo && eventInfo.date) || fromPayload.date || prev.date || null,
      venue: (eventInfo && eventInfo.venue) || fromPayload.venue || prev.venue || null,
      currency: "USD",
      performanceId: eventId,
    };
  }

  const venueName = games[gameKey].match && games[gameKey].match.venue;
  logTierMapping(venueName);

  // sectionId -> group name, from this same payload.
  const vc = body.venueConfiguration || {};
  const groupNames = {};
  for (const g of Array.isArray(vc.groups) ? vc.groups : []) {
    if (g && g.id != null && g.name) groupNames[String(g.id)] = String(g.name);
  }
  const sectionGroup = {};
  for (const sec of Array.isArray(vc.sections) ? vc.sections : []) {
    if (sec && sec.id != null && sec.groupId != null) {
      sectionGroup[String(sec.id)] = groupNames[String(sec.groupId)] || "";
    }
  }

  const seats = {};
  let parking = 0;
  let missingPrice = 0;
  // Lot-size diagnostic. The event page url carried quantity=2, but the
  // listings request did not. If every listing can be bought as a pair, the
  // response was filtered to that quantity server-side and a sweep is needed;
  // if some cannot, the response already holds every quantity.
  let notSoldAsPair = 0;
  const splitSizes = new Set();

  try {
    for (const listing of body.listings) {
      if (!listing) continue;
      if (goTicketsIsParking(listing)) { parking++; continue; }

      const dollars = goTicketsPrice(listing);
      if (dollars == null) { missingPrice++; continue; }
      // Stored in thousandths to match centsToUSD() in the popup.
      const price = Math.round(dollars * 1000);

      const splits = Array.isArray(listing.validSplitQuantities) ? listing.validSplitQuantities : [];
      splits.forEach((q) => splitSizes.add(Number(q)));
      if (splits.length && splits.map(Number).indexOf(2) === -1) notSoldAsPair++;

      const fullSection = String(listing.section || "");
      const block = goTicketsBlockName(listing);
      const row = String(listing.row != null ? listing.row : "");
      const area = sectionGroup[String(listing.sectionId)]
        || fullSection.replace(/\s*[0-9]+[A-Za-z]?\s*$/, "").trim();
      // `validSplitQuantities` is the list of purchasable lot sizes; reading it
      // as a count would turn a 6-seat listing that sells in 1,2,3,4,6 into
      // five seats.
      const qty = Number(listing.quantity) || 1;
      const attributes = goTicketsAttributes(listing);
      const listingId = String(listing.id != null ? listing.id : `${block}-${row}`);
      const accessible = /\b(ada|accessible|wheelchair)\b/i
        .test(fullSection + " " + attributes.join(" "));

      for (let i = 0; i < qty; i++) {
        seats[`${listingId}-${i}`] = {
          block,
          row,
          seat: "",
          area,
          category: "resale",
          tier: VenueTiers.tierFor(venueName, block, row),
          price,
          exclusive: true,
          site: "gotickets",
          accessible,
          attributes,
        };
      }
    }
  } catch (error) {
    bgLog("[background] Error parsing GoTickets listings:", error.message);
  }

  const total = Object.keys(seats).length;
  bgLog(`[background] GoTickets: ${total} seats from ${body.listings.length} listings` +
    (parking ? `, ${parking} parking excluded` : "") +
    (missingPrice ? `, ${missingPrice} had no price` : ""));
  bgLog(`[background] GoTickets: lot sizes offered = ${[...splitSizes].sort((a, b) => a - b).join(",") || "none"}; ` +
    `${notSoldAsPair} of ${body.listings.length} listing(s) cannot be bought as a pair` +
    (notSoldAsPair ? " — so the response is NOT filtered to quantity=2"
      : " — every listing sells in pairs; the request carries no quantity, so this is seller behaviour, not a filter"));

  // The decisive check. "Every listing sells in pairs" is consistent with a
  // server-side quantity filter AND with sellers simply avoiding odd lots, so
  // it cannot settle the question alone. The event object carries its own
  // availableTickets count; if that is well above what this response holds,
  // the response is a filtered slice and inventory is missing.
  //
  // ALWAYS logged. The first version printed only for a positive count, and a
  // live load produced no line at all — which could mean a stale build or an
  // empty field, and silence cannot say which. So the raw value is reported
  // whatever it is.
  const inResponse = body.listings.reduce((n, l) => n + (Number(l && l.quantity) || 0), 0);
  const rawAvailable = body.event ? body.event.availableTickets : undefined;
  const available = Number(rawAvailable);
  if (rawAvailable != null && rawAvailable !== "" && isFinite(available) && available > 0) {
    bgLog(`[background] GoTickets: event reports ${available} ticket(s) available; ` +
      `this response lists ${inResponse}` +
      (inResponse >= available ? " — the whole inventory is here"
        : ` — ${available - inResponse} fewer than the event count. The listings request ` +
          `carries only a bot-detection token, no filter or page, so compare this with how many ` +
          `listings the GoTickets page itself shows before treating it as missing inventory`));
  } else {
    const pct = body.event ? body.event.percentInventoryAvailable : undefined;
    bgLog(`[background] GoTickets: availableTickets not usable (raw value: ` +
      `${JSON.stringify(rawAvailable)}, percentInventoryAvailable: ${JSON.stringify(pct)}); ` +
      `this response lists ${inResponse} ticket(s) — cannot tell from the event whether it is filtered`);
  }

  games[gameKey].seats = mergeSeats(games[gameKey].seats, seats, tabId, gameKey);
  games[gameKey].site = site;
  games[gameKey].lastScanned = Date.now();

  if (tabId) tabGameMap[tabId] = gameKey;
  await chrome.storage.local.set({ games });
}

// ─── AXS ──────────────────────────────────────────────────────────────────
// GET unifiedapicommerce-us.axs.com/axsmarketplace/offers?onsaleID=<token>
//
// Top level: { meta, listings }. 1797 listings on the event this was mapped
// against (Denver Broncos at Kansas City Chiefs, Arrowhead Stadium).
//
// A listing, read off that capture:
//
//   id            "VB17047084306"
//   row           "40"
//   quantity      10                       seats in this listing
//   splits        [1,2,3,4,5,6,7,8,10]     purchasable lot sizes, NOT a count
//   price         188                      per ticket, before fees
//   allInPrice    225.34                   per ticket, fees included
//   priceBreakdown { price: 188, serviceFee: 33.84, total: 225.34 }
//   section       { id: 330, name: "Upper Level 330", longSectionName: … }
//   groupId       424039                   -> mapinfo groups
//   seatFeatures  ["Restricted/Obstructed View"]
//   stockType     "Ticketmaster Transfer"
//   isZoneSeating false
//
// Prices are DOLLARS here, unlike Gametime's cents — 188 is $188.00, and
// 188 + 33.84 = 225.34 confirms it. Getting that backwards in either direction
// is a hundredfold error that still looks like a plausible ticket price.
//
// No seat numbers: AXS publishes section and row only.

// The onsale token identifies the event across all three payloads and appears
// in the page url too, which is what lets the popup find these seats without
// seeing a payload. Mirrors getAxsEventId() in axs-adapter.js: the leading run
// before the first percent-escape.
function axsOnsaleToken(url) {
  try {
    // Read the RAW query string, not searchParams.
    //
    // searchParams.get() percent-DECODES, so "…ACb%2Fv%2F2F%2F%2FwD" comes back
    // as "…ACb/v/2F//wD": the first "%" no longer exists, the cut never
    // happens, and stripping the slashes leaves "qyNwCQAAAACR8mTJAAAAACbv2FwD"
    // — a token the adapter and the popup never produce. The seats would be
    // stored under a key the dashboard does not look up, which presents as
    // capturing nothing with no error anywhere.
    const raw = (String(url).match(/[?&]onsale_?id=([^&#]*)/i) || [])[1] || "";
    const token = (raw.split("%")[0] || "").replace(/[^A-Za-z0-9_-]/g, "");
    return token.length >= 12 ? token : "";
  } catch (e) {
    return "";
  }
}

// allInPrice is what the buyer pays; `price` is the base. Same call as every
// other marketplace here, and FEE_MULTIPLIER_BY_SITE stays 1.0 because the fee
// is already inside the figure.
function axsPrice(listing) {
  const breakdown = listing && listing.priceBreakdown;
  const candidates = [
    listing && listing.allInPrice,
    breakdown && breakdown.total,
    listing && listing.price,
  ];
  for (const c of candidates) {
    const n = typeof c === "string" ? parseFloat(c) : c;
    if (typeof n === "number" && isFinite(n) && n > 0) return n;
  }
  return null;
}

function axsSectionName(listing) {
  const section = (listing && listing.section) || {};
  return String(section.name || section.longSectionName || "");
}

// The section as a buyer refers to it: "330", not "Upper Level 330".
//
// AXS names sections with their level, and the level is already carried by the
// Area column ("Upper Level", or "Upper Level - Endzone" once mapinfo is in),
// so keeping it here reads as "Block Upper Level 330 - Upper Level" on the
// dashboard and pads every CSV row. Stadium section numbers do not repeat
// across levels — 100s lower, 200s club, 300s upper — so the number alone is
// unambiguous.
//
// A section with no trailing number ("Penthouse", "(Block)") keeps its name;
// there is nothing to shorten it to.
function axsBlockName(listing) {
  const full = axsSectionName(listing);
  const tail = full.match(/([0-9]{1,4}[A-Za-z]?)\s*$/);
  return tail ? tail[1] : full;
}

function axsIsParking(listing) {
  return /\bparking\b|\blot\s*[0-9]+\b/i.test(axsSectionName(listing));
}

// What a buyer would want to see before committing.
function axsAttributes(listing) {
  const out = [];
  if (Array.isArray(listing.seatFeatures)) {
    for (const f of listing.seatFeatures) if (f) out.push(String(f));
  }
  if (Array.isArray(listing.tags)) {
    for (const t of listing.tags) if (t) out.push(String(t));
  }
  if (Array.isArray(listing.premiumPerks)) {
    for (const perk of listing.premiumPerks) if (perk) out.push(String(perk));
  }
  const stock = String(listing.stockType || "").trim();
  if (stock) out.push(stock);
  // A zone listing is not a specific seat in that section, which matters to
  // anyone reading a row number next to it.
  if (listing.isZoneSeating === true) out.push("Zone seating");
  return out;
}

// Bring-up for AXS events whose page never calls /axsmarketplace/offers (the
// Veritix primary flow). Walks a payload and logs every array of objects: its
// path, length, the first record's keys, and a few inventory-looking values
// from it (price, section, row, seat, name...), strings capped at 40 chars.
// What the onsale actually sells, for events with no seat map.
//
// The Jimmy Carr onsale at The Midland Theatre has one group, "Admission",
// whose product carries zoneDescription "Admissions" and seatType STANDARD:
// general admission, so there is no per-seat inventory to list and the array
// walk above finds only offers, fees and parking upsells. Price and remaining
// quantity on an event like that are plain fields, not arrays, so they are
// invisible to that walk — this prints the group itself.
const axsOnsaleLogged = new Set();

function axsLogOnsale(path, body) {
  const onsale = body && body.onsaleInformation;
  if (!onsale || typeof onsale !== "object") return;
  const key = path.slice(-40);
  if (axsOnsaleLogged.has(key)) return;
  axsOnsaleLogged.add(key);

  bgLog(`[background] AXS onsale keys: ${Object.keys(onsale).join(",").slice(0, 400)}`);

  const groups = Array.isArray(onsale.groups) ? onsale.groups : [];
  groups.slice(0, 2).forEach((g, i) => {
    // venueMapImage is a base64 jpeg of the whole map; it would bury the line.
    const trimmed = {};
    for (const k of Object.keys(g || {})) {
      if (k === "venueMapImage") { trimmed[k] = "(image omitted)"; continue; }
      trimmed[k] = g[k];
    }
    let shown;
    try { shown = JSON.stringify(trimmed); } catch (e) { shown = "?"; }
    bgLog(`[background] AXS onsale group ${i + 1}: ${String(shown).slice(0, 1500)}`);
  });

  // Anything that looks like remaining quantity or a price, wherever it sits.
  const hits = [];
  const walk = (node, where, depth) => {
    if (!node || typeof node !== "object" || depth > 6 || hits.length > 30) return;
    if (Array.isArray(node)) {
      node.slice(0, 3).forEach((v, i) => walk(v, where + "[" + i + "]", depth + 1));
      return;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (/avail|quantity|qty|remaining|capacity|price|amount/i.test(k) &&
          (typeof v === "number" || typeof v === "string") && String(v).length < 40) {
        hits.push(where + "." + k + "=" + JSON.stringify(v));
      }
      walk(v, where + "." + k, depth + 1);
    }
  };
  walk(onsale, "onsale", 0);
  if (hits.length) {
    bgLog(`[background] AXS onsale price/availability fields: ${hits.slice(0, 25).join(" ")}`);
  } else {
    bgLog(`[background] AXS onsale: no price or availability field anywhere in it`);
  }
}

function axsLogArrays(path, body) {
  const found = [];
  const INTERESTING = /price|amount|total|fee|sect|row|seat|name|desc|avail|qty|quant|count|level|zone|area|date|venue|type|code|id$/i;
  const walk = (v, where, depth) => {
    if (!v || typeof v !== "object" || depth > 9 || found.length > 400) return;
    if (Array.isArray(v)) {
      const first = v.find((x) => x && typeof x === "object" && !Array.isArray(x));
      if (first) found.push({ where, len: v.length, first });
      v.slice(0, 3).forEach((x, i) => walk(x, where + "[" + i + "]", depth + 1));
      return;
    }
    for (const k of Object.keys(v)) walk(v[k], where + "." + k, depth + 1);
  };
  walk(body, "", 0);
  const short = path.split("/").slice(-3).join("/").slice(0, 60);
  bgLog(`[background] AXS arrays in …${short}: ${found.length} found, largest first`);
  found.sort((a, b) => b.len - a.len).slice(0, 25).forEach((f) => {
    const keys = Object.keys(f.first);
    const sample = keys.filter((k) => INTERESTING.test(k)).slice(0, 10).map((k) => {
      const val = f.first[k];
      if (val === null || typeof val !== "object") return k + "=" + String(val).slice(0, 40);
      return k + "=" + (Array.isArray(val) ? "array(" + val.length + ")" : "{…}");
    });
    bgLog(`[background] AXS   ${f.where || "(root)"} ×${f.len} keys=${keys.slice(0, 30).join(",")}` +
      (sample.length ? ` | ${sample.join(" ")}` : ""));
  });
}

// token -> { groupId -> group name }, from /axsmarketplace/mapinfo.
const axsGroupNames = {};
// token -> { name, venue }, from /veritix/start-flow.
const axsEvents = {};

function axsIndexMap(token, body) {
  if (!token) return;
  const groups = Array.isArray(body.groups) ? body.groups : [];
  const names = axsGroupNames[token] || (axsGroupNames[token] = {});
  let added = 0;
  for (const g of groups) {
    if (!g || g.id == null || !g.name) continue;
    names[String(g.id)] = String(g.name);
    added++;
  }
  if (added) bgLog(`[background] AXS: indexed ${added} seating group(s) for the Area column`);
}

// GET /axsmarketplace/eventinfo?onsaleID=<token> — 448 bytes, and the only
// payload carrying a DATE:
//
//   { id: 6491101, name: "Denver Broncos at Kansas City Chiefs (…)",
//     utcDate: "2026-09-15T00:15:00", localDate: "2026-09-14T19:15:00",
//     venueName: "Arrowhead Stadium", venueAddress: { … } }
//
// localDate is the venue's own clock, which is what a buyer reads on the
// ticket; utcDate is the fallback. Note they differ by a calendar day here —
// a 19:15 kickoff local is 00:15 the next day UTC — so choosing the wrong one
// mislabels the event by a day rather than by hours.
function axsIndexEventInfo(token, body) {
  if (!token || !body) return;
  const name = body.name ? String(body.name) : null;
  const venue = body.venueName ? String(body.venueName) : null;
  const date = isoToDisplayDate(body.localDate || body.utcDate);
  if (!name && !venue && !date) return;
  axsEvents[token] = {
    name: name || (axsEvents[token] && axsEvents[token].name) || null,
    venue: venue || (axsEvents[token] && axsEvents[token].venue) || null,
    date: date || (axsEvents[token] && axsEvents[token].date) || null,
  };
  bgLog(`[background] AXS: event info — name=${name || "?"} date=${date || "?"} venue=${venue || "?"}`);
}

// The start-flow payload is the session/config response — NOT the inventory,
// which is what it was mistaken for until the offers endpoint was found. It
// does carry the event name and venue, and the ticket flow's own page publishes
// neither (its JSON-LD reads as "FanSight"), so it is the only source for them.
function axsIndexEvent(token, body) {
  if (!token) return;
  const onsale = body.onsaleInformation || {};
  const venues = Array.isArray(onsale.venues) ? onsale.venues : [];
  const groups = Array.isArray(onsale.groups) ? onsale.groups : [];
  const products = groups.length && Array.isArray(groups[0].products) ? groups[0].products : [];
  const name = products.length && products[0].description ? String(products[0].description) : null;
  const venue = venues.length && venues[0].name ? String(venues[0].name) : null;
  if (!name && !venue) return;
  const prev = axsEvents[token] || {};
  // eventinfo is the better source and may already have run; never drop its
  // date just because this payload has none.
  axsEvents[token] = {
    name: name || prev.name || null,
    venue: venue || prev.venue || null,
    date: prev.date || null,
  };
  bgLog(`[background] AXS: event identity — name=${name || "?"} venue=${venue || "?"}`);
}

// --- AXS Veritix inventory (tix.axs.com shop pages) ----------------------
// Confirmed on the Jimmy Carr onsale at The Midland Theatre (token
// Z4khGgAAAAABU4y2AgAAAACZ, 2027-09-20):
//
//   offer/search -> offers[].items[] = 592 seats
//       sectionLabel "101"  rowLabel "8"  number  priceLevelID
//       statusCodeLabel "Open" / "ADA" / "AXS Premium POSTED AEG"
//       seatType, disabilityTypes, offerID
//
//   price -> offerPrices[].zonePrices[].priceLevels[]
//       priceLevelID 6591 -> priceComponents [{name:"Base Component",
//       amount:6075}, ...]  — hundredths, so 6075 is $60.75
//
// Three offers on this event: standard, ADA and AXS Premium, each with its own
// prices, so the price is looked up by offer AND price level rather than price
// level alone.

// token -> { offerID -> { priceLevelID -> dollars } }
const axsVeritixPrices = {};
let axsVeritixPriceShapeLogged = false;

// The onsale token out of a Veritix path. The same leading run the page url
// carries and the popup keys on, so seats land where the dashboard looks.
function axsVeritixToken(url) {
  const m = String(url).match(/\/veritix\/[^/]+\/[^/]+\/([^/?#]+)/i);
  if (!m) return "";
  const token = (m[1].split("%")[0] || "").replace(/[^A-Za-z0-9_-]/g, "");
  return token.length >= 12 ? token : "";
}

// Every component summed: "Base Component" is the face price and the rest are
// the per-ticket fees AXS adds, so the total is what a buyer pays. Logged once
// with the parts so the sum can be checked against the site rather than
// trusted.
function axsVeritixLevelPrice(level) {
  const entry = (level && level.prices && level.prices[0]) || null;
  if (!entry) return null;
  const components = Array.isArray(entry.priceComponents) ? entry.priceComponents : [];
  let hundredths = 0;
  for (const c of components) {
    const n = Number(c && c.amount);
    if (isFinite(n)) hundredths += n;
  }
  if (!hundredths) hundredths = Number(entry.base) || 0;
  return hundredths > 0 ? hundredths / 100 : null;
}

function axsIndexVeritixPrices(token, body) {
  const byOffer = axsVeritixPrices[token] || (axsVeritixPrices[token] = {});
  let levels = 0;
  const preview = [];
  for (const op of body.offerPrices || []) {
    const offerID = String((op && op.offerID) || "");
    if (!offerID) continue;
    const map = byOffer[offerID] || (byOffer[offerID] = {});
    for (const zp of (op.zonePrices || [])) {
      for (const level of (zp.priceLevels || [])) {
        const dollars = axsVeritixLevelPrice(level);
        if (dollars == null || level.priceLevelID == null) continue;
        map[String(level.priceLevelID)] = dollars;
        levels++;
        if (preview.length < 6) {
          preview.push(`${level.label || level.priceLevelID}=$${dollars.toFixed(2)}`);
        }
        if (!axsVeritixPriceShapeLogged) {
          axsVeritixPriceShapeLogged = true;
          const parts = ((level.prices[0] || {}).priceComponents || [])
            .map((c) => `${c.name}=${c.amount}(${c.calculationMethod || "?"})`).join(" + ");
          bgLog(`[background] AXS Veritix: price level ${level.priceLevelID} built from ` +
            `${parts} = $${dollars.toFixed(2)}`);
          // The components alone read LOW: a seat shown at $34.75 rings up at
          // $45.71 on the site, a $10.96 gap that matches a service fee plus
          // tax. Those live in a separate fees table, keyed by id from the
          // offer, each with its own calculation method. Print the inputs
          // rather than guess the arithmetic: a wrong formula would misprice
          // every seat on every AXS event and still look plausible.
          try {
            bgLog(`[background] AXS Veritix fees table: ` +
              JSON.stringify(body.fees || []).slice(0, 1200));
            bgLog(`[background] AXS Veritix offer ${offerID} fee assignments: ` +
              JSON.stringify(op.fees || []).slice(0, 600));
            bgLog(`[background] AXS Veritix taxes: ` +
              JSON.stringify(body.taxes || []).slice(0, 400));
            const lvl0 = JSON.stringify(level).slice(0, 700);
            bgLog(`[background] AXS Veritix one whole price level: ${lvl0}`);
          } catch (e) {
            bgLog("[background] AXS Veritix: could not print the fee inputs: " + (e && e.message));
          }
        }
      }
    }
  }
  bgLog(`[background] AXS Veritix: ${levels} price level(s) across ` +
    `${Object.keys(byOffer).length} offer(s) [${preview.join(" ")}]`);
}

async function saveAxsVeritixSeats(token, body, tabId, site, eventInfo) {
  if (!body || !Array.isArray(body.offers)) return;

  const gameKey = `${site}:${token}`;
  const data = await getStorage();
  const games = data.games || {};
  if (!games[gameKey]) games[gameKey] = emptyGame();

  // tix.axs.com's own JSON-LD reads "FanSight" or the venue's name, so an
  // indexed name from start-flow is preferred where there is one.
  const indexed = axsEvents[token] || {};
  const pageName = eventInfo && eventInfo.name;
  const usablePage = pageName && !/^fansight$/i.test(pageName) &&
    !/ - select$/i.test(pageName);
  const prev = games[gameKey].match || {};
  // No fallback to the page heading: "The Midland Theatre - Select" is the
  // seat picker's own title, and storing it would read as the show's name on
  // every Veritix event. Better an empty name the popup can fill from
  // start-flow later than a wrong one that looks right.
  const name = (usablePage ? pageName : null) || indexed.name || prev.name || null;
  games[gameKey].match = {
    name,
    date: (eventInfo && eventInfo.date) || indexed.date || prev.date || null,
    venue: (eventInfo && eventInfo.venue) || indexed.venue || prev.venue || null,
    currency: "USD",
    performanceId: token,
  };

  const venueName = games[gameKey].match && games[gameKey].match.venue;
  logTierMapping(venueName);

  const prices = axsVeritixPrices[token] || {};
  const seats = {};
  let missingPrice = 0;
  const statusSeen = new Map();
  const offerSeen = [];

  for (const offer of body.offers) {
    if (!offer || !Array.isArray(offer.items)) continue;
    const offerID = String(offer.offerID || "");
    const offerPrices = prices[offerID] || {};
    offerSeen.push(`${offer.category || offerID}×${offer.items.length}`);

    for (const item of offer.items) {
      if (!item) continue;
      const status = String(item.statusCodeLabel || "");
      if (statusSeen.size < 12) statusSeen.set(status, (statusSeen.get(status) || 0) + 1);

      const dollars = offerPrices[String(item.priceLevelID)];
      if (dollars == null) { missingPrice++; continue; }

      const block = String(item.sectionLabel || item.sectionID || "");
      const row = String(item.rowLabel || "");
      const attrs = [];
      if (status && status !== "Open") attrs.push(status);
      if (item.seatType && item.seatType !== "STANDARD") attrs.push(String(item.seatType));

      // sectionID+rowID+number is unique within an offer, and the offer id
      // keeps the ADA and premium copies of a section apart.
      seats[`veritix:${offerID}:${item.sectionID}:${item.rowID}:${item.number}`] = {
        block,
        row,
        seat: String(item.number || ""),
        area: String(item.neighborhoodPrintDescription || ""),
        category: String(offer.category || "standard"),
        tier: VenueTiers.tierFor(venueName, block, row),
        price: Math.round(dollars * 1000),
        exclusive: true,
        site: "axs",
        accessible: /ADA/i.test(status) ||
          (Array.isArray(item.disabilityTypes) && item.disabilityTypes.length > 0),
        attributes: attrs,
      };
    }
  }

  const total = Object.keys(seats).length;
  bgLog(`[background] AXS Veritix: ${total} seats from ${offerSeen.join(", ")}` +
    (missingPrice ? `, ${missingPrice} with no price for their level` : ""));
  if (statusSeen.size) {
    bgLog(`[background] AXS Veritix: statusCodeLabel values: ` +
      [...statusSeen.entries()].map((e) => `"${e[0]}"x${e[1]}`).join(", "));
  }
  if (missingPrice && !Object.keys(prices).length) {
    bgLog(`[background] AXS Veritix: no price payload seen for ${token} yet — ` +
      `/veritix/inventory/v4/<token>/price carries it`);
  }

  games[gameKey].seats = mergeSeats(games[gameKey].seats, seats, tabId, gameKey);
  games[gameKey].site = site;
  games[gameKey].lastScanned = Date.now();
  if (tabId) tabGameMap[tabId] = gameKey;
  await chrome.storage.local.set({ games });
}

async function saveAxsSeats(eventId, body, tabId, site, eventInfo) {
  if (!body || !Array.isArray(body.listings)) return;

  const gameKey = `${site}:${eventId}`;
  const data = await getStorage();
  const games = data.games || {};
  if (!games[gameKey]) games[gameKey] = emptyGame();

  // JSON-LD first, but on tix.axs.com it reads the shell app and returns
  // "FanSight", so start-flow is what actually names this event.
  const indexed = axsEvents[eventId] || {};
  const name = (eventInfo && eventInfo.name && !/^fansight$/i.test(eventInfo.name)
    ? eventInfo.name : null) || indexed.name;

  if (name) {
    const prev = games[gameKey].match || {};
    games[gameKey].match = {
      name,
      date: (eventInfo && eventInfo.date) || indexed.date || prev.date || null,
      venue: (eventInfo && eventInfo.venue) || indexed.venue || prev.venue || null,
      currency: "USD",
      performanceId: eventId,
    };
  }

  const venueName = games[gameKey].match && games[gameKey].match.venue;
  logTierMapping(venueName);

  const groupNames = axsGroupNames[eventId] || {};
  const seats = {};
  let parking = 0;
  let missingPrice = 0;

  try {
    for (const listing of body.listings) {
      if (!listing) continue;
      if (axsIsParking(listing)) { parking++; continue; }

      const dollars = axsPrice(listing);
      if (dollars == null) { missingPrice++; continue; }
      // Stored in thousandths to match centsToUSD() in the popup.
      const price = Math.round(dollars * 1000);

      const fullSection = axsSectionName(listing);
      const block = axsBlockName(listing);
      const row = String(listing.row != null ? listing.row : "");
      // mapinfo names the group ("Upper Level - Endzone"). When it has not
      // arrived, the section's own prefix carries most of the same meaning:
      // "Upper Level 330" -> "Upper Level". Taken from the FULL name, not from
      // `block`, which is just "330" now and has no prefix left to take.
      const area = groupNames[String(listing.groupId)]
        || fullSection.replace(/\s*[0-9]+[A-Za-z]?\s*$/, "").trim();
      // `splits` is the list of purchasable lot sizes, not a count — reading it
      // would turn a 10-seat listing selling in 1..10 into nine phantom seats.
      const qty = Number(listing.quantity) || 1;
      const attributes = axsAttributes(listing);
      const listingId = String(listing.id || `${block}-${row}`);
      const accessible = /\b(ada|accessible|wheelchair)\b/i
        .test(fullSection + " " + attributes.join(" "));

      // AXS publishes no seat numbers, only section and row, so a listing of N
      // becomes N seats with an empty seat field — as TickPick and Vivid do.
      for (let i = 0; i < qty; i++) {
        seats[`${listingId}-${i}`] = {
          block,
          row,
          seat: "",
          area,
          category: "resale",
          tier: VenueTiers.tierFor(venueName, block, row),
          price,
          exclusive: true,
          site: "axs",
          accessible,
          attributes,
        };
      }
    }
  } catch (error) {
    bgLog("[background] Error parsing AXS listings:", error.message);
  }

  const total = Object.keys(seats).length;
  bgLog(`[background] AXS: ${total} seats from ${body.listings.length} listings` +
    (parking ? `, ${parking} parking excluded` : "") +
    (missingPrice ? `, ${missingPrice} had no price` : "") +
    (Object.keys(groupNames).length ? "" : ", mapinfo not seen yet — Area from section names"));

  games[gameKey].seats = mergeSeats(games[gameKey].seats, seats, tabId, gameKey);
  games[gameKey].site = site;
  games[gameKey].lastScanned = Date.now();

  if (tabId) tabGameMap[tabId] = gameKey;
  await chrome.storage.local.set({ games });
}

// ─── Gametime ─────────────────────────────────────────────────────────────
// GET mobile.gametime.co/v3/listings/<eventId>?all_in_pricing=true&quantity=N
//
// Top level: { lot, available_lots, listings, display_groups, display_filters }.
// A listing, read off the capture on event 68af55be0dcf1d7f796e5e89
// (Rays at Rangers, Globe Life Field):
//
//   id             "6941d5d94c87f865d0bcf87d"
//   price          { prefee: 2300, total: 3000, sales_tax: 229,
//                    pre_tax_total: 2771 }        ← CENTS, not dollars
//   seats          ["15","16"]                    ← actual seat numbers
//   spot           { section: "224", row: "5", section_group: "Middle",
//                    position: {x,y}, view_url }
//   available_lots [2]            purchasable lot sizes, NOT a count
//   disclosures    []             see gametimeDisclosures
//   delivery_type  "direct" | "mobile"
//   event_id       "68af55be0dcf1d7f796e5e89"
//
// Gametime is the only source here that publishes seat NUMBERS on resale
// listings — every other marketplace stops at section and row.
//
// Prices are in cents and `all_in_pricing=true` is in the query, so
// price.total is the all-in figure. FEE_MULTIPLIER_BY_SITE stays 1.0.

// The two dollars-per-ticket figures are `total` (all-in) and `prefee`. Same
// call as Vivid Seats: report what the buyer actually pays.
//
// Cents, so divide. A parser that treated 3000 as dollars would report a $30
// seat as $3,000 — and it would look plausible next to a real premium listing,
// which is why this is asserted rather than assumed.
function gametimePrice(listing) {
  const p = listing && listing.price;
  if (!p) return null;
  for (const c of [p.total, p.pre_tax_total, p.prefee]) {
    const n = typeof c === "string" ? parseFloat(c) : c;
    if (typeof n === "number" && isFinite(n) && n > 0) return n / 100;
  }
  return null;
}

// Parking is sold as a separate event on Gametime (event.related_events.parking
// holds its id), so a parking pass should not appear in a normal listings
// payload at all. The name check is defensive only.
function gametimeIsParking(listing) {
  const spot = (listing && listing.spot) || {};
  const name = String(spot.section || "") + " " + String(spot.section_group || "");
  return /\bparking\b|\blot\s*[0-9]+\b/i.test(name);
}

// `disclosures` was an empty array on every sampled listing, so its element
// type is unconfirmed. The site's /v1/disclosures endpoint returns objects of
// { slug, title, icon_url, ... }, which suggests either bare slugs or those
// objects appear here — both are handled rather than guessing one.
function gametimeDisclosures(listing) {
  const out = [];
  const raw = listing && listing.disclosures;
  if (!Array.isArray(raw)) return out;
  for (const d of raw) {
    if (!d) continue;
    if (typeof d === "string") out.push(d);
    else if (d.title) out.push(String(d.title));
    else if (d.slug) out.push(String(d.slug));
  }
  const delivery = String((listing && listing.delivery_type) || "").trim();
  if (delivery) out.push(delivery);
  return out;
}

// event_id -> { name, date, venue }, filled from /v1/events.
//
// A single page issues several events calls: one for this event by id, and
// broader ones by performer that return a hundred other fixtures. Indexing by
// id rather than taking events[0] is what keeps a neighbouring fixture's name
// off this event.
const gametimeEvents = {};

// event-info.js normalises dates to "DD-MM-YYYY - HH:MM" for the popup, and it
// is a page-context script the service worker cannot import. Reimplemented here
// to the same contract; event-info-check.js asserts the shared format.
//
// Shared rather than per-site: Gametime's datetime_local and AXS's localDate
// are the same ISO shape, and a second copy would be a second thing to get
// wrong.
function isoToDisplayDate(iso) {
  if (typeof iso !== "string") return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}` + (m[4] ? ` - ${m[4]}:${m[5]}` : "");
}

function gametimeIndexEvents(body) {
  const rows = Array.isArray(body.events) ? body.events : [];
  let added = 0;
  for (const row of rows) {
    const ev = row && row.event;
    if (!ev || !ev.id) continue;
    const venue = row.venue && row.venue.name ? String(row.venue.name) : null;
    gametimeEvents[String(ev.id)] = {
      name: ev.name ? String(ev.name) : null,
      // datetime_local is the venue's own clock, which is what a buyer reads
      // on the ticket; datetime_utc is the fallback.
      date: isoToDisplayDate(ev.datetime_local || ev.datetime_utc),
      venue,
    };
    added++;
  }
  if (added) bgLog(`[background] Gametime: indexed ${added} event(s) for identity`);
}

async function saveGametimeSeats(eventId, body, tabId, site, eventInfo, url) {
  if (!body || !Array.isArray(body.listings)) return;

  const gameKey = `${site}:${eventId}`;
  const data = await getStorage();
  const games = data.games || {};
  if (!games[gameKey]) games[gameKey] = emptyGame();

  // JSON-LD first, then whatever /v1/events told us about this id.
  const indexed = gametimeEvents[String(eventId)] || {};
  const name = (eventInfo && eventInfo.name) || indexed.name;

  if (name) {
    const prev = games[gameKey].match || {};
    games[gameKey].match = {
      name,
      date: (eventInfo && eventInfo.date) || indexed.date || prev.date || null,
      venue: (eventInfo && eventInfo.venue) || indexed.venue || prev.venue || null,
      currency: "USD",
      performanceId: eventId,
    };
  }

  const venueName = games[gameKey].match && games[gameKey].match.venue;
  logTierMapping(venueName);

  const seats = {};
  let parking = 0;
  let missingPrice = 0;
  let withSeatNumbers = 0;
  // Seat numbers high enough to be suspect. "Seats 999-1000" showed up in
  // Block 312 Row 4, and blocks do not hold a thousand seats — so either
  // Gametime uses high values as a placeholder for seats it will not name, or
  // something here is misreading them. Which one is answered by WHERE they
  // appear: a placeholder repeats the same one or two values across many
  // unrelated blocks, whereas real seats are scattered and confined.
  const highNumbers = [];

  try {
    for (const listing of body.listings) {
      if (!listing) continue;
      if (gametimeIsParking(listing)) { parking++; continue; }

      const dollars = gametimePrice(listing);
      if (dollars == null) { missingPrice++; continue; }
      // Stored in thousandths to match centsToUSD() in the popup.
      const price = Math.round(dollars * 1000);

      const spot = listing.spot || {};
      const block = String(spot.section || "");
      const row = String(spot.row || "");
      const area = String(spot.section_group || "");
      const attributes = gametimeDisclosures(listing);
      const listingId = String(listing.id || `${block}-${row}`);

      // Gametime publishes the seat numbers themselves. `available_lots` is
      // the list of purchasable lot SIZES ([2] means "sold as a pair"), so a
      // parser reading it as a count would be wrong the moment a listing
      // offers more than one lot size.
      const numbers = Array.isArray(listing.seats)
        ? listing.seats.filter((n) => n !== null && n !== undefined && n !== "")
        : [];
      if (numbers.length) withSeatNumbers++;
      const qty = numbers.length ||
        Math.max.apply(null, [1].concat(
          (Array.isArray(listing.available_lots) ? listing.available_lots : [])
            .map(Number).filter((n) => isFinite(n) && n > 0)));

      for (let i = 0; i < qty; i++) {
        const n = numbers[i] != null ? parseInt(String(numbers[i]), 10) : NaN;
        if (isFinite(n) && n >= 900) highNumbers.push({ block, row, n });
        seats[`${listingId}-${i}`] = {
          block,
          row,
          seat: numbers[i] != null ? String(numbers[i]) : "",
          area,
          category: "resale",
          tier: VenueTiers.tierFor(venueName, block, row),
          price,
          exclusive: true,
          site: "gametime",
          accessible: /\b(ada|accessible|wheelchair)\b/i.test(block + " " + area),
          attributes,
        };
      }
    }
  } catch (error) {
    bgLog("[background] Error parsing Gametime listings:", error.message);
  }

  if (highNumbers.length) {
    const values = [...new Set(highNumbers.map((h) => h.n))].sort((a, b) => a - b);
    const places = new Set(highNumbers.map((h) => h.block + "/" + h.row));
    bgLog(`[background] Gametime: ${highNumbers.length} seat number(s) >= 900, ` +
      `across ${places.size} block/row combination(s). Values: ` +
      `${values.slice(0, 12).join(", ")}${values.length > 12 ? ", …" : ""}. ` +
      `Blocks: ${[...new Set(highNumbers.map((h) => h.block))].slice(0, 8).join(", ")}. ` +
      `A handful of values repeating across many blocks means these are ` +
      `placeholders rather than seats.`);
  }

  const total = Object.keys(seats).length;
  bgLog(`[background] Gametime: ${total} seats from ${body.listings.length} listings` +
    (withSeatNumbers ? `, ${withSeatNumbers} with seat numbers` : "") +
    (parking ? `, ${parking} parking excluded` : "") +
    (missingPrice ? `, ${missingPrice} had no price` : ""));

  // The page asks for a quantity, and the response honours it: the observed
  // request carried quantity=2 and every listing came back as a pair. So this
  // is the inventory for ONE lot size, not the whole event. Say so rather than
  // let a filtered count read as a complete scan.
  // Each payload is one lot size. injected.js sweeps the rest automatically,
  // so this names the slice rather than asking anyone to go clicking — the
  // earlier wording told people to change the quantity selector by hand, which
  // stopped being true the moment the sweep landed.
  const q = (String(url || "").match(/[?&]quantity=(\d+)/) || [])[1];
  if (q) {
    bgLog(`[background] Gametime: this payload is the quantity=${q} slice; ` +
      `the page-side sweep requests the other lot sizes and they merge in here.`);
  }

  games[gameKey].seats = mergeSeats(games[gameKey].seats, seats, tabId, gameKey);
  games[gameKey].site = site;
  games[gameKey].lastScanned = Date.now();

  if (tabId) tabGameMap[tabId] = gameKey;
  await chrome.storage.local.set({ games });
}

// ─── Ticketmaster Account Manager (ISM v810) ──────────────────────────────
// am.ticketmaster.com is a Ticketmaster host running a different application.
// ISMDS is cross-origin from it and blocked, so the scan cannot reach the
// facets endpoint at any id — confirmed against event 060064A9DD13378D, which
// IS a valid ISMDS id and still failed at the network layer. The page's own
// ISM v810 calls carry the same information, so they are captured passively.
//
// Two payloads, arriving independently:
//
//   /v810/venueAvailability/buy   what is for sale, per section
//   /v810/priceData/buy           what each price code costs
//
// Both are tilde-delimited rows with a `header` naming every column, so the
// columns are read BY NAME rather than by position.
//
// Confirmed against Mizzou event 7524 (host id 060064A9DD13378D):
//   "101~10~G,F~0~~0~0~~~~~~~~~~6,4~~~GEYDC"  section 101, 10 seats, codes G,F
//   "_AS~AS~92~Reserved - Single Game~..."    code A, all-in amount 92
//
// This is SECTION level. ISM exposes counts per section, not individual seats,
// so there is no row/seat here and no seats-together clustering.
function amParseDelimited(block) {
  const rows = block && block.data;
  const header = block && block.header;
  if (!Array.isArray(rows) || typeof header !== "string") return [];
  const cols = header.split("~");
  const out = [];
  for (const line of rows) {
    if (typeof line !== "string") continue;
    const parts = line.split("~");
    const rec = {};
    cols.forEach((c, i) => { rec[c] = parts[i]; });
    out.push(rec);
  }
  return out;
}

// price code -> all-in amount in dollars.
//
// `amount` is the all-in figure: for eight of the nine codes on the captured
// event it equals ticketPrice + the $8 component, so it is what a buyer pays.
// The bracketed component list is NOT split on "~" reliably (it contains
// commas, not tildes), so `amount` is read by name and the components ignored.
function amPriceMap(priceData) {
  const map = {};
  const codes = priceData && priceData.data && priceData.data.priceCode
    && priceData.data.priceCode.data;
  if (!codes || typeof codes !== "object") return map;

  const header = priceData.data.priceCode.header;
  for (const code of Object.keys(codes)) {
    const entry = codes[code];
    const rows = amParseDelimited({ data: entry && entry.data, header });
    for (const r of rows) {
      const amount = parseFloat(r.amount);
      if (isFinite(amount) && amount > 0) {
        map[code.toUpperCase()] = amount;
        break;
      }
    }
  }
  return map;
}

// Cheapest code wins. A section can list several ("G,F") without saying how
// many seats sit at each, so quoting the lowest matches what the site
// advertises as its "from" price. Every code and price is kept in attributes
// so nothing is hidden by the choice.
function amSectionPrice(priceCodes, priceMap) {
  const codes = String(priceCodes || "").split(",")
    .map((c) => c.trim().toUpperCase()).filter(Boolean);
  const prices = codes.map((c) => priceMap[c]).filter((n) => typeof n === "number" && n > 0);
  if (!prices.length) return { price: null, codes, prices };
  return { price: Math.min.apply(null, prices), codes, prices };
}

async function saveAmSeats(eventId, availability, priceData, tabId, site, eventInfo) {
  const sections = amParseDelimited(
    availability && availability.data && availability.data.section);
  if (!sections.length) {
    bgLog("[background] AM: no section rows in venueAvailability — not parsing");
    return;
  }
  const priceMap = amPriceMap(priceData);

  const gameKey = `${site}:${eventId}`;
  const data = await getStorage();
  const games = data.games || {};
  if (!games[gameKey]) games[gameKey] = emptyGame();

  if (eventInfo && eventInfo.name) {
    games[gameKey].match = {
      name: eventInfo.name,
      date: eventInfo.date || null,
      venue: eventInfo.venue || null,
      currency: "USD",
      performanceId: eventId,
    };
  }

  const venueName = games[gameKey].match && games[gameKey].match.venue;
  const seats = {};
  let noPrice = 0;
  let empty = 0;

  try {
    for (const sec of sections) {
      const block = String(sec.sectionName || "");
      const available = Number(sec.totalAvailableSeat) || 0;
      if (!block || available <= 0) { empty++; continue; }

      const { price: dollars, codes, prices } = amSectionPrice(sec.priceCode, priceMap);
      if (dollars == null) { noPrice++; continue; }
      const price = Math.round(dollars * 1000);

      const attributes = [];
      if (codes.length) attributes.push(`price codes ${codes.join(",")}`);
      if (prices.length > 1) attributes.push(`prices ${prices.join(", ")}`);
      if (Number(sec.resaleSeatsCount) > 0) attributes.push(`${sec.resaleSeatsCount} resale`);

      // One row per available seat, so counts and price stats are right even
      // though ISM never says WHICH seats they are.
      for (let i = 0; i < available; i++) {
        seats[`${block}-${i}`] = {
          block,
          row: "",
          seat: "",
          area: sec.adaCodes ? `ADA ${sec.adaCodes}` : "",
          category: "primary",
          tier: VenueTiers.tierFor(venueName, block, ""),
          price,
          exclusive: true,
          site: "ticketmaster",
          accessible: String(sec.isWheelChairEnabled) === "1",
          attributes,
        };
      }
    }
  } catch (error) {
    bgLog("[background] Error parsing AM sections:", error.message);
  }

  const total = Object.keys(seats).length;
  bgLog(`[background] AM: ${total} seats across ${sections.length} sections ` +
    `(${Object.keys(priceMap).length} price codes)` +
    (noPrice ? `, ${noPrice} sections had no resolvable price` : "") +
    (empty ? `, ${empty} sections had none available` : ""));

  games[gameKey].seats = mergeSeats(games[gameKey].seats, seats, tabId, gameKey);
  games[gameKey].site = site;
  games[gameKey].lastScanned = Date.now();

  if (tabId) tabGameMap[tabId] = gameKey;
  await chrome.storage.local.set({ games });
}

// Half-arrived Account Manager payloads, keyed by event id. In memory only:
// a scan that never completes should not persist.
const amPending = {};

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
