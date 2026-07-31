// ============================================================================
// bnpl-core.js — the whole decision engine, framework-free, no dependencies.
// Loaded by both the popup and the content script so the math lives in one place.
// Nothing here touches the network. All computation is local.
// ============================================================================

// Realistic provider assumptions (US, mid-2026, "Pay-in-4" style plans).
// These are indicative defaults for education — not scraped from providers.
const BNPL_PROVIDERS = {
  klarna:    { label: "Klarna",    lateFee: 7,  lateFeeCapPct: 25, cadence: "biweekly" },
  afterpay:  { label: "Afterpay",  lateFee: 8,  lateFeeCapPct: 25, cadence: "biweekly" },
  affirm:    { label: "Affirm",    lateFee: 0,  lateFeeCapPct: 0,  cadence: "monthly", canCarryAPR: true },
  zip:       { label: "Zip",       lateFee: 7,  lateFeeCapPct: 25, cadence: "biweekly" },
  sezzle:    { label: "Sezzle",    lateFee: 10, lateFeeCapPct: 25, cadence: "biweekly" },
  generic:   { label: "Pay-in-4",  lateFee: 7,  lateFeeCapPct: 25, cadence: "biweekly" },
};

// Effective APR of a fee-based pay-in-4 plan, given a late-fee scenario.
// Pay-in-4 has no stated interest, so "cost" only appears if you miss a payment.
// We express that missed-payment fee as an annualized rate over the plan's life
// so it's comparable to a credit card APR.
function effectiveAPR({ total, payments, feePaid, cadence }) {
  if (feePaid <= 0 || total <= 0) return 0;
  // Average outstanding balance over the plan, roughly total/2 for even splits.
  const avgOutstanding = total / 2;
  // Plan length in years.
  const gapDays = cadence === "monthly" ? 30 : 14;
  const planDays = gapDays * (payments - 1) || gapDays;
  const years = planDays / 365;
  if (years <= 0 || avgOutstanding <= 0) return 0;
  return (feePaid / avgOutstanding) / years * 100;
}

// Core evaluation. Returns everything the UI needs to render a verdict.
function evaluateBNPL({
  price,
  payments = 4,
  provider = "generic",
  missedPayments = 0,          // user's honest self-assessment / scenario slider
  existingPlansTotal = 0,      // sum of other active BNPL balances (local only)
  existingPlansCount = 0,
  collision = null,            // worst colliding window this purchase would join (or null)
}) {
  const prov = BNPL_PROVIDERS[provider] || BNPL_PROVIDERS.generic;
  const p = Math.max(0, Number(price) || 0);
  const perPayment = payments > 0 ? p / payments : p;

  // Late-fee exposure: fee per missed installment, capped at a % of order value.
  const rawFees = prov.lateFee * Math.max(0, missedPayments);
  const feeCap = prov.lateFeeCapPct > 0 ? (p * prov.lateFeeCapPct) / 100 : Infinity;
  const feePaid = Math.min(rawFees, feeCap);

  const trueCost = p + feePaid;
  const apr = effectiveAPR({ total: p, payments, feePaid, cadence: prov.cadence });

  // Stacking view: how much you'd owe across ALL bnpl plans if you add this one.
  const totalBnplAfter = existingPlansTotal + p;
  const plansAfter = existingPlansCount + 1;

  // Verdict logic — deliberately conservative and legible.
  // Collision comes first: it's a concrete, dated warning ("$140 due the week of
  // the 6th, you already have $95 landing then"), not a hypothetical APR.
  let verdict, reason, tone;
  if (collision && collision.isCollision) {
    const existingInWindow = collision.total - perPayment;
    verdict = "This lands on a busy week";
    reason = `Your first payment ($${perPayment.toFixed(2)}) drops into ${fmtRange(collision.start, collision.end)}, when you already have ~$${Math.max(0, existingInWindow).toFixed(0)} due across ${collision.providerCount > 1 ? `${collision.providerCount} providers` : "another plan"}. That's $${collision.total.toFixed(0)} in one week — the kind of pile-up that trips autopay.`;
    tone = "warn";
  } else if (missedPayments > 0 && feePaid > 0) {
    verdict = "Costs more than it looks";
    reason = `Miss ${missedPayments} payment${missedPayments > 1 ? "s" : ""} and you pay $${feePaid.toFixed(2)} in late fees — an effective ${apr.toFixed(0)}% APR on this purchase.`;
    tone = "warn";
  } else if (plansAfter >= 3) {
    verdict = "You're stacking plans";
    reason = `This would be your ${ordinal(plansAfter)} active plan ($${totalBnplAfter.toFixed(0)} across all of them). Overlapping due dates are the main way pay-in-4 users get caught out.`;
    tone = "warn";
  } else if (perPayment > 0 && p >= 150) {
    verdict = "Fine if the payments fit";
    reason = `No interest if you pay on time. The real question: does $${perPayment.toFixed(2)} every ${prov.cadence === "monthly" ? "month" : "2 weeks"} fit your budget without needing the next plan to cover it?`;
    tone = "ok";
  } else {
    verdict = "Probably just pay now";
    reason = `At $${p.toFixed(2)}, splitting into ${payments} adds due dates to track for little benefit. If you can cover it now, that's one less thing to miss.`;
    tone = "neutral";
  }

  return {
    provider: prov.label,
    price: p,
    payments,
    perPayment,
    cadence: prov.cadence,
    feePaid,
    trueCost,
    apr,
    totalBnplAfter,
    plansAfter,
    collision,
    verdict,
    reason,
    tone,
  };
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ============================================================================
// PAYMENT CALENDAR + COLLISION DETECTION
// ----------------------------------------------------------------------------
// The differentiator: no provider, bank, or budgeting app shows you a single
// merged calendar of every BNPL payment across every provider. Missed payments
// are usually a *timing collision* — several due dates landing in the same few
// days on an account the user isn't watching — not recklessness. This section
// turns saved plans into a unified schedule and flags the weeks where money
// bunches up, including for a hypothetical plan the user is about to open.
// All date math is local; nothing is sent anywhere.
// ============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;
function gapDaysFor(cadence) { return cadence === "monthly" ? 30 : 14; }

// Normalize a date-ish input to a midnight Date (so day-level bucketing is clean).
function atMidnight(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Given a plan, produce its remaining payment dates. A plan carries:
//   { name, amount, provider, payments, paidCount, firstDue }  (firstDue = ISO date)
// We generate the full schedule from firstDue, then drop installments already
// paid (paidCount) and any date in the past. amount is the ORDER total; each
// installment is amount / payments.
function planSchedule(plan, now = new Date()) {
  const prov = BNPL_PROVIDERS[plan.provider] || BNPL_PROVIDERS.generic;
  const payments = Math.max(1, Number(plan.payments) || 4);
  const per = (Number(plan.amount) || 0) / payments;
  const gap = gapDaysFor(prov.cadence);
  const start = plan.firstDue ? atMidnight(plan.firstDue) : atMidnight(now);
  const today = atMidnight(now);
  const paid = Math.max(0, Number(plan.paidCount) || 0);

  const out = [];
  for (let i = 0; i < payments; i++) {
    if (i < paid) continue; // already paid off
    const due = new Date(start.getTime() + i * gap * DAY_MS);
    if (due < today) continue; // in the past, treat as done
    out.push({
      date: due,
      amount: +per.toFixed(2),
      planName: plan.name || prov.label,
      provider: prov.label,
      installment: i + 1,
      ofPayments: payments,
    });
  }
  return out;
}

// Merge schedules from many plans into one sorted list of upcoming payments.
function mergeSchedules(plans, now = new Date()) {
  const all = [];
  for (const p of plans) all.push(...planSchedule(p, now));
  all.sort((a, b) => a.date - b.date);
  return all;
}

// Bucket a merged schedule into ISO-week windows and flag "collisions": windows
// where 2+ payments land, or where the summed amount crosses a strain threshold.
// windowDays defines the collision window (default 7 = a rolling week).
function findCollisions(schedule, { windowDays = 7, strainAmount = 120 } = {}) {
  const clusters = [];
  const used = new Array(schedule.length).fill(false);

  for (let i = 0; i < schedule.length; i++) {
    if (used[i]) continue;
    const windowStart = schedule[i].date;
    const windowEnd = new Date(windowStart.getTime() + windowDays * DAY_MS);
    const members = [];
    for (let j = i; j < schedule.length; j++) {
      if (used[j]) continue;
      if (schedule[j].date <= windowEnd) { members.push(schedule[j]); used[j] = true; }
    }
    const total = members.reduce((s, m) => s + m.amount, 0);
    const providers = new Set(members.map((m) => m.provider));
    const isCollision = members.length >= 2 || total >= strainAmount;
    clusters.push({
      start: windowStart,
      end: members[members.length - 1].date,
      payments: members,
      total: +total.toFixed(2),
      providerCount: providers.size,
      isCollision,
      severity: members.length >= 3 || total >= strainAmount * 2 ? "high"
              : members.length >= 2 || total >= strainAmount ? "med" : "low",
    });
  }
  return clusters;
}

// The headline question: if the user adds a NEW plan right now, does it drop
// payments into an already-busy week? Returns the worst colliding window that
// the new plan would contribute to, or null if it lands clear.
// candidate = { amount, payments, provider, firstDue? }  (firstDue defaults to
// the provider's first cadence step from today, which is how pay-in-4 works —
// first payment usually today or in ~2 weeks; we assume ~today for the overlay).
function collisionForCandidate(candidate, existingPlans, now = new Date()) {
  const prov = BNPL_PROVIDERS[candidate.provider] || BNPL_PROVIDERS.generic;
  const cand = {
    name: `New · ${prov.label}`,
    amount: candidate.amount,
    provider: candidate.provider || "generic",
    payments: candidate.payments || 4,
    paidCount: 0,
    firstDue: candidate.firstDue || atMidnight(now).toISOString(),
    _isCandidate: true,
  };
  const withCand = mergeSchedules([...existingPlans, cand], now);
  const clusters = findCollisions(withCand);

  // Which clusters contain a candidate payment AND at least one existing one?
  let worst = null;
  for (const c of clusters) {
    const hasCand = c.payments.some((p) => p.planName === cand.name);
    const hasExisting = c.payments.some((p) => p.planName !== cand.name);
    if (hasCand && hasExisting && c.isCollision) {
      if (!worst || c.total > worst.total) worst = c;
    }
  }
  return worst; // null => the new plan lands in a clear week
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function fmtRange(a, b) {
  const A = new Date(a), B = new Date(b);
  if (A.toDateString() === B.toDateString()) return fmtDate(A);
  return `${fmtDate(A)}–${fmtDate(B)}`;
}

// ---------------------------------------------------------------------------
// Offer detection: pull a BNPL offer out of arbitrary checkout page text.
// Matches patterns like "4 payments of $37.50", "4 interest-free installments
// of $37.50", "or 4 x $37.50 with Klarna".
// Returns { price, payments, provider } or null.
// ---------------------------------------------------------------------------
function detectOfferFromText(text) {
  if (!text) return null;
  const clean = text.replace(/\s+/g, " ");

  // "4 payments of $37.50" / "4 interest-free payments of $37.50" / "4 x $37.50"
  const re = /(\d)\s*(?:interest[- ]free\s+)?(?:payments?|installments?|x)\s*(?:of\s*)?\$?\s*(\d[\d,]*\.?\d{0,2})/i;
  const m = clean.match(re);
  if (!m) return null;

  const payments = parseInt(m[1], 10);
  const perPayment = parseFloat(m[2].replace(/,/g, ""));
  if (!payments || !perPayment || payments < 2 || payments > 12) return null;

  const price = +(perPayment * payments).toFixed(2);

  // Which provider is named nearby?
  let provider = "generic";
  const lc = clean.toLowerCase();
  for (const key of Object.keys(BNPL_PROVIDERS)) {
    if (key !== "generic" && lc.includes(key)) { provider = key; break; }
  }
  return { price, payments, provider, perPayment };
}

// ---------------------------------------------------------------------------
// PURCHASE CAPTURE
// ----------------------------------------------------------------------------
// Detecting an *offer* (marketing "or pay in 4") is not the same as detecting a
// *completed purchase*. Auto-logging every offer would fill the calendar with
// things the user only browsed. The reliable signal for a real purchase is the
// order-confirmation / thank-you page shown AFTER payment. We look for that
// signal, then extract price, provider, split, and — if present — the first due
// date, so the popup can show a prefilled "Confirm & add" card. Confirm is the
// user's correction step: nothing is logged silently.
// ---------------------------------------------------------------------------

// Phrases that indicate the payment actually went through (confirmation page),
// as opposed to an offer being advertised on a product/checkout page. Strong
// cues are near-unambiguous ("order confirmed") and score high on their own;
// weak cues ("order number") corroborate but shouldn't capture alone.
const CONFIRMATION_CUES_STRONG = [
  "order confirmed", "thank you for your order", "your order is confirmed",
  "payment confirmed", "order complete", "purchase complete", "order is confirmed",
  "your plan is set", "installment plan confirmed", "payment schedule",
];
const CONFIRMATION_CUES_WEAK = [
  "order number", "order #", "confirmation number",
  "your first payment", "first installment",
];

// Phrases that mark a page as *just an offer* — used to DOWNWEIGHT, so we don't
// mistake a product page's "or 4 interest-free payments" for a real purchase.
const OFFER_ONLY_CUES = [
  "or pay in", "or 4 interest-free", "pay over time", "as low as",
  "prequalify", "see if you qualify", "add to cart", "add to bag",
];

// Returns a confidence score 0..1 that this page represents a completed BNPL
// purchase (not just an offer). >= 0.5 is treated as capture-worthy. A single
// strong confirmation cue clears the bar; weak cues only corroborate.
function purchaseConfidence(text) {
  if (!text) return 0;
  const lc = text.toLowerCase();
  let score = 0;
  for (const cue of CONFIRMATION_CUES_STRONG) if (lc.includes(cue)) score += 0.55;
  for (const cue of CONFIRMATION_CUES_WEAK) if (lc.includes(cue)) score += 0.2;
  for (const cue of OFFER_ONLY_CUES) if (lc.includes(cue)) score -= 0.25;
  return Math.max(0, Math.min(1, score));
}

// Try to pull a first-due / next-payment date out of confirmation text.
// Handles "first payment due August 14, 2026", "next payment: 08/14/2026",
// "first installment on Aug 14". Returns an ISO yyyy-mm-dd string or null.
function detectDueDate(text, now = new Date()) {
  if (!text) return null;
  const clean = text.replace(/\s+/g, " ");

  // Look only in the neighbourhood of a payment-date phrase to avoid grabbing
  // an unrelated date (order date, delivery date).
  const anchor = /(?:first|next)\s+(?:payment|installment)[^.]{0,40}?(?:due|on|:)?\s*/i;
  const am = clean.match(anchor);
  const region = am ? clean.slice(am.index, am.index + 80) : clean;

  const months = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";

  // "August 14, 2026" / "Aug 14" (year optional)
  const reWord = new RegExp(`(${months})\\.?\\s+(\\d{1,2})(?:,?\\s*(\\d{4}))?`, "i");
  const wm = region.match(reWord);
  if (wm) {
    const monthIdx = monthNameToIndex(wm[1]);
    const day = parseInt(wm[2], 10);
    let year = wm[3] ? parseInt(wm[3], 10) : now.getFullYear();
    let d = new Date(year, monthIdx, day);
    // If no year given and the date already passed, assume next year.
    if (!wm[3] && d < atMidnight(now)) d = new Date(year + 1, monthIdx, day);
    if (!isNaN(d)) return toISODate(d);
  }

  // "08/14/2026" or "8/14/26" (assume US M/D/Y on US-facing BNPL pages)
  const reNum = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/;
  const nm = region.match(reNum);
  if (nm) {
    let [_, mo, da, yr] = nm;
    yr = parseInt(yr, 10); if (yr < 100) yr += 2000;
    const d = new Date(yr, parseInt(mo, 10) - 1, parseInt(da, 10));
    if (!isNaN(d)) return toISODate(d);
  }
  return null;
}

function monthNameToIndex(name) {
  const n = name.toLowerCase().slice(0, 3);
  return ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(n);
}
function toISODate(d) {
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// The full capture extractor. Given page text, decide whether it's a completed
// BNPL purchase and, if so, return a prefilled draft plan for user confirmation.
// Returns { draft, confidence } or null.
function extractCapture(text, now = new Date()) {
  const offer = detectOfferFromText(text);
  if (!offer) return null;

  const confidence = purchaseConfidence(text);
  if (confidence < 0.5) return null; // looks like an offer, not a purchase

  const due = detectDueDate(text, now);
  const provLabel = (BNPL_PROVIDERS[offer.provider] || BNPL_PROVIDERS.generic).label;

  const draft = {
    name: `${provLabel} purchase`,
    amount: offer.price,
    provider: offer.provider,
    payments: offer.payments,
    paidCount: 0,
    firstDue: due || toISODate(atMidnight(now)),
    dueWasDetected: !!due, // so the popup can flag "we guessed this — check it"
    capturedAt: Date.now(),
  };
  return { draft, confidence };
}

// Expose for both service-worker/module and plain-script contexts.
const _exports = {
  BNPL_PROVIDERS, evaluateBNPL, detectOfferFromText, effectiveAPR,
  planSchedule, mergeSchedules, findCollisions, collisionForCandidate,
  fmtDate, fmtRange, gapDaysFor,
  purchaseConfidence, detectDueDate, extractCapture, toISODate,
};
if (typeof module !== "undefined" && module.exports) module.exports = _exports;
if (typeof window !== "undefined") window.BNPLCore = _exports;
