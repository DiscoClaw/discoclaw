---
spec_version: "1.0"
plan_id: "auto-thread-welcome-action"
title: "Auto Thread Welcome Message Action"
author: "Discoclaw Community Example"
source: "manual"
license: "MIT"
created_at: "2026-02-11T00:00:00Z"
integration_type: "actions"
discoclaw_min_version: "0.1.0"
risk_level: "medium"
---

# Discoclaw Plan

## Metadata

Canonical metadata lives in YAML frontmatter.

## Use Case

A user wants Discoclaw to post a short policy or onboarding note when a new thread is created in selected channels.

## Scope

In scope:

- Add a new Discord action handler for posting a thread welcome message.
- Add category-level gate and env configuration.
- Document safe defaults and allowlist behavior.

Out of scope:

- Full moderation automation or role assignment.
- Cross-server auto-configuration.

## Integration Contract

`implementation_contract`:

```json
{
  "files_add": [
    "src/discord/actions-thread-welcome.ts",
    "src/discord/actions-thread-welcome.test.ts"
  ],
  "files_modify": [
    "src/discord/actions.ts",
    "src/discord/action-types.ts",
    "src/config.ts",
    "src/index.ts",
    "README.md",
    ".env.example"
  ],
  "env_changes": [
    {
      "name": "DISCOCLAW_DISCORD_ACTIONS_THREAD_WELCOME",
      "required": false,
      "default": "0",
      "description": "Enable thread welcome action category"
    },
    {
      "name": "DISCOCLAW_THREAD_WELCOME_TEMPLATE",
      "required": false,
      "default": "",
      "description": "Message template used when a thread is opened"
    }
  ],
  "runtime_behavior_changes": [
    "When enabled, action payload can request a welcome message in a newly created thread.",
    "Behavior remains disabled by default."
  ],
  "out_of_scope": [
    "Automatic welcomes for every thread without explicit action request"
  ]
}
```

Local repo mapping:

- Action dispatch lives in `src/discord/actions.ts`.
- Action type definitions live in `src/discord/action-types.ts`.

Compatibility notes:

- Default-off gating avoids behavior changes for existing installs.

## Implementation Steps

1. Add action type and payload schema in `src/discord/action-types.ts`.
2. Implement handler in a focused module and wire into dispatcher.
3. Add config parsing and bot parameter wiring for new env flags.
4. Add unit tests for allow/deny/gating behavior.
5. Update docs and env examples.

## Acceptance Tests

`acceptance_contract`:

```json
{
  "scenarios": [
    {
      "name": "Feature disabled by default",
      "type": "unit",
      "steps": [
        "Dispatch thread welcome action with feature flag off"
      ],
      "expected": [
        "Action is rejected or ignored with a clear error"
      ]
    },
    {
      "name": "Feature enabled posts message",
      "type": "integration",
      "steps": [
        "Enable feature flag",
        "Create thread and dispatch welcome action"
      ],
      "expected": [
        "Bot posts welcome message in target thread"
      ]
    }
  ],
  "required_checks": [
    "pnpm build",
    "pnpm test"
  ]
}
```

Manual verification:

- Confirm message formatting fits Discord limits.
- Confirm no mention spam and allowlist protections still apply.

## Risk, Permissions, Rollback

Risk rationale:

- Medium risk because this can post messages automatically in channels if misconfigured.

Required permissions/capabilities:

- Discord `View Channels`, `Read Message History`, and `Send Messages in Threads`.
- Optional template env variable for message body.

Rollback plan:

1. Disable `DISCOCLAW_DISCORD_ACTIONS_THREAD_WELCOME`.
2. Revert related files if needed.
3. Restart service and verify no further auto-welcome posts occur.

## Handoff Prompt (Consumer Agent)

```text
Validate this medium-risk actions plan, then generate a file-level implementation checklist for the local repo. Do not edit code until explicitly instructed.
```

## Changelog

- 2026-02-11: Initial example draft.
