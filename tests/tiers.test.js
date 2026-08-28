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

  // tierNameCmp — tab order. Row-split families must stay adjacent: Michigan
  // Stadium names them "Cat A" / "Cat A1" / "Cat A2" with different text after
  // the " - ", which is why the sort keys on the abbreviation.
  eq([
    "Cat B1 - 25-50 yardline Visitor Side rows 41-96",
    "Cat A2 - 25-50 yardline Home side rows 85 and up (Chairback seating)",
    "Cat A - 25-50 yardline Home side rows 1-40",
    "Cat B - 25-50 yardline Visitor Side rows 1-40",
    "Cat A1 - 25-50 yardline Home side rows 41-84",
  ].sort(V.tierNameCmp).map(V.tierAbbrev),
     ["Cat A", "Cat A1", "Cat A2", "Cat B", "Cat B1"],
     "tierNameCmp keeps row-split families together and in order");

  eq(["Cat C1 - x", "Cat B - y", "Cat C - z", "Cat A - w"].sort(V.tierNameCmp).map(V.tierAbbrev),
     ["Cat A", "Cat B", "Cat C", "Cat C1"], "tierNameCmp base before its splits");

  // Numeric collation, not digit-by-digit.
  eq(["Category 10", "Category 2", "Category 1"].sort(V.tierNameCmp),
     ["Category 1", "Category 2", "Category 10"], "tierNameCmp sorts numbers numerically");
  eq(["Upper (400+)", "Upper (300s)"].sort(V.tierNameCmp),
     ["Upper (300s)", "Upper (400+)"], "tierNameCmp orders bowl levels numerically");

  // Heuristic names have no " - ", so they compare whole.
  eq(["Other", "Floor / GA", "Lower (100s)", "Club / Mezz (200s)"].sort(V.tierNameCmp),
     ["Club / Mezz (200s)", "Floor / GA", "Lower (100s)", "Other"],
     "tierNameCmp is plain alphabetical for heuristic tiers");

  eq([null, "Cat A - x"].sort(V.tierNameCmp), [null, "Cat A - x"], "tierNameCmp tolerates null");

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
  //
  // Always swap in a FRESH object rather than mutating the live one. tiers.js
  // caches venueKey lookups and the base-name index against the identity of
  // VENUE_TIER_DATA, which is sound because the extension never mutates it —
  // but an in-place edit here would be served stale results and test nothing.
  let fixture = {
    version: 0,
    aliases: { "dallas stadium": "at&t stadium" },
    tiers: {},
    sections: {},
  };
  function useFixture(changes) {
    fixture = {
      version: 0,
      aliases: changes.aliases || fixture.aliases,
      tiers: changes.tiers || fixture.tiers,
      sections: changes.sections || fixture.sections,
    };
    root.self.VENUE_TIER_DATA = fixture;
  }
  root.self.VENUE_TIER_DATA = fixture;

  eq(V.venueKey("Dallas Stadium"), "at&t stadium", "fixture alias folds");
  eq(V.tierFor("AT&T Stadium", "315", "K"), "Upper (300s)", "no mapping -> heuristic");
  eq(V.hasVenueMapping("AT&T Stadium"), false, "no mapping reported");
  eq(V.tierRank("AT&T Stadium", "Lower (100s)") < V.tierRank("AT&T Stadium", "Upper (300s)"),
     true, "tierRank falls back to stadium-inward TIER_ORDER");

  useFixture({
    sections: {
      "at&t stadium": {
        "101": [{ from: null, to: null, tier: "Cat 1 - Sideline Lower" }],
        "205": [
          { from: "A", to: "M", tier: "Cat 1 - Club Front" },
          { from: "N", to: "Z", tier: "Cat 2 - Club Rear" },
          { from: null, to: null, tier: "Cat 3 - Club Other" },
        ],
        "310": [{ from: "1", to: "10", tier: "Cat 2 - Upper Front" }],
      },
    },
  });

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

  useFixture({
    tiers: {
      "at&t stadium": [
        { tier: "Cat 3 - Club Other", sort: 0 },
        { tier: "Cat 1 - Club Front", sort: 1 },
      ],
    },
  });
  eq(V.tierRank("AT&T Stadium", "Cat 3 - Club Other") < V.tierRank("AT&T Stadium", "Cat 1 - Club Front"),
     true, "saved per-venue sort beats TIER_ORDER");
  eq(V.tierRank("AT&T Stadium", "Not A Tier"), 1e6, "unknown tier sorts last");

  // Keys carrying a hand-typed disambiguator the real venue string lacks.
  // "Memorial Stadium - NE" is how TicketPortal distinguishes Nebraska's from
  // every other Memorial Stadium; no marketplace ever writes that suffix.
  useFixture({
    aliases: {},
    tiers: {},
    sections: {
      "memorial stadium - ne": { "101": [{ from: null, to: null, tier: "Cat A - Nebraska Lower" }] },
      "tiger stadium - baton rouge": { "101": [{ from: null, to: null, tier: "Cat A - LSU Lower" }] },
      "michigan stadium": { "101": [{ from: null, to: null, tier: "Cat A - Michigan" }] },
    },
  });

  eq(V.venueKey("Memorial Stadium"), "memorial stadium - ne",
     "bare name resolves to its disambiguated key");
  eq(V.venueKey("Memorial Stadium, Lincoln, NE"), "memorial stadium - ne",
     "disambiguated key reached through a city suffix too");
  eq(V.tierFor("Memorial Stadium", "101", "5"), "Cat A - Nebraska Lower",
     "curated tier reached from the bare venue name");
  eq(V.tierFor("Tiger Stadium", "Section 101", "5"), "Cat A - LSU Lower",
     "same for a city-style disambiguator");
  eq(V.hasVenueMapping("Memorial Stadium"), true, "diagnose/hint will report a match");
  eq(V.venueKey("Michigan Stadium"), "michigan stadium",
     "keys without a disambiguator are unaffected");

  // Ambiguity must NOT be guessed: labelling seats with another stadium's
  // categories is worse than falling back to the heuristic.
  useFixture({
    sections: {
      "memorial stadium - ne": { "101": [{ from: null, to: null, tier: "Cat A - Nebraska" }] },
      "memorial stadium - il": { "101": [{ from: null, to: null, tier: "Cat A - Illinois" }] },
    },
  });
  eq(V.venueKey("Memorial Stadium"), "memorial stadium",
     "ambiguous base is left unresolved rather than guessed");
  eq(V.tierFor("Memorial Stadium", "101", "5"), "Lower (100s)",
     "ambiguous venue falls back to the heuristic");
  eq(V.venueKey("Memorial Stadium, Champaign, IL"), "memorial stadium - il",
     "ambiguity resolved when the name carries the disambiguator");

  // ═══ 4. event identity (browser only) ════════════════════════════════════
  // event-info.js touches window/document at load, so it is only present under
  // the headless-Chrome runner. Skipped, not failed, under node.

  const EI = root.self.__eventInfo;
  if (EI) {
    // Same event, cosmetic differences only.
    eq(EI.pageIdentity("https://www.stubhub.com/x/event/12345/"),
       EI.pageIdentity("https://www.stubhub.com/x/event/12345"),
       "pageIdentity ignores a trailing slash");
    eq(EI.pageIdentity("https://www.stubhub.com/X/Event/12345"),
       EI.pageIdentity("https://www.stubhub.com/x/event/12345"),
       "pageIdentity ignores case");
    eq(EI.pageIdentity("https://www.stubhub.com/x/event/12345?quantity=2") ===
       EI.pageIdentity("https://www.stubhub.com/x/event/12345?quantity=4"),
       true, "pageIdentity ignores non-event query params");

    // The same event reached by its short url and its canonical slug url.
    // Ticketmaster serves both, and JSON-LD uses the slug form while the
    // address bar often holds the short one.
    eq(EI.pageIdentity("https://www.ticketmaster.com/event/Z7r9jZ1A7qIaF"),
       EI.pageIdentity("https://www.ticketmaster.com/michigan-wolverines-football-vs-oklahoma-sooners-ann-arbor-09-12-2026/event/Z7r9jZ1A7qIaF"),
       "a slug prefix does not make it a different event");
    eq(EI.ldNodeIsStale(
         { url: "https://www.ticketmaster.com/michigan-wolverines-football-vs-oklahoma-sooners-ann-arbor-09-12-2026/event/Z7r9jZ1A7qIaF" },
         "https://www.ticketmaster.com/event/Z7r9jZ1A7qIaF"),
       false, "the canonical slug url is not treated as a stale block");

    // Different events.
    eq(EI.pageIdentity("https://www.stubhub.com/x/event/12345") ===
       EI.pageIdentity("https://www.stubhub.com/x/event/99999"),
       false, "pageIdentity separates different event ids");
    // Evenue keys events off the query string, not the path.
    eq(EI.pageIdentity("https://x.evenue.net/cgi-bin/ncommerce3?eventId=111") ===
       EI.pageIdentity("https://x.evenue.net/cgi-bin/ncommerce3?eventId=222"),
       false, "pageIdentity separates events that differ only by query param");
    // Two segments still tells real events apart on a slug-heavy site.
    eq(EI.pageIdentity("https://www.ticketmaster.com/a-slug/event/AAAAAAAA") ===
       EI.pageIdentity("https://www.ticketmaster.com/a-slug/event/BBBBBBBB"),
       false, "different ids under the same slug are different events");
    eq(EI.pageIdentity("https://x.evenue.net/event/F26/01") ===
       EI.pageIdentity("https://x.evenue.net/event/F26/02"),
       false, "Evenue season/code pairs stay distinct");

    const page = "https://www.stubhub.com/team/event/12345";
    eq(EI.ldNodeIsStale({ url: "https://www.stubhub.com/team/event/99999" }, page),
       true, "a JSON-LD node naming another event is stale");
    eq(EI.ldNodeIsStale({ url: "https://www.stubhub.com/team/event/12345/" }, page),
       false, "the node for this event is not stale");
    eq(EI.ldNodeIsStale({ mainEntityOfPage: "https://www.stubhub.com/team/event/99999" }, page),
       true, "mainEntityOfPage is checked too");
    eq(EI.ldNodeIsStale({ mainEntityOfPage: { url: "https://www.stubhub.com/team/event/99999" } }, page),
       true, "mainEntityOfPage as an object");

    // A node with no url of its own cannot be checked. Keep it: rejecting
    // these would throw away the only source on pages that work fine.
    eq(EI.ldNodeIsStale({ name: "Some Event" }, page), false,
       "a node without a url is kept rather than assumed stale");
    eq(EI.ldNodeIsStale(null, page), false, "no node is not stale");
    eq(EI.ldNodeIsStale({ url: "" }, page), false, "an empty url is not stale");

    eq(EI.cleanTitle("Portugal vs. Spain Tickets | StubHub"), "Portugal vs. Spain",
       "cleanTitle strips the suffix the fallback path relies on");
    eq(EI.normalizeEventDate("2026-06-15T19:00:00-04:00"), "15-06-2026 - 19:00",
       "normalizeEventDate keeps venue-local wall clock");
  } else {
    lines.push("note  event-info.js not loaded (node run) — section 4 skipped");
  }

  // ═══ 5. venue category import (browser only) ═════════════════════════════
  // venue-import.js parses the CSV documented in
  // tools/venue_categories.sample.csv. It must accept and reject exactly what
  // tools/build_venue_tiers.py does, or a file that imports in the app would
  // fail at build time and vice versa.

  const VI = root.self.VenueImport;
  if (VI) {
    const good = [
      "# a comment",
      "venue,section,row_from,row_to,tier,sort",
      "Lane Stadium,1,,,Cat A - Lower,0",
      "Lane Stadium,Section 2,,,Cat A - Lower,",
      "Lane Stadium,20,A,M,Cat A - Lower,",
      "Lane Stadium,20,N,Z,Cat B - Corner,1",
      "Lane Stadium,20,,,Cat C - Endzone,2",
      "",
      "Lane Stadium,,,,Cat C - Endzone,2",
    ].join("\n");

    const parsed = VI.parse(good);
    eq(parsed.problems, [], "a valid file parses without problems");
    eq(parsed.rows.length, 6, "every non-comment, non-blank row is kept");
    eq(parsed.rows[1].section, "2", "section is normalized on import");
    eq(parsed.rows[0].venue, "lane stadium", "venue is normalized on import");

    const summary = VI.summarize(parsed.rows);
    eq([summary.venues, summary.sections, summary.bands, summary.ordering],
       [1, 3, 2, 1], "summarize counts venues, sections, bands and ordering rows");

    // Column order is taken from the header, not assumed.
    const reordered = VI.parse("tier,venue,section\nCat Z - Reordered,Some Place,7");
    eq(reordered.problems, [], "columns may be reordered");
    eq(reordered.rows[0].tier, "Cat Z - Reordered", "reordered columns map correctly");
    eq(reordered.rows[0].section, "7", "reordered columns map correctly (section)");

    // Quoted fields, because real spreadsheet exports have commas in names.
    const quoted = VI.parse('venue,section,tier\n"Smith, Jr. Arena",101,"Cat A - Lower, Front"');
    eq(quoted.problems, [], "quoted fields parse");
    eq(quoted.rows[0].venue, "smith, jr. arena", "comma inside a quoted venue survives");
    eq(quoted.rows[0].tier, "Cat A - Lower, Front", "comma inside a quoted tier survives");

    // Every rejection the build script makes, the app must make too.
    const bad = VI.parse([
      "venue,section,row_from,row_to,tier,sort",
      "Bad Arena,101,,,Cat A,0",
      "Bad Arena,101,,,Cat B,1",
      "Bad Arena,202,5,E,Cat C,",
      "Bad Arena,303,M,A,Cat D,",
      "Bad Arena,505,,,,",
      "Bad Arena,606,,,Cat F,abc",
      "Bad Arena,,,,Cat E,7",
      "Bad Arena,,,,Cat E,9",
    ].join("\n"));
    const joined = bad.problems.join(" | ");
    eq(/no tier/.test(joined), true, "rejects a row with no tier");
    eq(/not a whole number/.test(joined), true, "rejects a non-numeric sort");
    eq(/catch-all rows/.test(joined), true, "rejects two catch-alls on one section");
    eq(/mixes numeric and lettered/.test(joined), true, "rejects mixed band types");
    eq(/runs backwards/.test(joined), true, "rejects a reversed row band");
    eq(/sort given as both/.test(joined), true, "rejects one category with two sorts");

    eq(VI.parse("nope,nothing\n1,2").problems.length > 0, true, "rejects a file with no venue/tier header");
    eq(VI.parse("venue,tier,bogus\nA,B,C").problems.length > 0, true, "rejects an unknown column");

    // ── overlay ────────────────────────────────────────────────────────────
    const base = {
      version: 9,
      aliases: { "the big house": "michigan stadium" },
      tiers: { "michigan stadium": [{ tier: "Cat A - Old", sort: 0 }] },
      sections: {
        "michigan stadium": {
          "1": [{ from: null, to: null, tier: "Cat A - Old" }],
          "2": [{ from: null, to: null, tier: "Cat B - Old" }],
        },
        "memorial stadium - ne": {
          "9": [{ from: null, to: null, tier: "Cat Z - Nebraska" }],
        },
      },
    };

    const overlay = VI.applyOverlay(base, VI.parse([
      "venue,section,row_from,row_to,tier,sort",
      "Michigan Stadium,1,A,M,Cat A - New Front,0",
      "Michigan Stadium,1,N,Z,Cat A1 - New Rear,1",
      "The Big House,3,,,Cat C - Via Alias,",
      "Memorial Stadium,10,,,Cat Y - Via Base Name,",
    ].join("\n")).rows);

    eq(overlay.sections["michigan stadium"]["1"].length, 2,
       "an imported section REPLACES the shipped rules rather than adding to them");
    eq(overlay.sections["michigan stadium"]["1"][0].tier, "Cat A - New Front",
       "the imported rule wins");
    eq(overlay.sections["michigan stadium"]["2"][0].tier, "Cat B - Old",
       "sections not mentioned are left alone");
    eq(overlay.sections["michigan stadium"]["3"][0].tier, "Cat C - Via Alias",
       "an aliased venue name lands on the canonical key");
    eq(overlay.sections["memorial stadium - ne"]["10"][0].tier, "Cat Y - Via Base Name",
       "a bare name lands on its disambiguated key instead of making a new venue");
    eq(Object.keys(overlay.sections).sort(), ["memorial stadium - ne", "michigan stadium"],
       "no extra venue is created by the import");

    // ── shared set (venue_categories.json, fetched from the repo) ─────────
    const shared = {
      version: 42,
      aliases: { "the big house": "michigan stadium", "u of m": "michigan stadium" },
      tiers: { "michigan stadium": [{ tier: "Cat A - Shared", sort: 0 }] },
      sections: {
        "michigan stadium": { "1": [{ from: null, to: null, tier: "Cat A - Shared" }] },
        "new venue": { "5": [{ from: null, to: null, tier: "Cat S - Only Shared" }] },
      },
    };

    const layered = VI.applyShared(base, shared);
    eq(layered.sections["michigan stadium"]["1"][0].tier, "Cat A - Shared",
       "the shared set replaces a venue the build shipped");
    eq(layered.sections["michigan stadium"]["2"], undefined,
       "a venue is replaced wholesale, not merged section by section");
    eq(layered.sections["new venue"]["5"][0].tier, "Cat S - Only Shared",
       "the shared set can add a venue the build never had");
    eq(layered.sections["memorial stadium - ne"]["9"][0].tier, "Cat Z - Nebraska",
       "a venue the shared set omits is left alone");
    eq(layered.aliases["the big house"], "michigan stadium", "shared aliases merge in");
    eq(base.sections["michigan stadium"]["2"][0].tier, "Cat B - Old",
       "applyShared does not mutate the shipped data");
    eq(VI.applyShared(base, null) === base, true, "no shared set returns the base unchanged");
    eq(VI.applyShared(base, { sections: {}, aliases: {} }) === base, true,
       "an empty shared set returns the base unchanged");

    // Precedence: shipped < shared < local import. A local import must win for
    // the venues it names, or the Import button would be useless for a venue
    // that has not been published yet.
    const bothLayers = VI.applyOverlay(
      VI.applyShared(base, shared),
      VI.parse([
        "venue,section,tier",
        "Michigan Stadium,1,Cat A - Local Wins",
      ].join("\n")).rows);
    eq(bothLayers.sections["michigan stadium"]["1"][0].tier, "Cat A - Local Wins",
       "a local import beats the shared set");
    eq(bothLayers.sections["new venue"]["5"][0].tier, "Cat S - Only Shared",
       "the shared set still fills in venues the import does not name");

    // The base must be untouched, or clearing an import could not restore it.
    eq(base.sections["michigan stadium"]["1"][0].tier, "Cat A - Old",
       "applyOverlay does not mutate the shipped data");
    eq(base.sections["memorial stadium - ne"]["10"], undefined,
       "applyOverlay does not add to the shipped data");
    eq(VI.applyOverlay(base, []) === base, true, "an empty import returns the base unchanged");

    // Imported sorts are merged into the venue's ordering. A shipped category
    // the import did not mention is KEPT — `tiers` is display-order metadata,
    // and the tab strip is built from the categories the seat data actually
    // contains, so a leftover entry for an unused category costs nothing.
    const orderedTiers = overlay.tiers["michigan stadium"];
    eq(orderedTiers.filter((t) => t.tier === "Cat A - New Front")[0].sort, 0,
       "an imported category takes the sort it was given");
    eq(orderedTiers.filter((t) => t.tier === "Cat A1 - New Rear")[0].sort, 1,
       "a second imported category takes its own sort");
    eq(orderedTiers.some((t) => t.tier === "Cat A - Old"), true,
       "a shipped category the import did not mention is left in place");
    eq(orderedTiers.map((t) => t.sort), [0, 0, 1],
       "the ordering list stays sorted by sort value");

    // The whole point: tierFor must see the imported rules.
    const before = root.self.VENUE_TIER_DATA;
    root.self.VENUE_TIER_DATA = overlay;
    eq(V.tierFor("Michigan Stadium", "1", "C"), "Cat A - New Front",
       "tierFor resolves an imported row band");
    eq(V.tierFor("Michigan Stadium", "1", "Q"), "Cat A1 - New Rear",
       "tierFor resolves the second imported band");
    eq(V.tierFor("Memorial Stadium", "10", "5"), "Cat Y - Via Base Name",
       "tierFor resolves an import reached through base-name matching");
    root.self.VENUE_TIER_DATA = before;
  } else {
    lines.push("note  venue-import.js not loaded (node run) — section 5 skipped");
  }

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
