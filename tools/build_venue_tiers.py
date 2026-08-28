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
import csv
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
# Fetched at runtime from the repo, so a mapping change reaches every
# install without a store release. Same data as TARGET, as JSON.
SHARED = os.path.join(ROOT, "venue_categories.json")

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


# ── hand-maintained venue categories (CSV) ───────────────────────────────────
# A second source alongside the TicketPortal export, for venues that are not in
# TicketPortal or that need correcting by hand. Merged on top of the export, so
# an entry here beats the database for the same venue and section and survives
# re-running the export.

CATEGORIES_CSV = os.path.join(HERE, "venue_categories.csv")
SAMPLE_CSV = os.path.join(HERE, "venue_categories.sample.csv")
CSV_COLUMNS = ["venue", "section", "row_from", "row_to", "tier", "sort"]


def row_rank(value):
    """Mirror of rowRank() in tiers.js, enough to validate a band."""
    s = str(value or "").strip().upper()
    if not s:
        return None
    if re.match(r"^\d+$", s):
        return int(s)
    if re.match(r"^[A-Z]+$", s):
        n = 0
        for ch in s:
            n = n * 26 + (ord(ch) - 64)
        return n
    m = re.match(r"^\d+", s)
    if m:
        return int(m.group(0))
    m = re.match(r"^[A-Z]+", s)
    if m:
        n = 0
        for ch in m.group(0):
            n = n * 26 + (ord(ch) - 64)
        return n
    return None


def validate_category_rows(rows):
    """The same invariants tests/tiers.test.js checks on the generated file,
    enforced here where the error can name a line number instead of a venue."""
    problems = []
    by_section = {}
    for r in rows:
        if r["section"]:
            by_section.setdefault((r["venue"], r["section"]), []).append(r)

    for (venue, section), group in sorted(by_section.items()):
        catch_alls = [r for r in group if not r["row_from"] and not r["row_to"]]
        if len(catch_alls) > 1:
            problems.append(
                "%s / section %s: %d catch-all rows (lines %s) - only the first would "
                "ever apply, so give the others a row range or delete them"
                % (venue, section, len(catch_alls),
                   ", ".join(str(r["line"]) for r in catch_alls)))

        numeric = lettered = 0
        for r in group:
            for end in ("row_from", "row_to"):
                v = r[end]
                if v is None:
                    continue
                if row_rank(v) is None:
                    problems.append("%s / section %s line %d: %s %r cannot be ranked "
                                    "as a row" % (venue, section, r["line"], end, v))
                    continue
                if re.match(r"^\d", v.strip()):
                    numeric += 1
                else:
                    lettered += 1
        if numeric and lettered:
            problems.append(
                "%s / section %s: mixes numeric and lettered row bands - "
                "row 5 versus row E has no meaningful order" % (venue, section))

        for r in group:
            lo, hi = row_rank(r["row_from"]), row_rank(r["row_to"])
            if lo is not None and hi is not None and lo > hi:
                problems.append("%s / section %s line %d: row band %s-%s runs backwards"
                                % (venue, section, r["line"], r["row_from"], r["row_to"]))

    # One category should not claim two different sort positions.
    sorts = {}
    for r in rows:
        if r["sort"] is None:
            continue
        key = (r["venue"], r["tier"])
        if key in sorts and sorts[key][0] != r["sort"]:
            problems.append("%s / %r: sort given as both %d (line %d) and %d (line %d)"
                            % (r["venue"], r["tier"], sorts[key][0], sorts[key][1],
                               r["sort"], r["line"]))
        else:
            sorts.setdefault(key, (r["sort"], r["line"]))

    return problems


def read_categories_csv(path):
    """Parse a category CSV.

    Returns (rows, problems). A file with any problem is refused rather than
    half-imported: a silently dropped row is worse than a failed import.
    """
    rows, problems = [], []
    if not os.path.exists(path):
        return rows, problems

    with io.open(path, encoding="utf-8-sig", newline="") as fh:
        raw = fh.read().split("\n")

    header = None
    for lineno, line in enumerate(raw, 1):
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        fields = [f.strip() for f in next(csv.reader([line]))]

        if header is None:
            lowered = [f.lower() for f in fields]
            if "venue" not in lowered or "tier" not in lowered:
                problems.append("line %d: expected a header row containing at least "
                                "'venue' and 'tier', got: %s" % (lineno, ", ".join(fields)))
                return [], problems
            unknown = [f for f in lowered if f and f not in CSV_COLUMNS]
            if unknown:
                problems.append("line %d: unknown column(s): %s (known: %s)"
                                % (lineno, ", ".join(unknown), ", ".join(CSV_COLUMNS)))
                return [], problems
            header = lowered
            continue

        record = {}
        for i, name in enumerate(header):
            if name:
                record[name] = fields[i] if i < len(fields) else ""
        for name in CSV_COLUMNS:
            record.setdefault(name, "")

        venue = norm_venue(record["venue"])
        tier = record["tier"].strip()
        if not venue:
            problems.append("line %d: no venue" % lineno)
            continue
        if not tier:
            problems.append("line %d: no tier" % lineno)
            continue

        section = norm_sec(record["section"])
        row_from = record["row_from"].strip() or None
        row_to = record["row_to"].strip() or None

        if not section and (row_from or row_to):
            problems.append("line %d: row band given without a section" % lineno)
            continue

        sort = None
        if record["sort"].strip():
            try:
                sort = int(record["sort"].strip())
            except ValueError:
                problems.append("line %d: sort %r is not a whole number"
                                % (lineno, record["sort"]))
                continue

        rows.append({"venue": venue, "section": section, "row_from": row_from,
                     "row_to": row_to, "tier": tier, "sort": sort, "line": lineno})

    problems.extend(validate_category_rows(rows))
    return rows, problems


def write_categories_csv(path, rows):
    """Rewrite the store, sorted, with the preamble that explains it."""
    def sort_key(r):
        return (r["venue"], r["section"] == "", r["section"],
                row_rank(r["row_from"]) if r["row_from"] else -1, r["tier"])

    lines = [
        "# Venue categories - hand-maintained source, merged on top of the",
        "# TicketPortal export by tools/build_venue_tiers.py.",
        "#",
        "# See tools/venue_categories.sample.csv for the format and what each",
        "# column means. Edit this file directly, or merge another file in with:",
        "#     python tools/build_venue_tiers.py --import <file.csv>",
        "# Then rebuild:",
        "#     python tools/build_venue_tiers.py",
        "",
        ",".join(CSV_COLUMNS),
    ]
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    for r in sorted(rows, key=sort_key):
        writer.writerow([r["venue"], r["section"], r["row_from"] or "",
                         r["row_to"] or "", r["tier"],
                         "" if r["sort"] is None else r["sort"]])
    with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines) + "\n" + out.getvalue())


def import_categories(source):
    """Merge `source` into the category store. A venue+section named in the
    source REPLACES whatever the store held for it, so re-importing a corrected
    file updates rather than accumulating. Sections not mentioned are kept."""
    if not os.path.exists(source):
        print("No such file: " + source)
        return 2

    incoming, problems = read_categories_csv(source)
    if problems:
        print("Refusing to import %s - %d problem(s):" % (source, len(problems)))
        for problem in problems:
            print("  - " + problem)
        return 1
    if not incoming:
        print("%s has no category rows." % source)
        return 1

    existing, existing_problems = read_categories_csv(CATEGORIES_CSV)
    if existing_problems:
        print("The existing store %s has problems; fix it first:" % CATEGORIES_CSV)
        for problem in existing_problems:
            print("  - " + problem)
        return 1

    replaced = set((r["venue"], r["section"]) for r in incoming if r["section"])
    order_venues = set(r["venue"] for r in incoming if not r["section"])

    kept = [r for r in existing
            if not ((r["venue"], r["section"]) in replaced
                    or (not r["section"] and r["venue"] in order_venues))]

    merged = kept + incoming
    write_categories_csv(CATEGORIES_CSV, merged)

    print("Imported %d row(s) from %s" % (len(incoming), os.path.basename(source)))
    print("  venues:   %s" % ", ".join(sorted(set(r["venue"] for r in incoming))))
    print("  sections: %d replaced, %d row(s) in the store now"
          % (len(replaced), len(merged)))
    print("")
    print("Now run:  python tools/build_venue_tiers.py")
    return 0


def build():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", action="append", default=[],
                        help="canonical venue to keep (repeatable)")
    parser.add_argument("--stats", action="store_true",
                        help="print per-venue rule counts and stop")
    parser.add_argument("--import", dest="import_file", metavar="FILE",
                        help="merge a category CSV into tools/venue_categories.csv, "
                             "then stop (see venue_categories.sample.csv)")
    args = parser.parse_args()

    if args.import_file:
        return import_categories(args.import_file)

    curated = load_json(ALIASES, "curated aliases")
    if curated is None:
        return 2

    categories, category_problems = read_categories_csv(CATEGORIES_CSV)
    if category_problems:
        print("%s has %d problem(s) - not building:" % (CATEGORIES_CSV, len(category_problems)))
        for problem in category_problems:
            print("  - " + problem)
        return 1

    # The TicketPortal export is optional once categories are maintained by
    # hand: a venue that only exists in the CSV should still build.
    if os.path.exists(EXPORT):
        export = load_json(EXPORT, "TicketPortal export")
        if export is None:
            return 2
    elif categories:
        export = {}
        print("No TicketPortal export - building from %s alone."
              % os.path.basename(CATEGORIES_CSV))
    else:
        print("Nothing to build from.")
        print("")
        print("Either run tools/export_venue_tiers.sql in the TicketPortal project's")
        print("SQL editor and save the single result cell to:")
        print("  " + EXPORT)
        print("or create a category CSV - copy the sample to get started:")
        print("  copy %s %s" % (os.path.basename(SAMPLE_CSV), os.path.basename(CATEGORIES_CSV)))
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

    # ── hand-maintained categories win ───────────────────────────────────────
    # Applied after the export so a correction here beats the database. A venue
    # and section named in the CSV REPLACES the export's rules for that section
    # outright rather than adding to them, which is the only way to fix a wrong
    # mapping rather than stack a second one on top of it.
    # A hand-written "Memorial Stadium" must land on the export's
    # "memorial stadium - ne", not create a second venue beside it. tiers.js
    # resolves that at runtime by base name; without the same rule here, the
    # smaller CSV entry would win the exact-match lookup and shadow the 122
    # curated sections. Mirrors venueKey()'s base-name step, including its
    # refusal to guess when the base is ambiguous.
    base_index = {}
    for key in list(sections) + list(tiers):
        cut = key.rfind(" - ")
        if cut > 0:
            base_index.setdefault(key[:cut].strip(), set()).add(key)

    def resolve_csv_venue(name):
        key = canonical(name)
        if key in sections or key in tiers:
            return key
        hits = base_index.get(key)
        if hits and len(hits) == 1:
            return next(iter(hits))
        if hits and len(hits) > 1:
            print("warning: %r matches %d venues (%s) - left as its own entry"
                  % (name, len(hits), ", ".join(sorted(hits))))
        return key

    csv_sections = {}
    csv_sorts = {}
    for r in categories:
        key = resolve_csv_venue(r["venue"])
        if r["section"]:
            csv_sections.setdefault(key, {}).setdefault(r["section"], []).append(
                {"from": r["row_from"], "to": r["row_to"], "tier": r["tier"]})
        if r["sort"] is not None:
            csv_sorts.setdefault(key, {})[r["tier"]] = r["sort"]

    csv_rule_count = 0
    for key, section_map in csv_sections.items():
        target = sections.setdefault(key, {})
        for section, rules in section_map.items():
            target[section] = rules
            csv_rule_count += len(rules)

    for key, tier_sorts in csv_sorts.items():
        existing = {t["tier"]: t for t in tiers.get(key, [])}
        for tier_name, sort_value in tier_sorts.items():
            existing[tier_name] = {"tier": tier_name, "sort": sort_value}
        tiers[key] = sorted(existing.values(),
                            key=lambda r: (r["sort"] is None, r["sort"], r["tier"]))

    # Categories can name a venue the export never mentioned; make sure it is
    # not left with an empty mapping.
    for key in list(sections):
        if not sections[key]:
            sections.pop(key)

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

    # The same data as JSON, for the runtime fetch. Committing and pushing this
    # is what publishes a mapping change to everyone; the extension picks it up
    # on next load without a new release.
    shared = {
        "version": 1,
        "aliases": aliases,
        "tiers": tiers,
        "sections": sections,
    }
    with io.open(SHARED, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(shared, fh, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        fh.write("\n")

    print("Wrote %s" % os.path.relpath(TARGET, ROOT))
    print("Wrote %s  (%.0f KB) — commit and push to publish to every install"
          % (os.path.relpath(SHARED, ROOT), os.path.getsize(SHARED) / 1024.0))
    print("  aliases  %d (%d curated)" % (len(aliases), curated_count))
    print("  tiers    %d venues" % len(tiers))
    print("  sections %d venues, %d sections, %d rules (%d row bands)"
          % (len(sections), sum(len(m) for m in sections.values()), rule_total, band_total))
    if categories:
        print("  hand-maintained %d rule(s) across %d venue(s) from %s"
              % (csv_rule_count, len(csv_sections), os.path.basename(CATEGORIES_CSV)))
    if dropped_empty:
        print("  skipped  %d section rows that normalized to an empty key" % dropped_empty)
    report_conflicts(conflicts)
    print("")
    print("Now run:  python tests/run.py")
    return 0


if __name__ == "__main__":
    sys.exit(build())
