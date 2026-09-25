# Windows Browser migration (opt-in)

The app owns Marketplace URL building, radius UI handling, harvesting, listing detail and mileage parsing in `src/marketplace-browser/marketplace.mjs`. `remote-browser.mjs` sends generic page/locator commands to the Windows Browser service. No Playwright dependency is needed in this repo.

The service source is `/git/agent-infra/windows-browser`; deployed code is `C:\windows-browser`, port 3878. Legacy routes remain on port 3877 in the **same process**, sharing one Chromium context. The original `C:\fb-browser-worker\data\twitter-profile` is reused in place; Facebook is still logged in.

## Enable/test

Set `WINDOWS_BROWSER_URL=http://100.95.126.123:3878`. Credentials default to `BROWSER_WORKER_TOKEN`; set `WINDOWS_BROWSER_TOKEN` to override. Health checks use the new URL. Auto-restart uses `/mnt/c/Windows/System32/schtasks.exe /Run /TN WindowsBrowser`; `WINDOWS_BROWSER_AUTOSTART_COMMAND` can override it. The task is installed on this host. `BROWSER_WORKER_AUTOSTART_ENABLED=false` still disables recovery.

```bash
WINDOWS_BROWSER_URL=http://100.95.126.123:3878 npx tsx bin/windows-browser-smoke.ts
```

This tests Marketplace through the same app entry point used by watches. It sends no notifications and writes no listing stores. The search CLI and detail fetches also honor the opt-in. Without this variable all callers keep the old site-specific HTTP routes.

## Rollout status

- Old browsers were closed cleanly; the original profile was backed up while closed, then reused without a fresh login. Backup: `C:\windows-browser-backups\20260925-150346` (excluding disposable caches/debug screenshots).
- WindowsBrowser logon task installed and tested with a real service restart. Both API ports have the same Node owner; one Chrome uses the original profile.
- Watcher `.env` now enables `WINDOWS_BROWSER_URL=http://100.95.126.123:3878`. Existing watcher cron entries were already paused and remain paused. No alerts were sent.
- App smoke returned five mower listings after task restart. UI radius changes 20→40→20 km were verified. Vehicle detail returned a 932-character description, five photos and seller/attributes.
- Saved notifications UI exposed a selector collision. The app now targets the named Change location dialog instead of every dialog.
- Browser version, proxy and launch settings retained. Sampled fingerprint fields matched before/after.
- Typecheck/build and six migration tests pass; browser-service tests pass too. Three failures in the full suite also occur on unchanged HEAD (config keywords, Gumtree source field, integration smoke).

Known inherited parser gaps: ordinary listings with a Details section do not yet yield a description, and full-document image extraction may include recommendations. Do not mistake a successful transport test for complete extraction of every listing type.

Keep the legacy compatibility routes until Twitter, Reddit and generic callers migrate too. Launch scripts have not moved yet. See the infra Windows Browser README for full rollback instructions; simply unsetting `WINDOWS_BROWSER_URL` switches this app back to the legacy API.

## Build

The existing extractor was moved without a TypeScript rewrite. Its page scripts are template literals; `node --check` alone does not validate them. Migration tests explicitly parse all three embedded scripts. `npm run build` copies both runtime `.mjs` modules into `dist/marketplace-browser/` after TypeScript compilation.

## Limits

Sessions share a login profile and therefore site settings. Do not run concurrent searches that change radius until callers coordinate those workflows. Transport errors propagate; cleanup has its own timeout so a cancelled caller still closes its page. The server reclaims idle abandoned sessions.
