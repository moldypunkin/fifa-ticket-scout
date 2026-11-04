// Checkout panel (v3.6.0) — the small box on a Ticketmaster checkout that says
// WHICH account is loaded, with Fill and Clear.
//
// Shows only when TicketPortal has loaded an account AND this page has a card
// form (the payments page, or a page holding Ticketmaster's credit-card frame).
// It never sees card numbers: the background answers CHECKOUT_STATUS with a
// masked label only, and does the fill itself in the card frame.
//
// Fill runs on a TRUSTED click only (event.isTrusted), so nothing on the page
// can press it. The panel lives in a closed shadow root for the same reason.
(function () {
  if (window.top !== window) return;
  const looksLikeCheckout = () => location.hostname === "payments.ticketmaster.com" ||
    !!document.querySelector('iframe#credit-card-iframe, iframe[src*="payments-cc.ticketmaster.com"]');

  let host = null, root = null, lastLabel = "";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function build() {
    host = document.createElement("div");
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      .p{font:13px/1.4 system-ui,sans-serif;background:#111827;color:#f9fafb;border-radius:10px;padding:10px 12px;
         box-shadow:0 6px 24px rgba(0,0,0,.35);min-width:240px;max-width:320px}
      .t{font-weight:600;margin-bottom:4px} .who{color:#d1d5db} .sub{color:#9ca3af;font-size:12px;margin-top:2px}
      .row{display:flex;gap:8px;margin-top:8px}
      button{font:inherit;border:0;border-radius:6px;padding:6px 12px;cursor:pointer}
      .fill{background:#f59e0b;color:#111827;font-weight:600} .clr{background:#374151;color:#f9fafb}
      .res{margin-top:6px;font-size:12px;color:#d1d5db} .warn{color:#fbbf24}
    </style>
    <div class="p"><div class="t">Ticket Scout · checkout fill</div>
      <div class="who"></div><div class="sub"></div>
      <div class="row"><button class="fill">Fill</button><button class="clr">Clear</button></div>
      <div class="res">Fills card + billing only. You press Place order.</div></div>`;
    root.querySelector(".fill").addEventListener("click", onFill);
    root.querySelector(".clr").addEventListener("click", onClear);
    document.documentElement.appendChild(host);
  }
  function hide() { if (host) { host.remove(); host = null; root = null; lastLabel = ""; } }

  function show(st) {
    if (!host) build();
    const l = st.label || {};
    const who = [l.email, (l.brand || "Card") + (l.last4 ? " ••" + l.last4 : ""), l.name].filter(Boolean).join(" · ");
    if (who !== lastLabel) { root.querySelector(".who").textContent = who; lastLabel = who; }
    const mins = Math.max(0, Math.ceil((st.expiresAt - Date.now()) / 60000));
    root.querySelector(".sub").textContent = "Loaded from TicketPortal · clears in " + mins + " min";
  }

  function onFill(ev) {
    if (!ev.isTrusted) return;
    const res = root.querySelector(".res");
    res.className = "res"; res.textContent = "Filling…";
    chrome.runtime.sendMessage({ type: "CHECKOUT_FILL" }, (r) => {
      if (!root) return;
      if (chrome.runtime.lastError || !r) { res.className = "res warn"; res.textContent = "Ticket Scout did not answer — reload the page."; return; }
      if (r.error) { res.className = "res warn"; res.textContent = r.error; return; }
      const miss = (r.missed || []);
      res.className = "res" + (miss.length ? " warn" : "");
      res.innerHTML = "Filled " + (r.filled || []).length + " field(s)." +
        (miss.length ? " Check: <b>" + esc(miss.join(", ")) + "</b>." : "") + " Review, then Place order yourself.";
    });
  }
  function onClear(ev) {
    if (!ev.isTrusted) return;
    chrome.runtime.sendMessage({ type: "CHECKOUT_CLEAR" }, () => hide());
  }

  function poll() {
    if (document.hidden) return;
    try {
      chrome.runtime.sendMessage({ type: "CHECKOUT_STATUS" }, (st) => {
        if (chrome.runtime.lastError) return;
        if (st && st.loaded && looksLikeCheckout()) show(st); else hide();
      });
    } catch (e) { hide(); }   // extension reloaded underneath this page
  }
  poll();
  setInterval(poll, 4000);
  document.addEventListener("visibilitychange", poll);
})();
