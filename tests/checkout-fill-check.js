// Checkout fill (v3.6.0). The rules this suite exists to hold:
//   1. it types into card + billing boxes and NOTHING else: no button, no
//      submit, no payment-method radio, no "save card", no reCAPTCHA — the one
//      click allowed is a role="option" entry in the State/Country list;
//   2. card data goes only to frames on CHECKOUT_FILL_ORIGINS, accounts are
//      accepted only from TicketPortal's page, and the panel never sees the card;
//   3. nothing is written to disk or logged.
const fs = require("fs");
const EXT = require("./ext-dir");
const extractFn = require("./extract-fn");
const fillSrc = fs.readFileSync(EXT + "checkout-fill.js", "utf8");
const bg = fs.readFileSync(EXT + "background.js", "utf8");
const panel = fs.readFileSync(EXT + "checkout-panel.js", "utf8");
const bridge = fs.readFileSync(EXT + "portal-bridge.js", "utf8");
const mf = JSON.parse(fs.readFileSync(EXT + "manifest.json", "utf8"));

let fail = 0;
const out = console.log;
const check = (l, c, d) => { if (!c) fail++; out(`${c ? "ok  " : "FAIL"} ${l}${d !== undefined ? " - " + d : ""}`); };

// The top-level helpers, loaded as the background loads them.
const api = new Function(fillSrc + "\nreturn { CHECKOUT_FILL_ORIGINS, formatExpiry, stateNames, checkoutFillData, checkoutLabel };")();

out("--- formatting ---");
check("expiry 01/2029 -> 01/29", api.formatExpiry("01/2029") === "01/29");
check("expiry 1/29 -> 01/29", api.formatExpiry("1/29") === "01/29");
check("expiry 0129 -> 01/29", api.formatExpiry("0129") === "01/29");
check("expiry 2029-01 -> 01/29", api.formatExpiry("2029-01") === "01/29");
check("expiry 12-2030 -> 12/30", api.formatExpiry("12-2030") === "12/30");
check("expiry month 13 refused", api.formatExpiry("13/2029") === null);
check("expiry junk refused", api.formatExpiry("soon") === null && api.formatExpiry("") === null);
check("state code -> name", JSON.stringify(api.stateNames("ny")) === '{"code":"NY","name":"New York"}');
check("state name -> code", api.stateNames("missouri").code === "MO");
check("unknown state kept as typed", api.stateNames("Ontario").name === "Ontario");
const card = { cc: "4111 1111 1111 1111", cvv: "123", exp: "01/2029", name: "John Doe", brand: "Visa", email: "jdoe@outlook.com",
  address1: "123 Main St", address2: "", city: "Anytown", state: "NY", zip: "10001", phone: "(555) 123-4567" };
const data = api.checkoutFillData(card);
check("fill data: digits only for card, cvv, phone", data.cc === "4111111111111111" && data.cvv === "123" && data.phone === "5551234567");
check("fill data: expiry formatted, state both ways", data.exp === "01/29" && data.stateCode === "NY" && data.stateName === "New York");
check("fill data: carries no email or brand", !("email" in data) && !("brand" in data));
const label = api.checkoutLabel(card);
check("label: masked email", label.email === "j•••@outlook.com", label.email);
check("label: last four only", label.last4 === "1111" && !JSON.stringify(label).includes("4111111111111111"));
check("label: no security code or expiry", !JSON.stringify(label).includes("123\"") && !JSON.stringify(label).includes("2029"));

out("\n--- a fill against a fake checkout ---");
function el(attrs) {
  const e = { attrs, value: "", events: [], textContent: attrs.text || "",
    getAttribute: (n) => (attrs[n] == null ? null : String(attrs[n])),
    focus() {}, select() {}, blur() {}, dispatchEvent(ev) { e.events.push(ev.type); return true; } };
  return e;
}
const F = {
  name: el({ "data-testid": "card-details-name", name: "nameOnCard" }),
  cc: el({ "data-testid": "card-details-number", name: "cardNumber", autocomplete: "cc-number" }),
  exp: el({ "data-testid": "card-details-expiry-date", name: "expirationDate", autocomplete: "cc-exp" }),
  cvv: el({ "data-testid": "card-details-security-code", name: "securityCode" }),
  save: el({ "data-testid": "card-details-save-card-checkbox", name: "saveCardForLaterUse" }),
  country: el({ "data-testid": "address-country-select", name: "country" }),
  a1: el({ "data-testid": "address-line-one", name: "address" }),
  a2: el({ "data-testid": "address-line-two", name: "complementaryAddress" }),
  city: el({ "data-testid": "address-city", name: "city" }),
  zip: el({ "data-testid": "address-postal-code", name: "postalCode" }),
  state: el({ "data-testid": "address-state-select", name: "stateCode" }),
  phone: el({ "data-testid": "address-phone-number", name: "phone" }),
  radio: el({ name: "payment-method" }),
  captcha: el({ name: "g-recaptcha-response" }),
};
F.country.value = "United States";
const options = [el({ role: "option", text: "New Mexico" }), el({ role: "option", text: "New York" }), el({ role: "option", text: "North Carolina" })];
const placeOrder = el({ type: "submit", text: "Place Order" });
const all = Object.values(F);
const doc = {
  querySelector(sel) {
    const m = /^(?:input)?\[(data-testid|name|autocomplete)="([^"]+)"\]$/.exec(sel);
    if (!m) return null;
    return all.find((x) => x.attrs[m[1]] === m[2]) || null;
  },
  querySelectorAll(sel) { return sel === '[role="option"]' ? options : []; },
};
class Ev { constructor(type) { this.type = type; } }
const runFill = new Function("document", "location", "Event", "MouseEvent", "setTimeout",
  "return (async " + extractFn(fillSrc, "fillCheckoutFrame").replace(/^async\s+/, "") + ");");
const ORIG = api.CHECKOUT_FILL_ORIGINS;

(async () => {
  const fill = runFill(doc, { origin: "https://payments-cc.ticketmaster.com" }, Ev, Ev, (f) => f());
  const r = await fill(data, ORIG);
  check("card number typed", F.cc.value === "4111111111111111");
  check("expiry typed as MM/YY", F.exp.value === "01/29");
  check("security code typed", F.cvv.value === "123");
  check("name, address, city, zip, phone typed",
    F.name.value === "John Doe" && F.a1.value === "123 Main St" && F.city.value === "Anytown" && F.zip.value === "10001" && F.phone.value === "5551234567");
  check("blank address line 2 left alone", F.a2.value === "" && F.a2.events.length === 0);
  check("state: typed, then the ONE matching option picked", F.state.value === "New York" &&
    options[1].events.join(",") === "mousedown,mouseup,click" && options[0].events.length === 0 && options[2].events.length === 0);
  check("country already set -> untouched", F.country.value === "United States" && F.country.events.length === 0);
  check("page sees input + change events", F.cc.events.includes("input") && F.cc.events.includes("change"));
  check("save-card box, payment radio, reCAPTCHA untouched",
    F.save.events.length === 0 && F.radio.events.length === 0 && F.captcha.events.length === 0 && F.captcha.value === "");
  check("Place order never pressed", placeOrder.events.length === 0);
  check("report names fields, never values", r.missed.length === 0 && r.filled.length === 9 &&
    !JSON.stringify(r).match(/4111|John|Main|10001|123"/), JSON.stringify(r));

  // Ambiguous list: two entries match -> pick nothing, leave it to the person.
  options.forEach((o) => { o.events = []; });
  const dup = [el({ role: "option", text: "New York" }), el({ role: "option", text: "New York" })];
  const doc2 = Object.assign({}, doc, { querySelectorAll: () => dup });
  F.state.value = ""; F.state.events = [];
  const r2 = await runFill(doc2, { origin: "https://payments-cc.ticketmaster.com" }, Ev, Ev, (f) => f())(data, ORIG);
  check("two matching options -> none clicked, state reported to check", dup.every((o) => o.events.length === 0) && r2.missed.includes("state"));

  // A frame on any other origin gets nothing done.
  F.cc.value = ""; F.cc.events = [];
  const r3 = await runFill(doc, { origin: "https://www.google.com" }, Ev, Ev, (f) => f())(data, ORIG);
  check("frame outside the allowed origins: skipped, nothing typed", r3.skipped === "https://www.google.com" && F.cc.value === "" && F.cc.events.length === 0);

  out("\n--- the rules, in the source ---");
  const fillFn = extractFn(fillSrc, "fillCheckoutFrame");
  const pick = extractFn(fillFn.replace(/^[\s\S]*?(function pickOption)/, "$1"), "pickOption");
  check("fill never calls .click()", !/\.click\(/.test(fillFn));
  check("fill never submits", !/submit|requestSubmit/i.test(fillFn));
  check("fill never touches the reCAPTCHA or payment method", !/recaptcha|payment-method|saveCard/i.test(fillFn));
  check("MouseEvent is used only inside pickOption", (fillFn.match(/MouseEvent/g) || []).length === (pick.match(/MouseEvent/g) || []).length && /MouseEvent/.test(pick));
  check("pickOption refuses anything that is not role=option", /getAttribute\("role"\) !== "option"/.test(pick));
  check("fill re-checks its own origin first", /allowed\.indexOf\(location\.origin\) < 0/.test(fillFn));
  check("allowed origins are Ticketmaster payment frames only", ORIG.length === 2 && ORIG.every((o) => /^https:\/\/payments(-cc)?\.ticketmaster\.com$/.test(o)));

  const block = bg.slice(bg.indexOf("// ==== checkout fill — BEGIN"), bg.indexOf("// ==== checkout fill — END"));
  check("background: checkout block present", block.length > 500);
  check("background imports checkout-fill.js", /importScripts\([^)]*"checkout-fill\.js"/.test(bg));
  check("background: accepts accounts only from TicketPortal's page", /sender\.url\.indexOf\(CHECKOUT_PORTAL_ORIGIN \+ "\/"\) !== 0/.test(extractFn(block, "checkoutLoad")));
  check("background: held in storage.session only, never storage.local", /chrome\.storage\.session\.set/.test(block) && !/storage\.local/.test(block));
  check("background: expires (alarm + read-time check)", /alarms\.create\("checkout-expire"/.test(block) && /expiresAt > Date\.now\(\)/.test(block));
  check("background: fill only from a Ticketmaster page's top frame", /sender\.frameId !== 0/.test(extractFn(block, "checkoutFill")) && /TM_PAGE_RE\.test/.test(extractFn(block, "checkoutFill")));
  check("background: card sent only to probed frames on the allowed origins",
    /CHECKOUT_FILL_ORIGINS\.indexOf\(p\.result\.origin\) >= 0/.test(block) && /target: \{ tabId, frameIds \}/.test(block));
  check("background: the panel's status carries the label, not the card", !/held\.card/.test(extractFn(block, "checkoutStatus")));
  check("background: never logs card data", !/bgLog\([^;]*(card|held|cc|cvv|data)\b/.test(block.replace(/bgLog\("\[checkout\] account loaded[^;]*;/, "")));

  check("panel: Fill and Clear need a trusted click", (panel.match(/if \(!ev\.isTrusted\) return;/g) || []).length === 2);
  check("panel: closed shadow root", /attachShadow\(\{ mode: "closed" \}\)/.test(panel));
  check("bridge: same window + portal origin only", /ev\.source !== window \|\| ev\.origin !== PORTAL_ORIGIN/.test(bridge));

  const cs = mf.content_scripts || [];
  const bridgeCs = cs.filter((c) => (c.js || []).includes("portal-bridge.js"));
  check("manifest: bridge runs on the portal only", bridgeCs.length === 1 && JSON.stringify(bridgeCs[0].matches) === '["https://melodic-belekoy-ba321e.netlify.app/*"]');
  check("manifest: panel on Ticketmaster only", cs.some((c) => (c.js || []).includes("checkout-panel.js") && JSON.stringify(c.matches) === '["https://*.ticketmaster.com/*"]'));
  check("manifest: no all_frames content script carries the panel or bridge", !cs.some((c) => c.all_frames && ((c.js || []).includes("checkout-panel.js") || (c.js || []).includes("portal-bridge.js"))));

  out(`\n${fail ? fail + " FAILED" : "all passed"}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { out("FAIL the suite crashed - " + (e && e.message)); process.exit(1); });
