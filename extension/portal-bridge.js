// Portal bridge (v3.6.0) — runs ONLY on TicketPortal (manifest: one match).
//
// The portal's "⇢ Load for checkout" fetches the account's card through its own
// Edge function and posts it to this page's window. This script accepts it only
// from this page itself (same window, same origin, the expected message type),
// hands it to the background, and answers with an ack so the portal can say
// "loaded" — or tell the person Ticket Scout is missing or out of date.
//
// It keeps nothing: the background holds the card in chrome.storage.session
// (memory only) and clears it after 10 minutes or on Clear.
(function () {
  const PORTAL_ORIGIN = "https://melodic-belekoy-ba321e.netlify.app";
  if (location.origin !== PORTAL_ORIGIN) return;

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.origin !== PORTAL_ORIGIN) return;
    const m = ev.data;
    if (!m || typeof m !== "object") return;
    const reply = (extra) => window.postMessage(Object.assign({ type: "TS_CHECKOUT_ACK", nonce: m.nonce,
      version: chrome.runtime.getManifest().version }, extra), PORTAL_ORIGIN);
    if (m.type === "TS_CHECKOUT_PING") { reply({ ok: true, ping: true }); return; }
    if (m.type !== "TS_CHECKOUT_LOAD" || !m.card || typeof m.card !== "object") return;
    try {
      chrome.runtime.sendMessage({ type: "CHECKOUT_LOAD", card: m.card }, (res) => {
        if (chrome.runtime.lastError) { reply({ ok: false, error: "Ticket Scout did not answer — reload it in chrome://extensions" }); return; }
        reply(res && res.ok ? { ok: true, minutes: res.minutes } : { ok: false, error: (res && res.error) || "not loaded" });
      });
    } catch (e) {
      reply({ ok: false, error: "Ticket Scout was updated — refresh this page" });
    }
  });
})();
