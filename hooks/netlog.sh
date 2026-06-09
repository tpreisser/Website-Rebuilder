#!/usr/bin/env bash
# Logs every external URL touched (WebFetch / Playwright navigate) for provenance.
# Feeds the originality audit: anything in this log is "inspiration-adjacent" material.
set -uo pipefail

INPUT=$(cat)
URL=$(printf '%s' "$INPUT" | jq -r '.tool_input.url // empty')
[ -z "$URL" ] && exit 0

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TS=$(date -u +%FT%TZ)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // "unknown"')

echo "${TS},${TOOL},${URL}" >> "$REPO_ROOT/runs/network-log.csv"

# If exactly one job is active, attribute the URL to it.
ACTIVE=$(ls "$REPO_ROOT/queue/active/" 2>/dev/null | grep -v '^\.' | head -n2)
if [ "$(echo "$ACTIVE" | grep -c .)" = "1" ]; then
  SLUG=$(basename "$ACTIVE" .json | sed 's/^job-//')
  if [ -d "$REPO_ROOT/jobs/$SLUG" ]; then
    echo "${TS},${TOOL},${URL}" >> "$REPO_ROOT/jobs/$SLUG/network-log.txt"
  fi
fi
exit 0
