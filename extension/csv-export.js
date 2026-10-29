// The CSV export, as one function both callers share.
//
// The popup's "Download CSV" button and the background's auto-pull (a
// TicketPortal "⇣ Pull") must write the SAME file — the portal parses its
// header block and columns, so two hand-kept copies drifting apart would
// break its import without anything erroring here. Everything that depends on
// where it runs (the fee maths, the filename tag, the tier lookup) is passed
// in rather than read from a global, so this file has no context of its own.
//
// Plain ES2017, no ?. or ??: the node-12 test runner evaluates it as-is.
(function (root) {
  "use strict";

  // PRIMARY or RESALE for one seat, written as the export's Type column so TicketPortal does not have to
  // interpret Category, which means something different on every site. Returns "primary", "resale" or ""
  // (unknown, never a guess; the portal leaves unknown out of its "Primary only" shadow suggestions).
  //   ticketmaster / axs  sell both: Category "resale" is resale; anything else is the seller's own
  //                       primary inventory (Ticketmaster's "standard", Account Manager's "primary",
  //                       an AXS offer category)
  //   seatgeek            the primary seller for SOME teams, so per listing from its channel field (m):
  //                       exchange / marketplace / fan_to_fan are resale (all that 20 exports held,
  //                       2026-10-29); a value containing "primary" is primary; anything new is unknown
  //   lms, evenue, rutheckerd   FIFA Last Minute Sales and venue box offices: primary
  //   resale (FIFA resale) and the marketplaces: resale
  const PRIMARY_SITES = { lms: 1, evenue: 1, rutheckerd: 1 };
  const MIXED_SITES = { ticketmaster: 1, axs: 1 };
  const RESALE_SITES = { resale: 1, stubhub: 1, tickpick: 1, vividseats: 1, gametime: 1, gotickets: 1, ticketsforless: 1 };
  const SG_RESALE = { exchange: 1, marketplace: 1, fan_to_fan: 1 };
  function listingType(site, category) {
    const st = String(site || "").toLowerCase();
    const c = String(category == null ? "" : category).trim().toLowerCase();
    if (st === "seatgeek") return /primary/.test(c) ? "primary" : SG_RESALE[c] ? "resale" : "";
    if (MIXED_SITES[st]) return /resale/.test(c) ? "resale" : c ? "primary" : "";
    if (PRIMARY_SITES[st]) return "primary";
    if (RESALE_SITES[st]) return "resale";
    return "";
  }

  // game: one entry of chrome.storage.local.games
  // opts: { gameKey, now: Date, priceUSD(cents), tierFor(venue, block, row),
  //         fileTag(site), auto: bool }
  // Returns { csv, filename, count }, or null when there is nothing to export.
  function buildScoutCsv(game, opts) {
    if (!game) return null;
    const o = opts || {};
    const seats = Object.values(game.seats || {}).filter((s) => s.exclusive !== false && s.price != null);
    if (seats.length === 0) return null;

    const match = game.match || null;
    const m = match || {};
    const now = o.now || new Date();
    const exportTime = now.toISOString();

    const meta = [
      `# Match: ${m.name || "Unknown"}`,
      `# Date: ${m.date || "Unknown"}`,
      // Only FIFA folds the venue into `name`; Ticketmaster keeps it separate,
      // so surface it rather than losing it from the export.
      ...(m.venue ? [`# Venue: ${m.venue}`] : []),
      `# Currency: ${m.currency || "USD"}`,
      `# Site: ${game.site || "resale"}`,
      `# Performance ID: ${m.performanceId || o.gameKey}`,
      `# Exported: ${exportTime}`,
      `# Total Seats: ${seats.length}`,
      // Says the file was written by an auto-pull rather than the button, so
      // the portal can tell which path a file came down.
      ...(o.auto ? ["# Auto: yes"] : []),
    ];

    // Seat_Range carries StubHub listings whose seats could not be enumerated
    // (e.g. 3 tickets across 13-18). Empty for every other site and for rows
    // that do have a seat number.
    // Tier is the cross-site seating band from tiers.js. On the FIFA sites
    // Category is the real CAT 1/2/3/4 and Tier sits alongside it; on the
    // marketplaces Category is a constant and Tier is the useful column.
    // Type (primary / resale / blank) is LAST so a reader keyed on column position is undisturbed.
    const header = "Block,Area,Row,Seat,Seat_Range,Category,Tier,Price_USD,Exclusive,Type";
    const rows = seats
      .sort((a, b) =>
        a.price - b.price
        || a.block.localeCompare(b.block, undefined, { numeric: true })
        || a.row.localeCompare(b.row, undefined, { numeric: true })
        || a.seat.localeCompare(b.seat, undefined, { numeric: true })
      )
      .map((s) => {
        const area = s.area.includes(",") ? `"${s.area}"` : s.area;
        // Recomputed, not read from s.tier — see renderCategorySections: the
        // stored value is a scan-time snapshot and goes stale when the shipped
        // venue mapping changes.
        const tier = o.tierFor(m.venue, s.block, s.row);
        const tierCell = tier.includes(",") ? `"${tier}"` : tier;
        return `${s.block},${area},${s.row},${s.seat},${s.seatRange || ""},${s.category},${tierCell},${o.priceUSD(s.price).toFixed(2)},${s.exclusive},${listingType(s.site || game.site, s.category)}`;
      });

    const csv = [...meta, "", header, ...rows].join("\n");

    const matchName = m.name ? m.name.replace(/[^a-zA-Z0-9]/g, "_") : "seats";
    const pad = (n) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
    // Site first: exports from several sites for the same match then sort
    // together by source rather than interleaving.
    const filename = `${o.fileTag(game.site)}_${matchName}_${ts}.csv`;

    return { csv, filename, count: seats.length };
  }

  root.buildScoutCsv = buildScoutCsv;
  root.scoutListingType = listingType;
})(typeof self !== "undefined" ? self : this);
