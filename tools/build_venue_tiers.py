"""Regenerate extension/venue-tiers.js from a TicketPortal export.

    python tools/build_venue_tiers.py [--only <venue> ...] [--stats]

Reads tools/venue_tiers_export.json — the single result cell produced by
tools/export_venue_tiers.sql, run in the TicketPortal project's SQL editor —
merges in the curated aliases from tools/fifa_venue_aliases.json, and writes
extension/venue-tiers.js.

The two repos are separate Supabase projects, so this is a build-time export
rather than a live read. Re-run it whenever the mappings change.

Section keys are normalized here to match normSec() in tiers.js, so however
TicketPortal stored them, the lookup lines up.

--only limits output to the named canonical venues (repeatable, matched after
alias folding). TicketPortal tracks venues far beyond the World Cup ones, and
every unused venue is dead weight in the shipped extension.
"""

import argparse
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXPORT = os.path.join(HERE, "venue_tiers_export.json")
ALIASES = os.path.join(HERE, "fifa_venue_aliases.json")
TARGET = os.path.join(ROOT, "extension", "venue-tiers.js")

HEADER = '''// Venue tier mapping data — consumed by tiers.js.
//
// GENERATED FILE — do not edit by hand.
//   Regenerate:  python tools/build_venue_tiers.py
//   Source:      tools/export_venue_tiers.sql run in the TicketPortal project,
//                plus the curated aliases in tools/fifa_venue_aliases.json.
//
// Shipped as a .js file rather than .json on purpose: the MV3 service worker
// pulls this in with importScripts() and the popup with a <script> tag, both
// synchronous. A .json would force an async fetch into the seat-parsing path.
//
// Mirrors the shape TicketPortal loads from its `venue_tiers` and
// `venue_sections` tables (see venue_section_rowbands.sql). The two repos are
// separate Supabase projects, so this is a build-time export, not a live read.
//
//   aliases  normalized venue name -> canonical venue key
//   tiers    canonical venue key -> [{ tier, sort }]   display order per venue
//   sections canonical venue key -> { NORMALIZED_SECTION: [rule, ...] }
//
// A rule is { from, to, tier }:
//   { from: null, to: null, tier: "Lower (100s)" }        whole section
//   { from: "A",  to: "M",  tier: "Club / Mezz (200s)" }  row band, inclusive
// Row bands are matched by rowRank(), so "A".."Z".."AA" and "1".."30" both work,
// but a section's bands must all be the same type. A section may hold several
// band rules plus one catch-all (from/to null), used when a row matches no band.
//
// Empty `tiers`/`sections` are fine — tierFor() falls back to the tierOf()
// section-text heuristic.
//
// Venue aliases marked unverified in tools/fifa_venue_aliases.json were seeded
// by hand, NOT scraped. Confirm each against a real event page's venue string.
'''


def norm_venue(v):
    """Mirror of normVenue() in tiers.js."""
    return re.sub(r"\s+", " ", str(v or "")).strip().lower()


def norm_sec(s):
    """Mirror of normSec() in tiers.js."""
    v = str("" if s is None else s).upper()
    v = re.sub(r"\bSECTIONS?\b|\bSEC\b", "", v)
    return re.sub(r"\s+", " ", v).strip()


def js_string(s):
    """A JS double-quoted literal. json.dumps escapes exactly what JS needs."""
    return json.dumps(str(s), ensure_ascii=False)


def load_json(path, what):
    if not os.path.exists(path):
        print("Missing %s (%s)." % (path, what))
        return None
    with io.open(path, encoding="utf-8") as fh:
        try:
            return json.load(fh)
        except ValueError as exc:
            print("%s is not valid JSON: %s" % (path, exc))
            return None


def report_conflicts(conflicts):
    """Sections an aliased venue tried to redefine. Not an error — the canonical
    venue's mapping was kept — but a large count usually means two venue names
    are drifting apart in TicketPortal and one of them is stale."""
    if not conflicts:
        return
    by_venue = {}
    for canon, section, source in conflicts:
        by_venue.setdefault((canon, source), []).append(section)
    print("")
    print("  %d section(s) skipped as duplicates of a canonical venue's own mapping:" % len(conflicts))
    for (canon, source), secs in sorted(by_venue.items()):
        preview = ", ".join(sorted(secs)[:6])
        more = "" if len(secs) <= 6 else " (+%d more)" % (len(secs) - 6)
        print("    %s <- %r: %d [%s%s]" % (canon, source, len(secs), preview, more))


def build():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", action="append", default=[],
                        help="canonical venue to keep (repeatable)")
    parser.add_argument("--stats", action="store_true",
                        help="print per-venue rule counts and stop")
    args = parser.parse_args()

    curated = load_json(ALIASES, "curated aliases")
    if curated is None:
        return 2

    export = load_json(EXPORT, "TicketPortal export")
    if export is None:
        print("")
        print("Run tools/export_venue_tiers.sql in the TicketPortal project's SQL")
        print("editor and save the single result cell to:")
        print("  " + EXPORT)
        return 2

    # The SQL editor's "copy cell" sometimes wraps the object in a one-row,
    # one-column list. Unwrap it so either form works.
    if isinstance(export, list):
        if len(export) == 1 and isinstance(export[0], dict):
            export = export[0]
        else:
            print("Export is a list of %d rows; expected the single JSON cell." % len(export))
            return 2
    if "venue_tier_data" in export and isinstance(export["venue_tier_data"], dict):
        export = export["venue_tier_data"]

    # ── aliases: DB first, curated on top so a hand fix wins a stale row ─────
    aliases = {}
    for key, value in (export.get("aliases") or {}).items():
        aliases[norm_venue(key)] = norm_venue(value)
    curated_count = 0
    for group in ("unverified", "verified"):
        for key, value in (curated.get(group) or {}).items():
            aliases[norm_venue(key)] = norm_venue(value)
            curated_count += 1

    def canonical(venue):
        n = norm_venue(venue)
        return aliases.get(n, n)

    # ── tiers ────────────────────────────────────────────────────────────────
    tiers = {}
    for venue, rows in (export.get("tiers") or {}).items():
        key = canonical(venue)
        merged = tiers.setdefault(key, [])
        for row in rows or []:
            merged.append({"tier": row.get("tier"), "sort": row.get("sort")})
    for key in tiers:
        # Aliased venues can merge two lists; dedupe on tier name, keep lowest sort.
        best = {}
        for row in tiers[key]:
            name = row["tier"]
            if name not in best or (row["sort"] is not None and row["sort"] < best[name]["sort"]):
                best[name] = row
        tiers[key] = sorted(best.values(), key=lambda r: (r["sort"] is None, r["sort"], r["tier"]))

    # ── sections ─────────────────────────────────────────────────────────────
    # Several source venues can fold onto one canonical key: TicketPortal holds
    # both "Arrowhead Stadium" (hand-curated tiers) and "GEHA Field at Arrowhead
    # Stadium" (auto-seeded tierOf() defaults) for the same building. Merging
    # them blindly stacks two catch-all rules on a section, and tierFor() takes
    # whichever landed first — so the auto-seeded junk could beat the curated
    # mapping. Resolve instead: the canonical venue's own rows win, and an
    # aliased venue only fills sections the canonical one does not define.
    sections = {}
    dropped_empty = 0
    conflicts = []

    by_canonical = {}
    for venue, section_map in (export.get("sections") or {}).items():
        by_canonical.setdefault(canonical(venue), []).append((venue, section_map or {}))

    for key, sources in by_canonical.items():
        # Primary first: the source whose own name IS the canonical key. Failing
        # that, the richest mapping. Name breaks ties so runs are reproducible.
        sources.sort(key=lambda pair: (norm_venue(pair[0]) != key, -len(pair[1]), pair[0]))
        target = sections.setdefault(key, {})
        for venue, section_map in sources:
            for section, rules in section_map.items():
                skey = norm_sec(section)
                if not skey:
                    dropped_empty += 1
                    continue
                clean = [
                    {"from": r.get("from"), "to": r.get("to"), "tier": r.get("tier")}
                    for r in (rules or []) if r and r.get("tier")
                ]
                if not clean:
                    continue
                if skey in target:
                    conflicts.append((key, skey, venue))
                    continue
                target[skey] = clean
        if not target:
            sections.pop(key, None)

    # ── optional filter ──────────────────────────────────────────────────────
    if args.only:
        keep = set(canonical(v) for v in args.only)
        missing = keep - set(sections) - set(tiers)
        for name in sorted(missing):
            print("warning: --only %r matched nothing in the export" % name)
        tiers = {k: v for k, v in tiers.items() if k in keep}
        sections = {k: v for k, v in sections.items() if k in keep}
        # Keep only aliases that still point somewhere useful.
        aliases = {k: v for k, v in aliases.items() if v in keep or v in sections or v in tiers}

    rule_total = sum(len(r) for m in sections.values() for r in m.values())
    band_total = sum(1 for m in sections.values() for r in m.values()
                     for rule in r if rule["from"] is not None or rule["to"] is not None)

    if args.stats:
        print("%-42s %8s %8s" % ("venue", "sections", "rules"))
        for key in sorted(sections):
            n_rules = sum(len(r) for r in sections[key].values())
            print("%-42s %8d %8d" % (key[:42], len(sections[key]), n_rules))
        print("")
        print("%d venues, %d sections, %d rules (%d row bands)"
              % (len(sections), sum(len(m) for m in sections.values()), rule_total, band_total))
        report_conflicts(conflicts)
        return 0

    # ── emit ─────────────────────────────────────────────────────────────────
    out = [HEADER]
    out.append('\n(function (root) {\n  "use strict";\n\n  root.VENUE_TIER_DATA = {\n')
    out.append("    version: 2,\n\n")

    out.append("    aliases: {\n")
    for key in sorted(aliases):
        out.append("      %s: %s,\n" % (js_string(key), js_string(aliases[key])))
    out.append("    },\n\n")

    out.append("    // Per-venue tier display order. Empty -> tiers.js falls back to TIER_ORDER.\n")
    out.append("    tiers: {\n")
    for key in sorted(tiers):
        out.append("      %s: [\n" % js_string(key))
        for row in tiers[key]:
            sort = "null" if row["sort"] is None else int(row["sort"])
            out.append("        { tier: %s, sort: %s },\n" % (js_string(row["tier"]), sort))
        out.append("      ],\n")
    out.append("    },\n\n")

    out.append("    // Per-venue section rules. Empty -> tierOf() heuristic for every listing.\n")
    out.append("    sections: {\n")
    for key in sorted(sections):
        out.append("      %s: {\n" % js_string(key))
        for skey in sorted(sections[key]):
            parts = []
            for rule in sections[key][skey]:
                parts.append("{ from: %s, to: %s, tier: %s }" % (
                    "null" if rule["from"] is None else js_string(rule["from"]),
                    "null" if rule["to"] is None else js_string(rule["to"]),
                    js_string(rule["tier"]),
                ))
            out.append("        %s: [%s],\n" % (js_string(skey), ", ".join(parts)))
        out.append("      },\n")
    out.append("    },\n")

    out.append("  };\n")
    out.append('})(typeof self !== "undefined" ? self : this);\n')

    with io.open(TARGET, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("".join(out))

    print("Wrote %s" % os.path.relpath(TARGET, ROOT))
    print("  aliases  %d (%d curated)" % (len(aliases), curated_count))
    print("  tiers    %d venues" % len(tiers))
    print("  sections %d venues, %d sections, %d rules (%d row bands)"
          % (len(sections), sum(len(m) for m in sections.values()), rule_total, band_total))
    if dropped_empty:
        print("  skipped  %d section rows that normalized to an empty key" % dropped_empty)
    report_conflicts(conflicts)
    print("")
    print("Now run:  python tests/run.py")
    return 0


if __name__ == "__main__":
    sys.exit(build())
