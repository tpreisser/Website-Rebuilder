# Foundry

An autonomous Claude Code system that finds dated local-business websites and rebuilds
them into world-class, fully original sites — verified by a multi-stage Perfection Gate
before a human ever sees them.

**Operator:** Tyler Preisser, Preisser Solutions, Hays KS.

## How it works

A bash supervisor (`bin/foundry-run.sh`) is the only thing that runs forever. It claims
one job from a disk-based queue and launches one fresh headless Claude Code run
(`claude -p … --output-format json`) per job. Inside that run the main agent is the
orchestrator: it reads `jobs/<slug>/state.json`, resumes the pipeline at the recorded
stage, delegates heavy work to the subagents in `.claude/agents/`, and enforces the
Perfection Gate. State lives on disk; a killed run loses nothing.

```
PROSPECT → CAPTURE → RESEARCH → THESIS → BUILD ⇄ VERIFY → RELEASE
                                            (revision loop, budgeted)
```

See `pipeline/stages.md` for stage contracts and `pipeline/DOCS-NOTES.md` for the
verified CLI facts everything is built against.

## Quick start

```bash
npm install
npx playwright install chromium      # browser binary for tools/ + Playwright MCP
npm run smoke                        # toolchain + guardrail self-test

# enqueue a hand-picked job
bin/foundry-enqueue.sh --business "Smith Plumbing" --url https://smithplumbing.example

# run the supervisor (Strategy 2: host, deny-on-prompt)
bin/foundry-run.sh

# or sandboxed full autonomy (Strategy 1)
docker build -t foundry .
docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN -e FOUNDRY_PERMISSION_MODE=bypassPermissions \
  -v "$PWD":/foundry foundry

bin/foundry-status.sh                # the operator's one screen
```

Unattended auth: `claude setup-token` → set `CLAUDE_CODE_OAUTH_TOKEN`.

## Layout

| Path | What |
|---|---|
| `CLAUDE.md` | Orchestrator brain — the per-job main agent's standing instructions |
| `.claude/agents/` | 13 specialist subagents (archivist, analyst, director, engineers, 3 critics, 2 auditors, marshal, prospector) |
| `.claude/skills/` | Taste & standards library (7 skills incl. the Perfection Gate law and the direction die) |
| `.claude/settings.json` | Deny rules + allowlist + hook wiring |
| `hooks/` | guard (blocks destructive/exfil commands, works even in bypass mode), netlog (URL provenance), format, checkpoint |
| `bin/` | supervisor, enqueue, status, systemd/launchd/cron units |
| `tools/` | capture, audit (Lighthouse/axe/links/meta), screenshot-matrix, similarity-check |
| `queue/` | inbox → active → done / blocked (file moves are the state machine) |
| `jobs/<slug>/` | 00-capture … 05-release + state.json |
| `runs/` | headless run logs, ledger.csv (spend), guard/network logs |

## Hard rules

Originality (inspiration is never source material), polite capture (robots.txt, ≤ 1 req/s,
honest UA, public pages only), containment (private noindexed demos only, no outreach,
no publishing as the business), budgets (per-job run/iteration caps, 24h spend cap).
Encoded in `CLAUDE.md`, enforced by `.claude/settings.json` + `hooks/guard.sh`.

## Operator surface

1. `bin/foundry-status.sh` — one screen.
2. `queue/done/` — released jobs (passed the full gate; nothing else to review).
3. `queue/blocked/` — rare, short, decision-ready diagnoses.
4. Optional ntfy.sh ping on RELEASE/BLOCK (`foundry.config.json .notify.ntfy_topic`).
