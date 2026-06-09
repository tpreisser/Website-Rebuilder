# DOCS-NOTES — verified CLI/docs facts for Foundry
> Pinned 2026-06-09 against Claude Code CLI **2.1.170** and https://code.claude.com/docs.
> Re-verify after any CLI upgrade (`claude --version`); this file is the source of truth
> for flag names and rule syntax used by Foundry scripts.

## 1. Headless invocation
- `claude -p "<prompt>" --output-format json` — single JSON result on stdout
  (fields include `result`, `total_cost_usd`, `usage`, `session_id`, `is_error`).
  `--output-format stream-json` for realtime; `--include-hook-events` works only with stream-json.
- **`--max-turns` does NOT exist in 2.1.170.** The plan's supervisor sketch referenced it;
  use `--max-budget-usd <amount>` (print-mode only) as the per-run cost ceiling instead.
- Useful print-mode flags: `--fallback-model <m1,m2>`, `--no-session-persistence`,
  `--json-schema <schema>` (structured output), `--effort low|medium|high|xhigh|max`.
- `--model` accepts aliases (`fable`, `opus`, `sonnet`) or full names (`claude-fable-5`).
- `--settings <file-or-json>` loads extra settings; `--setting-sources user,project,local`
  restricts which settings files load.
- Settings files that fail validation are **silently ignored** in `-p` mode — validate
  `.claude/settings.json` with `jq` in CI/smoke tests, never assume it loaded.
- Auth for unattended runs: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, 1-year,
  Pro/Max/Team) or `ANTHROPIC_API_KEY`. Precedence: Bedrock/Vertex env > AUTH_TOKEN >
  API_KEY > apiKeyHelper > OAUTH_TOKEN > subscription login.
  Note: starting 2026-06-15, `claude -p` on subscription plans draws from a separate
  monthly Agent SDK credit.

## 2. Permission modes (CLI `--permission-mode`, settings `permissions.defaultMode`)
Choices: `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`.
- **`dontAsk`** = the "deny-on-prompt" mode Strategy 2 wants: auto-DENIES anything not
  pre-approved by allow rules, never hangs waiting for a human.
- **`bypassPermissions`** = Strategy 1 (inside Docker only). Explicit `ask` rules still
  prompt even in bypass mode — so Foundry must use **deny** rules (not ask) for hard blocks.
  `rm -rf /` and `rm -rf ~` still trip a built-in circuit-breaker prompt.
- `--dangerously-skip-permissions` ≈ bypassPermissions from the CLI. Never on the host.

## 3. Permission rule syntax (settings.json `permissions.{allow,ask,deny}`)
- Evaluation order: **deny → ask → allow**; first match wins; deny at any settings level
  beats allow at every level. Precedence of sources: managed > CLI args > `.claude/settings.local.json`
  > `.claude/settings.json` > `~/.claude/settings.json`.
- Bash: glob with `*` anywhere; `*` spans spaces. `Bash(ls *)` (space) enforces word
  boundary; `Bash(ls:*)` ≡ trailing-` *`. Compound commands (`&&`, `;`, `|`…) are split and
  EVERY subcommand must match an allow rule. Wrappers `timeout/time/nice/nohup/stdbuf` and
  bare `xargs` are stripped before matching. `find -exec`, `watch`, `setsid` always prompt.
  A built-in read-only set (`ls cat grep find diff git-read-only` …) never prompts in any mode.
- Read/Edit: gitignore-style. `//abs/path`, `~/home-rel`, `/project-root-rel`, `rel-to-cwd`.
  Bare filename matches at any depth (`Read(.env)` ≡ `Read(**/.env)`). Deny rules also catch
  symlinks whose **target** matches. They do NOT bind subprocesses (a node script can still
  open files) — that's what the Docker sandbox / OS sandbox is for.
- `WebFetch(domain:example.com)` — domain-scoped fetch rules.
- MCP: `mcp__server` (whole server), `mcp__server__tool`, `mcp__server__*`.
- Subagents: `Agent(agent-name)` rules can deny specific agents.
- Bare-tool-name deny removes the tool from context entirely; scoped deny blocks matching calls.
- Bash arg-constraining patterns are FRAGILE (flags/redirects/vars evade them) — per docs,
  enforce network policy via WebFetch domain rules + a PreToolUse hook, not curl patterns.

## 4. Hooks (settings.json `hooks` key)
- Events Foundry uses: `PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`, `SubagentStop`.
  (Many more exist: PostToolUseFailure, PermissionRequest/Denied, PreCompact/PostCompact, …)
- Shape: `{"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command",
  "command": "<abs-or-repo path>", "timeout": 30}]}]}}`. Matcher = tool name, `A|B` list,
  or regex when other chars present (`mcp__.*`). `"*"`/omitted = all.
- Handler types: `command`, `http`, `mcp_tool`, `prompt`, `agent`. Foundry uses `command`.
- Blocking from a command hook: **exit 2** blocks the tool call (stderr is fed to Claude);
  exit 0 allows (stdout JSON processed if present); other codes = non-blocking error.
  JSON alternative: exit 0 + `{"hookSpecificOutput":{"hookEventName":"PreToolUse",
  "permissionDecision":"deny|allow|ask|defer","permissionDecisionReason":"…"}}`.
- Hook stdin JSON: `session_id`, `transcript_path`, `cwd`, `permission_mode`,
  `hook_event_name`, `tool_name`, `tool_input` (e.g. `.tool_input.command` for Bash,
  `.tool_input.url` for WebFetch).
- **Hook deny/exit-2 beats allow rules and works in bypassPermissions mode** — this is the
  load-bearing fact for Strategy 1's defense-in-depth. Deny/ask permission rules are also
  still evaluated in bypass mode.

## 5. Subagents (`.claude/agents/*.md`)
- Markdown + YAML frontmatter. Identity comes from the `name` field; keep names unique.
- Frontmatter fields: `name`, `description` (drives delegation — write it for the
  orchestrator), `tools` (list; omit to inherit all), `disallowedTools`, `model`
  (alias like `sonnet`/`opus`/`fable` or full id), `permissionMode`, `maxTurns`,
  `skills`, `memory`, `effort`, `hooks`, `mcpServers`, `initialPrompt`, `color`.
- Project scope `.claude/agents/` (priority over `~/.claude/agents/`); scanned recursively;
  loaded at session start (file edits need a session restart — fine for fresh headless runs).
- Subagents cannot spawn subagents → the orchestrator must be the main agent (plan §1.2 holds).
- `maxTurns` frontmatter is the per-agent turn budget (replaces the dead CLI flag at agent level).

## 6. Playwright MCP
- Package: `@playwright/mcp` (Microsoft-maintained). Project-scoped install for Foundry:
  `.mcp.json` at repo root with
  `{"mcpServers": {"playwright": {"command": "npx", "args": ["@playwright/mcp@latest", "--headless", "--isolated"]}}}`
  (or `claude mcp add playwright -s project -- npx @playwright/mcp@latest --headless`).
- Tool names surface as `mcp__playwright__browser_navigate`, `…__browser_take_screenshot`,
  `…__browser_snapshot`, etc. Permission rules: `mcp__playwright` allows the whole server.
- Requires Chromium: `npx playwright install chromium --with-deps` (also needed by tools/*.ts;
  Dockerfile handles this in-image).
- Batch work (40-page crawls, 4-viewport matrices) goes through `tools/*.ts` raw Playwright,
  not MCP round-trips — MCP is for the orchestrator/critics' interactive inspection.

## 7. Corrections applied to the master plan
| Plan said | Reality (2.1.170) | Foundry does |
|---|---|---|
| `--max-turns 400` in supervisor | flag removed | `--max-budget-usd` per run + `maxTurns` in agent frontmatter |
| "deny-on-prompt permission mode" | named `dontAsk` | `--permission-mode dontAsk` (Strategy 2 default) |
| hooks block "even in bypass" | confirmed: exit-2 hook + deny rules apply in bypassPermissions | guard.sh exit-2 + deny rules |
| `claude --output-format json` cost tracking | `total_cost_usd` + `usage` in result JSON | supervisor parses run JSON into `runs/ledger.csv` |
