#!/usr/bin/env bash
set -euo pipefail

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

env_file="$tmpdir/.env"
cat > "$env_file" <<'ENV'
POSTCODE=NE30 3SB
ENV

actual="$(DOTENV_CONFIG_PATH="$env_file" node -r dotenv/config -e 'process.stdout.write(process.env.POSTCODE ?? "")')"

if [[ "$actual" != "NE30 3SB" ]]; then
  echo "dotenv postcode load regression: expected 'NE30 3SB', got '$actual'" >&2
  exit 1
fi

echo "dotenv postcode check passed"
