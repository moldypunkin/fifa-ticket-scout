// Seat-tier mapping — ported from the TicketPortal ticketboard venue tiering.
//
// Turns a marketplace's free-text section ("Section 315", "FLOOR GA", "KU:101")
// into a stable seating tier so listings can be compared across sites. On the
// FIFA sites `category` is already real (CAT 1/2/3/4); everywhere else the
// adapters stamp a constant ("resale", "primary", "standard"), which is what
// this replaces as a grouping axis.
//
// The tier lands in a PARALLEL `tier` field. `category` is never overwritten.
//
// Naming note: `TIERS` in background.js means LICENSE tiers. Everything here is
// namespaced under `VenueTiers` and talks about SEAT tiers. Do not conflate.
//
// Resolution order, per tierFor():
//   1. a saved whole-section rule for this venue          (venue-tiers.js)
//   2. a saved row-band rule whose range contains the row (venue-tiers.js)
//   3. the tierOf() section-text heuristic                (always available)
// So the file of saved mappings can be empty and this still returns something
// useful for every listing.

(function (root) {
  "use strict";

  // Stadium-inward order. Drives tab order in the popup, not just sorting.
  const TIER_ORDER = [
    "Floor / GA",
    "Orchestra",
    "Lower (100s)",
    "Club / Mezz (200s)",
    "Mezzanine",
    "Upper (300s)",
    "Balcony",
    "Upper (400+)",
    "Other",
  ];

  // Infer a seating tier from section text alone. Pure heuristic — top match
  // wins. Nothing is hidden by a wrong guess: the block-by-block table still
  // shows the real section.
  function tierOf(section) {
    const s = (section || "").toString().trim().toUpperCase();
    if (!s) return "Other";
    if (/\bGA\b|FLOOR|FLR|PIT|GENERAL/.test(s)) return "Floor / GA";
    if (/ORCH/.test(s)) return "Orchestra";
    if (/MEZZ/.test(s)) return "Mezzanine";
    if (/BALC/.test(s)) return "Balcony";
    const m = s.match(/\d{3,}/);
    if (m) {
      const n = parseInt(m[0], 10);
      if (n >= 100 && n < 200) return "Lower (100s)";
      if (n >= 200 && n < 300) return "Club / Mezz (200s)";
      if (n >= 300 && n < 400) return "Upper (300s)";
      if (n >= 400)            return "Upper (400+)";
    }
    return "Other";
  }

  function tierIndex(t) {
    const i = TIER_ORDER.indexOf(t);
    return i < 0 ? 99 : i;
  }

  // ── normalization ────────────────────────────────────────────────────────
  const NORM_SEC = new Map();

  function normVenue(v) {
    return (v || "").toString().toLowerCase().replace(/\s+/g, " ").trim();
  }

  // "Section 315" / "SEC 315" / "315" all collapse to "315". Memoized because
  // this runs once per seat and a full scan is tens of thousands of seats.
  function normSec(s) {
    const k = s == null ? "" : String(s);
    let v = NORM_SEC.get(k);
    if (v === undefined) {
      v = k.toUpperCase().replace(/\bSECTIONS?\b|\bSEC\b/g, "").replace(/\s+/g, " ").trim();
      NORM_SEC.set(k, v);
    }
    return v;
  }

  // FIFA calls venues by tournament names ("Dallas Stadium"); marketplaces use
  // the sponsored name ("AT&T Stadium"). The alias table folds both onto one key.
  //
  // Marketplaces also tack a city onto the venue ("Arrowhead Stadium, Kansas
  // City, MO", "Bobby Dodd Stadium Atlanta, GA" — the second shape appears in
  // TicketPortal's own venue rows). An exact lookup misses those, and the miss
  // is silent: tierFor just falls back to the heuristic and the curated
  // mapping never runs. So after the exact match fails, drop trailing
  // comma-separated fragments, then try the longest known venue key this name
  // starts with.
  //
  // Memoized: this runs once per seat, and a full scan is tens of thousands.
  const VENUE_KEY = new Map();

  function venueKeyUncached(n) {
    if (!n) return n;
    const data = root.VENUE_TIER_DATA || {};
    const alias = data.aliases || {};
    const known = data.sections || {};

    if (alias[n]) return alias[n];
    if (known[n]) return n;

    // "arrowhead stadium, kansas city, mo" -> "arrowhead stadium, kansas city"
    //                                      -> "arrowhead stadium"
    const parts = n.split(",");
    for (let i = parts.length - 1; i > 0; i--) {
      const head = parts.slice(0, i).join(",").trim();
      if (alias[head]) return alias[head];
      if (known[head]) return head;
    }

    // No separator at all ("bobby dodd stadium atlanta, ga"): longest known
    // key that this name starts with. Require a word boundary so "lane
    // stadium" cannot swallow "lane stadium annex".
    let best = "";
    const consider = (k) => {
      if (k.length > best.length && n.indexOf(k + " ") === 0) best = k;
    };
    Object.keys(known).forEach(consider);
    Object.keys(alias).forEach(consider);
    if (best) return alias[best] || best;

    return n;
  }

  // The cache is keyed to the data object it was built from, so swapping
  // VENUE_TIER_DATA (tests do; a future hot-reload might) cannot serve stale
  // keys. In the extension the data never changes and this never fires.
  let VENUE_KEY_SOURCE = null;

  function venueKey(v) {
    const data = root.VENUE_TIER_DATA || null;
    if (data !== VENUE_KEY_SOURCE) {
      VENUE_KEY.clear();
      VENUE_KEY_SOURCE = data;
    }
    const n = normVenue(v);
    let hit = VENUE_KEY.get(n);
    if (hit === undefined) {
      hit = venueKeyUncached(n);
      VENUE_KEY.set(n, hit);
    }
    return hit;
  }

  // Why a venue did or did not pick up its curated mapping. Logged once per
  // scan by background.js; the silent-fallback case is otherwise invisible.
  function diagnose(venue) {
    const data = root.VENUE_TIER_DATA || {};
    const key = venueKey(venue);
    const map = (data.sections || {})[key];
    return {
      venue: venue == null ? null : String(venue),
      key: key,
      matched: !!(map && Object.keys(map).length),
      sections: map ? Object.keys(map).length : 0,
    };
  }

  // Order a seat row for range checks: numeric ("1".."30") by value, lettered
  // ("A".."Z","AA") base-26. Null when unrankable. Within a section rows are one
  // type, and a band's from/to match that type.
  function rowRank(row) {
    const s = String(row == null ? "" : row).trim().toUpperCase();
    if (!s) return null;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (/^[A-Z]+$/.test(s)) {
      let n = 0;
      for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
      return n;
    }
    const d = /^\d+/.exec(s);
    if (d) return parseInt(d[0], 10);                       // "12A" -> 12
    const a = /^[A-Z]+/.exec(s);
    if (a) {
      let n = 0;
      for (let i = 0; i < a[0].length; i++) n = n * 26 + (a[0].charCodeAt(i) - 64);
      return n;
    }
    return null;
  }

  // Sort rows by seating DEPTH, not alphabetically: A–Z first, then AA, BB, CC…
  // (double-letter rows sit BEHIND single letters — that is how some venues
  // number them). rowRank already scores AA(27) after Z(26); this wraps it into
  // a comparator, with unrankable rows falling back to a numeric-aware string
  // compare and sorting after the ranked ones.
  function rowCmp(a, b) {
    const ra = rowRank(a), rb = rowRank(b);
    if (ra != null && rb != null) {
      return ra - rb ||
        String(a == null ? "" : a).localeCompare(String(b == null ? "" : b), undefined, { numeric: true });
    }
    if (ra != null) return -1;
    if (rb != null) return 1;
    return String(a == null ? "" : a).localeCompare(String(b == null ? "" : b), undefined, { numeric: true });
  }

  // ── resolution ───────────────────────────────────────────────────────────
  // The tier for one listing. Saved mapping wins; row-band rules pick by row;
  // else the heuristic. Never throws and never returns empty.
  function tierFor(venue, section, row) {
    const data = root.VENUE_TIER_DATA || {};
    const m = (data.sections || {})[venueKey(venue)];
    if (m) {
      const rules = m[normSec(section)];
      if (rules && rules.length) {
        // whole-section mapping (a single rule with no row range)
        if (rules.length === 1 && rules[0].from == null && rules[0].to == null) {
          return rules[0].tier;
        }
        const rr = rowRank(row);
        if (rr != null) {
          for (let i = 0; i < rules.length; i++) {
            const r = rules[i];
            if (r.from != null || r.to != null) {
              const lo = r.from != null ? rowRank(r.from) : -Infinity;
              const hi = r.to   != null ? rowRank(r.to)   :  Infinity;
              if (lo != null && hi != null && rr >= lo && rr <= hi) return r.tier;
            }
          }
        }
        // a row we could not rank, or one outside every band, falls to the
        // section's catch-all rule if it has one
        const whole = rules.find((r) => r.from == null && r.to == null);
        if (whole) return whole.tier;
      }
    }
    return tierOf(section);
  }

  // Order tiers within a venue: saved sort first, else the default TIER_ORDER,
  // else last.
  function tierRank(venue, tierName) {
    const data = root.VENUE_TIER_DATA || {};
    const list = (data.tiers || {})[venueKey(venue)];
    if (list) {
      const hit = list.find((t) => t.tier === tierName);
      if (hit) return hit.sort;
    }
    const i = TIER_ORDER.indexOf(tierName);
    return i < 0 ? 1e6 : i;
  }

  // Tier names may follow the "Cat A - LL Chiefs Center 3" convention — show the
  // short "Cat A" with the full name on hover. Delimiter is " - " (space-hyphen-
  // space); names without it show whole.
  function tierAbbrev(name) {
    const s = String(name == null ? "" : name);
    const i = s.indexOf(" - ");
    return i >= 0 ? s.slice(0, i).trim() : s;
  }

  // True when this venue has real saved mappings, i.e. tierFor is doing better
  // than the bare heuristic.
  function hasVenueMapping(venue) {
    const data = root.VENUE_TIER_DATA || {};
    const m = (data.sections || {})[venueKey(venue)];
    return !!(m && Object.keys(m).length);
  }

  root.VenueTiers = {
    TIER_ORDER,
    tierOf,
    tierIndex,
    tierFor,
    tierRank,
    tierAbbrev,
    hasVenueMapping,
    diagnose,
    normVenue,
    normSec,
    venueKey,
    rowRank,
    rowCmp,
  };
})(typeof self !== "undefined" ? self : this);
