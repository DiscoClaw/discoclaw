# DiscoClaw Documentation Audit Inventory (2026-02-27)

## Scope

- Audit corpus: all tracked Markdown files (`git ls-files '*.md'`).
- Total files in scope: 48.
- Excluded from scope:
  - generated artifacts (`dist/`)
  - dependency trees (`node_modules/`)
  - untracked planning scratch files

## Coverage Summary

| Surface | Count | Primary Audience |
|---|---:|---|
| Root docs (`README.md`, policies, contributor guides) | 7 | End users, contributors |
| `.context/` | 14 | Contributors, planning agents |
| `docs/` | 10 | End users, operators, contributors |
| `templates/workspace/` | 7 | Runtime agent persona/bootstrap |
| `templates/recipes/` | 1 | Integration authors |
| `recipes/` | 4 | Integration authors/users |
| `skills/` | 3 | Runtime agents |
| `.claude/skills/` | 1 | Runtime agents |
| `groups/` | 1 | Internal project org |

## Canonical File Inventory

### Root docs

- `AGENTS.md` (5 lines, last updated 2026-02-12, `8054666`)
- `CLAUDE.md` (84 lines, last updated 2026-02-26, `efcfa5a`)
- `CONTRIBUTING.md` (49 lines, last updated 2026-02-21, `1ad1c6a`)
- `DISCLAIMER.md` (25 lines, last updated 2026-02-16, `007c8bc`)
- `MIGRATION.md` (32 lines, last updated 2026-02-22, `ac5a110`)
- `README.md` (254 lines, last updated 2026-02-26, `efcfa5a`)
- `SECURITY.md` (25 lines, last updated 2026-02-22, `18f18bc`)

### `.context/`

- `.context/README.md` (44 lines, last updated 2026-02-26, `efcfa5a`)
- `.context/architecture.md` (58 lines, last updated 2026-02-26, `efcfa5a`)
- `.context/bot-setup.md` (24 lines, last updated 2026-02-21, `522719e`)
- `.context/dev.md` (345 lines, last updated 2026-02-22, `18f18bc`)
- `.context/discord.md` (156 lines, last updated 2026-02-24, `6cb3fae`)
- `.context/memory.md` (282 lines, last updated 2026-02-27, `a4847f5`)
- `.context/ops.md` (59 lines, last updated 2026-02-11, `3fbf630`)
- `.context/pa-safety.md` (47 lines, last updated 2026-02-22, `926d4c3`)
- `.context/pa.md` (118 lines, last updated 2026-02-25, `77c9827`)
- `.context/project.md` (42 lines, last updated 2026-02-26, `ea708fe`)
- `.context/runtime.md` (347 lines, last updated 2026-02-25, `b29a441`)
- `.context/tasks.md` (72 lines, last updated 2026-02-22, `18f18bc`)
- `.context/tools.md` (75 lines, last updated 2026-02-14, `60d9e53`)
- `.context/voice.md` (87 lines, last updated 2026-02-27, `dceea06`)

### `docs/`

- `docs/INVENTORY.md` (329 lines, last updated 2026-02-27, `28accdb`)
- `docs/data-migration.md` (71 lines, last updated 2026-02-22, `b6bc638`)
- `docs/discoclaw-recipe-spec.md` (183 lines, last updated 2026-02-27, `fef2870`)
- `docs/discord-actions.md` (550 lines, last updated 2026-02-27, `55545d5`)
- `docs/discord-bot-setup.md` (180 lines, last updated 2026-02-25, `d0c3d4a`)
- `docs/mcp.md` (93 lines, last updated 2026-02-27, `4aedbc5`)
- `docs/philosophy.md` (21 lines, last updated 2026-02-24, `ff730bd`)
- `docs/plan-and-forge.md` (1069 lines, last updated 2026-02-25, `b29a441`)
- `docs/releasing.md` (156 lines, last updated 2026-02-25, `f062171`)
- `docs/voice.md` (341 lines, last updated 2026-02-27, `dceea06`)

### Recipes + recipe templates

- `recipes/README.md` (17 lines, last updated 2026-02-13, `f4cfe22`)
- `recipes/examples/auto-thread-welcome-action.discoclaw-recipe.md` (162 lines, last updated 2026-02-13, `f4cfe22`)
- `recipes/examples/openai-compatible-runtime-adapter.discoclaw-recipe.md` (167 lines, last updated 2026-02-13, `f4cfe22`)
- `recipes/examples/photo-critique-channel-context.discoclaw-recipe.md` (112 lines, last updated 2026-02-13, `f4cfe22`)
- `templates/recipes/integration.discoclaw-recipe.md` (171 lines, last updated 2026-02-13, `f4cfe22`)

### Skills

- `.claude/skills/README.md` (15 lines, last updated 2026-02-09, `f3b75c8`)
- `skills/discoclaw-discord-bot-setup/SKILL.md` (107 lines, last updated 2026-02-21, `522719e`)
- `skills/discoclaw-recipe-consumer/SKILL.md` (58 lines, last updated 2026-02-13, `f4cfe22`)
- `skills/discoclaw-recipe-generator/SKILL.md` (64 lines, last updated 2026-02-13, `f4cfe22`)

### Workspace templates

- `templates/workspace/AGENTS.md` (215 lines, last updated 2026-02-26, `b83da57`)
- `templates/workspace/BOOTSTRAP.md` (1 line, last updated 2026-02-21, `1d8b608`)
- `templates/workspace/IDENTITY.md` (16 lines, last updated 2026-02-13, `09cceee`)
- `templates/workspace/MEMORY.md` (24 lines, last updated 2026-02-11, `28227c2`)
- `templates/workspace/SOUL.md` (52 lines, last updated 2026-02-21, `0dca795`)
- `templates/workspace/TOOLS.md` (501 lines, last updated 2026-02-25, `fdc7292`)
- `templates/workspace/USER.md` (37 lines, last updated 2026-02-11, `9c23027`)

### Other docs

- `groups/README.md` (10 lines, last updated 2026-02-09, `3afb289`)

## Mechanical Checks Run

- Local Markdown links to local files: no missing path targets detected.
- Source-of-truth drift scan:
  - stale references to missing docs and files were found (see `doc-audit-findings.md`).
- CI coverage scan:
  - no docs-specific quality gate in `.github/workflows/ci.yml`.

## High-Drift-Risk Documents (size and churn)

- `docs/plan-and-forge.md` (1069 lines)
- `docs/discord-actions.md` (550 lines)
- `templates/workspace/TOOLS.md` (501 lines)
- `.context/dev.md` (345 lines)
- `.context/runtime.md` (347 lines)
- `docs/voice.md` (341 lines)

These are the highest-value targets for split/indexing work in remediation waves.
