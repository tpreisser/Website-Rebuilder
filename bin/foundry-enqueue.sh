#!/usr/bin/env bash
# Add work to the Foundry queue.
#   foundry-enqueue.sh --business "Smith Plumbing" --url https://smithplumbing.example
#   foundry-enqueue.sh --sweep        # prospector discovery pass
set -euo pipefail
cd "$(dirname "$0")/.."

usage() { echo "usage: $0 --business <name> --url <url> | --sweep"; exit 1; }

MODE="" NAME="" URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --business) NAME="$2"; MODE="job"; shift 2 ;;
    --url)      URL="$2"; shift 2 ;;
    --sweep)    MODE="sweep"; shift ;;
    *) usage ;;
  esac
done
[ -z "$MODE" ] && usage

if [ "$MODE" = "sweep" ]; then
  SLUG="sweep-$(date +%Y%m%d-%H%M%S)"
  jq -n --arg slug "$SLUG" --arg now "$(date -u +%FT%TZ)" \
    '{slug: $slug, type: "sweep", enqueued_at: $now}' > "queue/inbox/job-$SLUG.json"
  echo "enqueued sweep: queue/inbox/job-$SLUG.json"
  exit 0
fi

[ -z "$NAME" ] || [ -z "$URL" ] && usage
SLUG=$(echo "$NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-50)
if [ -f "queue/inbox/job-$SLUG.json" ] || [ -f "queue/active/job-$SLUG.json" ] \
  || [ -f "queue/done/job-$SLUG.json" ] || [ -f "queue/blocked/job-$SLUG.json" ]; then
  echo "job '$SLUG' already exists in the queue" >&2; exit 1
fi
jq -n --arg slug "$SLUG" --arg name "$NAME" --arg url "$URL" --arg now "$(date -u +%FT%TZ)" \
  '{slug: $slug, type: "rebuild", business: $name, url: $url, enqueued_at: $now, source: "manual"}' \
  > "queue/inbox/job-$SLUG.json"
echo "enqueued: queue/inbox/job-$SLUG.json"
