// The Best Value tab: which listings are cheap FOR WHAT THEY ARE.
//
// The cheapest list answers a different question. Section 613 at $97 is not a
// find if $97 is simply what 613 costs; section 206 at $1,005 is one when the
// rest of 206 is $1,340. Everything here is about that distinction.
//
// Peers are found on a ladder — same section, then the curated tier, then the
// event — and the comparison is against the MEDIAN, never the average.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const popup = fs.readFileSync(EXT + "popup.js", "utf8");
const html = fs.readFileSync(EXT + "popup.html", "utf8");
const css = fs.readFileSync(EXT + "popup.css", "utf8");
const down = (s) => s.replace(/\?\.\[/g, "[").replace(/\?\.\(/g, "(")
  .replace(/(\w|\)|\])\?\./g, "$1.").replace(/ \?\? /g, " || ");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };
const fn = (name) => eval("(" + down(extractFn(popup, name)) + ")");

// Prices are stored in thousandths; the popup converts with centsToUSD, and no
// fee multiplier applies on the sources this matters for.
global.centsToUSD = (c) => c / 1000;
// The popup's formatPrice uses toLocaleString; node's ICU build here formats
// to the machine locale, so a plain equivalent keeps the assertions readable.
global.formatPrice = (n) => (n >= 1000
  ? String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  : n.toFixed(2));
global.median = fn("median");
global.dealPrice = fn("dealPrice");
global.DEAL_MIN_PEERS = 4;
global.DEAL_MAX_RESULTS = 25;
global.dealTier = fn("dealTier");
global.dealPeers = fn("dealPeers");
global.dealGroupEdge = fn("dealGroupEdge");
global.dealRowEdge = fn("dealRowEdge");
global.dealCaveats = fn("dealCaveats");
// The real clusterer, so the scores are built on what the popup actually shows.
global.buildAllClusters = fn("buildAllClusters");
const scoreDeals = fn("scoreDeals");

const seat = (block, row, num, dollars, tier, extra) => Object.assign({
  block, row, seat: String(num), price: dollars * 1000,
  tier: tier || "Lower (100s)", area: "", category: "standard", site: "test",
}, extra || {});

// A pair of adjacent seats at one price: one listing as far as the popup is
// concerned.
const pair = (block, row, startNum, dollars, tier, extra) => [
  seat(block, row, startNum, dollars, tier, extra),
  seat(block, row, startNum + 1, dollars, tier, extra),
];

out("--- the median, not the average ---");
check("even count averages the middle two", global.median([10, 20, 30, 40]) === 25);
check("odd count takes the middle", global.median([10, 20, 100]) === 20);
// One absurd listing in a section would otherwise drag the baseline up and make
// everything around it look like a bargain.
check("one outlier barely moves it", global.median([100, 100, 100, 100, 5000]) === 100);
check("no values, no median", global.median([]) === null);

out("");
out("--- cheap for its section beats cheap overall ---");
{
  const seats = [].concat(
    pair("206", "6", 1, 1005), pair("206", "7", 1, 1340), pair("206", "8", 1, 1350),
    pair("206", "9", 1, 1330), pair("206", "10", 1, 1360),
    // An upper deck that is simply cheap: every listing within a few dollars.
    pair("613", "40", 1, 97), pair("613", "41", 1, 99), pair("613", "42", 1, 101),
    pair("613", "43", 1, 98), pair("613", "44", 1, 100)
  );
  const deals = scoreDeals(seats);
  check("the underpriced listing ranks first",
    deals[0].cluster.block === "206" && Math.round(deals[0].price) === 1005,
    deals[0].cluster.block + " $" + deals[0].price);
  check("and the reason names the section median",
    /25% under section 206 \(median \$1,345\)/.test(deals[0].reasons[0]), deals[0].reasons[0]);
  // The $97 ticket is the cheapest in the event and is NOT the best value.
  const cheapest = deals.find((d) => d.cluster.block === "613");
  check("the cheapest seat in the event ranks below it",
    deals.indexOf(cheapest) > 0, "position " + deals.indexOf(cheapest));
  check("every entry states what it was compared with",
    deals.every((d) => d.peerCount > 0 && d.label));
}

out("");
out("--- the peer ladder ---");
{
  // Two listings in section 118 is not enough to say anything, so the tier is
  // used instead; the tier has plenty.
  const seats = [].concat(
    pair("118", "4", 1, 90, "Cat A"), pair("118", "5", 1, 180, "Cat A"),
    pair("119", "4", 1, 175, "Cat A"), pair("120", "4", 1, 185, "Cat A"),
    pair("121", "4", 1, 190, "Cat A"), pair("122", "4", 1, 170, "Cat A")
  );
  const deals = scoreDeals(seats);
  const thin = deals.find((d) => d.cluster.block === "118" && Math.round(d.price) === 90);
  check("a thin section falls through to the tier", thin.scope === "tier", thin.scope);
  check("and says so in the reason", /under Cat A/.test(thin.reasons[0]), thin.reasons[0]);

  // With no tier either, the event is the last rung.
  const noTier = seats.map((s) => Object.assign({}, s, { tier: "" }));
  const eventScope = scoreDeals(noTier)
    .find((d) => d.cluster.block === "118" && Math.round(d.price) === 90);
  check("with no tier it compares against the event", eventScope.scope === "event",
    eventScope.scope);
  check("and says this event", /under this event/.test(eventScope.reasons[0]),
    eventScope.reasons[0]);
}

out("");
out("--- a bigger group for less than the small ones ---");
{
  // Four together at $142 each where the pairs go for $186: never the cheapest
  // line, so a price sort cannot surface it.
  const four = [1, 2, 3, 4].map((n) => seat("118", "20", n, 142));
  const seats = [].concat(four,
    pair("118", "4", 1, 186), pair("118", "5", 1, 190), pair("118", "6", 1, 182),
    pair("118", "7", 1, 188), pair("118", "8", 1, 186)
  );
  const deals = scoreDeals(seats);
  const quad = deals.find((d) => d.cluster.together === 4);
  check("the four-seat listing is found", !!quad);
  check("it ranks first", deals[0] === quad, deals[0].cluster.together + " together");
  check("the group edge is explained",
    quad.reasons.some((r) => /4 together at \$142\.00 each/.test(r)), quad.reasons.join(" | "));
  check("and names what smaller groups cost",
    quad.reasons.some((r) => /smaller groups here go for \$186\.00/.test(r)));
  // A pair priced like every other pair has no group edge to claim.
  const ordinary = deals.find((d) => d.cluster.together === 2 && Math.round(d.price) === 186);
  check("an ordinary pair claims no group edge", !ordinary.group);
}

out("");
out("--- cheaper than the rows behind it ---");
{
  const seats = [].concat(
    pair("104", "3", 1, 120), pair("104", "18", 1, 150), pair("104", "19", 1, 155),
    pair("104", "20", 1, 148), pair("104", "21", 1, 152), pair("104", "22", 1, 151)
  );
  const front = scoreDeals(seats).find((d) => d.cluster.row === "3");
  check("a front row under the back rows is flagged", !!front.row, JSON.stringify(front.row));
  check("and the reason counts them",
    front.reasons.some((r) => /cheaper than \d+ listings further back/.test(r)),
    front.reasons.join(" | "));
  // Rows are missing on much of the resale inventory; a blank row must not be
  // treated as row 0 and turn every listing into a front-row find.
  const noRows = seats.map((s) => Object.assign({}, s, { row: "" }));
  check("a missing row claims nothing", scoreDeals(noRows).every((d) => !d.row));
}

out("");
out("--- why a listing might be cheap ---");
{
  const obstructed = { accessible: false, attributes: [{ name: "Obstructed View" }] };
  const seats = [].concat(
    pair("301", "5", 1, 60, "Upper", obstructed),
    pair("301", "6", 1, 120), pair("301", "7", 1, 118), pair("301", "8", 1, 122),
    pair("301", "9", 1, 119)
  );
  const flagged = scoreDeals(seats)[0];
  check("an obstructed listing still ranks", Math.round(flagged.price) === 60,
    String(flagged.price));
  // Shown, not subtracted: half price for an obstructed seat may be exactly
  // what someone wants, but they should know before they click.
  check("the obstruction is stated", flagged.caveats.some((c) => /obstructed/.test(c)),
    flagged.caveats.join(", "));

  const access = [].concat(
    pair("302", "5", 1, 60, "Upper", { accessible: true }),
    pair("302", "6", 1, 120), pair("302", "7", 1, 118), pair("302", "8", 1, 122),
    pair("302", "9", 1, 119)
  );
  check("accessible seating is stated",
    scoreDeals(access)[0].caveats.indexOf("accessible seating") !== -1);
}

out("");
out("--- a thin comparison is worth less than a thick one ---");
{
  // Same 50% discount either side; the one measured against more listings wins.
  const thin = [].concat(
    pair("A", "1", 1, 50), pair("A", "2", 1, 100), pair("A", "3", 1, 100),
    pair("A", "4", 1, 100), pair("A", "5", 1, 100)
  );
  const thick = [];
  thick.push.apply(thick, pair("B", "1", 1, 50));
  for (let i = 2; i < 30; i++) thick.push.apply(thick, pair("B", String(i), 1, 100));
  const thinScore = scoreDeals(thin)[0].score;
  const thickScore = scoreDeals(thick)[0].score;
  check("the better-evidenced discount scores higher", thickScore > thinScore,
    `${thickScore.toFixed(1)} vs ${thinScore.toFixed(1)}`);
  check("both are still shown", thinScore > 0 && thickScore > 0);
}

out("");
out("--- a ranking, not a verdict ---");
{
  // An evenly priced event has no real deal. It still returns a list, and the
  // top entry's gap is visibly tiny rather than dressed up as a find.
  const flat = [];
  for (let i = 1; i < 12; i++) flat.push.apply(flat, pair("200", String(i), 1, 100));
  const deals = scoreDeals(flat);
  check("a flat event still returns a ranking", deals.length > 0, String(deals.length));
  check("and the top gap is honestly tiny", deals[0].pct < 0.05,
    (deals[0].pct * 100).toFixed(1) + "%");
  check("no threshold hides anything", !/DEAL_MIN_DISCOUNT|minDiscount/.test(popup));
}

out("");
out("--- edges ---");
check("one listing cannot be compared", scoreDeals(pair("A", "1", 1, 100)).length === 0);
check("no seats at all", scoreDeals([]).length === 0);
{
  const many = [];
  for (let i = 1; i < 80; i++) many.push.apply(many, pair("C", String(i), 1, 100 + i));
  check("the list is capped", scoreDeals(many).length <= 25, String(scoreDeals(many).length));
}

out("");
out("--- wiring ---");
check("a Value tab exists", /data-tab="deals"/.test(html));
check("with a panel", /id="tab-deals"/.test(html) && /id="dealsContent"/.test(html));
check("opening it renders", /if \(target === "deals"\) renderDealsTab\(\);/.test(popup));
check("styled", /\.deal-row/.test(css) && /\.deals-head/.test(css));
// Every row has to say what it was measured against, or the number means
// nothing to whoever reads it.
check("the peer count is rendered", /compared with \$\{d\.peerCount\}/.test(popup));
check("the empty case is handled", /Nothing to compare yet/.test(popup));

out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
process.exit(fail ? 1 : 0);
