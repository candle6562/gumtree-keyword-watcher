#!/usr/bin/env bash
set -euo pipefail

bash scripts/check-dotenv-postcode.sh
npm run typecheck
npm test
npm run build
