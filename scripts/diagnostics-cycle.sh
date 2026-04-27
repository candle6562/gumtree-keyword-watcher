#!/usr/bin/env bash
set -euo pipefail

# Permission-safe manual diagnostics workflow for routine-owned runs.
# Produces a markdown summary that can be pasted into GUM-18.

ISSUE_REF="${ISSUE_REF:-GUM-unknown}"
ROUTINE_REF="${ROUTINE_REF:-routine-unknown}"
TMP_OUT="$(mktemp)"
TS_UTC="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

set +e
NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$PWD/.npm-cache}" npm run run:once >"$TMP_OUT" 2>&1
RUN_EXIT=$?
set -e

if [ "$RUN_EXIT" -eq 0 ]; then
  OUTCOME="success"
  ERRORS="none"
  NEXT_ACTION="Append this entry to GUM-18 and continue hourly cycle."
else
  OUTCOME="failed"
  ERRORS="run:once exited with code $RUN_EXIT"
  NEXT_ACTION="Record blocker details in GUM-18 and route to owner with explicit unblock request."
fi

echo "## Diagnostics Entry"
echo ""
echo "- Timestamp: $TS_UTC"
echo "- Run refs: issue=$ISSUE_REF, routine=$ROUTINE_REF"
echo "- Outcome: $OUTCOME"
echo "- Errors: $ERRORS"
echo "- Next action: $NEXT_ACTION"
echo ""
echo "### Runtime Output"
echo '```text'
cat "$TMP_OUT"
echo '```'

rm -f "$TMP_OUT"
exit "$RUN_EXIT"
