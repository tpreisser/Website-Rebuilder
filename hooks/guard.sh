#!/usr/bin/env bash
# Foundry PreToolUse(Bash) guard.
# Runs even in bypassPermissions mode; exit 2 BLOCKS the tool call (stderr -> Claude).
# Defense layer 2 behind the permissions deny list — patterns here catch what
# glob rules can't (flags, paths mid-command, obfuscation via wrappers).
set -euo pipefail

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
[ -z "$CMD" ] && exit 0

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

block() {
  echo "FOUNDRY GUARD BLOCKED: $1" >&2
  echo "$(date -u +%FT%TZ)|BLOCKED|$1|$CMD" >> "$REPO_ROOT/runs/guard-log.txt" 2>/dev/null || true
  exit 2
}

# --- Destructive / system-level ---------------------------------------------
echo "$CMD" | grep -qE '(^|[;&|[:space:]])rm[[:space:]].*(-[a-zA-Z]*[rf])' && {
  # rm -r / -f allowed ONLY on paths inside the repo (relative, or absolute under repo root)
  echo "$CMD" | grep -qE 'rm[[:space:]][^;&|]*[[:space:]](/|~)' \
    && ! echo "$CMD" | grep -qF "$REPO_ROOT" \
    && block "rm -rf outside repository"
}
echo "$CMD" | grep -qE '(^|[;&|[:space:]])(mkfs|fdisk|parted)([[:space:]]|$)' && block "disk tooling"
echo "$CMD" | grep -qE '(^|[;&|[:space:]])dd[[:space:]].*of=/dev' && block "dd to device"
echo "$CMD" | grep -qE '(^|[;&|[:space:]])(shutdown|reboot|halt|poweroff)([[:space:]]|$)' && block "system power command"
echo "$CMD" | grep -qE '(^|[;&|[:space:]])sudo[[:space:]]' && block "sudo"
echo "$CMD" | grep -qE 'chmod[[:space:]]+([0-7]*7[0-7]*7|777|a\+rwx)' && block "world-writable chmod"
echo "$CMD" | grep -qE '(^|[;&|[:space:]])(crontab|systemctl|launchctl)([[:space:]]|$)' && block "scheduler/service modification (operator installs units manually)"

# --- Publishing / exfiltration ----------------------------------------------
echo "$CMD" | grep -qE 'git[[:space:]]+push' && {
  echo "$CMD" | grep -qE 'git[[:space:]]+push[[:space:]]+(-[^[:space:]]+[[:space:]]+)*demo([[:space:]]|$)' \
    || block "git push to non-demo remote"
}
echo "$CMD" | grep -qE '(npm|pnpm|yarn)[[:space:]]+publish' && block "package publish"
echo "$CMD" | grep -qE 'docker[[:space:]]+push' && block "docker push"
echo "$CMD" | grep -qE '(^|[;&|[:space:]])(ssh|scp|sftp|rsync[[:space:]][^;&|]*@)' && block "remote shell/copy"

# --- Secrets ------------------------------------------------------------------
echo "$CMD" | grep -qE '(\.ssh/|\.aws/|\.credentials\.json|/etc/shadow|keychain|security[[:space:]]+find-generic-password)' \
  && block "credential/secret access"

# --- Outbound writes: curl/wget POST-ish to non-allowlisted hosts -------------
if echo "$CMD" | grep -qE '(^|[;&|[:space:]])(curl|wget)[[:space:]]' ; then
  if echo "$CMD" | grep -qE '(-X[[:space:]]*(POST|PUT|PATCH|DELETE)|--method[[:space:]=]*(POST|PUT|PATCH|DELETE)|--data|-d[[:space:]]|--form|-F[[:space:]]|--upload-file|-T[[:space:]]|--post-data|--post-file)'; then
    ALLOWED_POST_HOSTS=$(jq -r '.network.allowed_post_hosts[]?' "$REPO_ROOT/foundry.config.json" 2>/dev/null || true)
    OK=0
    for h in $ALLOWED_POST_HOSTS; do
      echo "$CMD" | grep -qF "$h" && OK=1 && break
    done
    [ "$OK" = "1" ] || block "HTTP write to non-allowlisted host"
  fi
fi

# --- Crawl politeness: raw curl loops against external sites are not the path -
# (capture goes through tools/capture.ts which rate-limits and honors robots.txt)
echo "$CMD" | grep -qE 'for[[:space:]].*(curl|wget)|while[[:space:]].*(curl|wget)' \
  && block "shell-loop crawling (use tools/capture.ts — it rate-limits and honors robots.txt)"

exit 0
