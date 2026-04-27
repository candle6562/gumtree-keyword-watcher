#!/usr/bin/env bash
set -euo pipefail

: "${PAPERCLIP_API_URL:?PAPERCLIP_API_URL is required}"
: "${PAPERCLIP_API_KEY:?PAPERCLIP_API_KEY is required}"
: "${PAPERCLIP_COMPANY_ID:?PAPERCLIP_COMPANY_ID is required}"

routines_json="$(curl -fsS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/routines")"

active_count="$(printf '%s' "$routines_json" | jq '[.[] | select(.status == "active")] | length')"
terminal_violations=0

printf 'Routine parent-link guard\n'
printf 'Active routines: %s\n' "$active_count"

while IFS=$'\t' read -r routine_id routine_status parent_issue_id; do
  if [ -z "$routine_id" ]; then
    continue
  fi

  issue_json="$(curl -fsS \
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
    "$PAPERCLIP_API_URL/api/issues/$parent_issue_id")"

  issue_identifier="$(printf '%s' "$issue_json" | jq -r '.identifier // .id')"
  issue_status="$(printf '%s' "$issue_json" | jq -r '.status // "unknown"')"

  printf -- '- routine=%s parent=%s status=%s\n' "$routine_id" "$issue_identifier" "$issue_status"

  if [ "$issue_status" = "done" ] || [ "$issue_status" = "cancelled" ]; then
    terminal_violations=$((terminal_violations + 1))
  fi
done < <(printf '%s' "$routines_json" | jq -r '.[] | select(.status == "active" and (.parentIssueId != null)) | [.id, .status, .parentIssueId] | @tsv')

if [ "$terminal_violations" -gt 0 ]; then
  printf 'Guard result: FAIL (%s active routines still linked to terminal parents)\n' "$terminal_violations"
  exit 2
fi

printf 'Guard result: PASS (no active routines linked to terminal parents)\n'
