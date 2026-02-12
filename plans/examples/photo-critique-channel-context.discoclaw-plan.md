---
spec_version: "1.0"
plan_id: "photo-critique-channel-context"
title: "Photo Critique Channel Context Preset"
author: "Discoclaw Community Example"
source: "manual"
license: "MIT"
created_at: "2026-02-11T00:00:00Z"
integration_type: "context"
discoclaw_min_version: "0.1.0"
risk_level: "low"
---

# Discoclaw Plan

## Metadata

Canonical metadata lives in YAML frontmatter.

## Use Case

A user wants a reusable channel-context style for constructive photography critique, with consistent tone and structured feedback sections.

## Scope

In scope:

- Add a reusable markdown context template for critique channels.
- Document how to apply it to a channel context file.

Out of scope:

- Runtime adapter changes.
- Discord permission or action changes.

## Integration Contract

Files to add:

- `content/discord/channels/photo-critique.md` (or equivalent channel context path).

Files to modify:

- `docs/` notes if a team wants to document the channel convention.

Environment changes:

- None required.

Runtime behavior changes:

- Prompt behavior shifts toward structured critique output.

Out of scope:

- Any autonomous posting or moderation automation.

Local repo mapping:

- If `DISCOCLAW_CONTENT_DIR` is custom, place the file under that content root.

Compatibility notes:

- Works as a pure context change for existing Discoclaw versions that support per-channel context files.

## Implementation Steps

1. Create a channel context markdown file for the target channel.
2. Add critique structure rules (strengths, opportunities, next experiment).
3. Confirm channel mapping resolves to the new file.
4. Run one manual prompt to verify tone and structure.

## Acceptance Tests

Scenarios:

- Happy path:
  Send a photo critique request in the configured channel.
  Expected: response follows structured critique format.
- Isolation:
  Send the same request in a different channel.
  Expected: no critique-specific formatting unless that channel has its own context file.

Required checks:

- `pnpm build`
- `pnpm test`

## Risk, Permissions, Rollback

Risk rationale:

- Low risk because this is context-only and does not alter runtime plumbing or permissions.

Required permissions/capabilities:

- Existing channel read/write permissions only.

Rollback plan:

1. Restore previous channel context file contents (or remove the new file).
2. Re-run a prompt in the channel to confirm old behavior is restored.

## Handoff Prompt (Consumer Agent)

```text
Read this low-risk context plan and produce a local implementation checklist. Since this is low risk, treat missing JSON contract blocks as acceptable if section prose is complete. Do not edit code until explicitly asked.
```

## Changelog

- 2026-02-11: Initial example draft.
