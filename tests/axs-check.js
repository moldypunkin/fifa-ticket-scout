// AXS plumbing and event identity. There is no parser yet — that is the point
// of this file existing now: AXS is wired through every other layer and has
// been since it was added, so it LOOKS finished. background.js has no
// saveAxsSeats and never has, and nothing asserted that either way.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const bg = fs.readFileSync(EXT + "background.js", "utf8");
const popup = fs.readFileSync(EXT + "popup.js", "utf8");
const inj = fs.readFileSync(EXT + "injected.js", "utf8");
const axs = fs.readFileSync(EXT + "axs-adapter.js", "utf8");
const mf = JSON.parse(fs.readFileSync(EXT + "manifest.json", "utf8"));

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

out("--- event id: every url shape AXS actually serves ---");
global.window = { location: {} };
global.URLSearchParams = URLSearchParams;
const getId = eval("(" + extractFn(axs, "getAxsEventId") + ")");
const at = (pathname, search) => {
  global.window.location = { pathname, search: search || "" };
  return getId();
};

// 1. Browse page.
check("browse path id", at("/events/1234567/chiefs-tickets") === "1234567",
  String(at("/events/1234567/chiefs-tickets")));
// 2. The older ticket flow, which carries `e`.
check("e= parameter", at("/nZA9NwAAAAABIj1H", "?c=axs&e=92678159754876303")
  === "92678159754876303");
check("eventId parameter", at("/x", "?eventId=1234567") === "1234567");

// 3. The flow observed live, which carries NO numeric id anywhere. Before this
//    resolved, the console said "No event ID resolved" and a scan had no key
//    to store under — a parser alone would not have been enough.
const LIVE = "/qyNwCQAAAACR8mTJAAAAACb%2Fv%2F2F%2F%2FwD%2F%2F%2F%2FBXRoZW11AP";
check("opaque ticket-flow token", at(LIVE) === "qyNwCQAAAACR8mTJAAAAACb", String(at(LIVE)));
// The same token prefixes the API path the page then calls, which is what
// makes it usable as an identity rather than just a unique string.
check("the token also prefixes the veritix path",
  "/veritix/start-flow/v1/qyNwCQAAAACR8mTJAAAAACb%2Fv%2F2F".indexOf(at(LIVE)) > 0);

check("root is not an event", at("/") === null, String(at("/")));
check("a short segment is rejected", at("/abc") === null, String(at("/abc")));
check("a percent-escape alone is not an id", at("/%2F%2F%2F%2F%2F%2F") === null,
  String(at("/%2F%2F%2F%2F%2F%2F")));
// Numeric shapes must still win over the token fallback.
check("a numeric id outranks the token",
  at("/events/1234567/x") === "1234567", at("/events/1234567/x"));

out("");
out("--- the popup derives the same id ---");
// If these drift, the parser stores under one key and the dashboard looks
// under another, which presents as "captured nothing" with no error anywhere.
const popupId = (u) => {
  if (!/axs\.com/.test(u)) return null;
  const m = u.match(/\/events?\/(\d{4,})/i)
    || u.match(/[?&]eventId=(\d{4,})/i)
    || u.match(/[?&]e=(\d{6,})/i)
    || u.match(/^https?:\/\/[^/]*tix\.axs\.com\/([A-Za-z0-9_-]{12,})/i);
  return m ? m[1] : null;
};
const LIVE_URL = "https://tix.axs.com" + LIVE + "?rt=AfterEvent";
check("agrees on the live ticket flow", popupId(LIVE_URL) === at(LIVE), popupId(LIVE_URL));
check("agrees on a browse page",
  popupId("https://www.axs.com/events/1234567/x") === "1234567");
check("agrees on the e= flow",
  popupId("https://tix.axs.com/nZA9NwAAAAABIj1H?c=axs&e=92678159754876303")
  === "92678159754876303");
check("the token branch is scoped to tix.axs.com",
  popupId("https://www.axs.com/somethingverylongindeed") === null,
  "a browse url must not yield a token id");
check("other sites unaffected", popupId("https://gametime.co/x/events/abcdef123456") === null);
check("popup keys off axs:<id>", /axs:\$\{axsEventId\}/.test(popup));

out("");
out("--- manifest and site wiring ---");
check("host permission", mf.host_permissions.some((h) => h.includes("axs")));
const main = mf.content_scripts.find((c) => c.world === "MAIN" && c.matches.join().includes("axs"));
check("MAIN world entry", !!main, main && main.js.join(" -> "));
check("adapter shipped", !!main && main.js.includes("axs-adapter.js"));
check("the ticket-flow host is covered", mf.host_permissions.concat(
  mf.content_scripts.reduce((a, c) => a.concat(c.matches), []))
  .some((p) => /\*\.axs\.com/.test(p)), "tix.axs.com is a different host from www");

out("");
out("--- what the popup claims must match what exists ---");
// This file was written while AXS had no parser and was nevertheless listed as
// passive capture, so the empty state told people "the tickets will be captured
// automatically" for a site that stored nothing. Both halves are asserted now,
// together: whichever way they drift, they must not disagree.
const passive = eval("(" + popup.match(/const PASSIVE_SITE_LABELS = \{[^}]*\}/)[0]
  .replace(/^const PASSIVE_SITE_LABELS = /, "") + ")");
const hasParser = /function saveAxsSeats/.test(bg);
check("there is a parser", hasParser);
check("advertised as passive capture", !!passive.axs, passive.axs);
check("the claim and the parser agree", hasParser === !!passive.axs,
  hasParser ? "parser exists but the popup does not offer capture"
            : "the popup promises automatic capture for a site nothing parses");
check("no longer flagged unsupported", !/unsupported: isAxsEvent/.test(popup));

out("");
out("--- captures the endpoint that actually holds inventory ---");
// "/veritix/" was captured for a long time on the belief that start-flow was
// the largest JSON the page fetched. It is 34KB of session and config; the
// inventory is 1250KB at /axsmarketplace/offers, and no seat ever came from
// start-flow.
check("offers is matched", /"\/axsmarketplace\/offers"/.test(inj));
check("mapinfo is matched", /"\/axsmarketplace\/mapinfo"/.test(inj));
check("start-flow is still matched for identity", /"\/veritix\/start-flow\/"/.test(inj),
  "it is the only source for the event name and venue");
check("the dispatch requires a listings array", /Array\.isArray\(body\.listings\)/.test(bg));

out("");
out("--- the probe says whether it is armed ---");
// A capture came back with no probe output and the build stamp matched either
// way, because BUILD_STAMP only changes when package.py runs. On an unpacked
// build it cannot tell you whether chrome://extensions was reloaded.
check("the banner exists", /discovery probe ARMED for/.test(inj));
check("and names the disarmed case too", /discovery probe is DISARMED/.test(inj));
// It must sit BELOW the DISCOVERY_SITE declaration. Called from the site
// if/else chain instead, it reads the const inside its temporal dead zone and
// injected.js throws on load for every AXS page.
const declAt = inj.indexOf("const DISCOVERY_SITE =");
const bannerAt = inj.indexOf("discovery probe ARMED for");
check("the banner reads DISCOVERY_SITE after it is initialised",
  declAt > 0 && bannerAt > declAt, "banner at " + bannerAt + ", declaration at " + declAt);

out(fail ? "\n" + fail + " FAILURES" : "\nall passed");
process.exit(fail ? 1 : 0);
