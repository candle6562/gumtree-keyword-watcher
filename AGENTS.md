# AGENTS.md — gumtree-keyword-watcher

## Purpose
Market watch bot for WhatsApp alerts.

- Repo: `/git/gumtree-keyword-watcher`
- Mounted in OpenClaw container at: `/opt/gumtree-keyword-watcher`
- Cron wrappers live in: `/git/agent-infra/gumtree-keyword-watcher/`
- OpenClaw routing docs live in: `/git/openclaw-data/workspace/TOOLS.md` and `/git/openclaw-data/workspace/skills/market-watch/SKILL.md`
- Legacy Facebook scraper worker lives on Windows at: `/mnt/c/fb-browser-worker`
- New generic Windows Browser: `/mnt/c/windows-browser`, source `/git/agent-infra/windows-browser`, port 3878. Opt-in only; production is not switched.
- Marketplace logic now also lives in `src/marketplace-browser/`. See `docs/windows-browser.md` for migration, login blocker and read-only smoke command.

## Source of truth
Use `config/watches.json` for watches.
Do not use old `config/keywords.json` except for legacy cleanup.

Watch model:
```json
{
  "name": "Camper van",
  "enabled": true,
  "frequency": "10m",
  "noChange": true,
  "distanceKm": 100,
  "minPrice": 1000,
  "maxPrice": 10000,
  "terms": ["camper van"]
}
```

`distanceKm` is rounded up to the nearest radius Facebook offers (1, 2, 5, 10,
20, 40, 60, 80, 100, 250, 500 km) and applied through its own location control —
it is not a URL parameter. `minPrice`/`maxPrice` are sent to Facebook as search
filters and re-checked locally; a listing with no parseable price is excluded
whenever either bound is set.

A new watch should always get a default term equal to the watch name, lower-cased.

## Common commands
Run from `/git/gumtree-keyword-watcher`:

```bash
npm run watches -- list
npm run watches -- show "Robo Lawnmower"
npm run watches -- create "Camper van"
npm run watches -- add "Camper van" "vw camper"
npm run watches -- max-price "Camper van" 10000
npm run watches -- no-found "Camper van" on
npm --silent run search -- "camper van 30D"
npm run typecheck
```

## Cron
Installed crons:

```cron
*/10 * * * * /git/agent-infra/gumtree-keyword-watcher/run-robotic-lawn-mower.sh >> /home/tom/.agent-logs/gumtree-robotic-lawn-mower-cron.log 2>&1
0 8 * * * /git/agent-infra/gumtree-keyword-watcher/daily-summary.sh >> /home/tom/.agent-logs/gumtree-daily-summary-cron.log 2>&1
```

Main watch loop:
```bash
/git/agent-infra/gumtree-keyword-watcher/run-robotic-lawn-mower.sh
```

Daily summary:
```bash
/git/agent-infra/gumtree-keyword-watcher/daily-summary.sh
```

Both wrappers load Node via nvm and OpenClaw token from `/git/openclaw/.env`.
Both use lock files in `/home/tom/.agent-logs/` to prevent overlap.

## Cache / dedupe
Seen cache:

```text
/git/gumtree-keyword-watcher/.data/seen-listings.json
```

Cron sends only unseen URLs.
Daily summary does not mark items as seen.
Use a temp cache for tests:

```bash
DRY_RUN=true DATA_PATH=/tmp/gumtree-test-seen.json /git/agent-infra/gumtree-keyword-watcher/run-robotic-lawn-mower.sh
```

## Deploy rules
Repo code is bind-mounted into OpenClaw. No `docker cp` needed for `/git/gumtree-keyword-watcher` code changes.

After code changes:
```bash
cd /git/gumtree-keyword-watcher
npm run typecheck
```

After cron wrapper changes:
```bash
bash -n /git/agent-infra/gumtree-keyword-watcher/run-robotic-lawn-mower.sh
bash -n /git/agent-infra/gumtree-keyword-watcher/daily-summary.sh
crontab -l | grep gumtree
```

After OpenClaw command/routing doc changes:
```bash
docker cp /git/openclaw-data/workspace/TOOLS.md openclaw_openclaw-gateway_1:/home/node/.openclaw/workspace/TOOLS.md
docker cp /git/openclaw-data/workspace/skills/market-watch/SKILL.md openclaw_openclaw-gateway_1:/home/node/.openclaw/workspace/skills/market-watch/SKILL.md
docker exec openclaw_openclaw-gateway_1 chown node:node /home/node/.openclaw/workspace/TOOLS.md /home/node/.openclaw/workspace/skills/market-watch/SKILL.md
docker restart openclaw_openclaw-gateway_1
```

If OpenClaw keeps old behavior, reset the WhatsApp session:
```bash
docker exec openclaw_openclaw-gateway_1 openclaw sessions --json | python3 -c "import json,sys; d=json.load(sys.stdin); [print(s['sessionId']) for s in d['sessions'] if 'whatsapp' in s['key']]"
docker exec openclaw_openclaw-gateway_1 openclaw agent --to +447791851722 --channel whatsapp --session-id <SESSION_ID> --message "/reset" --json
```

After Facebook worker changes in `/mnt/c/fb-browser-worker`:
```bash
/mnt/c/Windows/System32/wbem/WMIC.exe process where "name='node.exe'" get processid,commandline
/mnt/c/Windows/System32/taskkill.exe /PID <server.js pid> /PID <npm wrapper pid> /F
/mnt/c/Windows/System32/cmd.exe /c "C:\fb-browser-worker\start-worker-detached.cmd"
```

## Test path
Before saying done, run enough of this:

```bash
cd /git/gumtree-keyword-watcher
npm run typecheck
npm run watches -- list
DRY_RUN=true DATA_PATH=/tmp/gumtree-test-seen.json /git/agent-infra/gumtree-keyword-watcher/run-robotic-lawn-mower.sh
DRY_RUN=true /git/agent-infra/gumtree-keyword-watcher/daily-summary.sh
```

For OpenClaw WhatsApp command tests, always use the real WhatsApp session id, not default `agent:main:main`.
