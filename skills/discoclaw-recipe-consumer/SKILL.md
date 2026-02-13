---
name: discoclaw-recipe-consumer
description: Consume a shared `*.discoclaw-recipe.md` file and produce a decision-complete, local-repo implementation checklist with YAML metadata validation, risk-gated contract validation, and recipe-first execution behavior.
---

# DiscoClaw Recipe Consumer

Consume a shared DiscoClaw integration recipe without immediately coding.

Default mode is recipe-first apply.

## Use This Skill When

- A user provides a `.discoclaw-recipe.md` and asks to implement/adapt it.
- A user asks for feasibility or migration mapping from a shared integration recipe.
- A user wants a safe checklist before code changes.

## Validation Workflow

1. Confirm filename pattern and required headings from `docs/discoclaw-recipe-spec.md`.
2. Validate YAML frontmatter and read `risk_level` from frontmatter metadata.
3. Apply risk-gated JSON checks:
   - `low`: `implementation_contract` and `acceptance_contract` JSON blocks are optional, but section prose must still be complete.
   - `medium/high`: `implementation_contract` and `acceptance_contract` JSON blocks are mandatory.
4. Verify mandatory attribution and safety fields exist:
   - Author/source/license
   - Risk rationale
   - Required permissions/capabilities
   - Rollback steps

If required data is missing, stop and request a corrected recipe before implementation.

## Output Contract

Produce a decision-complete implementation checklist that includes:

- Local file mapping (`files_add`, `files_modify`, equivalents if repo differs)
- Environment/config changes
- Test and verification sequence
- Rollback and risk gates
- Explicit assumptions

Do not begin code edits unless the user explicitly asks to execute.

## Adaptation Guidance

When local repo structure differs:

- Map each contract path to the closest actual path.
- Record each path mapping explicitly.
- Preserve stated out-of-scope constraints.

## Final Self-Check

1. Validation result is explicit (`pass` or `blocked`).
2. Missing fields are listed with exact corrections needed.
3. Implementation checklist is file-specific and complete.
4. Recipe-first behavior is preserved unless user overrides.
