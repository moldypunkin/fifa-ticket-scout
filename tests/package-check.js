// Validate the shippable bundle before it goes to machines we cannot debug.
const EXT = require("./ext-dir");
const fs = require("fs"), path = require("path");
const dir = EXT;
const mf = JSON.parse(fs.readFileSync(dir + "manifest.json", "utf8"));
const bg = fs.readFileSync(dir + "background.js", "utf8");
const inj = fs.readFileSync(dir + "injected.js", "utf8");
const popup = fs.readFileSync(dir + "popup.js", "utf8");
const html = fs.readFileSync(dir + "popup.html", "utf8");
const tm = fs.readFileSync(dir + "ticketmaster-adapter.js", "utf8");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " — " + d : ""}`); };

out(`--- manifest v${mf.version} ---`);
check("manifest v3", mf.manifest_version === 3);
check("version newer than the last shipped build (2.4.0)",
  mf.version.localeCompare("2.4.0", undefined, { numeric: true }) > 0, mf.version);
check("service worker declared", !!(mf.background && mf.background.service_worker));
check("popup declared", !!(mf.action && mf.action.default_popup === "popup.html"));

out("\n--- every referenced file ships ---");
const referenced = new Set(["manifest.json", "popup.html", mf.background.service_worker]);
for (const cs of mf.content_scripts) cs.js.forEach((j) => referenced.add(j));
for (const k of Object.keys(mf.icons || {})) referenced.add(mf.icons[k]);
for (const f of referenced) check(`exists: ${f}`, fs.existsSync(dir + f));
for (const m of html.matchAll(/(?:src|href)="([^"h][^"]*)"/g)) {
  if (!m[1].startsWith("#")) check(`popup asset: ${m[1]}`, fs.existsSync(dir + m[1]));
}

out("\n--- the regression that stranded teammates on 2.4.0 ---");
// 2.4.0 matched /event/([A-F0-9]+) — hex only — so a modern id like
// Z7r9jZ1A7qIaF never resolved and the scan could not start.
const idRe = (tm.match(/const TM_EVENT_ID = (\/.*?\/[a-z]*);/) || [])[1];
check("TM_EVENT_ID present", !!idRe, idRe);
if (idRe) {
  const re = eval(idRe);
  check("matches a modern base62 id", (("/event/Z7r9jZ1A7qIaF".match(re) || [])[1]) === "Z7r9jZ1A7qIaF");
  check("still matches a legacy hex id", (("/event/0700646BCF6088AD".match(re) || [])[1]) === "0700646BCF6088AD");
  check("matches the slug form",
    (("/michigan-wolverines-vs-oklahoma-09-12-2026/event/Z7r9jZ1A7qIaF".match(re) || [])[1]) === "Z7r9jZ1A7qIaF");
  check("NOT the old hex-only pattern", !/A-F0-9/.test(idRe), idRe);
}
check("has canonical-link fallback", /link\[rel="canonical"\]/.test(tm));
check("has og:url fallback", /og:url/.test(tm));

out("\n--- all sources wired end to end ---");
const sites = {
  ticketmaster: { adapter: "ticketmaster-adapter.js", parser: "saveTicketmasterSeats" },
  seatgeek:     { adapter: "seatgeek-adapter.js",     parser: "saveSeatGeekSeats" },
  stubhub:      { adapter: "stubhub-adapter.js",      parser: "saveStubHubSeats" },
  evenue:       { adapter: "evenue-adapter.js",       parser: "saveEvenueSeats" },
  tickpick:     { adapter: "tickpick-adapter.js",     parser: "saveTickPickSeats" },
  axs:          { adapter: "axs-adapter.js",          parser: null },
};
for (const [site, cfg] of Object.entries(sites)) {
  check(`${site}: host permission`, mf.host_permissions.some((h) => h.includes(site)));
  const main = mf.content_scripts.find((c) => c.world === "MAIN" && c.matches.join().includes(site));
  check(`${site}: MAIN world script`, !!main, main && main.js.join(" -> "));
  check(`${site}: adapter shipped`, !!main && main.js.includes(cfg.adapter));
  check(`${site}: event-info.js first`, !!main && main.js.indexOf("event-info.js") === 0);
  check(`${site}: content bridge`,
    mf.content_scripts.some((c) => c.world !== "MAIN" && c.matches.join().includes(site)));
  check(`${site}: siteFromUrl`, bg.includes(`return "${site}"`));
  if (cfg.parser) check(`${site}: parser`, bg.includes(`function ${cfg.parser}`));
}
check("fifa host permission", mf.host_permissions.some((h) => h.includes("tickets.fifa.com")));

out("\n--- popup knows every site ---");
for (const s of ["resale","lms","ticketmaster","seatgeek","stubhub","evenue","tickpick"]) {
  check(`label ${s}`, new RegExp(`${s}: "`).test(popup));
  check(`fee multiplier ${s}`, new RegExp(`${s}: [0-9.]+`).test(popup));
}

out("\n--- nothing left in diagnostic mode ---");
// A shipped build must not carry an armed discovery probe. Name which site is
// armed rather than just failing, so the message says what to do about it.
const armed = (inj.match(/const DISCOVERY_SITE = (.*);/) || [])[1] || "";
const isArmed = armed.trim() !== "null";
const armedFor = (armed.match(/"([A-Z]+)"/) || [])[1] || "unknown";
check(isArmed
  ? `discovery probe is ARMED for "${armedFor}" — diagnostic build, disarm before release`
  : "discovery probe disarmed", !isArmed, armed.trim());

// The service worker and the popup load helper scripts outside
// manifest.content_scripts (importScripts, and <script src> in popup.html).
// Those ship too, and a missing one breaks the extension on load.
const imported = [];
for (const m of bg.matchAll(/importScripts\(([^)]*)\)/g)) {
  for (const q of m[1].matchAll(/"([^"]+)"/g)) imported.push(q[1]);
}
check("background importScripts found", imported.length > 0, imported.join(", "));
for (const f of imported) check("importScripts ships: " + f, fs.existsSync(dir + f));

const popupScripts = [];
for (const m of html.matchAll(/<script src="([^"]+)"/g)) {
  if (!/^https?:/.test(m[1])) popupScripts.push(m[1]);
}
check("popup script tags found", popupScripts.length > 0, popupScripts.join(", "));
for (const f of popupScripts) check("popup script ships: " + f, fs.existsSync(dir + f));

out("\n--- no duplicate declarations ---");
for (const [name, src] of [["background.js", bg], ["injected.js", inj], ["popup.js", popup]]) {
  const decls = (src.match(/^\s*(?:async )?function [a-zA-Z_]+/gm) || []).map((d) => d.trim());
  const dupes = decls.filter((d, i) => decls.indexOf(d) !== i);
  check(`${name} has no duplicates`, dupes.length === 0, dupes.join(", "));
}

out(fail ? `\n${fail} FAILURES — do not ship` : "\nall checks passed — safe to package");
process.exit(fail ? 1 : 0);
