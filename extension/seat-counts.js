// One stored seat record can stand for more than one ticket.
//
// Some inventory is published as a section and a count with no seats named at
// all: a Ticketmaster GA section, or a resale listing that discloses none. The
// tickets in one of those are indistinguishable — same block, same price, no
// row, no seat number — so storing one record per ticket wrote N identical
// copies, and the only thing they carried that a count does not was their own
// weight. chrome.storage.local has about 10MB and the manifest asks for no
// unlimitedStorage permission, so a 5,000-seat GA section is 5,000 records
// spent on one line of output.
//
// The parser now stores ONE record carrying `count`, and every reader expands
// it back to `count` rows here, at the point of use. Everything downstream —
// the stats bar, the histogram, the median, the deal scoring, the block table,
// the section filter and the CSV — goes on seeing a flat array with one object
// per ticket, so none of them needed changing and none of them can drift out
// of agreement with the others.
//
// A record with no `count` is one ticket, which is every other source and
// every record written before this existed.
//
// Plain ES2017, no ?. or ??: the node-12 test runner evaluates it as-is.
(function (root) {
  "use strict";

  // A bound on what one record may become, so a malformed count cannot hang
  // the popup trying to draw ten million rows. It is far above any real GA
  // allocation — the largest stadium on any of these sites seats under
  // 110,000 and a single GA facet is a fraction of that — and it bounds only
  // the expansion. The record keeps the true count either way, and
  // expandSeatCounts reports anything it had to truncate rather than
  // quietly shortening it, which is the mistake the 200 clamp made.
  var MAX_EXPAND = 50000;

  // How many tickets one stored record stands for.
  function seatCountOf(seat) {
    var n = Number(seat && seat.count);
    if (!isFinite(n) || n < 1) return 1;
    return Math.floor(n);
  }

  // seats: stored seat records. Returns one object per ticket.
  //
  // The copies must be distinct objects. buildAllClusters() tracks the seats
  // it has already consumed in a Set keyed on identity, so N references to a
  // single object would collapse into one cluster member and the count would
  // come out as 1.
  function expandSeatCounts(seats) {
    var out = [];
    var truncated = [];
    var list = seats || [];
    for (var i = 0; i < list.length; i++) {
      var seat = list[i];
      var want = seatCountOf(seat);
      if (want === 1) { out.push(seat); continue; }
      var n = Math.min(want, MAX_EXPAND);
      if (n < want) truncated.push({ block: seat.block, want: want, used: n });
      for (var k = 0; k < n; k++) {
        // `count` comes off the copies: from here on the rows ARE the count,
        // and leaving it on would invite a second multiplication.
        var copy = Object.assign({}, seat);
        delete copy.count;
        out.push(copy);
      }
    }
    out.truncated = truncated;
    return out;
  }

  root.expandSeatCounts = expandSeatCounts;
  root.seatCountOf = seatCountOf;
  root.SEAT_COUNT_MAX_EXPAND = MAX_EXPAND;
})(typeof self !== "undefined" ? self : this);
