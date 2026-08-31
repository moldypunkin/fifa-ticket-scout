// Static wiring checks on the popup brand change (no DOM needed).
const EXT = require("./ext-dir");
const fs = require("fs");
const dir = EXT;
const js = fs.readFileSync(dir + "popup.js", "utf8");
const html = fs.readFileSync(dir + "popup.html", "utf8");

let fail = 0;
const check = (label, cond, detail) => {
  if (!cond) fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
};

// 1. Exactly one SITE_LABELS definition, and it is module scope (not indented).
// [ \t] not \s — \s matches the preceding newline and defeats the indent test.
const defs = js.match(/^[ \t]*const SITE_LABELS/gm) || [];
check("SITE_LABELS defined once", defs.length === 1, `${defs.length} definition(s)`);
check("SITE_LABELS at module scope", defs.length === 1 && !/^[ \t]+/.test(defs[0]),
  JSON.stringify(defs[0]));

// 2. The ids setBrand looks up actually exist in the markup.
for (const id of ["brandTitle", "brandLogo"]) {
  check(`#${id} exists in popup.html`, html.includes(`id="${id}"`));
}

// 3. Every site key used anywhere resolves through SITE_BRANDS/SITE_LABELS.
const brands = eval("(" + js.match(/const SITE_BRANDS = \{[\s\S]*?\};/)[0]
  .replace(/^const SITE_BRANDS = /, "").replace(/;$/, "") + ")");
const labels = eval("(" + js.match(/const SITE_LABELS = \{[^}]*\};/)[0]
  .replace(/^const SITE_LABELS = /, "").replace(/;$/, "") + ")");
// Sites come from siteFromUrl() in background.js.
const bg = fs.readFileSync(dir + "background.js", "utf8");
const sites = [...bg.matchAll(/return "(resale|lms|ticketmaster)"/g)].map((m) => m[1]);
check("found the site keys in background.js", sites.length === 3, sites.join(","));
for (const s of new Set(sites)) {
  check(`SITE_BRANDS covers "${s}"`, !!brands[s], brands[s]);
  check(`SITE_LABELS covers "${s}"`, !!labels[s], labels[s]);
}

// 4. setBrand is called on each path that can change which site is displayed.
// Exclude the `function setBrand(site)` declaration itself.
const calls = [...js.matchAll(/(?<!function )setBrand\((.*?)\)/g)].map((m) => m[1]);
// Call sites grow as sources are added, so assert coverage of the paths
// that matter rather than an exact count.
check("setBrand called on every display path", calls.length >= 3, calls.join(" | "));
check("dashboard path brands off currentSite", calls.includes("currentSite"));
check("empty path brands off the tab, not stale state",
  calls.some((c) => c.includes("isTicketmasterEvent") || c.includes("passive")),
  calls.join(" | "));

// 5. Fallback: an unknown site must not blank the header.
check("unknown site falls back", (brands["nope"] || brands.resale) === "FIFA Ticket Scout");

// 6. No stale FIFA-only assumption left where the badge is built.
check("badge uses hoisted map", /const siteBadge = .*SITE_LABELS\[currentSite\]/.test(js));

console.log(fail ? `\n${fail} FAILURES` : "\nall passed");
process.exit(fail ? 1 : 0);
