# Foundry pipeline stages — canonical definitions

A **job** = one local business. `jobs/<slug>/state.json` records `stage`, `iteration`,
`gate_history`, `started_at`, `budget`. The orchestrator reads state first and resumes
idempotently; a relaunched run picks up exactly where the last one died. Transitions are
one-way except VERIFY→BUILD (the revision loop). Every transition is logged to
`state.json` with a one-line rationale.

`stage` values: `CAPTURE → RESEARCH → THESIS → BUILD → VERIFY → RELEASED`
(plus `BLOCKED` terminal, and sweep jobs which run `PROSPECT` only).

| # | Stage | Owner | Entry requires | Exit criteria |
|---|-------|-------|----------------|---------------|
| P | PROSPECT (sweep jobs only) | prospector | sweep job claimed | ≥ N scored leads (see `foundry.config.json .sweep`) written to `queue/inbox/` as `job-<slug>.json` with evidence screenshots; excluded verticals & existing clients filtered |
| 0 | CAPTURE | site-archivist | job json has `url` | `00-capture/` holds: full-page screenshots (mobile+desktop) of ≤ 40 public pages, `copy-inventory.md`, `page-inventory.json`, `assets-manifest.json` (stock vs proprietary noted), `tech-fingerprint.json`, `weakness-audit.md` with screenshot exhibits. Capture via `tools/capture.ts` (robots.txt, ≤ 1 req/s, honest UA) |
| 1 | RESEARCH | industry-analyst | CAPTURE done | `01-research/industry-brief.md`: precise industry classification, 3 local/regional + 3–5 world-class teardowns (annotated screenshots, layout/motion/type/IA/conversion notes **in words and diagrams, never code**), table-stakes list, white-space list, honest verdict on whether the world-class set sets a high bar (if not, the brief pivots the bar to the design-excellence skill) |
| 2 | THESIS | design-director, orchestrator co-authors | RESEARCH done | `02-thesis/thesis.md` signed by orchestrator: one-sentence concept, 3 moodwords, type system (license-verified), color tokens, layout grammar, motion language + reduced-motion plan, IA + page list, component inventory, banned-pattern list, signature moment, "never been seen because ___" statement, direction-die roll recorded (no family twice in a row; full die cycles before repeats — check `skills/design-excellence/LEARNED.md`) |
| 3 | BUILD | component-engineer + motion-engineer + copy-strategist | THESIS signed | `03-build/` is a self-contained package (Astro default / Next if thesis demands); all thesis pages implemented; production build succeeds; dev server runs; zero console errors; copy sourced only from capture facts |
| 4 | VERIFY | auditor-technical, auditor-originality, 3 critics, orchestrator | BUILD complete | Full Perfection Gate (`.claude/skills/perfection-gate/SKILL.md`): §8.1 hard gates pass, §8.2 matrix reviewed by orchestrator, §8.3 originality pass, §8.4 three critics ≥ 9.0 with zero blocking findings, **twice consecutively**. Failure → revision brief → BUILD (max `budget.max_verify_loops`) |
| 5 | RELEASE | release-marshal | orchestrator certifies gate | Private demo deployed (noindex, `<slug>.demo.preissersolutions.com`), final live screenshot pass verified, `05-release/` holds before/after page, Lighthouse deltas, pitch one-pager, `release.json` with `demo_url`; `state.stage = RELEASED`; supervisor moves job to `queue/done/` |

## BLOCKED
After `budget.max_verify_loops` failed VERIFY rounds or `budget.max_runs` headless runs:
orchestrator writes `queue/blocked/<slug>-diagnosis.md` (what kept failing, hypothesis,
recommended human decision), sets `stage = BLOCKED`, exits 0. The near-miss is never shipped.

## state.json shape
```json
{
  "slug": "smith-plumbing",
  "stage": "BUILD",
  "iteration": 1,
  "gate_history": [
    { "round": 1, "at": "…", "technical": "fail", "originality": "pass",
      "critics": { "design": 8.5, "conversion": 9.0, "craft": 9.5 },
      "blocking_findings": 2, "rationale": "LCP 2.4s on /services; hero similarity 0.91" }
  ],
  "started_at": "…",
  "budget": { "max_runs": 6, "max_verify_loops": 4, "runs_used": 2 },
  "plan_next": "one-line note for the next run"
}
```
