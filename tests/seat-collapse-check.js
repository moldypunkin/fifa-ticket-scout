// Seats without numbers must not collapse into one another.
//
// buildAllClusters tracked consumed seats by seatKey(s) = seat + "_" + block +
// "_" + row. Every seat WITHOUT a number in the same block and row therefore
// shared one key, and the `used` set skipped all but the first — so they never
// reached the dashboard.
//
// That is not an edge case. TickPick, StubHub and Vivid Seats publish no seat
// numbers at all and store "", and Gametime returns "*" for seats it does not
// disclose. A Gametime listing of four unnumbered seats in 318 row 8 showed as
// one seat, which is what "it's only capturing some of the seats" looked like.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const popup = fs.readFileSync(EXT + "popup.js", "utf8");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

// buildAllClusters formats a display price through centsToUSD, so the real one
// is supplied rather than stubbed — the function under test stays unmodified.
// node 12 predates ??, which centsToUSD uses.
const down = (src) => src.replace(/ \?\? /g, " || ");
global.FEE_MULTIPLIER_BY_SITE = { gametime: 1.0 };
global.FEE_FLAT_BY_SITE = { gametime: 0 };
global.currentSite = "gametime";
global.centsToUSD = eval("(" + down(extractFn(popup, "centsToUSD")) + ")");
const buildAllClusters = eval("(" + extractFn(popup, "buildAllClusters") + ")");

const seat = (block, row, num, price) => ({
  block: block, row: row, seat: num, price: price == null ? 12000 : price,
  area: "Upper", category: "resale", site: "gametime",
});

out("--- unnumbered seats each survive ---");
{
  // Gametime's shape: four seats, same block and row and price, all "*".
  const seats = [seat("318", "8", "*"), seat("318", "8", "*"),
                 seat("318", "8", "*"), seat("318", "8", "*")];
  const clusters = buildAllClusters(seats);
  const total = clusters.reduce((n, c) => n + c.count, 0);
  check("all four are accounted for", total === 4, total + " of 4");
  // They are indistinguishable, so they share one row rather than repeating —
  // ten identical "Block 233 · Row 13 · Seat *" lines is what N rows looked
  // like. The count is what carries the information.
  check("shown as one row, not four", clusters.length === 1, clusters.length + " cluster(s)");
  check("the row says how many", clusters[0].count === 4, String(clusters[0].count));
  // The load-bearing distinction: nothing establishes that these adjoin. They
  // may come from different listings, so offering them as "4 together" would
  // send someone to a block of four that does not exist.
  check("adjacency is not claimed", clusters[0].adjacent === false, String(clusters[0].adjacent));
  check("and the together-count stays 1", clusters[0].together === 1, String(clusters[0].together));
}

out("");
out("--- and so do blank ones, which is what most sources store ---");
{
  // TickPick / StubHub / Vivid Seats: seat is "".
  const seats = [seat("Theater Box 103B", "AA", ""), seat("Theater Box 103B", "AA", ""),
                 seat("Theater Box 103B", "AA", ""), seat("Theater Box 103B", "AA", ""),
                 seat("Theater Box 103B", "AA", ""), seat("Theater Box 103B", "AA", "")];
  const clusters = buildAllClusters(seats);
  const total = clusters.reduce((n, c) => n + c.count, 0);
  check("a six-seat listing stays six seats", total === 6, total + " of 6");
  check("on a single row", clusters.length === 1, clusters.length + " cluster(s)");
  check("not offered as six together", clusters[0].together === 1, String(clusters[0].together));
}

out("");
out("--- numbered seats still cluster into runs ---");
{
  const seats = [seat("309", "4", "10"), seat("309", "4", "11"), seat("309", "4", "12")];
  const clusters = buildAllClusters(seats);
  check("three consecutive seats make one cluster", clusters.length === 1,
    clusters.length + " cluster(s)");
  check("counted as three", clusters[0].count === 3, String(clusters[0].count));
  check("shown as a range", clusters[0].seatDisplay === "Seats 10-12", clusters[0].seatDisplay);
  // Real consecutive numbers DO establish adjacency, so this one is genuinely
  // three together and must keep saying so.
  check("adjacency is claimed here", clusters[0].adjacent === true);
  check("and the together-count is three", clusters[0].together === 3, String(clusters[0].together));
}

out("");
out("--- a gap still breaks the run ---");
{
  const seats = [seat("309", "4", "10"), seat("309", "4", "11"), seat("309", "4", "20")];
  const clusters = buildAllClusters(seats);
  const total = clusters.reduce((n, c) => n + c.count, 0);
  check("nothing is lost across the gap", total === 3, total + " of 3");
  check("it is not one run", clusters.length === 2, clusters.length + " cluster(s)");
}

out("");
out("--- different rows and prices stay separate ---");
{
  const seats = [seat("318", "8", "*"), seat("318", "9", "*"),
                 seat("318", "8", "*", 13000)];
  const clusters = buildAllClusters(seats);
  const total = clusters.reduce((n, c) => n + c.count, 0);
  check("all three survive", total === 3, total + " of 3");
}

out("");
out("--- the real Gametime shape: numbered and unnumbered side by side ---");
{
  // One block and row holding a disclosed pair and three undisclosed singles.
  // The pair must stay a genuine "2 together" — grouping everything by block
  // and row would destroy the one piece of adjacency the site did give us.
  const seats = [seat("233", "13", "*"), seat("233", "13", "6"),
                 seat("233", "13", "7"), seat("233", "13", "*"),
                 seat("233", "13", "*")];
  const clusters = buildAllClusters(seats);
  const total = clusters.reduce((n, c) => n + c.count, 0);
  check("all five survive", total === 5, total + " of 5");
  check("two rows: the pair and the rest", clusters.length === 2, clusters.length + " cluster(s)");

  const pair = clusters.find((c) => c.adjacent === true);
  const rest = clusters.find((c) => c.adjacent === false);
  check("the disclosed pair is preserved", pair && pair.seatDisplay === "Seats 6-7",
    pair && pair.seatDisplay);
  check("and still counts as 2 together", pair && pair.together === 2, pair && String(pair.together));
  check("the three undisclosed share a row", rest && rest.count === 3, rest && String(rest.count));
  check("and claim no adjacency", rest && rest.together === 1, rest && String(rest.together));
}

out("");
out("--- an unnumbered seat is labelled, not left blank ---");
{
  const clusters = buildAllClusters([seat("318", "8", "")]);
  check("a blank seat reads as *", clusters[0].seatDisplay === "Seat *", clusters[0].seatDisplay);
  const starred = buildAllClusters([seat("318", "8", "*")]);
  check("an explicit * is unchanged", starred[0].seatDisplay === "Seat *", starred[0].seatDisplay);
  const numbered = buildAllClusters([seat("309", "4", "10")]);
  check("a real number is unchanged", numbered[0].seatDisplay === "Seat 10", numbered[0].seatDisplay);
}

out("");
out("--- the composite key is gone for good ---");
// If it comes back, every assertion above passes only by accident of ordering.
check("seatKey is no longer used to track consumed seats",
  !/used\.(has|add)\(seatKey/.test(popup), "the collapsing key is back");
check("nor to filter by together-count",
  !/qualifyingKeys\.has\(seatKey/.test(popup));

out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
process.exit(fail ? 1 : 0);
