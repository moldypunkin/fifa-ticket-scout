// Checkout survey (v3.5.2): lists how a checkout names its fields, for building
// TicketPortal's checkout filler. The one rule that matters: IT NEVER READS WHAT
// IS IN A FIELD. Every fake field and option below throws if `value`, `checked`
// or `selectedIndex` is touched, so a survey that reads one fails here.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const src = fs.readFileSync(EXT + "checkout-survey.js", "utf8");
const popup = fs.readFileSync(EXT + "popup.js", "utf8");
const popupHtml = fs.readFileSync(EXT + "popup.html", "utf8");
const mf = JSON.parse(fs.readFileSync(EXT + "manifest.json", "utf8"));

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d ? " - " + d : ""}`); };

const SECRET = () => { throw new Error("the survey read a field's contents"); };
function el(tag, attrs, extra) {
  extra = extra || {};
  const e = {
    tagName: tag.toUpperCase(),
    getAttribute: (n) => (attrs && attrs[n] != null ? String(attrs[n]) : null),
    hasAttribute: (n) => !!(attrs && n in attrs),
    labels: extra.labels || [],
    textContent: extra.text || "",
    shadowRoot: extra.shadowRoot || null,
    getClientRects: () => (extra.hidden ? [] : [{}]),
    getBoundingClientRect: () => ({ width: 300, height: 40 }),
    querySelectorAll: (sel) => (sel === "option" ? (extra.options || []) : []),
  };
  for (const k of ["value", "checked", "selectedIndex", "selectedOptions"]) Object.defineProperty(e, k, { get: SECRET });
  return e;
}
const opt = (v, t) => el("option", { value: v }, { text: t });

const cc = el("input", { type: "text", name: "cardNumber", id: "cc", autocomplete: "cc-number", placeholder: "4111 1111 1111 1111", "data-bdd": "card-number" },
  { labels: [{ textContent: " Card  number " }] });
const month = el("select", { name: "expMonth", autocomplete: "cc-exp-month" }, { options: [opt("", "Month"), opt("01", "01"), opt("02", "02")] });
const year = el("select", { name: "expYear" }, { options: [opt("2029", "2029"), opt("41111111", "Visa •••• 41111111")] });
const token = el("input", { type: "hidden", name: "csrf" });
const zipInShadow = el("input", { name: "zip", autocomplete: "postal-code" }, { hidden: true });
const shadow = { querySelectorAll: (sel) => (sel === "input, select, textarea" ? [zipInShadow] : []) };
const host = el("div", {}, { shadowRoot: shadow });
const frame = el("iframe", { src: "https://pay.example.com/hosted/card?token=SECRETTOKEN#x", title: "Secure card" });

const doc = {
  title: "Checkout | Ticketmaster",
  getElementById: () => null,
  querySelectorAll: (sel) => sel === "input, select, textarea" ? [cc, month, year, token]
    : sel === "iframe" ? [frame] : sel === "*" ? [host] : [],
};
const loc = { href: "https://checkout.ticketmaster.com/abc/pay?session=SECRET#step2" };
const win = {}; win.top = win;

const run = new Function("document", "location", "window", src + "\nreturn surveyCheckoutFrame();");
let r = null, err = null;
try { r = run(doc, loc, win); } catch (e) { err = e; }

out("--- never reads contents ---");
check("survey runs against fields whose value throws", !err, err && err.message);
check("source never touches .value / .checked / .selectedIndex", !/\.(value|checked|selectedIndex|selectedOptions)\b/.test(src));

if (r) {
  out("\n--- what it records ---");
  const byName = Object.fromEntries(r.fields.map((f) => [f.name, f]));
  check("frame: origin + path only (no query or hash)", r.frame === "https://checkout.ticketmaster.com/abc/pay", r.frame);
  check("top frame flagged", r.top === true);
  check("hidden inputs counted, never listed", r.hiddenInputs === 1 && !byName.csrf);
  check("autocomplete hint recorded", byName.cardNumber && byName.cardNumber.autocomplete === "cc-number");
  check("label text recorded, tidied", byName.cardNumber && byName.cardNumber.label === "Card number", byName.cardNumber && byName.cardNumber.label);
  check("data-bdd recorded", byName.cardNumber && byName.cardNumber.dataBdd === "card-number");
  check("digit runs in a placeholder are masked", byName.cardNumber && byName.cardNumber.placeholder === "#### #### #### ####", byName.cardNumber && byName.cardNumber.placeholder);
  check("field inside an open shadow root found", !!byName.zip && byName.zip.visible === false);
  check("select: choices listed, month format visible", byName.expMonth && byName.expMonth.options === 3 && byName.expMonth.optionSample[1] === "01=01");
  check("select: a 4-digit year is kept", byName.expYear && byName.expYear.optionSample[0] === "2029=2029");
  check("select: a long number in a choice is masked", byName.expYear && byName.expYear.optionSample[1] === "########=Visa •••• ########", byName.expYear && byName.expYear.optionSample[1]);
  check("iframe: src reduced to origin + path (token dropped)", r.iframes.length === 1 && r.iframes[0].src === "https://pay.example.com/hosted/card", r.iframes[0] && r.iframes[0].src);
  check("nothing secret anywhere in the report", !/SECRET|4111/.test(JSON.stringify(r)));
}

out("\n--- wiring ---");
check("popup loads checkout-survey.js before popup.js",
  popupHtml.indexOf('src="checkout-survey.js"') > 0 && popupHtml.indexOf('src="checkout-survey.js"') < popupHtml.indexOf('src="popup.js"'));
check("popup runs it in every frame", /executeScript\(\{ target: \{ tabId: tab\.id, allFrames: true \}, func: surveyCheckoutFrame \}\)/.test(extractFn(popup, "surveyCheckout")));
check("manifest has the scripting permission", (mf.permissions || []).includes("scripting"));
check("the survey only runs when the button is clicked", /onClick\("surveyBtn", surveyCheckout\)/.test(popup));

out(`\n${fail ? fail + " FAILED" : "all passed"}`);
process.exit(fail ? 1 : 0);
