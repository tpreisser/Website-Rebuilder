#!/usr/bin/env bash
# One-screen Foundry status: queue depths, active jobs, last releases, 24h spend.
# Deliberately not set -e: a reporting script must print the whole screen even
# when globs match nothing.
set -u
cd "$(dirname "$0")/.."

count() { ls "$1" 2>/dev/null | grep -c '^job-.*\.json$' || true; }

echo "FOUNDRY STATUS — $(date -u +%FT%TZ)"
echo "─────────────────────────────────────────────"
printf "queue   inbox:%s  active:%s  done:%s  blocked:%s\n" \
  "$(count queue/inbox)" "$(count queue/active)" "$(count queue/done)" "$(count queue/blocked)"

echo
echo "ACTIVE"
for j in queue/active/job-*.json; do
  [ -e "$j" ] || { echo "  (none)"; break; }
  SLUG=$(basename "$j" .json | sed 's/^job-//')
  if [ -f "jobs/$SLUG/state.json" ]; then
    jq -r '"  \(.slug): \(.stage) (iteration \(.iteration), runs \(.budget.runs_used)/\(.budget.max_runs))"' "jobs/$SLUG/state.json"
  else
    echo "  $SLUG: (no state yet)"
  fi
done

echo
echo "LAST 5 RELEASES"
ls -t queue/done/job-*.json 2>/dev/null | head -5 | while read -r j; do
  SLUG=$(basename "$j" .json | sed 's/^job-//')
  URL=$(jq -r '.demo_url // "—"' "jobs/$SLUG/05-release/release.json" 2>/dev/null || echo "—")
  echo "  $SLUG → $URL"
done
[ -z "$(ls queue/done/job-*.json 2>/dev/null)" ] && echo "  (none yet)"

echo
echo "BLOCKED (needs operator decision)"
ls queue/blocked/*-diagnosis.md 2>/dev/null | while read -r d; do echo "  $d"; done
[ -z "$(ls queue/blocked/*-diagnosis.md 2>/dev/null)" ] && echo "  (none)"

echo
if [ -f runs/ledger.csv ]; then
  awk -F, -v cutoff="$(( $(date +%s) - 86400 ))" \
    '$1 > cutoff { s += $4; n += 1 } END { printf "24h: %d runs, $%.2f spent\n", n, s }' runs/ledger.csv
else
  echo "24h: no runs yet"
fi
CAP=$(jq -r '.budget.max_spend_usd_24h' foundry.config.json)
echo "cap: \$$CAP / 24h"
