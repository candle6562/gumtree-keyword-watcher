# Gumtree Keyword Watcher (MVP)

Service that monitors Gumtree listings for a postcode + keyword set and sends WhatsApp alerts when new matching items appear.

## Stack and architecture
- **Runtime**: Node.js + TypeScript.
- **Scrape approach**: Periodic HTTP fetch of Gumtree search HTML, parsed with `cheerio`.
- **Scheduler**: In-process `setInterval` loop.
- **Persistence**: JSON file (`DATA_PATH`) containing seen listing URLs for deduplication, with retention pruning.
- **Diagnostics sink**: append-only JSONL log (`DIAGNOSTICS_LOG_PATH`) for run outcomes/errors/next actions, including transport readiness (`transportReadiness.mode`/`transportReadiness.ready`).
- **Controlled delivery canary**: fixture-backed webhook send check on each production cycle (`details.checkType=delivery_canary`) to detect send-path regressions independent of live Gumtree markup drift.
- **Observability endpoint** (optional): hardened local HTTP server exposing `/health` (JSON) and `/metrics` (Prometheus text).
- **Alert channel**: Twilio WhatsApp API.

Trade-offs:
- Fast to ship and easy to deploy (single process), but file-based dedupe is single-instance and not ideal for horizontal scaling.
- HTML scraping is pragmatic for MVP but vulnerable to site markup changes and anti-bot controls.

## Configuration
See `.env.example` and [docs/RUNBOOK.md](docs/RUNBOOK.md).

Minimum required vars:
- `POSTCODE`
- `WHATSAPP_TO`
- one WhatsApp transport:
  - `WHATSAPP_ALERT_WEBHOOK_URL` (for existing integrations such as OpenClaw), or
  - `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`

Defaults:
- `KEYWORDS` defaults to include `lawnmower` even when empty.
- `SCRAPE_INTERVAL_SECONDS=3600` (hourly)
- `DEDUPE_RETENTION_DAYS=30` and `DEDUPE_MAX_ENTRIES=5000` bound dedupe state size.

`WHATSAPP_TO` supports `whatsapp:+E164`, `+E164`, or UK local `07...` (auto-converted to `whatsapp:+44...`).

Optional observability controls:
- `HEALTH_METRICS_ENABLED=true` to enable endpoint exposure.
- `HEALTH_METRICS_HOST` defaults to `127.0.0.1` (recommended).
- `HEALTH_METRICS_PORT` defaults to `9464`.
- `HEALTH_METRICS_TOKEN` optional bearer token. Required when host is non-loopback.
- `HEALTH_MAX_STALENESS_SECONDS` optional readiness threshold (`0` disables stale checks).

Delivery canary controls:
- `DELIVERY_CANARY_ENABLED` defaults to `true` for non-dry-run and `false` for dry-run.
- `DELIVERY_CANARY_FIXTURE_PATH` defaults to `test/fixtures/gumtree-search-stable.html`.
- `DELIVERY_CANARY_KEYWORD` defaults to `lawnmower`.

Readiness gate behavior:
- canary execution requires `transportReadiness.mode=webhook` and `transportReadiness.ready=true`;
- if the gate fails, a `delivery_canary` diagnostics failure is emitted and the cycle is marked degraded.

Requester runtime target:
- `POSTCODE=NE30 3SB`
- `KEYWORDS=lawnmower`
- `WHATSAPP_TO=07791851722`

`npm run dev`/`npm start` auto-load `.env`, so values with spaces (like postcodes) are parsed correctly without shell `source`.

## Run
```bash
npm ci
cp .env.example .env
npm run dev
```

## Hourly routine execution
For control-plane hourly routine issues, execute a single scan cycle and exit:

```bash
npm run run:once
```

Use `npm run dev` only for long-running local development loops.

If routine fire permissions are restricted, use `scripts/diagnostics-cycle.sh` to run an equivalent cycle and emit a standardized diagnostics entry for `GUM-18`.

Before triggering routines from the control plane, run:
```bash
npm run guard:routines
```
This fails fast if any active routine is still linked to a `done`/`cancelled` parent issue.

## Verify
```bash
npm run verify
```

## Demo proof (without sending real messages)
Use dry run mode:
```bash
export DRY_RUN=true
npm run dev
```
When a new match is found, logs contain `[DRY_RUN] WhatsApp alert ...` with title + URL.

## CI
GitHub Actions workflow at `.github/workflows/ci.yml` runs typecheck, tests, and build.
