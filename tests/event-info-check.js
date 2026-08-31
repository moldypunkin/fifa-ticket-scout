// The shared event-info reader, including the staleness guard added upstream:
// after an in-page navigation the server-rendered JSON-LD still names the
// PREVIOUS event, and using it puts the wrong match in the popup header.
const EXT = require("./ext-dir");
const fs = require("fs");
const extractFn = require("./extract-fn");
const src = fs.readFileSync(
  EXT + "event-info.js", "utf8");

const down = (s) => s.replace(/(\w|\))\?\./g, "$1.").replace(/ \?\? /g, " || ");
global.URL = URL;
global.URLSearchParams = URLSearchParams;
global.EVENT_PARAMS = eval(src.match(/const EVENT_PARAMS = \[[\s\S]*?\];/)[0]
  .replace("const EVENT_PARAMS = ", "").replace(/;$/, ""));
global.normalizeEventDate = eval("(" + down(extractFn(src, "normalizeEventDate")) + ")");
global.cleanTitle = eval("(" + down(extractFn(src, "cleanTitle")) + ")");
global.pageIdentity = eval("(" + down(extractFn(src, "pageIdentity")) + ")");
global.ldNodeIsStale = eval("(" + down(extractFn(src, "ldNodeIsStale")) + ")");
const readEventInfo = eval("(" + down(extractFn(src, "readEventInfo")) + ")");

// --- DOM + location stub -------------------------------------------------
function setPage({ ld = [], og = null, title = "", href = "https://x.test/event/A1" }) {
  global.window = { location: { href } };
  global.document = {
    title,
    querySelectorAll: (sel) =>
      sel.includes("ld+json")
        ? ld.map((t) => ({ textContent: typeof t === "string" ? t : JSON.stringify(t) }))
        : [],
    querySelector: (sel) => (sel.includes("og:title") && og ? { content: og } : null),
  };
}
const logged = [];
const realLog = console.log;
global.console = { log: (...a) => logged.push(a.join(" ")) };

let fail = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; realLog(`FAIL ${l}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`); }
  else realLog(`ok   ${l}`);
};

realLog("--- date normalisation ---");
eq("ISO with offset keeps venue-local time", normalizeEventDate("2026-06-15T19:00:00-04:00"), "15-06-2026 - 19:00");
eq("ISO without offset", normalizeEventDate("2026-06-15T19:00:00"), "15-06-2026 - 19:00");
eq("date only", normalizeEventDate("2026-06-15"), "15-06-2026");
eq("garbage -> null", normalizeEventDate("next Tuesday"), null);
eq("non-string -> null", normalizeEventDate(undefined), null);
const fmt = /(\d{2})-(\d{2})-(\d{4})\s*-\s*(\d{2}:\d{2})/;
eq("popup formatDate accepts our output", fmt.test(normalizeEventDate("2026-09-14T19:15:00")), true);

realLog("\n--- pageIdentity (last two path segments) ---");
eq("short and slug forms match",
  pageIdentity("https://www.ticketmaster.com/event/Z7r9jZ1A7qIaF"),
  pageIdentity("https://www.ticketmaster.com/michigan-wolverines-vs-oklahoma-09-12-2026/event/Z7r9jZ1A7qIaF"));
eq("different events differ",
  pageIdentity("https://x.test/event/AAA") === pageIdentity("https://x.test/event/BBB"), false);
eq("trailing slash ignored", pageIdentity("https://x.test/event/A1/"), pageIdentity("https://x.test/event/A1"));
eq("case ignored", pageIdentity("https://x.test/Event/A1"), pageIdentity("https://x.test/event/a1"));
eq("evenue query params counted",
  pageIdentity("https://k.evenue.net/cgi/x?ticketCode=ABC"),
  pageIdentity("https://k.evenue.net/cgi/x?ticketCode=abc"));
eq("empty url -> empty", pageIdentity(""), "");

realLog("\n--- ldNodeIsStale ---");
eq("same event kept", ldNodeIsStale({ url: "https://x.test/event/A1" }, "https://x.test/event/A1"), false);
eq("different event rejected", ldNodeIsStale({ url: "https://x.test/event/B2" }, "https://x.test/event/A1"), true);
eq("node with no url is kept", ldNodeIsStale({ name: "x" }, "https://x.test/event/A1"), false);
eq("mainEntityOfPage string honoured",
  ldNodeIsStale({ mainEntityOfPage: "https://x.test/event/B2" }, "https://x.test/event/A1"), true);
eq("null node", ldNodeIsStale(null, "https://x.test/event/A1"), false);

realLog("\n--- extraction ---");
setPage({ ld: [{ "@type": "SportsEvent", name: "Portugal vs. Spain", startDate: "2026-06-15T19:00:00-04:00", location: { name: "MetLife Stadium" } }] });
eq("plain node", readEventInfo("T"), { name: "Portugal vs. Spain", date: "15-06-2026 - 19:00", venue: "MetLife Stadium" });

setPage({ ld: [{ "@graph": [{ "@type": "WebSite" }, { "@type": "Event", name: "Final", startDate: "2026-07-19T15:00:00", location: [{ name: "Rose Bowl" }] }] }] });
eq("@graph + array location", readEventInfo("T"), { name: "Final", date: "19-07-2026 - 15:00", venue: "Rose Bowl" });

setPage({ ld: ["{ not json", { "@type": "Event", name: "Survived", startDate: "2026-06-01T12:00:00" }] });
eq("malformed block skipped", readEventInfo("T"), { name: "Survived", date: "01-06-2026 - 12:00", venue: null });

setPage({ ld: [{ "@type": ["Thing", "MusicEvent"], name: "Gig", startDate: "2026-06-02T20:00:00" }] });
eq("array @type", readEventInfo("T"), { name: "Gig", date: "02-06-2026 - 20:00", venue: null });

setPage({ ld: [{ "@type": "Organization", name: "Ticketmaster" }], og: "Brazil vs. Croatia Tickets | Ticketmaster" });
eq("non-Event ignored, og fallback", readEventInfo("T"), { name: "Brazil vs. Croatia", date: null, venue: null });

setPage({ ld: [], title: "France vs. Germany Tickets Jun 20 | Ticketmaster" });
eq("title fallback", readEventInfo("T"), { name: "France vs. Germany", date: null, venue: null });

setPage({ ld: [], title: "" });
eq("nothing available", readEventInfo("T"), { name: null, date: null, venue: null });

realLog("\n--- the staleness guard in action ---");
setPage({
  href: "https://tm.test/event/NEW1",
  ld: [{ "@type": "Event", name: "Old Event", url: "https://tm.test/event/OLD9", startDate: "2026-01-01T12:00:00", location: { name: "Old Arena" } }],
  og: "Old Event Tickets",
  title: "New Event Tickets | Ticketmaster",
});
const stale = readEventInfo("T");
eq("stale block not used for the name", stale.name, "New Event");
eq("stale date not used", stale.date, null);
eq("stale venue not used", stale.venue, null);
eq("og also skipped once staleness seen", stale.name !== "Old Event", true);
eq("it says so in the log", logged.some((l) => /different event/.test(l)), true);

realLog(fail ? `\n${fail} FAILURES` : "\nall passed");
process.exit(fail ? 1 : 0);
