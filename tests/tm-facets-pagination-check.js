// Ticketmaster's facets endpoint pages its results, and the scan used to read
// page one and stop.
//
// Found on a Nebraska resale event (Z7r9jZ1A7Oaq7, Memorial Stadium): the
// dashboard reported 1,739 seats while section 206 — plainly on the map, with a
// $1,005.70 listing — was missing, because its facet sat on a later page. The
// seats that did arrive looked complete, which is what made it hard to see.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const src = fs.readFileSync(EXT + "ticketmaster-adapter.js", "utf8");
const down = (s) => s.replace(/\?\.\[/g, "[").replace(/\?\.\(/g, "(")
  .replace(/(\w|\)|\])\?\./g, "$1.").replace(/ \?\? /g, " || ");

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

const nextUrl = eval("(" + down(extractFn(src, "facetsNextUrl")) + ")");
const pageNote = eval("(" + down(extractFn(src, "facetsPageNote")) + ")");
global.facetsNextUrl = nextUrl;
global.facetsPageNote = pageNote;
global.console = console;
// extract-fn hands back the declaration from `function`, so the async keyword
// has to go back on.
const follow = eval("(async " + down(extractFn(src, "followFacetPages")) + ")");

const facet = (section) => ({ name: "seating", section, offers: ["o-" + section] });
const offer = (id) => ({ offerId: id, totalPrice: 100 });

// Three pages, as ISMDS serves them: each links to the next, the last does not.
function pagedResponses() {
  return {
    "https://services.ticketmaster.com/api/ismds/event/E1/facets?offset=1&apikey=b462oi7fic6pehcdkzony5bxhe&apisecret=pquzpfrfz7zd2ylvtz3w5dtyse": {
      facets: [facet("206"), facet("207")],
      _embedded: { offer: [offer("o-206"), offer("o-207")] },
      page: { number: 1, totalPages: 3, totalElements: 6 },
      _links: { next: { href: "/event/E1/facets?offset=2" } },
    },
    "https://services.ticketmaster.com/api/ismds/event/E1/facets?offset=2&apikey=b462oi7fic6pehcdkzony5bxhe&apisecret=pquzpfrfz7zd2ylvtz3w5dtyse": {
      facets: [facet("301")],
      _embedded: { offer: [offer("o-301")] },
      page: { number: 2, totalPages: 3, totalElements: 6 },
    },
  };
}

const firstPage = () => ({
  facets: [facet("32"), facet("36C"), facet("14")],
  _embedded: { offer: [offer("o-32"), offer("o-36C"), offer("o-14")] },
  page: { number: 0, totalPages: 3, totalElements: 6 },
  _links: { next: { href: "/event/E1/facets?offset=1" } },
});

function stubFetch(responses, opts) {
  const calls = [];
  global.fetch = (url) => {
    calls.push(url);
    // != null, not truthiness: throwAfter 0 means "throw on the first call".
    if (opts && opts.failAfter != null && calls.length > opts.failAfter) {
      return Promise.resolve({ ok: false, status: 503 });
    }
    if (opts && opts.throwAfter != null && calls.length > opts.throwAfter) {
      return Promise.reject(new Error("network down"));
    }
    const body = responses[url];
    if (!body) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  return calls;
}

(async () => {
  out("--- the next-page link ---");
  check("a relative href becomes an absolute url",
    nextUrl({ _links: { next: { href: "/event/E1/facets?offset=1" } } })
      .indexOf("https://services.ticketmaster.com/api/ismds/event/E1/facets?offset=1") === 0);
  // Without these the next page 401s and the walk stops after page one.
  check("the credentials are put back on",
    /apikey=.*apisecret=/.test(nextUrl({ _links: { next: { href: "/event/E1/facets?offset=1" } } })));
  check("an href that already has them is left alone",
    nextUrl({ _links: { next: { href: "/x?apikey=k&apisecret=s" } } })
      === "https://services.ticketmaster.com/api/ismds/x?apikey=k&apisecret=s");
  check("a link served as an array works too",
    nextUrl({ _links: { next: [{ href: "/event/E1/facets?offset=1" }] } }) !== null);
  check("no next link means the last page", nextUrl({ _links: {} }) === null);
  check("no links block at all", nextUrl({}) === null);
  check("an absolute href is not prefixed",
    nextUrl({ _links: { next: { href: "https://x.test/f?apikey=k" } } }) === "https://x.test/f?apikey=k");

  out("");
  out("--- following the pages ---");
  {
    const calls = stubFetch(pagedResponses());
    const merged = await follow(firstPage(), {}, null);
    check("two more pages fetched", calls.length === 2, String(calls.length));
    const sections = merged.facets.map((f) => f.section);
    check("all six facets, in order", sections.join(",") === "32,36C,14,206,207,301",
      sections.join(","));
    // The seats the user could see on the map and the scout could not.
    check("section 206 arrives", sections.indexOf("206") !== -1);
    // A facet whose offer stayed behind would be stored priceless.
    check("the offers come with them", merged._embedded.offer.length === 6,
      String(merged._embedded.offer.length));
    check("the body still has one facets array", Array.isArray(merged.facets));
  }

  out("");
  out("--- a page that fails does not lose the ones already fetched ---");
  {
    stubFetch(pagedResponses(), { failAfter: 1 });
    const merged = await follow(firstPage(), {}, null);
    check("page one plus the page that worked", merged.facets.length === 5,
      String(merged.facets.length));
    check("still usable", merged.facets.map((f) => f.section).indexOf("206") !== -1);
  }
  {
    stubFetch(pagedResponses(), { throwAfter: 0 });
    const merged = await follow(firstPage(), {}, null);
    check("a thrown request keeps page one", merged.facets.length === 3,
      String(merged.facets.length));
  }

  out("");
  out("--- a single-page event is untouched ---");
  {
    const calls = stubFetch({});
    const only = { facets: [facet("A")], _embedded: { offer: [offer("o-A")] },
      page: { number: 0, totalPages: 1, totalElements: 1 } };
    const merged = await follow(only, {}, null);
    check("nothing else is fetched", calls.length === 0, String(calls.length));
    check("the body is unchanged", merged.facets.length === 1);
  }

  out("");
  out("--- it cannot loop forever ---");
  {
    // A page that links to itself: without the cap this never returns.
    const selfRef = {
      facets: [facet("X")], _embedded: { offer: [] },
      page: { number: 1, totalPages: 99 },
      _links: { next: { href: "/event/E1/facets?offset=1" } },
    };
    const url = "https://services.ticketmaster.com/api/ismds/event/E1/facets?offset=1" +
      "&apikey=b462oi7fic6pehcdkzony5bxhe&apisecret=pquzpfrfz7zd2ylvtz3w5dtyse";
    const calls = stubFetch({ [url]: selfRef });
    const merged = await follow(firstPage(), {}, null);
    check("stops at the page cap", calls.length <= 40, String(calls.length));
    check("and keeps what it gathered", merged.facets.length > 3, String(merged.facets.length));
  }

  out("");
  out("--- wiring ---");
  check("the fetch runs the pages through it", /followFacetPages\(data, headers, params\)/.test(src));
  check("the page count is logged", /followed \$\{pages\} pages/.test(src));

  out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("THREW:", e && e.stack); process.exit(1); });
