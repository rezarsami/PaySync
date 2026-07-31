// popup.js — reads inputs, calls the shared core, renders the verdict.
// Plans now carry due-date info so we can build a merged payment calendar and
// warn when a new purchase would collide with a week that's already loaded.
// Everything persists in chrome.storage.local (device-only).

const $ = (id) => document.getElementById(id);
const core = window.BNPLCore;

// Plan shape: { name, amount, provider, payments, paidCount, firstDue }
// Older saved plans may only have { name, amount } — migrate on load.
let plans = [];

// ---- storage ---------------------------------------------------------------
function loadPlans() {
  return new Promise((res) => {
    if (chrome?.storage?.local) {
      chrome.storage.local.get(["bnplPlans"], (r) => res(migrate(r.bnplPlans || [])));
    } else {
      try { res(migrate(JSON.parse(localStorage.getItem("bnplPlans") || "[]"))); }
      catch { res([]); }
    }
  });
}
function savePlans() {
  if (chrome?.storage?.local) chrome.storage.local.set({ bnplPlans: plans });
  else localStorage.setItem("bnplPlans", JSON.stringify(plans));
}
// Backfill sensible defaults for plans saved before the calendar existed.
function migrate(arr) {
  const todayISO = new Date().toISOString().slice(0, 10);
  return arr.map((p) => ({
    name: p.name || "Plan",
    amount: Number(p.amount) || 0,
    provider: p.provider || "generic",
    payments: Number(p.payments) || 4,
    paidCount: Number(p.paidCount) || 0,
    firstDue: p.firstDue || todayISO,
  }));
}

// ---- pending captures ------------------------------------------------------
// Purchases the content script auto-detected on confirmation pages, waiting for
// the user to confirm (and optionally correct) before joining the calendar.
let pendingCaptures = [];

function loadCaptures() {
  return new Promise((res) => {
    if (chrome?.storage?.local) chrome.storage.local.get(["pendingCaptures"], (r) => res(r.pendingCaptures || []));
    else res([]);
  });
}
function saveCaptures() {
  if (chrome?.storage?.local) chrome.storage.local.set({ pendingCaptures });
}

// ---- prefill from a detected offer on the active tab -----------------------
function prefillFromTab() {
  if (!chrome?.tabs?.query) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: "GET_DETECTED_OFFER" }, (resp) => {
      if (chrome.runtime.lastError) return; // no content script on this page
      if (resp?.offer) {
        $("price").value = resp.offer.price;
        $("payments").value = String(resp.offer.payments);
        if (resp.offer.provider && resp.offer.provider !== "generic")
          $("provider").value = resp.offer.provider;
        render();
      }
    });
  });
}

// ---- render ----------------------------------------------------------------
function render() {
  const price = parseFloat($("price").value) || 0;
  const payments = parseInt($("payments").value, 10);
  const provider = $("provider").value;
  const missed = parseInt($("missed").value, 10);
  $("missedN").textContent = missed;

  const existingTotal = plans.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const existingCount = plans.length;

  $("missed").max = String(payments);
  $("stackSummary").textContent = existingCount
    ? `${existingCount} plan${existingCount > 1 ? "s" : ""} · $${existingTotal.toFixed(0)} outstanding`
    : "No plans saved";

  // No price entered yet: don't evaluate a phantom purchase. Show a neutral
  // prompt and reflect the real calendar state, nothing more.
  if (price <= 0) {
    renderNextCollision(null, true); // shows real saved-calendar state or hides
    $("verdict").className = "verdict neutral";
    $("verdict").innerHTML = `<div class="v-title">Check a purchase</div><div class="v-reason">Enter a price above to see what splitting it really costs — and whether it lands on a busy week.</div>`;
    $("breakdown").innerHTML = "";
    return;
  }

  // Does THIS purchase collide with an already-busy week? Assume its first
  // payment lands about now (typical pay-in-4 first installment at checkout).
  // Guard: if the price/provider/split already matches a saved plan, this isn't
  // a *candidate* purchase — it's already on the calendar, so checking it would
  // collide it against itself. In that case, don't run the candidate check.
  const alreadyaPlan = plans.some((p) =>
    p.provider === provider &&
    (p.payments || 4) === payments &&
    Math.abs((Number(p.amount) || 0) - price) < 0.01
  );
  const collision = (!alreadyaPlan)
    ? core.collisionForCandidate({ amount: price, payments, provider }, plans)
    : null;

  renderNextCollision(collision, alreadyaPlan);

  const r = core.evaluateBNPL({
    price, payments, provider,
    missedPayments: missed,
    existingPlansTotal: existingTotal,
    existingPlansCount: existingCount,
    collision,
  });

  const v = $("verdict");
  v.className = `verdict ${r.tone === "warn" ? "warn" : r.tone === "ok" ? "ok" : "neutral"}`;
  v.innerHTML = `<div class="v-title">${r.verdict}</div><div class="v-reason">${r.reason}</div>`;

  const aprClass = r.apr >= 30 ? "coral" : "mint";
  $("breakdown").innerHTML = `
    <div class="stat"><div class="k">Per payment</div><div class="val">$${r.perPayment.toFixed(2)}</div><div class="sub">every ${r.cadence === "monthly" ? "month" : "2 weeks"}</div></div>
    <div class="stat"><div class="k">True cost</div><div class="val ${r.feePaid > 0 ? "coral" : ""}">$${r.trueCost.toFixed(2)}</div><div class="sub">${r.feePaid > 0 ? `incl. $${r.feePaid.toFixed(2)} late fees` : "if paid on time"}</div></div>
    <div class="stat wide"><div class="k">Effective APR ${missed > 0 ? "" : "(if you slip)"}</div><div class="val ${aprClass}">${(missed > 0 ? r.apr : core.evaluateBNPL({price,payments,provider,missedPayments:1}).apr).toFixed(0)}%</div><div class="sub">${missed > 0 ? "based on your missed payments" : "annualized cost of missing one payment"}</div></div>
  `;
}

function renderNextCollision(collision, alreadyaPlan) {
  const el = $("nextCollision");
  // A genuine candidate collision (the purchase in the calculator is new AND
  // would land on a busy week) gets the strong warning.
  if (collision && collision.isCollision && !alreadyaPlan) {
    el.className = "next-collision warn";
    el.innerHTML = `<span class="nc-dot"></span>Adding this bunches $${collision.total.toFixed(0)} into ${core.fmtRange(collision.start, collision.end)}`;
    el.classList.remove("hidden");
    return;
  }
  // Otherwise reflect the true state of the saved calendar: the next real crunch
  // among plans already saved, or a clear message.
  if (plans.length) {
    const clusters = core.findCollisions(core.mergeSchedules(plans));
    const next = clusters.find((c) => c.isCollision);
    if (next) {
      el.className = "next-collision soft";
      el.innerHTML = `<span class="nc-dot"></span>Next crunch: $${next.total.toFixed(0)} due ${core.fmtRange(next.start, next.end)}`;
    } else {
      el.className = "next-collision clear";
      el.innerHTML = `<span class="nc-dot"></span>No payment pile-ups ahead`;
    }
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

// ---- manage-plans drawer ---------------------------------------------------
function renderPlans() {
  const list = $("planList");
  if (!plans.length) {
    list.innerHTML = `<div class="plan-empty">No plans yet. Add any BNPL balances you're still paying off — the more complete this is, the earlier we can warn you about a collision.</div>`;
    return;
  }
  list.innerHTML = plans.map((p, i) => {
    const per = ((Number(p.amount) || 0) / (p.payments || 4)).toFixed(2);
    const left = Math.max(0, (p.payments || 4) - (p.paidCount || 0));
    const label = (core.BNPL_PROVIDERS[p.provider] || core.BNPL_PROVIDERS.generic).label;
    return `<div class="plan-item">
      <div class="plan-meta">
        <span class="plan-name">${escapeHtml(p.name || "Plan")}</span>
        <span class="plan-sub">${escapeHtml(label)} · $${per}/payment · ${left} left</span>
      </div>
      <div class="plan-right"><span class="amt">$${(Number(p.amount) || 0).toFixed(0)}</span> <button data-i="${i}" aria-label="Remove">×</button></div>
    </div>`;
  }).join("");
  list.querySelectorAll("button[data-i]").forEach((b) => {
    b.onclick = () => { plans.splice(+b.dataset.i, 1); savePlans(); renderPlans(); render(); };
  });
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ---- calendar drawer -------------------------------------------------------
function renderCalendar() {
  const summary = $("calSummary");
  const body = $("calBody");
  if (!plans.length) {
    summary.innerHTML = "";
    body.innerHTML = `<div class="plan-empty">Add plans to see your merged payment calendar.</div>`;
    return;
  }
  const schedule = core.mergeSchedules(plans);
  const clusters = core.findCollisions(schedule);
  const collisionCount = clusters.filter((c) => c.isCollision).length;
  const total = schedule.reduce((s, p) => s + p.amount, 0);

  summary.innerHTML = `
    <div class="cal-stat"><div class="cs-val">${schedule.length}</div><div class="cs-k">payments ahead</div></div>
    <div class="cal-stat"><div class="cs-val">$${total.toFixed(0)}</div><div class="cs-k">still to pay</div></div>
    <div class="cal-stat ${collisionCount ? "hot" : ""}"><div class="cs-val">${collisionCount}</div><div class="cs-k">crunch week${collisionCount === 1 ? "" : "s"}</div></div>
  `;

  body.innerHTML = clusters.map((c) => {
    const cls = c.isCollision ? (c.severity === "high" ? "cl-high" : "cl-med") : "cl-low";
    const rows = c.payments.map((p) =>
      `<div class="cl-pay"><span class="clp-date">${core.fmtDate(p.date)}</span><span class="clp-name">${escapeHtml(p.planName)}</span><span class="clp-amt">$${p.amount.toFixed(2)}</span></div>`
    ).join("");
    // The window-total tag only adds information when the window holds more than
    // one payment (i.e. an actual pile-up). For a single payment it would just
    // repeat the row amount at a different rounding, so we omit it.
    const tag = c.payments.length > 1
      ? `<span class="cl-tag">${c.payments.length} payments · $${c.total.toFixed(2)}</span>`
      : "";
    return `<div class="cl-window ${cls}">
      <div class="cl-head"><span>${core.fmtRange(c.start, c.end)}</span>${tag}</div>
      ${rows}
    </div>`;
  }).join("");
}

// ---- events ----------------------------------------------------------------
["price", "payments", "provider", "missed"].forEach((id) => {
  $(id).addEventListener("input", render);
  $(id).addEventListener("change", render);
});

$("manageBtn").onclick = () => { $("drawer").classList.remove("hidden"); renderPlans(); };
$("closeDrawer").onclick = () => { $("drawer").classList.add("hidden"); };
$("calendarBtn").onclick = () => { $("calDrawer").classList.remove("hidden"); renderCalendar(); };
$("closeCal").onclick = () => { $("calDrawer").classList.add("hidden"); };

$("addPlan").onclick = () => {
  const name = $("newPlanName").value.trim();
  const amount = parseFloat($("newPlanAmt").value) || 0;
  if (amount <= 0) return;
  const provider = $("newPlanProvider").value;
  const payments = parseInt($("newPlanPayments").value, 10) || 4;
  const firstDue = $("newPlanFirstDue").value || new Date().toISOString().slice(0, 10);
  const paidCount = Math.max(0, Math.min(payments, parseInt($("newPlanPaid").value, 10) || 0));
  const label = (core.BNPL_PROVIDERS[provider] || core.BNPL_PROVIDERS.generic).label;

  plans.push({ name: name || label, amount, provider, payments, firstDue, paidCount });

  $("newPlanName").value = "";
  $("newPlanAmt").value = "";
  $("newPlanPaid").value = "0";
  savePlans(); renderPlans(); render();
};

function seedDate() {
  const d = $("newPlanFirstDue");
  if (d && !d.value) d.value = new Date().toISOString().slice(0, 10);
}

// ---- capture review cards --------------------------------------------------
function renderCaptures() {
  const section = $("captureSection");
  const list = $("captureList");
  if (!pendingCaptures.length) {
    section.classList.add("hidden");
    list.innerHTML = "";
    return;
  }
  section.classList.remove("hidden");
  $("captureCount").textContent = pendingCaptures.length > 1 ? ` (${pendingCaptures.length})` : "";

  const provOptions = (sel) => Object.entries(core.BNPL_PROVIDERS)
    .map(([k, v]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${v.label}</option>`).join("");

  list.innerHTML = pendingCaptures.map((c, i) => {
    const per = ((Number(c.amount) || 0) / (c.payments || 4)).toFixed(2);
    const dueNote = c.dueWasDetected
      ? `<span class="cap-flag ok">Due date read from page</span>`
      : `<span class="cap-flag guess">We couldn't find a due date — please set it</span>`;
    return `<div class="cap-card" data-i="${i}">
      <div class="cap-top">
        <span class="cap-source">${escapeHtml(c.source || "Detected at checkout")}</span>
        <button class="cap-dismiss" data-dismiss="${i}" aria-label="Dismiss">×</button>
      </div>
      <div class="cap-grid">
        <div class="cap-field">
          <label>Amount</label>
          <div class="money sm"><span>$</span><input type="number" inputmode="decimal" data-f="amount" value="${Number(c.amount) || 0}" /></div>
        </div>
        <div class="cap-field">
          <label>Provider</label>
          <select data-f="provider">${provOptions(c.provider)}</select>
        </div>
        <div class="cap-field">
          <label>Split</label>
          <select data-f="payments">
            <option value="4" ${c.payments === 4 ? "selected" : ""}>4 payments</option>
            <option value="3" ${c.payments === 3 ? "selected" : ""}>3 payments</option>
            <option value="6" ${c.payments === 6 ? "selected" : ""}>6 payments</option>
          </select>
        </div>
        <div class="cap-field">
          <label>Next payment due</label>
          <input type="date" data-f="firstDue" value="${c.firstDue}" />
        </div>
      </div>
      <div class="cap-foot">
        ${dueNote}
        <span class="cap-per">$${per} / payment</span>
      </div>
      <button class="cap-confirm" data-confirm="${i}">Confirm &amp; add to calendar</button>
    </div>`;
  }).join("");

  // Live-edit: write field changes back into the pending capture in memory.
  list.querySelectorAll(".cap-card").forEach((card) => {
    const i = +card.dataset.i;
    card.querySelectorAll("[data-f]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const f = inp.dataset.f;
        pendingCaptures[i][f] = f === "amount" ? (parseFloat(inp.value) || 0)
          : f === "payments" ? (parseInt(inp.value, 10) || 4)
          : inp.value;
      });
    });
  });

  list.querySelectorAll("[data-confirm]").forEach((b) => {
    b.onclick = () => confirmCapture(+b.dataset.confirm);
  });
  list.querySelectorAll("[data-dismiss]").forEach((b) => {
    b.onclick = () => dismissCapture(+b.dataset.dismiss);
  });
}

function confirmCapture(i) {
  const c = pendingCaptures[i];
  if (!c || (Number(c.amount) || 0) <= 0) return;
  const label = (core.BNPL_PROVIDERS[c.provider] || core.BNPL_PROVIDERS.generic).label;
  plans.push({
    name: c.name || `${label} purchase`,
    amount: Number(c.amount) || 0,
    provider: c.provider || "generic",
    payments: c.payments || 4,
    paidCount: 0,
    firstDue: c.firstDue,
  });
  savePlans();
  pendingCaptures.splice(i, 1);
  saveCaptures();
  renderCaptures();

  // Reset the calculator to its empty state so it isn't left showing the
  // purchase we just added (which would otherwise look like a pending decision).
  $("price").value = "";
  $("payments").value = "4";
  $("provider").value = "generic";
  $("missed").value = "0";

  render(); // refresh verdict + collision now that a plan was added
}

function dismissCapture(i) {
  pendingCaptures.splice(i, 1);
  saveCaptures();
  renderCaptures();
}

// ---- init ------------------------------------------------------------------
(async function init() {
  plans = await loadPlans();
  pendingCaptures = await loadCaptures();
  seedDate();
  renderCaptures();
  render();
  prefillFromTab();
})();
