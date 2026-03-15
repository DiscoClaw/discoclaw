---
spec_version: "1.0"
plan_id: "replace-with-kebab-id"
title: "Replace with clear integration title"
author: "Your name or handle"
source: "manual"
license: "MIT"
created_at: "2026-02-11T00:00:00Z"
integration_type: "runtime"
discoclaw_min_version: "0.1.0"
risk_level: "low"
---

<!--
Author instructions (remove before sharing):
- Keep required headings exactly as written.
- Use YAML frontmatter for metadata in all plans.
- For low-risk plans, JSON contract blocks are recommended but optional.
- For medium/high-risk plans, JSON contract blocks are required.
-->

# DiscoClaw Recipe

## Metadata

Canonical metadata lives in YAML frontmatter.

Optional notes:

- Distribution notes:
- Ownership notes:

## Use Case

- Problem:
- Who benefits:
- What this unlocks for another DiscoClaw user:

## Scope

In scope:

- Item 1
- Item 2

Out of scope:

- Item A
- Item B

## Integration Contract

`implementation_contract` JSON block (required for medium/high risk; recommended for low risk):

```json
{
  "files_add": [
    "path/to/new-file"
  ],
  "files_modify": [
    "path/to/existing-file"
  ],
  "env_changes": [
    {
      "name": "ENV_VAR_NAME",
      "required": false,
      "default": "",
      "description": "What this controls"
    }
  ],
  "runtime_behavior_changes": [
    "Describe visible behavior changes"
  ],
  "out_of_scope": [
    "Non-goal"
  ]
}
```

If omitting JSON for low-risk plans, include equivalent prose for files, env/config, behavior, and out-of-scope.

Local repo mapping:

- Primary entrypoints:
- Files that may differ by user setup:
- Mapping notes for alternate layouts:

Compatibility notes:

- Minimum DiscoClaw version:
- Known incompatibilities:
- Backward-compatible fallback behavior:

## Implementation Steps

1. Step one with concrete file-level action.
2. Step two with concrete file-level action.
3. Step three with concrete file-level action.

## Acceptance Tests

`acceptance_contract` JSON block (required for medium/high risk; recommended for low risk):

```json
{
  "scenarios": [
    {
      "name": "Happy path",
      "type": "integration",
      "steps": [
        "Run action"
      ],
      "expected": [
        "Expected outcome"
      ]
    }
  ],
  "required_checks": [
    "pnpm build",
    "pnpm test"
  ]
}
```

If omitting JSON for low-risk plans, include equivalent prose for scenarios and expected outcomes.

Manual test notes:

- Test account/channel assumptions:
- Required fixtures or mock data:
- Observability/log lines to verify:

## Risk, Permissions, Rollback

Risk rationale:

- Why this is low/medium/high risk.

Required permissions/capabilities:

- Discord permissions:
- Runtime tools/capabilities:
- Env vars or secrets:

Rollback plan:

1. Revert files:
2. Revert config/env:
3. Restart/redeploy steps:
4. Verification steps after rollback:

## Handoff Prompt (Consumer Agent)

Use this prompt when another DiscoClaw user asks their agent to implement this plan:

```text
Read this .discoclaw-recipe.md file and produce a decision-complete implementation checklist mapped to local repo files. Validate required headings, YAML frontmatter metadata, and risk-gated JSON contract requirements first. Do not start coding until explicitly asked.
```

## Changelog

- 2026-02-11: Initial version.

Human approval checklist:

- [ ] Required headings are present.
- [ ] YAML frontmatter metadata is complete.
- [ ] Metadata includes author/source/license.
- [ ] Risk, permissions, and rollback are explicit.
- [ ] JSON contract blocks satisfy risk-level requirements.
- [ ] Handoff prompt is included and clear.
