// Checkout survey (v3.5.2) — step 1 of TicketPortal's checkout filler.
//
// The popup's "Survey checkout page" button runs surveyCheckoutFrame() in every
// frame of the current tab (chrome.scripting.executeScript, allFrames) and copies
// the result, so we can see how a checkout names its fields before writing a
// filler against them.
//
// IT NEVER READS WHAT IS IN A FIELD. It records only how each field is labelled:
// tag, type, name, id, autocomplete hint, placeholder, label text, and a few test
// attributes. tests/checkout-survey-check.js runs it against fake fields whose
// `value` throws, so reading one fails the suite. Hidden inputs (tokens) are only
// counted. Long digit runs in any text it does record are masked (maskDigits).
//
// executeScript serialises the function it is given, so surveyCheckoutFrame must
// be self-contained: everything it needs is declared inside it.

function surveyCheckoutFrame() {
  // Digit runs that could be part of a card or account number become '#'. A
  // 4-digit year (19xx/20xx) is kept: expiry-year menus are what we need to see.
  function maskDigits(s) {
    return String(s == null ? "" : s).replace(/\d{4,}/g, function (run) {
      return /^(19|20)\d\d$/.test(run) ? run : "#".repeat(run.length);
    });
  }
  function clip(s, n) {
    s = maskDigits(String(s == null ? "" : s).replace(/\s+/g, " ").trim());
    return s.length > n ? s.slice(0, n) + "…" : s;
  }
  function attr(el, name) {
    var v = el.getAttribute ? el.getAttribute(name) : null;
    return v == null ? "" : clip(v, 80);
  }
  function where(u) {
    try { var x = new URL(u, location.href); return x.origin + x.pathname; } catch (e) { return ""; }
  }
  function visible(el) {
    try { return !!(el.getClientRects && el.getClientRects().length); } catch (e) { return false; }
  }
  function labelOf(el) {
    try {
      if (el.labels && el.labels.length) return clip(el.labels[0].textContent, 80);
      var by = el.getAttribute && el.getAttribute("aria-labelledby");
      if (by && el.ownerDocument) {
        var t = by.split(/\s+/).map(function (id) {
          var n = el.ownerDocument.getElementById(id); return n ? n.textContent : "";
        }).join(" ");
        if (t.trim()) return clip(t, 80);
      }
    } catch (e) { /* a label we cannot read is just blank */ }
    return "";
  }
  // Walk the document and any OPEN shadow roots (closed ones cannot be reached).
  function all(root, sel, out, depth) {
    out = out || []; depth = depth || 0;
    var list = root.querySelectorAll ? root.querySelectorAll(sel) : [];
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    if (depth < 6) {
      var hosts = root.querySelectorAll ? root.querySelectorAll("*") : [];
      for (var j = 0; j < hosts.length; j++) if (hosts[j].shadowRoot) all(hosts[j].shadowRoot, sel, out, depth + 1);
    }
    return out;
  }

  var fields = [], hidden = 0;
  all(document, "input, select, textarea").forEach(function (el) {
    var tag = String(el.tagName || "").toLowerCase();
    var type = tag === "input" ? (attr(el, "type") || "text").toLowerCase() : tag;
    if (type === "hidden") { hidden++; return; }
    var f = {
      tag: tag, type: type, name: attr(el, "name"), id: attr(el, "id"),
      autocomplete: attr(el, "autocomplete"), placeholder: attr(el, "placeholder"),
      ariaLabel: attr(el, "aria-label"), label: labelOf(el),
      dataBdd: attr(el, "data-bdd"), dataTestid: attr(el, "data-testid"), dataQa: attr(el, "data-qa"),
      maxLength: attr(el, "maxlength"), required: !!(el.hasAttribute && el.hasAttribute("required")),
      visible: visible(el),
    };
    if (tag === "select") {
      // The menu's CHOICES, never which one is picked: a month menu reading
      // "01".."12" vs "January".."December" decides how expiry is filled.
      var opts = el.querySelectorAll ? el.querySelectorAll("option") : [];
      f.options = opts.length;
      f.optionSample = [];
      for (var k = 0; k < opts.length && k < 6; k++) {
        f.optionSample.push(clip(opts[k].getAttribute("value"), 20) + "=" + clip(opts[k].textContent, 20));
      }
    }
    fields.push(f);
  });

  var frames = all(document, "iframe").map(function (fr) {
    var r = null; try { r = fr.getBoundingClientRect(); } catch (e) { /* detached */ }
    return {
      src: where(fr.getAttribute("src") || ""), name: attr(fr, "name"), id: attr(fr, "id"),
      title: attr(fr, "title"), size: r ? Math.round(r.width) + "x" + Math.round(r.height) : "",
    };
  });

  return {
    frame: where(location.href), top: window.top === window, title: clip(document.title, 80),
    fields: fields, hiddenInputs: hidden, iframes: frames,
  };
}
