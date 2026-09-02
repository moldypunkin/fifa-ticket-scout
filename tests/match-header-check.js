// The match header, and specifically its "loading" state.
//
// Two bugs lived here together:
//   1. "Match data loading..." was shown whenever the event name was missing,
//      including AFTER a scan had finished. On sites that publish no name
//      (Account Manager was one) it waited forever above a full seat list.
//   2. The re-render guard keyed on the name alone. With no name the key
//      stayed null when seats arrived, so the header never redrew even once
//      there was something better to say.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const src = fs.readFileSync(EXT + "popup.js", "utf8");

// Null-SAFE down-level: turning match?.name into match.name throws on null,
// which is a harness artefact, not a defect in the shipped code.
const down = (s) => s
  .replace(/\?\.\[/g, "[")
  .replace(/\?\.\(/g, "(")
  .replace(/(\w+)\?\./g, "($1 || {}).")
  .replace(/(\)|\])\?\./g, "$1.")
  .replace(/ \?\? /g, " || ");

// Minimal DOM: the function only sets innerHTML on one element.
let el;
global.document = { getElementById: () => el };
global.escapeHtml = (s) => String(s);
global.scanSpeedHtml = () => "<span class=\"speed\"></span>";
global.initSpeedButtons = () => {};
global.restorePillProgress = () => {};
global.formatDate = (d) => "FORMATTED(" + d + ")";
global.SITE_LABELS = { ticketmaster: "Ticketmaster", seatgeek: "SeatGeek", resale: "Resale" };
global.currentSite = "ticketmaster";
global.lastMatchName = null;

const renderMatchInfo = eval("(" + down(extractFn(src, "renderMatchInfo")) + ")");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

function render(match, seatCount) {
  el = { innerHTML: "", children: [] };
  renderMatchInfo(match, seatCount);
  // Mimic the browser: once innerHTML is set the element has children, which
  // is what the re-render guard checks.
  if (el.innerHTML) el.children = [{}];
  return el.innerHTML;
}

out("--- a real match renders normally ---");
let html = render({ name: "Mizzou Football vs. Arkansas", date: "03-09-2026 - 19:00", venue: "Faurot Field" }, 150);
check("name shown", /Mizzou Football vs\. Arkansas/.test(html));
check("venue shown", /Faurot Field/.test(html));
check("date formatted", /FORMATTED\(03-09-2026 - 19:00\)/.test(html));
check("not claiming to load", !/Match data loading/.test(html));

out("");
out("--- no name, no seats: genuinely still loading ---");
html = render(null, 0);
check("says loading", /Match data loading/.test(html), html.slice(0, 80));

out("");
out("--- no name, but seats captured: NOT loading ---");
// This is the case that hung: the scan finished, nothing more is coming.
html = render(null, 150);
check("does not say loading", !/Match data loading/.test(html), html.slice(0, 120));
check("says the site published no name", /did not publish an event name/.test(html), html.slice(0, 160));
check("names the site", /Ticketmaster/.test(html));
check("drops the FIFA seat-map advice", !/Browse the seat map/.test(html));

out("");
out("--- venue alone is used as the heading when there is one ---");
html = render({ venue: "Faurot Field" }, 150);
check("venue used", /Faurot Field/.test(html), html.slice(0, 100));
check("still not loading", !/Match data loading/.test(html));

out("");
out("--- the re-render guard lets the message change ---");
{
  // Same sequence the popup goes through: header drawn while empty, seats
  // arrive later. Previously the key stayed null and the second render was
  // skipped, leaving "loading" on screen permanently.
  global.lastMatchName = null;
  el = { innerHTML: "", children: [] };
  renderMatchInfo(null, 0);
  if (el.innerHTML) el.children = [{}];
  const first = el.innerHTML;
  renderMatchInfo(null, 150);
  const second = el.innerHTML;
  check("first render says loading", /Match data loading/.test(first));
  check("second render replaced it", !/Match data loading/.test(second), second.slice(0, 120));
  check("second render explains why", /did not publish an event name/.test(second));
}

out("");
out("--- an unchanged state is still skipped (no flicker) ---");
{
  global.lastMatchName = null;
  el = { innerHTML: "", children: [] };
  renderMatchInfo({ name: "Same Event" }, 10);
  if (el.innerHTML) el.children = [{}];
  el.innerHTML = "SENTINEL";
  renderMatchInfo({ name: "Same Event" }, 10);
  check("identical state does not redraw", el.innerHTML === "SENTINEL", el.innerHTML.slice(0, 60));
}

out("");
out("--- a name arriving after seats does redraw ---");
{
  global.lastMatchName = null;
  el = { innerHTML: "", children: [] };
  renderMatchInfo(null, 150);
  if (el.innerHTML) el.children = [{}];
  renderMatchInfo({ name: "Late Name" }, 150);
  check("name replaces the fallback", /Late Name/.test(el.innerHTML), el.innerHTML.slice(0, 100));
}

out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
process.exit(fail ? 1 : 0);
