#!/usr/bin/env bash
# Foundry supervisor: claims one job, runs one headless Claude Code pass, repeats.
# The ONLY thing that runs forever. All intelligence lives in the per-job runs.
#
# Env knobs:
#   FOUNDRY_WORKER            worker id (default w1)
#   FOUNDRY_PERMISSION_MODE   dontAsk (host, Strategy 2 — default) |
#                             bypassPermissions (inside Docker only, Strategy 1)
#   FOUNDRY_ONCE=1            process at most one job then exit (smoke tests)
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT=$PWD

WORKER="${FOUNDRY_WORKER:-w1}"
PERM_MODE="${FOUNDRY_PERMISSION_MODE:-dontAsk}"

if [ "$PERM_MODE" = "bypassPermissions" ] && [ "${FOUNDRY_IN_SANDBOX:-0}" != "1" ]; then
  echo "REFUSING: bypassPermissions outside the sandbox (set FOUNDRY_IN_SANDBOX=1 only in Docker)." >&2
  exit 1
fi

spend_24h() {
  # ledger.csv: timestamp_epoch,slug,worker,cost_usd,turns,result
  [ -f runs/ledger.csv ] || { echo 0; return; }
  awk -F, -v cutoff="$(( $(date +%s) - 86400 ))" \
    '$1 > cutoff { s += $4 } END { printf "%.2f", s }' runs/ledger.csv
}

while true; do
  # --- spend cap -------------------------------------------------------------
  CAP=$(jq -r '.budget.max_spend_usd_24h // 50' foundry.config.json)
  SPENT=$(spend_24h)
  if awk -v s="$SPENT" -v c="$CAP" 'BEGIN { exit !(s >= c) }'; then
    echo "$(date -u +%FT%TZ) spend cap reached (\$$SPENT / \$$CAP / 24h); sleeping 1h"
    sleep 3600; continue
  fi

  # --- claim next job ----------------------------------------------------------
  JOB=$(ls queue/inbox/ 2>/dev/null | grep '^job-.*\.json$' | head -n1 || true)
  if [ -z "$JOB" ]; then
    [ "${FOUNDRY_ONCE:-0}" = "1" ] && exit 0
    sleep 300; continue
  fi
  mv "queue/inbox/$JOB" "queue/active/$JOB"    # atomic claim
  SLUG=$(basename "$JOB" .json | sed 's/^job-//')
  TS=$(date +%Y%m%d-%H%M%S)
  RUN_LOG="runs/${TS}-${SLUG}-${WORKER}.json"

  # --- job scaffolding + run-budget check -------------------------------------
  mkdir -p "jobs/$SLUG"/{00-capture,01-research,02-thesis,03-build,04-verification,05-release}
  if [ ! -f "jobs/$SLUG/state.json" ]; then
    jq -n --arg slug "$SLUG" --arg now "$(date -u +%FT%TZ)" \
      --argjson runs "$(jq '.budget.max_runs_per_job' foundry.config.json)" \
      --argjson loops "$(jq '.budget.max_verify_loops' foundry.config.json)" \
      '{slug: $slug, stage: "CAPTURE", iteration: 0, gate_history: [],
        started_at: $now, budget: {max_runs: $runs, max_verify_loops: $loops, runs_used: 0}}' \
      > "jobs/$SLUG/state.json"
  fi
  RUNS_USED=$(jq -r '.budget.runs_used // 0' "jobs/$SLUG/state.json")
  MAX_RUNS=$(jq -r '.budget.max_runs // 6' "jobs/$SLUG/state.json")
  if [ "$RUNS_USED" -ge "$MAX_RUNS" ]; then
    jq '.stage = "BLOCKED"' "jobs/$SLUG/state.json" > "jobs/$SLUG/state.json.tmp" \
      && mv "jobs/$SLUG/state.json.tmp" "jobs/$SLUG/state.json"
    [ -f "queue/blocked/${SLUG}-diagnosis.md" ] || \
      echo "Run budget exhausted ($RUNS_USED/$MAX_RUNS) before RELEASE. See jobs/$SLUG/state.json gate_history." \
      > "queue/blocked/${SLUG}-diagnosis.md"
    mv "queue/active/$JOB" "queue/blocked/$JOB"
    echo "BLOCKED $SLUG" > runs/last-event.txt
    continue
  fi
  jq '.budget.runs_used += 1' "jobs/$SLUG/state.json" > "jobs/$SLUG/state.json.tmp" \
    && mv "jobs/$SLUG/state.json.tmp" "jobs/$SLUG/state.json"

  # --- one headless pass --------------------------------------------------------
  MAX_USD=$(jq -r '.budget.max_budget_usd_per_run // 8' foundry.config.json)
  echo "$(date -u +%FT%TZ) [$WORKER] run $((RUNS_USED + 1))/$MAX_RUNS for '$SLUG' (mode: $PERM_MODE)"
  claude -p "Execute the Foundry pipeline for job '$SLUG'. Read CLAUDE.md and jobs/$SLUG/state.json first; resume from the recorded stage. Work until the job reaches RELEASE, hits its budget, or you have made all the progress one run can make. Update state.json before exiting." \
    --output-format json \
    --permission-mode "$PERM_MODE" \
    --max-budget-usd "$MAX_USD" \
    --no-session-persistence \
    > "$RUN_LOG" 2> "${RUN_LOG%.json}.stderr" || true

  # --- ledger ---------------------------------------------------------------------
  COST=$(jq -r '.total_cost_usd // 0' "$RUN_LOG" 2>/dev/null || echo 0)
  TURNS=$(jq -r '.num_turns // 0' "$RUN_LOG" 2>/dev/null || echo 0)
  RESULT=$(jq -r 'if .is_error then "error" else "ok" end' "$RUN_LOG" 2>/dev/null || echo "crashed")
  echo "$(date +%s),$SLUG,$WORKER,$COST,$TURNS,$RESULT" >> runs/ledger.csv

  # --- route by resulting stage ------------------------------------------------------
  if [ -f "queue/active/$JOB" ]; then
    STAGE=$(jq -r '.stage // "unknown"' "jobs/$SLUG/state.json" 2>/dev/null || echo "unknown")
    case "$STAGE" in
      RELEASED) mv "queue/active/$JOB" "queue/done/$JOB";    echo "RELEASED $SLUG" > runs/last-event.txt ;;
      BLOCKED)  mv "queue/active/$JOB" "queue/blocked/$JOB"; echo "BLOCKED $SLUG"  > runs/last-event.txt ;;
      *)        mv "queue/active/$JOB" "queue/inbox/$JOB" ;;   # resume next cycle
    esac
    echo "$(date -u +%FT%TZ) [$WORKER] '$SLUG' → $STAGE (cost \$$COST, $TURNS turns, $RESULT)"
  fi

  [ "${FOUNDRY_ONCE:-0}" = "1" ] && exit 0
done
