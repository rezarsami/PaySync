# Split Check — BNPL true-cost checker & payment-collision calendar

A Chrome extension (Manifest V3) that shows what a Buy-Now-Pay-Later offer *actually* costs you — and, more importantly, gives you the one view no provider, bank, or budgeting app offers: a single calendar of every pay-in-4 payment you owe, merged across all providers, with the weeks where payments pile up flagged before you open the plan that causes them.

Everything runs locally. No accounts, no network calls, no payment data ever leaves the browser.

---

## Why this exists

Pay-in-4 BNPL is marketed as "0% interest," so the real cost is invisible at the point of decision. But the sharpest problem isn't any single plan's cost — it's that each purchase is a separate plan with its own due dates, and nothing shows you how those dates stack up together. Missed payments are usually a *timing collision* (several due dates landing in the same few days on an account you're not watching), not overspending. Providers only see their own plan; your bank sees the debits but not that they're BNPL. Split Check fills that gap.

## What it does

- **Payment-collision calendar** — the headline feature. Split Check merges every upcoming installment across all your plans into one calendar and flags the weeks where payments pile up.
- **Auto-capture at checkout** — when you complete a BNPL purchase, the content script detects the confirmation page and queues a prefilled plan (price, provider, split, and next due date). A badge appears on the toolbar icon; open the popup and you get a "Confirm & add to calendar" card with everything filled in — just review and confirm. No manual logging.
- **Collision warning at checkout** — when you're about to open a new plan, Split Check checks whether its first payment drops into an already-loaded week and warns you concretely: *"$140 would land the week of the 6th — you already have $95 due then."* A real date and dollar figure, not a hypothetical APR.
- **Popup calculator** — enter or confirm a price, split, and provider; get a plain-language verdict plus per-payment, true-cost, and effective-APR breakdown.
- **Offer auto-detect** — a content script scans checkout pages for offers like "4 payments of $62.25 with Klarna" and injects a compact overlay with the verdict and any collision.

## Files

```
split-check-extension/
  manifest.json      MV3 manifest
  bnpl-core.js       all cost logic, calendar/collision, and capture detection (shared, no deps)
  background.js      service worker — keeps the toolbar badge in sync with pending captures
  popup.html/.css/.js  toolbar calculator, plan manager, calendar, and capture-review cards
  content.js         page scan → offer overlay + purchase capture
  overlay.css        injected overlay styles
  icons/             16 / 48 / 128
demo-checkout.html      mock checkout to demo offer auto-detection
demo-confirmation.html  mock "thank you" page to demo auto-capture
```

## Install (unpacked)

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked** and select the `split-check-extension` folder (the one containing `manifest.json`)
4. Pin the extension if you like
5. To run the demos from local files, open the extension's **Details** and enable **"Allow access to file URLs"** — content scripts are blocked on `file://` pages by default

## Try the demos

**Offer detection** — open `demo-checkout.html`. An overlay appears bottom-right analyzing the Klarna offer. To see a collision, first add a couple of overlapping plans (popup → Manage), then reload.

**Auto-capture** — open `demo-confirmation.html` (a mock "thank you for your order" page). The toolbar icon shows a badge; open the popup and you'll see a prefilled "Confirm & add to calendar" card with the $249 Klarna plan and its Aug 14 due date. Confirm it, then open **Calendar** to see it on your timeline.

## How the numbers work

Pay-in-4 has no stated interest, so cost only appears as late fees. Split Check expresses a missed-payment fee as an **annualized rate over the plan's life**, against the average outstanding balance, so it's comparable to a credit-card APR. A $7 late fee on a $150 four-payment plan works out to roughly an 80% effective APR — a small flat fee on a short, small balance is expensive money.

Provider fee assumptions are indicative defaults for education (US, 2026), not scraped live from providers.

## How the collision calendar works

Each saved plan generates a schedule from its next-due date, stepping by the provider's cadence (biweekly for pay-in-4, monthly for Affirm-style), skipping installments already paid. All schedules merge into one sorted timeline. Split Check buckets payments into rolling 7-day windows and flags a **collision** when two or more payments — or more than a strain threshold in dollars — land in the same window. Before you open a new plan, it drops that plan's first payment onto the timeline and reports the worst window it would join.

## How auto-capture works

Detecting an *offer* (marketing "or pay in 4") is not the same as detecting a *completed purchase*. Auto-logging every offer would fill the calendar with things you only browsed. So capture keys off the order-confirmation page shown *after* payment: a confidence score weighs confirmation cues ("order confirmed," "payment schedule") against offer-only cues ("or pay in 4," "add to cart"). On a real purchase it extracts price, provider, split, and — where present — the first due date, then queues a draft for you to confirm. Confirm is the correction step: nothing is logged silently, and you can edit any field the scan got wrong.

Capture is going-forward and manual-confirm: you add plans as you check out (or seed the ones you're already carrying via Manage). Split Check does not scrape provider dashboards or read your email — that would break the local-only promise and is deliberately out of scope.

## Scope & honesty

Offer detection and capture are tuned to work reliably on the demo pages and common phrasings. Robust detection across every real retailer's checkout markup is a genuinely hard problem (every site is different) and is deliberately out of scope for this build — see the PRD's phased-rollout section. This is not financial advice; figures are indicative estimates.
