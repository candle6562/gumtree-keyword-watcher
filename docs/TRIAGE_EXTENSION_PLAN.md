# Marketplace Triage Extension — Plan

Status: draft for review
Date: 2026-07-29

## What this is

Today the watcher answers "is there a new listing matching this keyword?". It sends a
link, a price and a location, and a human does all the judging.

This extension makes it answer "is this listing actually worth my time, against a written
specification of what I want?" — with evidence: full listing text, photos, and official
DVLA/MOT data pulled from gov.uk.

Two things ship separately:

- **Part 0 — auto-recovery.** Unrelated to triage, but the reason the group chat went
  silent for three days. Small, ships first, independently.
- **Parts 1–6 — the triage pipeline.** The actual extension.
- **Part 7 — V2 conversation automation.** Scoped here, not built yet.

---

## Part 0 — Auto-recovery (ship first, standalone)

### The problem

Last successful Facebook scrape: `2026-07-26T08:11:09Z`. Next 2,584 cycles all failed with
`TypeError: fetch failed`. Nothing recovered, nothing escalated. Every previous recovery in
this repo's history has been a human noticing the silence.

Root cause is not one bug but three gaps:

1. **No recovery.** `src/facebook-marketplace.ts:95` throws on worker failure.
   `monitor.ts` retries the same dead URL via `withRetry`, gives up, and waits for the next
   cron tick to do exactly the same thing. `grep` across `src/` finds zero references to
   worker restart or health checking.
2. **No escalation.** A total-failure cycle looks identical in WhatsApp to a
   nothing-new-today cycle: silence. The 08:00 digest *did* say `fetch failed` — that was
   the only signal, and it took three days and a human to read it.
3. **The worker dies unattended.** It is a non-headless Playwright process on the Windows
   host started by `start-worker-if-needed.cmd`. Nothing supervises it. When the desktop
   session ends, or Playwright crashes, it stays dead.

### Proposed fix

**Ordered by value per unit of work.**

**0a. Worker health probe + self-heal in the scrape path.**
New `src/browser-worker.ts` exporting `ensureWorkerHealthy()`:

- `GET /health` with the bearer token, short timeout. `200` → proceed.
- On failure, invoke the Windows-side start script via WSL interop:
  `/mnt/c/Windows/System32/cmd.exe /c "cd /d C:\fb-browser-worker && npm.cmd run start:if-needed"`
- Poll `/health` for up to ~90s (worker cold start is slow — Playwright launch).
- Recovered → carry on and record a `worker_restarted` diagnostic.
  Still dead → throw, but a *typed* `WorkerUnavailableError`, not a bare fetch failure.

Called once per cycle before any Facebook work, not per keyword. Guard with a cooldown
(don't attempt restart more than once every N minutes) so a genuinely broken worker
doesn't get hammered.

Caveat worth stating plainly: this only works while the Windows user session is logged in.
`HEADLESS=false` means the worker needs an interactive desktop. If the host is at the lock
screen or logged out, no amount of retry logic helps. If that turns out to be the actual
death cause, the real fix is a Windows Scheduled Task with "run whether user is logged on
or not" plus headless mode — worth investigating once we have the diagnostics from 0c.

**0b. Failure escalation to WhatsApp.**
Consecutive-failure counter in `.data/`. On the Nth consecutive fully-failed cycle
(N≈3, i.e. ~30 min), send one message — and only one, latched until recovery:

> ⚠️ Market watcher degraded — Facebook scrape failing since 08:11 (18 cycles).
> Auto-restart attempted 3×, worker still unreachable.

Then a recovery message when it comes back. This is the difference between three days of
silence and a 30-minute heads-up. Reuses the existing notifier; the delivery-queue purge
work already done means a backlog can't build behind it.

**0c. Record *why* the worker died.**
Currently we log `fetch failed` and learn nothing. Capture the worker's own stdout/stderr
to a rotating log on the Windows side, so next death has a post-mortem. Cheap, and the
only way to fix the root cause rather than papering over it.

**0d. Fix the seen-store ordering bug** (already diagnosed, still unfixed).
`monitor.ts` only calls `store.addEntry()` *after* a successful send. Any prolonged
transport outage therefore re-matches the same listings every 10 minutes and re-queues
duplicate notifications — this is what produced the 355-message backlog and the WhatsApp
flood on 2026-07-22. Mark listings seen at match time; track delivery state separately.

**0e. Decouple Facebook failure from Gumtree results.**
`monitor.ts` runs the Gumtree fetch and the Facebook search inside one `try`. A Facebook
failure discards Gumtree matches found in the same pass. Per-source error isolation:
one source failing should degrade, not blank, the cycle. Had this been in place, the last
three days would still have produced Gumtree camper van alerts.

---

## Part 1 — Specifications

### Format

Your example spec is prose, and prose is the right source of truth — it is what the LLM
reads, and it captures nuance ("small vans *may be* too cramped") that structured fields
can't. Keep it as written.

Add a small YAML front-matter block for the things that must be *deterministic and free* —
hard rejects that should never cost an LLM call:

```markdown
---
name: camper-van
hard_reject:
  price_gt: 10000
  year_lt: 2016
  weight_kg_gt: 3500
  seats_lt: 4
  fuel_not_in: [diesel-euro6, petrol, electric, hybrid]
soft_flags:
  price_ideal: [6000, 8500]
  mileage_ideal: [70000, 120000]
  preferred_models: [expert, dispatch, vivaro, trafic, proace, transit custom]
sources: [facebook, gumtree, autotrader]
distance_km: 200
---

# Camper Van Search Requirements

I am looking for a camper van in the UK that I can keep for at least five years...
(your prose, unchanged)
```

Stored at `config/specs/camper-van.md`. The prose below the front-matter goes to the LLM
verbatim. The front-matter drives cheap pre-filtering.

Why both: the front-matter kills the obvious rejects for free, so LLM budget is spent only
on listings that could plausibly be right.

### Command surface

```
npm run marketplace -- --spec camper-van            # full triage cycle
npm run marketplace -- --spec camper-van --dry-run  # triage, print, don't send
npm run marketplace -- --inspect <url>              # deep-dive one listing
npm run marketplace -- --vision <url>               # follow-up photo analysis
npm run marketplace -- --dvla <reg>                 # ad-hoc gov.uk check
```

Existing keyword watches keep working unchanged. A spec is a new *kind* of watch, not a
replacement.

---

## Part 2 — Detail extraction (the mandatory groundwork)

Nothing else in this plan works without this. Current `Listing` (`src/types.ts:3`) is:

```ts
{ title, url, matchedKeyword, source?, price?, postedDate?, location? }
```

That is not enough to triage on. No description, no photos, no year, mileage, fuel, or
seats.

New `ListingDetail`, populated by fetching each listing's own page through the browser
worker's existing `/session/*` API (no new infrastructure needed):

```ts
interface ListingDetail extends Listing {
  description?: string;
  images: string[];          // URLs
  attributes: Record<string, string>;  // seller-declared: year, mileage, fuel, transmission…
  sellerType?: "private" | "trade";
  postedAt?: string;
  fetchedAt: string;
}
```

Per-source extractors: Facebook and Gumtree first, AutoTrader in Part 5.

Cache detail pages aggressively in `.data/` keyed by URL — a listing's description doesn't
change, and re-fetching costs both time and anti-bot risk.

**Risk:** detail-page fetching multiplies browser worker load by the number of matches per
cycle. Needs a concurrency cap and a per-cycle budget, or we'll trip Facebook's rate
limiting and lose the session. Recommend serial fetching with a small delay, capped at
~15 detail fetches per cycle, newest first.

---

## Part 3 — LLM triage

**Provider:** OpenRouter, key in `.env` as `OPENROUTER_API_KEY`. Two configurable model
slots so cost and quality can be tuned without code changes:

```
OPENROUTER_TEXT_MODEL=...     # spec matching, structured extraction
OPENROUTER_VISION_MODEL=...   # photo analysis, plate OCR
```

New `src/triage/` module. Text triage takes the spec prose + `ListingDetail`, returns
structured JSON:

```ts
interface TriageResult {
  score: number;              // 0-100 against the spec
  verdict: "shortlist" | "maybe" | "reject";
  matched: string[];          // spec points this listing satisfies
  concerns: string[];         // spec points it fails or looks weak on
  hardRejects: string[];      // spec "reject or strongly flag" hits
  unknowns: string[];         // spec points the listing doesn't say either way
  registration?: string;      // if stated in text
  extracted: { year?, mileage?, fuel?, euroStatus?, seats?, model? };
}
```

The `unknowns` field is the useful one for your workflow — it maps directly onto your spec's
"Before recommending a viewing / try to obtain" list, and becomes the question list for the
V2 conversation automation.

**Cost control — staged gating.** Vision and DVLA are the expensive steps, so they run last
and only on listings that survive:

```
search → hard-gate (free, front-matter)
       → detail fetch (browser, no LLM cost)
       → hard-gate again on detail attrs (free)
       → TEXT TRIAGE  ......... LLM call #1, every surviving listing
       → if score ≥ threshold:
           VISION ............. LLM call #2, plate OCR + condition
       → if reg found:
           DVLA + MOT ......... browser, no LLM cost
       → final score → send
```

You asked for **everything, scored and sorted** in the group chat — so all of it gets sent.
But low scorers get sent with text-only evidence and a marker saying so; we don't spend
vision and DVLA budget on a van that already failed on price and year. You'll be able to
see the triage's reasoning on the rejects, which is what you wanted to sanity-check, without
paying full freight for them.

---

## Part 4 — DVLA + MOT via gov.uk

You chose browser-worker scraping over the official APIs. Noted, and it works today with no
signup. Two things to be aware of: gov.uk's terms don't contemplate automated form
submission, and these are public-service endpoints — so this must be low-volume and
well-behaved. Concretely: only look up registrations for listings that already passed
triage, cache every result permanently by reg (a van's Euro status never changes), and rate
limit hard. Realistically that's a handful of lookups a day, which is fine.

Worth revisiting later: the DVSA MOT History API and DVLA Vehicle Enquiry Service API are
both free and give structured JSON. If this becomes load-bearing, registering is a couple of
days' wait for a much more robust integration. I'd build behind an interface so the swap is
a one-file change.

**What we get, mapped to your spec:**

| gov.uk field | Spec requirement it answers |
|---|---|
| Euro status / fuel | "Diesel must be confirmed Euro 6 and ULEZ compliant" — a *hard reject* |
| Revenue weight | "Maximum vehicle weight of 3,500kg or less" — a *hard reject* |
| First registered | "Preferably 2016 or newer" |
| MOT history + advisories | "Good service and MOT history", "No serious rust" |
| Recurring rust advisories | "Repeated rust advisories" — your explicit reject condition |
| Mileage per MOT | Mileage plausibility / clocking detection |

The MOT advisory history is the single highest-value signal here. Rust advisories repeating
across years is exactly the "serious corrosion" reject in your spec, and it is invisible in
any listing photo.

---

## Part 5 — AutoTrader

New source alongside Gumtree and Facebook. AutoTrader has meaningfully more aggressive
bot detection than Gumtree, so this runs through the browser worker session API rather than
plain HTTP, and needs conservative pacing.

Upside: AutoTrader listings are far richer than Facebook's — structured year, mileage, fuel,
engine, sometimes the reg is displayed outright. Best data quality of the three sources, and
often no OCR needed.

Build the source adapter interface properly here, since this is the third source — it should
be a clean plug-in point, not a third special case.

---

## Part 6 — Vision

Runs on shortlisted listings. Two jobs:

1. **Plate OCR** — read the registration off the numberplate, unlocking Part 4. Note that
   many sellers blur or crop plates; expect maybe 50–70% hit rate. When it fails, the
   listing gets flagged "reg not obtainable — ask seller", which feeds V2.
2. **Condition assessment against the spec** — pop-top present and does it have a real
   sleeping platform; rock-and-roll bed; rust on sills and wheel arches; damp staining;
   how many actual travelling seats with belts; leisure battery and hookup.

These are the spec points that only exist in photos. A listing that says nothing about a
pop-top but clearly shows one in image 3 should score accordingly.

Also available as the standalone follow-up command you suggested
(`--vision <url>`), so you can spend it deliberately on a van you're already interested in.

---

## Part 7 — V2: conversation automation (scoped, not built)

The natural extension: `TriageResult.unknowns` is already a question list derived from your
spec's "Before recommending a viewing" section. V2 turns that into an actual conversation.

Sketch, in rough order of risk:

1. **Draft-only.** Generate the message to send the seller, show it to you in WhatsApp, you
   copy-paste it. Zero risk, most of the value.
2. **Send with approval.** You reply 👍 in the group chat, OpenClaw sends it as you.
3. **Reply ingestion.** Poll the marketplace inbox, parse seller replies, update the
   listing's known/unknown fields, re-score.
4. **Multi-turn.** Follow-up questions autonomously until the unknowns list is empty or the
   seller stops replying.

Strong recommendation: stop at stage 2 for a long while. Stages 3–4 mean an automated system
talking to real people, in your name, about a several-thousand-pound purchase. The failure
modes (agreeing to something, misrepresenting your position, annoying a seller with a good
van) are real and not recoverable by a code fix. Worth doing eventually, worth doing slowly.

---

## Suggested build order

| Step | What | Why here |
|---|---|---|
| 1 | Part 0 auto-recovery + escalation | Bleeding now. Independent of everything else. |
| 2 | Part 0d/0e store + isolation fixes | Prevents the next flood; small. |
| 3 | Part 2 detail extraction | Everything downstream needs it. No LLM cost to build. |
| 4 | Part 1 spec format + command | Cheap once detail exists. |
| 5 | Part 3 text triage | First real value. Testable against your camper van spec. |
| 6 | Part 4 DVLA/MOT | Highest-signal data, gated behind triage. |
| 7 | Part 6 vision | Unlocks reg for Part 4, most expensive. |
| 8 | Part 5 AutoTrader | Additive; pipeline already proven by then. |
| 9 | Part 7 V2 | Only after the triage is trusted. |

Steps 1–2 are worth doing regardless of whether the rest of this gets built.

## Open questions

- What score threshold should gate vision/DVLA spend? Suggest starting at 50/100 and
  tuning once we see real scores.
- Should the spec-based watch replace the existing `camper van` keyword watch in the group,
  or run alongside it during a trust-building period? Recommend alongside initially.
- Budget ceiling per day for OpenRouter calls — worth setting a hard cap in config so a
  runaway loop can't cost real money.
