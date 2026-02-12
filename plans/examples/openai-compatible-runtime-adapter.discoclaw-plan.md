---
spec_version: "1.0"
plan_id: "openai-compatible-runtime-adapter"
title: "OpenAI-Compatible Runtime Adapter"
author: "Discoclaw Community Example"
source: "manual"
license: "MIT"
created_at: "2026-02-11T00:00:00Z"
integration_type: "runtime"
discoclaw_min_version: "0.1.0"
risk_level: "medium"
---

# Discoclaw Plan

## Metadata

Canonical metadata lives in YAML frontmatter.

## Use Case

A user wants to run Discoclaw against an OpenAI-compatible endpoint while preserving the existing runtime abstraction and safety defaults.

## Scope

In scope:

- Add a new runtime adapter implementation under `src/runtime/`.
- Add env-based adapter selection in configuration parsing.
- Keep Claude CLI adapter as default for backward compatibility.

Out of scope:

- Changes to Discord action schemas.
- Vendor-specific tool emulation beyond existing runtime interface.

## Integration Contract

`implementation_contract`:

```json
{
  "files_add": [
    "src/runtime/openai-compatible.ts",
    "src/runtime/openai-compatible.test.ts"
  ],
  "files_modify": [
    "src/runtime/types.ts",
    "src/config.ts",
    "src/index.ts",
    "README.md",
    ".env.example"
  ],
  "env_changes": [
    {
      "name": "RUNTIME_ADAPTER",
      "required": false,
      "default": "claude-cli",
      "description": "Select runtime adapter implementation"
    },
    {
      "name": "OPENAI_BASE_URL",
      "required": true,
      "default": "",
      "description": "Base URL for OpenAI-compatible endpoint"
    },
    {
      "name": "OPENAI_API_KEY",
      "required": true,
      "default": "",
      "description": "API key for OpenAI-compatible endpoint"
    }
  ],
  "runtime_behavior_changes": [
    "Runtime selection becomes adapter-driven via env.",
    "Invocation path varies by adapter while Discord routing remains unchanged."
  ],
  "out_of_scope": [
    "Automatic migration of existing Claude runtime sessions"
  ]
}
```

Local repo mapping:

- Runtime files live in `src/runtime/`.
- Config parsing and wiring live in `src/config.ts` and `src/index.ts`.

Compatibility notes:

- Preserve default behavior when `RUNTIME_ADAPTER` is unset.
- Treat unknown adapter names as configuration errors.

## Implementation Steps

1. Add `openai-compatible` adapter file implementing `RuntimeAdapter`.
2. Add adapter config env parsing and validation in `src/config.ts`.
3. Add adapter selection wiring in `src/index.ts`.
4. Add tests for config selection and adapter event behavior.
5. Update docs/env examples with new adapter variables.

## Acceptance Tests

`acceptance_contract`:

```json
{
  "scenarios": [
    {
      "name": "Default adapter unchanged",
      "type": "unit",
      "steps": [
        "Run bot startup with no RUNTIME_ADAPTER set"
      ],
      "expected": [
        "Claude CLI adapter is selected"
      ]
    },
    {
      "name": "OpenAI adapter selected",
      "type": "unit",
      "steps": [
        "Set RUNTIME_ADAPTER=openai-compatible and valid OpenAI env vars"
      ],
      "expected": [
        "OpenAI-compatible adapter is selected and can stream text events"
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

- Confirm one Discord message roundtrip using the selected adapter.
- Confirm startup logs show chosen adapter.

## Risk, Permissions, Rollback

Risk rationale:

- Medium risk because runtime invocation path changes and misconfig can break all responses.

Required permissions/capabilities:

- Runtime network access to OpenAI-compatible API.
- Secrets management for API key.

Rollback plan:

1. Revert adapter-related commits.
2. Remove `RUNTIME_ADAPTER` from env to fall back to Claude CLI.
3. Restart service and verify startup logs and Discord reply flow.

## Handoff Prompt (Consumer Agent)

```text
Read this .discoclaw-plan.md and produce a decision-complete implementation checklist for this repo. Validate medium-risk JSON contract blocks first. Do not code until explicitly asked.
```

## Changelog

- 2026-02-11: Initial example draft.
