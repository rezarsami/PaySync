// content.js — scans the page for a BNPL offer, injects a compact overlay,
// and answers the popup's request for whatever it detected.
// bnpl-core.js is injected before this file (see manifest), so window.BNPLCore exists.

(function () {
  const core = window.BNPLCore;
  if (!core) return;

  let detectedOffer = null;

  // Look through visible text nodes for an offer pattern. We check element text
  // rather than the whole body string so we can anchor the overlay near the offer.
  function scanForOffer() {
    const candidates = document.querySelectorAll(
      "[data-bnpl], .bnpl-offer, p, span, div, li, label"
    );
    for (const el of candidates) {
      // Skip huge containers; we want the leaf-ish node that holds the offer text.
      if (el.children.length > 3) continue;
      const txt = (el.textContent || "").trim();
      if (txt.length < 8 || txt.length > 160) continue;
      if (!/payment|installment|\bx\s*\$|pay in \d/i.test(txt)) continue;
      const offer = core.detectOfferFromText(txt);
      if (offer) return { offer, anchor: el };
    }
    return null;
  }

  // Pull saved plans (device-only) so the overlay can warn about date collisions
  // at the checkout moment — the whole point of the feature.
  function loadPlans() {
    return new Promise((res) => {
      if (chrome?.storage?.local) {
        chrome.storage.local.get(["bnplPlans"], (r) => res(r.bnplPlans || []));
      } else res([]);
    });
  }

  // --- Purchase capture -----------------------------------------------------
  // When the page looks like a completed BNPL purchase (a confirmation page,
  // not just an offer), stash a prefilled draft plan so the popup can show a
  // "Confirm & add to calendar" card. We use the whole page's text for this so
  // scattered confirmation cues + the plan structure are seen together.
  function scanForCapture() {
    const bodyText = (document.body?.innerText || "").slice(0, 8000);
    const result = core.extractCapture(bodyText);
    if (!result) return;
    stashCapture(result.draft);
  }

  // Store the pending capture, de-duplicated so a page re-scan or a reload
  // doesn't queue the same purchase twice. Dedupe key = provider+amount+due.
  function stashCapture(draft) {
    if (!chrome?.storage?.local) return;
    chrome.storage.local.get(["pendingCaptures"], (r) => {
      const pending = r.pendingCaptures || [];
      const key = (d) => `${d.provider}|${d.amount}|${d.firstDue}`;
      if (pending.some((p) => key(p) === key(draft))) return; // already queued
      // Also skip if the user already has this exact plan saved.
      loadPlans().then((plans) => {
        if (plans.some((p) => key(p) === key(draft))) return;
        draft.source = location.hostname;
        pending.push(draft);
        chrome.storage.local.set({ pendingCaptures: pending }, updateBadge);
      });
    });
  }

  // Reflect the number of pending captures on the toolbar icon badge.
  function updateBadge() {
    if (!chrome?.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type: "REFRESH_BADGE" });
  }

  async function injectOverlay(offer, anchor) {
    if (document.getElementById("splitcheck-overlay")) return;

    const plans = await loadPlans();
    const collision = core.collisionForCandidate(
      { amount: offer.price, payments: offer.payments, provider: offer.provider },
      plans
    );

    const r = core.evaluateBNPL({
      price: offer.price, payments: offer.payments, provider: offer.provider,
      existingPlansTotal: plans.reduce((s, p) => s + (Number(p.amount) || 0), 0),
      existingPlansCount: plans.length,
      collision,
    });
    const worstAPR = core.evaluateBNPL({ price: offer.price, payments: offer.payments, provider: offer.provider, missedPayments: 1 }).apr;

    const box = document.createElement("div");
    box.id = "splitcheck-overlay";
    box.className = `sc-overlay sc-${r.tone === "warn" ? "warn" : r.tone === "ok" ? "ok" : "neutral"}`;
    box.innerHTML = `
      <div class="sc-head">
        <span class="sc-mark">◧</span>
        <span class="sc-name">Split Check</span>
        <button class="sc-close" aria-label="Dismiss">×</button>
      </div>
      <div class="sc-body">
        <div class="sc-verdict">${r.verdict}</div>
        <div class="sc-reason">${r.reason}</div>
        ${collision && collision.isCollision ? `<div class="sc-collision">📅 $${collision.total.toFixed(0)} would land in ${core.fmtRange(collision.start, collision.end)} across your plans</div>` : ""}
        <div class="sc-stats">
          <div><span class="sc-k">Per payment</span><span class="sc-v">$${r.perPayment.toFixed(2)}</span></div>
          <div><span class="sc-k">APR if you slip</span><span class="sc-v sc-hot">${worstAPR.toFixed(0)}%</span></div>
        </div>
      </div>
      <div class="sc-foot">Estimate · local only · not financial advice</div>
    `;
    document.body.appendChild(box);
    box.querySelector(".sc-close").onclick = () => box.remove();
  }

  function run() {
    const hit = scanForOffer();
    if (hit) {
      detectedOffer = hit.offer;
      injectOverlay(hit.offer, hit.anchor); // async; fire-and-forget
    }
    // Independently check whether this page is a completed purchase to capture.
    scanForCapture();
  }

  // Answer the popup.
  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, send) => {
      if (msg?.type === "GET_DETECTED_OFFER") { send({ offer: detectedOffer }); }
      return true;
    });
  }

  // Initial scan + a couple of retries for pages that render checkout late.
  run();
  let tries = 0;
  const iv = setInterval(() => { if (detectedOffer || ++tries > 6) return clearInterval(iv); run(); }, 700);
})();
