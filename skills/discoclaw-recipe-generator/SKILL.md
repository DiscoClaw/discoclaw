---
name: discoclaw-recipe-generator
description: Generate a spec-compliant `recipes/*.discoclaw-recipe.md` file for shareable DiscoClaw integrations (runtime, actions, or context), including YAML frontmatter metadata, risk-gated JSON contracts, safety details, and a consumer handoff prompt.
---

# DiscoClaw Recipe Generator

Generate shareable DiscoClaw integration recipes using `docs/discoclaw-recipe-spec.md`.

## Use This Skill When

- A user asks to create a reusable integration recipe for another DiscoClaw user.
- A user wants a PRD-style handoff file for agent implementation.
- A user asks for a `.discoclaw-recipe.md` scaffold or draft.

## Inputs To Collect

Collect only missing values:

- Integration title and short use case
- Integration type: `runtime` | `actions` | `context`
- Risk level: `low` | `medium` | `high`
- Author, source, license
- Target DiscoClaw minimum version

## Output Contract

Create exactly one markdown file at:

- `recipes/community/<kebab-slug>.discoclaw-recipe.md`

The file must include:

- YAML frontmatter with all required metadata fields
- All required headings from `docs/discoclaw-recipe-spec.md`

Risk-gated JSON behavior:

- `low` risk: `implementation_contract` and `acceptance_contract` JSON blocks are recommended; prose-only is allowed if complete.
- `medium/high` risk: `implementation_contract` and `acceptance_contract` fenced JSON blocks are required.

## Safety Requirements

Always include in `## Risk, Permissions, Rollback`:

- Risk rationale
- Required permissions/capabilities
- Explicit rollback steps

Always include attribution fields in frontmatter:

- `author`
- `source`
- `license`

## Final Self-Check

Before finalizing, verify:

1. Filename ends with `.discoclaw-recipe.md`.
2. YAML frontmatter is present and complete.
3. Required headings exist exactly once.
4. JSON contract blocks satisfy risk-level rules.
5. Handoff prompt is present and recipe-first (no auto-code by default).
