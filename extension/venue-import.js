// Venue category import — CSV parsing and overlay, for the popup's Import button.
//
// A JS mirror of tools/build_venue_tiers.py's CSV reader, so the same file is
// accepted or rejected identically whether it goes through the build script or
// the extension. The format is documented in tools/venue_categories.sample.csv.
//
// Imported categories live in chrome.storage.local under `userVenueCategories`
// and are layered OVER the shipped venue-tiers.js at runtime. Nothing is
// written back to the shipped file: a rebuild from the TicketPortal export
// cannot clobber an import, and clearing an import restores the shipped data
// exactly.
//
// Load order: after venue-tiers.js and tiers.js, both of which this uses.

(function (root) {
  "use strict";

  const COLUMNS = ["venue", "section", "row_from", "row_to", "tier", "sort"];

  // Compound map keys join a venue and a section. Venue names contain spaces,
  // so a space-joined key cannot be split back apart correctly — "lane stadium
  // 101" would cut in the wrong place. Unit Separator never appears in either.
  const SEP = String.fromCharCode(31);

  // ── CSV ──────────────────────────────────────────────────────────────────
  // Enough of RFC 4180 for real spreadsheet exports: quoted fields, escaped
  // quotes inside them, and commas or newlines within quotes.
  function splitCsvLine(line) {
    const out = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') { field += '"'; i++; }
          else quoted = false;
        } else field += ch;
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ",") {
        out.push(field);
        field = "";
      } else {
        field += ch;
      }
    }
    out.push(field);
    return out.map((f) => f.trim());
  }

  // Mirror of rowRank() in tiers.js, used to validate a band.
  function rowRank(value) {
    return root.VenueTiers ? root.VenueTiers.rowRank(value) : null;
  }

  function parse(text) {
    const rows = [];
    const problems = [];
    const lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");

    let header = null;
    for (let i = 0; i < lines.length; i++) {
      const lineno = i + 1;
      const raw = lines[i];
      const trimmed = raw.trim();
      if (!trimmed || trimmed.charAt(0) === "#") continue;

      const fields = splitCsvLine(raw);

      if (!header) {
        const lowered = fields.map((f) => f.toLowerCase());
        if (lowered.indexOf("venue") < 0 || lowered.indexOf("tier") < 0) {
          problems.push(`line ${lineno}: expected a header row containing at least ` +
            `"venue" and "tier", got: ${fields.join(", ")}`);
          return { rows: [], problems };
        }
        const unknown = lowered.filter((f) => f && COLUMNS.indexOf(f) < 0);
        if (unknown.length) {
          problems.push(`line ${lineno}: unknown column(s): ${unknown.join(", ")} ` +
            `(known: ${COLUMNS.join(", ")})`);
          return { rows: [], problems };
        }
        header = lowered;
        continue;
      }

      const record = {};
      header.forEach((name, idx) => {
        if (name) record[name] = idx < fields.length ? fields[idx] : "";
      });
      COLUMNS.forEach((name) => { if (record[name] === undefined) record[name] = ""; });

      const venue = root.VenueTiers.normVenue(record.venue);
      const tier = String(record.tier || "").trim();
      if (!venue) { problems.push(`line ${lineno}: no venue`); continue; }
      if (!tier) { problems.push(`line ${lineno}: no tier`); continue; }

      const section = root.VenueTiers.normSec(record.section);
      const rowFrom = String(record.row_from || "").trim() || null;
      const rowTo = String(record.row_to || "").trim() || null;

      if (!section && (rowFrom || rowTo)) {
        problems.push(`line ${lineno}: row band given without a section`);
        continue;
      }

      let sort = null;
      const sortRaw = String(record.sort || "").trim();
      if (sortRaw) {
        if (!/^-?\d+$/.test(sortRaw)) {
          problems.push(`line ${lineno}: sort "${sortRaw}" is not a whole number`);
          continue;
        }
        sort = parseInt(sortRaw, 10);
      }

      rows.push({ venue, section, from: rowFrom, to: rowTo, tier, sort, line: lineno });
    }

    if (!header) problems.push("no header row found");
    problems.push.apply(problems, validate(rows));
    return { rows, problems };
  }

  // The invariants tests/tiers.test.js checks on the generated file, applied
  // here where the error can name a line instead of a venue.
  function validate(rows) {
    const problems = [];
    const bySection = new Map();
    rows.forEach((r) => {
      if (!r.section) return;
      const key = r.venue + SEP + r.section;
      if (!bySection.has(key)) bySection.set(key, []);
      bySection.get(key).push(r);
    });

    bySection.forEach((group, key) => {
      const [venue, section] = key.split(SEP);

      const catchAlls = group.filter((r) => !r.from && !r.to);
      if (catchAlls.length > 1) {
        problems.push(`${venue} / section ${section}: ${catchAlls.length} catch-all rows ` +
          `(lines ${catchAlls.map((r) => r.line).join(", ")}) — only the first would ever ` +
          `apply, so give the others a row range or delete them`);
      }

      let numeric = 0;
      let lettered = 0;
      group.forEach((r) => {
        ["from", "to"].forEach((end) => {
          const v = r[end];
          if (v == null) return;
          if (rowRank(v) == null) {
            problems.push(`${venue} / section ${section} line ${r.line}: ` +
              `${end === "from" ? "row_from" : "row_to"} "${v}" cannot be ranked as a row`);
            return;
          }
          if (/^\d/.test(v)) numeric++; else lettered++;
        });
        const lo = rowRank(r.from);
        const hi = rowRank(r.to);
        if (lo != null && hi != null && lo > hi) {
          problems.push(`${venue} / section ${section} line ${r.line}: ` +
            `row band ${r.from}-${r.to} runs backwards`);
        }
      });
      if (numeric && lettered) {
        problems.push(`${venue} / section ${section}: mixes numeric and lettered row ` +
          `bands — "row 5" versus "row E" has no meaningful order`);
      }
    });

    const sorts = new Map();
    rows.forEach((r) => {
      if (r.sort == null) return;
      const key = r.venue + SEP + r.tier;
      const prev = sorts.get(key);
      if (prev && prev.sort !== r.sort) {
        problems.push(`${r.venue} / "${r.tier}": sort given as both ${prev.sort} ` +
          `(line ${prev.line}) and ${r.sort} (line ${r.line})`);
      } else if (!prev) {
        sorts.set(key, { sort: r.sort, line: r.line });
      }
    });

    return problems;
  }

  // ── overlay ──────────────────────────────────────────────────────────────
  // Build a fresh VENUE_TIER_DATA with the imported rows layered on top of
  // `base`. Never mutates `base`: clearing an import must restore it exactly,
  // and tiers.js keys its caches on object identity, so a new object is also
  // what makes the change take effect.
  function applyOverlay(base, rows) {
    const source = base || { aliases: {}, tiers: {}, sections: {} };
    if (!rows || !rows.length) return source;

    const merged = {
      version: source.version,
      aliases: source.aliases || {},
      tiers: {},
      sections: {},
    };
    Object.keys(source.tiers || {}).forEach((k) => { merged.tiers[k] = source.tiers[k]; });
    Object.keys(source.sections || {}).forEach((k) => {
      merged.sections[k] = Object.assign({}, source.sections[k]);
    });

    // Resolve each imported venue name the same way a live page's venue is
    // resolved, so "Memorial Stadium" lands on an existing
    // "memorial stadium - ne" instead of creating a second venue that would
    // then shadow it on an exact-match lookup.
    const previous = root.VENUE_TIER_DATA;
    root.VENUE_TIER_DATA = source;
    const keyFor = {};
    rows.forEach((r) => {
      if (keyFor[r.venue] === undefined) keyFor[r.venue] = root.VenueTiers.venueKey(r.venue);
    });
    root.VENUE_TIER_DATA = previous;

    // A venue+section named in the import REPLACES what was there, rather than
    // adding to it — otherwise a correction stacks a second rule beside the
    // wrong one instead of fixing it.
    const touched = new Set();
    rows.forEach((r) => {
      if (!r.section) return;
      const key = keyFor[r.venue];
      if (!merged.sections[key]) merged.sections[key] = {};
      const seen = key + SEP + r.section;
      if (!touched.has(seen)) {
        touched.add(seen);
        merged.sections[key][r.section] = [];
      }
      merged.sections[key][r.section].push({ from: r.from, to: r.to, tier: r.tier });
    });

    rows.forEach((r) => {
      if (r.sort == null) return;
      const key = keyFor[r.venue];
      const list = (merged.tiers[key] || []).slice();
      const at = list.findIndex((t) => t.tier === r.tier);
      if (at >= 0) list[at] = { tier: r.tier, sort: r.sort };
      else list.push({ tier: r.tier, sort: r.sort });
      list.sort((a, b) => (a.sort == null) - (b.sort == null) ||
                          a.sort - b.sort ||
                          String(a.tier).localeCompare(String(b.tier)));
      merged.tiers[key] = list;
    });

    return merged;
  }

  // A short human summary of what an import covers, for the popup.
  function summarize(rows) {
    const venues = new Set();
    const sections = new Set();
    let bands = 0;
    let ordering = 0;
    rows.forEach((r) => {
      venues.add(r.venue);
      if (r.section) sections.add(r.venue + SEP + r.section); else ordering++;
      if (r.from || r.to) bands++;
    });
    return {
      venues: venues.size,
      sections: sections.size,
      rules: rows.length - ordering,
      bands,
      ordering,
      venueNames: [...venues].sort(),
    };
  }

  root.VenueImport = { parse, applyOverlay, summarize, COLUMNS };
})(typeof self !== "undefined" ? self : this);
