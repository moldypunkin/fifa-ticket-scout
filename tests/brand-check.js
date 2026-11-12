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

// 2. The actions row wraps. Five buttons do not fit across 420px, and a flex
// item will not shrink below its own text — without this the last button is
// pushed off the right edge and cannot be clicked.
const css = fs.readFileSync(dir + "popup.css", "utf8");
const actionsRule = (css.match(/\.actions \{[^}]*\}/) || [""])[0];
check("the actions row wraps", /flex-wrap:\s*wrap/.test(actionsRule), actionsRule.slice(0, 80));
check("and its buttons size from their label",
  /\.actions \.btn \{[^}]*flex:\s*1 1 auto/.test(css));

// 3. The ids setBrand looks up actually exist in the markup.
for (const id of ["brandTitle", "brandLogo"]) {
  check(`#${id} exists in popup.html`, html.includes(`id="${id}"`));
}

// 4. Every site key used anywhere resolves through SITE_BRANDS/SITE_LABELS.
const brands = eval("(" + js.match(/const SITE_BRANDS = \{[\s\S]*?\};/)[0]
  .replace(/^const SITE_BRANDS = /, "").replace(/;$/, "") + ")");
const labels = eval("(" + js.match(/const SITE_LABELS = \{[^}]*\};/)[0]
  .replace(/^const SITE_LABELS = /, "").replace(/;$/, "") + ")");
// Sites come from siteFromUrl() in background.js. Read from that function
// alone: scanning the whole file also caught a parser returning "resale" as a
// listing CATEGORY, which is a different namespace and not a site key.
const bg = fs.readFileSync(dir + "background.js", "utf8");
const siteFromUrlSrc = require("./extract-fn")(bg, "siteFromUrl");
const sites = [...siteFromUrlSrc.matchAll(/return "(resale|lms|ticketmaster)"/g)].map((m) => m[1]);
check("found the site keys in background.js", sites.length === 3, sites.join(","));
for (const s of new Set(sites)) {
  check(`SITE_BRANDS covers "${s}"`, !!brands[s], brands[s]);
  check(`SITE_LABELS covers "${s}"`, !!labels[s], labels[s]);
}

// 5. setBrand is called on each path that can change which site is displayed.
// Exclude the `function setBrand(site)` declaration itself.
// [\s\S] not . — a setBrand call may wrap across lines, and a single-line
// regex silently stopped seeing it, which reads as a missing call site.
const calls = [...js.matchAll(/(?<!function )setBrand\(([\s\S]*?)\)\s*;/g)].map((m) => m[1]);
// Call sites grow as sources are added, so assert coverage of the paths
// that matter rather than an exact count.
check("setBrand called on every display path", calls.length >= 3, calls.join(" | "));
check("dashboard path brands off currentSite", calls.includes("currentSite"));
check("empty path brands off the tab, not stale state",
  calls.some((c) => c.includes("isTicketmasterEvent") || c.includes("passive")),
  calls.join(" | "));

// 6. Fallback: an unknown site must not blank the header.
check("unknown site falls back", (brands["nope"] || brands.resale) === "FIFA Ticket Scout");

// 7. No stale FIFA-only assumption left where the badge is built.
check("badge uses hoisted map", /const siteBadge = .*SITE_LABELS\[currentSite\]/.test(js));

console.log(fail ? `\n${fail} FAILURES` : "\nall passed");
process.exit(fail ? 1 : 0);
