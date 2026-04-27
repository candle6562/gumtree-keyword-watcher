# Runbook

## What it does
- Polls Gumtree search results by `POSTCODE` and each configured keyword.
- Matches listing titles against each keyword (default always includes `lawnmower`).
- Sends WhatsApp alerts for unseen matching listings.
- Stores seen listing URLs in `DATA_PATH` so duplicates are suppressed.

## Required env vars
- `POSTCODE`: UK postcode to search.
- `WHATSAPP_TO`: Destination WhatsApp number. Accepted formats:
  - `whatsapp:+447...`
  - `+447...`
  - UK local `07...` (auto-normalized to `whatsapp:+44...`)
- one transport mode:
  - `WHATSAPP_ALERT_WEBHOOK_URL` for existing WhatsApp integrations (recommended for OpenClaw),
  - or `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` for direct Twilio send.

## Optional env vars
- `WHATSAPP_FROM`: Twilio WhatsApp sender number (default sandbox sender).
- `WHATSAPP_ALERT_WEBHOOK_TOKEN`: Optional bearer token for webhook transport.
- `KEYWORDS`: Comma-separated extra keywords. `lawnmower` is always included.
- `SCRAPE_INTERVAL_SECONDS`: Poll interval (default `3600`, hourly).
- `HTTP_TIMEOUT_MS`: Fetch timeout (default `15000`).
- `RETRY_ATTEMPTS`: Retry count for fetch/send (default `3`).
- `RETRY_DELAY_MS`: Retry delay base in ms (default `1000`).
- `DATA_PATH`: JSON file path for dedupe state (default `.data/seen-listings.json`).
- `DEDUPE_RETENTION_DAYS`: Keep dedupe entries for this many days (default `30`).
- `DEDUPE_MAX_ENTRIES`: Cap dedupe entries; oldest are evicted first (default `5000`).
- `DIAGNOSTICS_LOG_PATH`: JSONL diagnostics sink path (default `.data/diagnostics.log`).
- `DELIVERY_CANARY_ENABLED`: Enable controlled fixture-based delivery canary (defaults to `true` when `DRY_RUN` is false, otherwise `false`).
- `DELIVERY_CANARY_FIXTURE_PATH`: Fixture path used for controlled canary matching (default `test/fixtures/gumtree-search-stable.html`).
- `DELIVERY_CANARY_KEYWORD`: Keyword forced against the controlled fixture (default `lawnmower`).
- `HEALTH_METRICS_ENABLED`: Enable hardened observability HTTP server for `/health` and `/metrics` (default `false`).
- `HEALTH_METRICS_HOST`: Bind host for observability server (default `127.0.0.1`).
- `HEALTH_METRICS_PORT`: Bind port for observability server (default `9464`).
- `HEALTH_METRICS_TOKEN`: Optional bearer token; required if host is non-loopback.
- `HEALTH_MAX_STALENESS_SECONDS`: Mark `/health` stale when last cycle age exceeds this threshold (default `0`, disabled).
- `DRY_RUN`: If `true`/`1`, logs WhatsApp payloads instead of sending.

## Local startup
1. `npm ci`
2. `cp .env.example .env` and edit values.
3. choose mode:
   - long-running loop: `npm run dev`
   - single hourly execution (routine/manual): `npm run run:once`

Runtime note: the app auto-loads `.env` at startup. Keep postcodes with spaces quoted in `.env` (for example `POSTCODE="NE30 3SB"`).

## Hourly routine operator flow
1. Ensure runtime env is set for `POSTCODE`, `KEYWORDS`, `WHATSAPP_TO`, and transport secrets/webhook.
2. Run routine parent-link guard preflight: `npm run guard:routines`.
3. Trigger the control-plane hourly routine (or run manually as owner).
4. The run issue executes `npm run run:once` and exits.
5. Append summary/errors/improvements to diagnostics issue `GUM-18`.

## Routine parent-link guard
- Command: `npm run guard:routines`
- Requires: `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID`.
- Behavior:
  - Lists each active routine and its parent issue status.
  - Exits non-zero if any active routine points to a `done` or `cancelled` parent issue.

## Permission-safe diagnostics path (non-routine-owner)
If control-plane routine fire is ownership-restricted (`403`), use this equivalent path:
1. Set runtime env vars for the target run.
2. Execute `ISSUE_REF=GUM-xx ROUTINE_REF=<routine-id> scripts/diagnostics-cycle.sh`.
3. Paste the generated markdown block into `GUM-18`.
4. If `run:once` fails, mark execution ticket `blocked` with explicit owner + unblock action.

## Production notes
- Run with a process manager (systemd/PM2/container orchestrator).
- Persist `DATA_PATH` on durable storage to avoid duplicate notifications on restart.
- Store Twilio secrets in a secret manager; do not commit them.
- If using an existing integration number (for example OpenClaw WhatsApp), keep sender credentials in secret storage and supply only runtime env vars to the process.
- Keep observability bound to loopback where possible. If non-loopback binding is required, set `HEALTH_METRICS_TOKEN` and enforce ingress ACLs.

## Requester runtime profile (example)
- `POSTCODE=NE30 3SB`
- `KEYWORDS=lawnmower`
- `WHATSAPP_TO=07791851722` (normalized internally to WhatsApp E.164)

## Secret handling checklist
- Keep `.env` out of version control (`.gitignore` already excludes it).
- Inject `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` from a secret manager or deployment platform secrets.
- Rotate auth tokens if shared accidentally; never post them in issue comments/logs.

## Failure behavior
- Per-keyword fetch/send operations retry with backoff.
- Errors are logged and the process continues to next keyword/cycle.
- Next scheduled cycle recovers automatically unless config/secrets are invalid.

## Diagnostics inspection
- Local file sink is append-only JSONL at `DIAGNOSTICS_LOG_PATH`.
- Each hourly JSONL entry now includes `transportReadiness`:
  - `mode`: `webhook`, `twilio`, `dry_run`, or `unconfigured`
  - `ready`: `true` when a real send transport is configured and `false` when delivery is not currently possible
- Use diagnostics fields together to classify run health:
  - scrape/scheduler success: `outcome=success`
  - send-path not exercised: `details.matched=0` or `details.sent=0`
  - send-path readiness status: `transportReadiness`
  - controlled canary: `details.checkType=delivery_canary` with `details.expectedMinimumSent=1`
- Readiness guardrail for controlled canary:
  - canary only passes when `transportReadiness.mode=webhook` and `transportReadiness.ready=true`
  - any other mode/readiness emits a diagnostics failure with escalation-oriented `nextAction`
- Canary success criteria:
  - `details.checkType=delivery_canary`
  - `outcome=success`
  - `details.sent >= details.expectedMinimumSent` (current target: `1`)
- Example inspection:
  - `tail -n 20 .data/diagnostics.log`
  - `jq -c . .data/diagnostics.log | tail -n 20`
  - `jq -c '{timestamp,outcome,transportReadiness,keyword:.details.keyword,matched:.details.matched,sent:.details.sent}' .data/diagnostics.log | tail -n 20`
  - `jq -c 'select(.details.checkType==\"delivery_canary\") | {timestamp,outcome,transportReadiness,sent:.details.sent,expectedMinimumSent:.details.expectedMinimumSent,errorDetail,nextAction}' .data/diagnostics.log | tail -n 10`

## Alerting and escalation
- Trigger an incident/escalation when either condition occurs:
  - latest `delivery_canary` entry has `outcome=failure`
  - latest `delivery_canary` entry has `outcome=success` but `details.sent < details.expectedMinimumSent`
- Escalation flow:
  1. Post the failing diagnostics JSONL line into the active run issue and diagnostics issue `GUM-18`.
  2. Mark the execution issue `blocked` if remediation is not immediate.
  3. Route to webhook integration owner with explicit unblock request (restore webhook readiness or fix canary path).

## Health and metrics endpoint
- Enable with `HEALTH_METRICS_ENABLED=true`.
- Routes:
  - `GET /health`: process + cycle health (returns `200` on healthy, `503` on starting/degraded/stale).
  - `GET /metrics`: Prometheus text metrics for uptime and cycle counters.
- Hardening behavior:
  - only `GET`/`HEAD` allowed
  - unknown paths return `404`
  - optional bearer auth via `HEALTH_METRICS_TOKEN`
  - no-store cache headers and content-type sniffing disabled

## Anti-bot constraints
- Gumtree may throttle/block requests. If blocked:
  - reduce scrape frequency,
  - verify user-agent/network behavior,
  - consider alternate compliant ingestion if scraping is no longer reliable.
