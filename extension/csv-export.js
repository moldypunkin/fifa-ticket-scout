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
    const header = "Block,Area,Row,Seat,Seat_Range,Category,Tier,Price_USD,Exclusive";
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
        return `${s.block},${area},${s.row},${s.seat},${s.seatRange || ""},${s.category},${tierCell},${o.priceUSD(s.price).toFixed(2)},${s.exclusive}`;
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
})(typeof self !== "undefined" ? self : this);
