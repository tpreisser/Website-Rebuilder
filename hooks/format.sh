#!/usr/bin/env bash
# PostToolUse(Write|Edit): auto-format files written inside any job's 03-build/.
set -uo pipefail

INPUT=$(cat)
FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0

case "$FILE" in
  */jobs/*/03-build/*)
    case "$FILE" in
      *.ts|*.tsx|*.js|*.jsx|*.astro|*.css|*.json|*.html|*.md)
        REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
        (cd "$REPO_ROOT" && npx --no-install prettier --write "$FILE" >/dev/null 2>&1) || true
        ;;
    esac
    ;;
esac
exit 0
