// Curated venue tiers must survive a section name that carries its level.
//
// The curated maps are keyed by the bare number a venue prints on a ticket
// ("330"). Marketplaces do not all send that: AXS ships "Upper Level 330",
// "Club Level 227", "Lower Level 125". An exact lookup misses every one, and
// the miss is SILENT — tierFor falls through to the section-text heuristic, so
// the dashboard cheerfully reports "149 mapped sections" for the venue while
// every seat is tiered by a guess. That is what "it's not getting the venue
// tiers" looked like on a live Arrowhead Stadium event.
const fs = require("fs");
const vm = require("vm");
const EXT = require("./ext-dir");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

const ctx = { console: { log: () => {}, warn: () => {}, error: () => {} } };
ctx.self = ctx; ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
for (const f of ["venue-tiers.js", "tiers.js"]) {
  vm.runInContext(fs.readFileSync(EXT + f, "utf8"), ctx, { filename: f });
}
const T = ctx.VenueTiers;
const tier = (section, row) => T.tierFor("Arrowhead Stadium", section, row || "40");

out("--- the curated map is keyed by bare numbers ---");
const data = ctx.VENUE_TIER_DATA || {};
const sections = (data.sections || {})["arrowhead stadium"] || {};
const keys = Object.keys(sections);
check("arrowhead stadium is mapped", keys.length > 100, keys.length + " sections");
check("keyed as bare numbers", keys.indexOf("330") >= 0 && keys.indexOf("227") >= 0,
  keys.slice(0, 6).join(", "));
check("NOT keyed with the level prefix", keys.indexOf("UPPER LEVEL 330") === -1,
  "if this ever changes, the exact match handles it and the fallback is inert");

out("");
out("--- a level-prefixed section still finds its curated tier ---");
// The heuristic answers for these are "Upper (300s)", "Club / Mezz (200s)" and
// "Lower (100s)". Anything of that shape means the curated map was missed.
const HEURISTIC = /^(Upper|Lower|Club \/ Mezz|Other)\b/;
for (const [name, bare] of [["Upper Level 330", "330"],
                            ["Club Level 227", "227"],
                            ["Lower Level 125", "125"]]) {
  const got = tier(name);
  check(name + " resolves", !HEURISTIC.test(got), got);
  check("  and matches the bare section", got === tier(bare), got + " vs " + tier(bare));
}

out("");
out("--- the bare form is unaffected ---");
check("330 still resolves", !HEURISTIC.test(tier("330")), tier("330"));
check("101 still resolves", !HEURISTIC.test(tier("101")), tier("101"));

out("");
out("--- the exact name wins over the trailing number ---");
// Order matters: a venue whose map genuinely keys "UPPER LEVEL 330" must not be
// overridden by a section that happens to end in 330.
const src = fs.readFileSync(EXT + "tiers.js", "utf8");
check("full name is tried first", /const keys = \[norm\];/.test(src));
check("the number is appended, not prepended", /keys\.push\(tail\[1\]\)/.test(src));

out("");
out("--- it does not invent matches ---");
check("an unmapped name falls back", HEURISTIC.test(tier("Penthouse")), tier("Penthouse"));
check("an unknown venue falls back",
  HEURISTIC.test(T.tierFor("Some Field Nobody Mapped", "Upper Level 330", "40")),
  T.tierFor("Some Field Nobody Mapped", "Upper Level 330", "40"));
check("an empty section does not crash", typeof tier("") === "string", tier(""));
check("a null section does not crash", typeof tier(null) === "string", String(tier(null)));

out("");
out("--- lettered sections keep their letter ---");
// "330A" and "330" can be different sections; the fallback must not merge them
// by stripping the letter.
const withLetter = "Upper Level 330A".toUpperCase().match(/(\d{1,4}[A-Z]?)$/);
check("330A is extracted whole", withLetter && withLetter[1] === "330A", withLetter && withLetter[1]);

out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
process.exit(fail ? 1 : 0);
