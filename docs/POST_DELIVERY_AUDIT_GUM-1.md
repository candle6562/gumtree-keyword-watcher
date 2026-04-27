# Technical Post-Delivery Audit (GUM-1)

Date: 2026-04-26  
Issue: GUM-17

## Scope
Production-readiness audit of Gumtree watcher MVP covering:
- Build/test health
- Dependency/security posture
- Runtime reliability and failure handling
- Operability risks and hardening actions

## Verification evidence
- `npm run verify` passed (typecheck, tests, build)
- `npm audit --omit=dev --json` reported `0` vulnerabilities (`low` through `critical`)

## Findings and actions
1. Interval configuration validation bypass in runtime bootstrap (fixed)
- Risk: startup logic read `SCRAPE_INTERVAL_SECONDS` directly from `process.env`; invalid values could bypass validated config and cause unsafe schedule behavior.
- Action: bootstrap now uses `loadConfig()` once and schedules from validated `config.scrapeIntervalSeconds`.

2. Non-atomic dedupe state writes (fixed)
- Risk: direct writes to `DATA_PATH` could leave truncated/corrupt JSON if interrupted.
- Action: dedupe store now writes to a temp file and renames atomically.

3. Corrupt dedupe file could block startup (fixed)
- Risk: malformed JSON in `DATA_PATH` caused startup failure.
- Action: store now rotates corrupt files to `*.corrupt-<timestamp>` and self-heals with a fresh empty state.

4. Webhook notification path lacked explicit timeout (fixed)
- Risk: webhook send could stall indefinitely and delay cycle completion.
- Action: webhook sends now use `AbortController` timeout aligned to `HTTP_TIMEOUT_MS`.

## Test coverage added
- `test/store.test.ts`
  - Corrupt state file rotation + recovery behavior.
- `test/notifier.test.ts`
  - Webhook request path and non-2xx failure behavior.

## Residual risks (MVP-acceptable)
- Scrape parser is dependent on Gumtree HTML structure and may degrade if markup changes.
- Single-file dedupe state remains single-instance storage (not horizontally scalable).

## Recommended next hardening backlog
- Add optional health/metrics endpoint for process-level observability and external uptime checks.
- Add dedupe TTL/retention policy to bound state growth.
- Add integration smoke test against a stable HTML fixture snapshot pipeline.
