// Checkout filler (v3.6.0) — fills Ticketmaster's checkout card + billing form
// from the account TicketPortal loaded ("⇢ Load for checkout").
//
// THE RULES, each enforced by tests/checkout-fill-check.js:
//   * A person starts every fill: the Fill button on the checkout panel
//     (checkout-panel.js), a trusted click only.
//   * It types into the card and billing boxes and NOTHING ELSE. It never
//     clicks a button, never submits a form, never touches the payment-method
//     choice, the "save this card" box or the reCAPTCHA. The one click it may
//     make is picking the State/Country entry out of the type-ahead list
//     (pickOption), and only on an element with role="option".
//   * Card data only goes to frames on CHECKOUT_FILL_ORIGINS, and the fill
//     re-checks its own origin before touching anything.
//   * Values are never logged. The report names FIELDS, never what went in.
//
// Field names come from the 3.5.2 survey of a real checkout (2026-11-04): every
// box sits in one frame on payments-cc.ticketmaster.com and carries a stable
// data-testid. name= is the fallback; cc-number / cc-exp autocomplete the last.
//
// Loaded by background.js (importScripts), which runs checkoutFrameProbe and
// fillCheckoutFrame inside the page with chrome.scripting.executeScript. That
// serialises the function, so both must be self-contained.

const CHECKOUT_FILL_ORIGINS = [
  "https://payments-cc.ticketmaster.com",
  "https://payments.ticketmaster.com",
];

const US_STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

// "01/2029", "1/29", "0129", "01-2029", "2029-01" -> "01/29" (the box takes MM/YY). null if unreadable.
function formatExpiry(exp) {
  const s = String(exp == null ? "" : exp).trim();
  let m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m) return pad2(m[2]) + "/" + m[1].slice(2);
  m = /^(\d{1,2})\s*[\/\-. ]\s*(\d{2}|\d{4})$/.exec(s);
  if (!m) m = /^(\d{2})(\d{2}|\d{4})$/.exec(s);
  if (!m) return null;
  const mm = Number(m[1]);
  if (mm < 1 || mm > 12) return null;
  return pad2(m[1]) + "/" + m[2].slice(-2);
}
function pad2(n) { n = String(n); return n.length < 2 ? "0" + n : n; }

// The state as both the code and the full name: the type-ahead may list either.
function stateNames(state) {
  const s = String(state == null ? "" : state).trim();
  if (!s) return null;
  const code = s.toUpperCase();
  if (US_STATES[code]) return { code, name: US_STATES[code] };
  const hit = Object.keys(US_STATES).find((k) => US_STATES[k].toLowerCase() === s.toLowerCase());
  return hit ? { code: hit, name: US_STATES[hit] } : { code: "", name: s };
}

// What the fill function receives: only the fields it types, already formatted.
function checkoutFillData(card) {
  const c = card || {};
  const st = stateNames(c.state);
  return {
    name: c.name || "", cc: String(c.cc || "").replace(/\D/g, ""), exp: formatExpiry(c.exp) || "",
    cvv: String(c.cvv || "").replace(/\D/g, ""), address1: c.address1 || "", address2: c.address2 || "",
    city: c.city || "", zip: c.zip || "", phone: String(c.phone || "").replace(/\D/g, ""),
    stateCode: st ? st.code : "", stateName: st ? st.name : "",
  };
}

// What the panel shows: enough to see WHICH account will fill, nothing usable.
function checkoutLabel(card) {
  const c = card || {};
  const em = String(c.email || "");
  const at = em.indexOf("@");
  const email = at > 0 ? em[0] + "•••" + em.slice(at) : "";
  const digits = String(c.cc || "").replace(/\D/g, "");
  return { email, brand: c.brand || "Card", last4: digits.slice(-4), name: c.name || "" };
}

// Runs in every frame of the checkout tab. Says where it is and how many known
// boxes it holds, so the background sends card data only to the right frame.
function checkoutFrameProbe() {
  const ids = ["card-details-name", "card-details-number", "card-details-expiry-date", "card-details-security-code",
    "address-line-one", "address-city", "address-postal-code", "address-phone-number"];
  let n = 0;
  for (const id of ids) if (document.querySelector('[data-testid="' + id + '"]')) n++;
  if (!n && document.querySelector('input[autocomplete="cc-number"]')) n = 1;
  return { origin: location.origin, fields: n };
}

// Runs ONLY in frames the probe picked. Types each value the way a person
// would (so the page's own formatting and checks run), then reports which
// boxes it filled. Never reads anything back out except to confirm its own
// value took.
async function fillCheckoutFrame(data, allowed) {
  if (!Array.isArray(allowed) || allowed.indexOf(location.origin) < 0) return { skipped: location.origin, filled: [], missed: [] };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const digits = (s) => String(s == null ? "" : s).replace(/\D/g, "");
  const find = (testid, name, auto) =>
    document.querySelector('[data-testid="' + testid + '"]') ||
    (name && document.querySelector('input[name="' + name + '"]')) ||
    (auto && document.querySelector('input[autocomplete="' + auto + '"]')) || null;

  function setValue(el, v) {
    const proto = typeof HTMLInputElement !== "undefined" ? HTMLInputElement.prototype : null;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  // Insert as typed text first (the page sees real input events and formats as
  // it would for a person); fall back to setting the value directly.
  function typeInto(el, v, numeric) {
    if (typeof el.focus === "function") el.focus();
    if (typeof el.select === "function") el.select();
    let ok = false;
    try {
      if (typeof document.execCommand === "function") document.execCommand("insertText", false, v);
      ok = numeric ? digits(el.value) === digits(v) : el.value === v;
    } catch (e) { ok = false; }
    if (!ok) {
      setValue(el, v);
      ok = numeric ? digits(el.value) === digits(v) : el.value === v;
    }
    if (typeof el.blur === "function") el.blur();
    return ok;
  }
  // The ONLY click this function makes: one entry in a type-ahead list.
  function pickOption(opt) {
    if (!opt || opt.getAttribute("role") !== "option") return false;
    for (const type of ["mousedown", "mouseup", "click"]) {
      opt.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
    return true;
  }
  async function typeAhead(el, wanted) {
    if (!typeInto(el, wanted[0], false)) return false;
    await wait(350);
    const want = wanted.filter(Boolean).map((w) => String(w).toLowerCase());
    const opts = Array.prototype.slice.call(document.querySelectorAll('[role="option"]')).filter((o) => {
      const t = String(o.textContent || "").trim().toLowerCase();
      return want.some((w) => t === w || t.indexOf("(" + w + ")") >= 0);
    });
    if (opts.length === 1) { pickOption(opts[0]); return true; }
    return false;   // left typed for the person to pick from the list
  }

  const filled = [], missed = [];
  const put = async (key, testid, name, auto, value, numeric) => {
    if (!value) return;
    const el = find(testid, name, auto);
    if (!el) { missed.push(key); return; }
    (typeInto(el, value, numeric) ? filled : missed).push(key);
    await wait(120);
  };

  await put("name", "card-details-name", "nameOnCard", "", data.name, false);
  await put("card number", "card-details-number", "cardNumber", "cc-number", data.cc, true);
  await wait(400);   // the CVV box only takes digits once the card brand is known
  await put("expiry", "card-details-expiry-date", "expirationDate", "cc-exp", data.exp, true);
  await put("security code", "card-details-security-code", "securityCode", "", data.cvv, true);
  await put("address", "address-line-one", "address", "", data.address1, false);
  await put("address line 2", "address-line-two", "complementaryAddress", "", data.address2, false);
  await put("city", "address-city", "city", "", data.city, false);
  await put("postal code", "address-postal-code", "postalCode", "", data.zip, false);

  const country = find("address-country-select", "country", "");
  if (country && !String(country.value || "").trim()) {
    (await typeAhead(country, ["United States", "United States of America", "US", "USA"]) ? filled : missed).push("country");
  }
  if (data.stateName || data.stateCode) {
    const st = find("address-state-select", "stateCode", "");
    if (!st) missed.push("state");
    else (await typeAhead(st, [data.stateName || data.stateCode, data.stateCode]) ? filled : missed).push("state");
  }
  await put("phone", "address-phone-number", "phone", "", data.phone, true);
  return { filled, missed };
}
