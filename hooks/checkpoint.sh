#!/usr/bin/env bash
# Stop hook: checkpoint-commit job state so every headless run leaves an audit
# trail and an instant rollback point. Never pushes (guard.sh + deny rules block
# pushes anyway); never blocks the stop (always exits 0).
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO_ROOT"

# Only commit pipeline state, not unrelated noise.
git add -A jobs queue runs 2>/dev/null || true
if ! git diff --cached --quiet 2>/dev/null; then
  ACTIVE=$(ls queue/active/ 2>/dev/null | grep -v '^\.' | head -n1 || true)
  SLUG=$(basename "${ACTIVE:-checkpoint}" .json | sed 's/^job-//')
  git -c user.name="foundry" -c user.email="foundry@preissersolutions.local" \
    commit -m "checkpoint(${SLUG}): run ended $(date -u +%FT%TZ)" >/dev/null 2>&1 || true
fi

# Optional operator ping on release/block (configure in foundry.config.json).
NTFY=$(jq -r '.notify.ntfy_topic // empty' foundry.config.json 2>/dev/null || true)
if [ -n "$NTFY" ] && [ -f runs/last-event.txt ]; then
  EVENT=$(cat runs/last-event.txt)
  case "$EVENT" in
    RELEASED*|BLOCKED*)
      curl -s -m 10 -d "$EVENT" "https://ntfy.sh/$NTFY" >/dev/null 2>&1 || true
      rm -f runs/last-event.txt
      ;;
  esac
fi
exit 0
