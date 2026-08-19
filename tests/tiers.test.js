// Tests for extension/tiers.js and the generated extension/venue-tiers.js.
//
// Runs in two places, because the code under test targets a browser but node is
// the convenient harness:
//
//   python tests/run.py             headless Chrome         (no node needed)
//   node tests/tiers.test.js        exit 0 = pass           (if node is present)
//
// No test framework and no dependencies, on purpose: tiers.js has none either.
//
// Three phases:
//   1. pure functions — unaffected by whatever data is shipped
//   2. the shipped venue-tiers.js — structural validation of generated output
//   3. resolution — against a controlled fixture that REPLACES the shipped data,
//      so these never break when a new export lands

(function (root) {
  "use strict";

  const isNode = typeof process === "object" && typeof require === "function";
  if (isNode) {
    // tiers.js and venue-tiers.js assign onto `self`; give them one.
    root.self = root;
    require("../extension/venue-tiers.js");
    require("../extension/tiers.js");
  }
  // In the browser the two scripts are already loaded by runner.html.

  const V = root.self.VenueTiers;
  const lines = [];
  let failed = 0;
  let passed = 0;

  function eq(got, want, label) {
    if (JSON.stringify(got) === JSON.stringify(want)) {
      passed++;
    } else {
      failed++;
      lines.push("FAIL  " + label + "\n        got  " + JSON.stringify(got) +
                 "\n        want " + JSON.stringify(want));
    }
  }

  // ═══ 1. pure functions ═══════════════════════════════════════════════════

  // tierOf: the nine parity cases from TicketPortal pure-functions.test.js
  eq(V.tierOf("103"), "Lower (100s)", "tierOf 103");
  eq(V.tierOf("Section 215"), "Club / Mezz (200s)", "tierOf 215");
  eq(V.tierOf("315"), "Upper (300s)", "tierOf 315");
  eq(V.tierOf("418"), "Upper (400+)", "tierOf 418");
  eq(V.tierOf("FLOOR GA"), "Floor / GA", "tierOf floor");
  eq(V.tierOf("Orchestra L"), "Orchestra", "tierOf orchestra");
  eq(V.tierOf("Mezzanine"), "Mezzanine", "tierOf mezzanine");
  eq(V.tierOf("Balcony R"), "Balcony", "tierOf balcony");
  eq(V.tierOf(""), "Other", "tierOf empty");

  // Shapes the marketplace adapters actually emit
  eq(V.tierOf(null), "Other", "tierOf null");
  eq(V.tierOf(101), "Lower (100s)", "tierOf numeric input");
  eq(V.tierOf("GA PIT"), "Floor / GA", "tierOf GA pit");
  eq(V.tierOf("VIP Lounge"), "Other", "tierOf unrecognised");

  eq(V.rowRank("1"), 1, "rowRank 1");
  eq(V.rowRank("Z"), 26, "rowRank Z");
  eq(V.rowRank("AA"), 27, "rowRank AA — behind Z, not before A");
  eq(V.rowRank("12A"), 12, "rowRank 12A");
  eq(V.rowRank(""), null, "rowRank empty");
  eq(V.rowRank(null), null, "rowRank null");

  eq(V.normSec("Section 315"), "315", "normSec Section prefix");
  eq(V.normSec("SEC 101"), "101", "normSec SEC prefix");
  eq(V.normSec("  sections 7  "), "7", "normSec plural + whitespace");
  eq(V.normVenue("  AT&T   Stadium "), "at&t stadium", "normVenue collapse");

  eq(V.tierAbbrev("Cat 1 - Sideline Lower"), "Cat 1", "tierAbbrev splits on ' - '");
  eq(V.tierAbbrev("Upper (300s)"), "Upper (300s)", "tierAbbrev leaves plain names");
  eq(V.tierAbbrev("A-B"), "A-B", "tierAbbrev ignores hyphen without spaces");
  eq(V.tierAbbrev(null), "", "tierAbbrev null");

  eq(["AA", "B", "A", "Z"].sort(V.rowCmp), ["A", "B", "Z", "AA"], "rowCmp seating depth");
  eq(["12", "2", "1"].sort(V.rowCmp), ["1", "2", "12"], "rowCmp numeric rows");

  // ═══ 2. the shipped venue-tiers.js ═══════════════════════════════════════
  // Structural validation of whatever build_venue_tiers.py last produced.
  // All of these pass on an empty file, so they hold before the first export
  // and keep holding after — they check shape, not contents.

  const shipped = root.self.VENUE_TIER_DATA;
  eq(typeof shipped, "object", "VENUE_TIER_DATA exists");

  const shippedAliases = (shipped && shipped.aliases) || {};
  const shippedTiers = (shipped && shipped.tiers) || {};
  const shippedSections = (shipped && shipped.sections) || {};

  // Keys are looked up post-normVenue, so an unnormalized key can never match.
  const badAliasKeys = Object.keys(shippedAliases)
    .filter((k) => k !== V.normVenue(k) || !k);
  eq(badAliasKeys, [], "every alias key is normalized and non-empty");

  const badAliasValues = Object.keys(shippedAliases)
    .filter((k) => {
      const v = shippedAliases[k];
      return typeof v !== "string" || !v || v !== V.normVenue(v);
    });
  eq(badAliasValues, [], "every alias value is a normalized non-empty string");

  // venueKey() does ONE hop, so an alias pointing at another alias silently
  // resolves to the wrong venue. Catch chains rather than debugging them later.
  const aliasChains = Object.keys(shippedAliases)
    .filter((k) => Object.prototype.hasOwnProperty.call(shippedAliases, shippedAliases[k]));
  eq(aliasChains, [], "no alias points at another alias (venueKey does one hop)");

  const selfAliases = Object.keys(shippedAliases).filter((k) => shippedAliases[k] === k);
  eq(selfAliases, [], "no alias maps a name to itself");

  // Venue keys in tiers/sections are the CANONICAL side, so they must not
  // themselves be aliased away, or nothing will ever look them up.
  const aliasedVenueKeys = Object.keys(shippedSections).concat(Object.keys(shippedTiers))
    .filter((k) => Object.prototype.hasOwnProperty.call(shippedAliases, k));
  eq(aliasedVenueKeys, [], "no tiers/sections venue key is itself an alias");

  // Section keys are looked up via normSec(), so they must already be normalized.
  const badSectionKeys = [];
  const badRules = [];
  const mixedBands = [];
  Object.keys(shippedSections).forEach((venue) => {
    const map = shippedSections[venue] || {};
    Object.keys(map).forEach((section) => {
      if (section !== V.normSec(section) || !section) {
        badSectionKeys.push(venue + " / " + JSON.stringify(section));
      }
      const rules = map[section];
      if (!Array.isArray(rules) || !rules.length) {
        badRules.push(venue + " / " + section + " (no rules)");
        return;
      }
      let numeric = 0;
      let lettered = 0;
      rules.forEach((r) => {
        if (!r || typeof r.tier !== "string" || !r.tier) {
          badRules.push(venue + " / " + section + " (rule without a tier)");
        }
        ["from", "to"].forEach((end) => {
          const val = r && r[end];
          if (val === null || val === undefined) return;
          if (typeof val !== "string" || V.rowRank(val) === null) {
            badRules.push(venue + " / " + section + " (unrankable " + end + ": " + JSON.stringify(val) + ")");
            return;
          }
          if (/^\d/.test(val.trim())) numeric++; else lettered++;
        });
      });
      // rowRank puts letters and numbers on one scale, so mixing them inside a
      // section makes "row 5 vs row E" a coin flip. Bands must agree.
      if (numeric && lettered) mixedBands.push(venue + " / " + section);
    });
  });
  eq(badSectionKeys, [], "every section key is already normSec-normalized");
  eq(badRules, [], "every rule has a tier and rankable row bounds");
  eq(mixedBands, [], "no section mixes numeric and lettered row bands");

  // A section with two catch-alls is ambiguous — tierFor takes the first.
  const doubleCatchAll = [];
  Object.keys(shippedSections).forEach((venue) => {
    const map = shippedSections[venue] || {};
    Object.keys(map).forEach((section) => {
      const n = (map[section] || [])
        .filter((r) => r && r.from == null && r.to == null).length;
      if (n > 1) doubleCatchAll.push(venue + " / " + section);
    });
  });
  eq(doubleCatchAll, [], "no section has more than one catch-all rule");

  // The curated FIFA aliases are always merged in by build_venue_tiers.py.
  eq(V.venueKey("Dallas Stadium"), "at&t stadium", "curated alias survives regeneration");
  eq(V.venueKey("Unknown Park Nowhere"), "unknown park nowhere", "alias miss falls through");

  // ═══ 3. resolution, against a controlled fixture ═════════════════════════
  // Replace the shipped data outright so these assertions do not shift when a
  // new export lands. Everything below is about tierFor's LOGIC, not the data.

  root.self.VENUE_TIER_DATA = {
    version: 0,
    aliases: { "dallas stadium": "at&t stadium" },
    tiers: {},
    sections: {},
  };

  eq(V.venueKey("Dallas Stadium"), "at&t stadium", "fixture alias folds");
  eq(V.tierFor("AT&T Stadium", "315", "K"), "Upper (300s)", "no mapping -> heuristic");
  eq(V.hasVenueMapping("AT&T Stadium"), false, "no mapping reported");
  eq(V.tierRank("AT&T Stadium", "Lower (100s)") < V.tierRank("AT&T Stadium", "Upper (300s)"),
     true, "tierRank falls back to stadium-inward TIER_ORDER");

  root.self.VENUE_TIER_DATA.sections["at&t stadium"] = {
    "101": [{ from: null, to: null, tier: "Cat 1 - Sideline Lower" }],
    "205": [
      { from: "A", to: "M", tier: "Cat 1 - Club Front" },
      { from: "N", to: "Z", tier: "Cat 2 - Club Rear" },
      { from: null, to: null, tier: "Cat 3 - Club Other" },
    ],
    "310": [{ from: "1", to: "10", tier: "Cat 2 - Upper Front" }],
  };

  eq(V.tierFor("Dallas Stadium", "Section 101", "7"), "Cat 1 - Sideline Lower",
     "whole-section rule, reached via alias + normSec");
  eq(V.tierFor("AT&T Stadium", "205", "A"), "Cat 1 - Club Front", "band lower bound inclusive");
  eq(V.tierFor("AT&T Stadium", "205", "M"), "Cat 1 - Club Front", "band upper bound inclusive");
  eq(V.tierFor("AT&T Stadium", "205", "N"), "Cat 2 - Club Rear", "second band lower bound");
  eq(V.tierFor("AT&T Stadium", "205", "Q"), "Cat 2 - Club Rear", "second band interior");
  eq(V.tierFor("AT&T Stadium", "205", "AA"), "Cat 3 - Club Other", "past every band -> catch-all");
  eq(V.tierFor("AT&T Stadium", "205", ""), "Cat 3 - Club Other", "unrankable row -> catch-all");
  eq(V.tierFor("AT&T Stadium", "310", "5"), "Cat 2 - Upper Front", "numeric band");
  eq(V.tierFor("AT&T Stadium", "310", "40"), "Upper (300s)",
     "outside a band with no catch-all -> heuristic, not silently wrong");
  eq(V.tierFor("AT&T Stadium", "999", "A"), "Upper (400+)", "unmapped section -> heuristic");
  eq(V.hasVenueMapping("Dallas Stadium"), true, "mapping seen through alias");

  // City-suffixed venue names. Marketplaces append them and TicketPortal's own
  // rows show both shapes; an exact-match-only lookup misses silently.
  eq(V.tierFor("AT&T Stadium, Arlington, TX", "101", "7"), "Cat 1 - Sideline Lower",
     "comma-separated city suffix stripped");
  eq(V.tierFor("Dallas Stadium, Arlington, TX", "101", "7"), "Cat 1 - Sideline Lower",
     "alias + city suffix together");
  eq(V.tierFor("AT&T Stadium Arlington, TX", "101", "7"), "Cat 1 - Sideline Lower",
     "no-comma city suffix via longest-prefix match");
  eq(V.venueKey("AT&T Stadium, Arlington, TX"), "at&t stadium", "venueKey strips city");
  eq(V.venueKey("Some Other Place, Nowhere, ZZ"), "some other place, nowhere, zz",
     "unknown venue is left alone rather than mangled");
  eq(V.venueKey(""), "", "empty venue");
  eq(V.venueKey(null), "", "null venue");
  eq(V.diagnose("Dallas Stadium").matched, true, "diagnose reports a match");
  eq(V.diagnose("Nowhere Arena").matched, false, "diagnose reports a miss");
  eq(V.diagnose(null).venue, null, "diagnose handles a missing venue");

  root.self.VENUE_TIER_DATA.tiers["at&t stadium"] = [
    { tier: "Cat 3 - Club Other", sort: 0 },
    { tier: "Cat 1 - Club Front", sort: 1 },
  ];
  eq(V.tierRank("AT&T Stadium", "Cat 3 - Club Other") < V.tierRank("AT&T Stadium", "Cat 1 - Club Front"),
     true, "saved per-venue sort beats TIER_ORDER");
  eq(V.tierRank("AT&T Stadium", "Not A Tier"), 1e6, "unknown tier sorts last");

  // ═══ report ══════════════════════════════════════════════════════════════
  const total = passed + failed;
  const summary = failed
    ? "TIERS-RESULT: FAIL " + failed + "/" + total
    : "TIERS-RESULT: PASS " + total + "/" + total;
  lines.push(summary);
  const out = lines.join("\n");

  if (isNode) {
    console.log(out);
    process.exit(failed ? 1 : 0);
  } else {
    const el = root.document && root.document.getElementById("out");
    if (el) el.textContent = out;
    root.__TIERS_RESULT = { passed: passed, failed: failed, text: out };
  }
})(typeof self !== "undefined" ? self : global);
