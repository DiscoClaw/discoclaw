# Plan / Work / Review / Compound Gap Memo

Date: 2026-03-09
Scope: Discoclaw's current planning and implementation workflow as implemented in the repo today.

## Objective

Map the `plan -> work -> review -> compound` loop onto current Discoclaw files, identify what already exists, and call out the missing pieces before changing behavior.

## Summary

Discoclaw already has a strong `plan -> work -> review` spine:

- `plan` is covered by the plan/forge lifecycle and plan template.
- `work` is covered by phased execution with per-phase prompts, progress events, and git commits.
- `review` is covered by forge audit rounds plus a mandatory post-implementation audit phase.

The weak link is `compound`:

- lessons are not consistently written back into durable project artifacts
- verification evidence is not first-class output from a run
- medium/minor concerns can auto-flow into implementation without an explicit evidence gate

## Current Map

### Plan

Primary files:

- `docs/plan-and-forge.md`
- `docs/plan-architecture.md`
- `src/discord/forge-commands.ts`
- `src/discord/plan-commands.ts`

What exists:

- plans move through `DRAFT -> REVIEW -> APPROVED -> IMPLEMENTING -> AUDITING -> DONE/CLOSED`
- forge performs draft -> audit -> revise loops before a plan reaches review
- the fallback plan template requires `Objective`, `Scope`, `Changes`, `Risks`, `Testing`, `Audit Log`, and `Implementation Notes`

Missing pieces:

- no dedicated artifact that summarizes "why this plan changed over time" beyond appended audit rounds
- no single short operator-facing doc that explains the practical handoff from approved plan to evidence-backed completion

### Work

Primary files:

- `src/discord/plan-manager.ts`
- `src/discord/message-coordinator.ts`

What exists:

- plans decompose into `implement`, `read`, and `audit` phases
- implement phases can modify code with `Read`, `Write`, `Edit`, `Glob`, `Grep`, and `Bash`
- runs track modified files, retry state, convergence state, and per-phase git commits

Missing pieces:

- implement prompts tell the agent to change code and summarize it, but not to execute the plan's `Testing` section or preserve proof that it did
- successful work is summarized mostly as status + changed files + commit hashes, not as "here is the evidence this phase is good"

### Review

Primary files:

- `src/discord/forge-commands.ts`
- `src/discord/audit-handler.ts`
- `src/discord/plan-manager.ts`
- `src/discord/forge-auto-implement.ts`

What exists:

- forge audit rounds append review notes into the plan
- structural plan audits can stop bad plans before expensive runtime review
- post-implementation audit is always generated as the last phase
- audit fix loops can attempt targeted repairs when the post-implementation audit fails

Missing pieces:

- review mainly checks implementation against plan intent, not implementation against explicit build/test evidence
- only `blocking` concerns stop forge; `medium`, `minor`, and `suggestion` findings can still auto-approve into implementation
- `!plan show` surfaces only the latest audit verdict, not a concise "verification state" for the whole run

### Compound

Primary files and surfaces:

- `docs/memory.md`
- `src/discord/prompt-common.ts`
- `src/tasks/context-summary.ts`
- plan `## Audit Log`
- plan `## Implementation Notes`

What exists:

- durable memory, rolling summaries, short-term memory, and workspace files provide multiple places to retain context
- plans have `Audit Log` and `Implementation Notes` sections available as durable artifacts
- task threads provide a stable place to keep follow-up work attached to the originating change

Missing pieces:

- memory auto-extraction is aimed at user facts/preferences, not engineering lessons, postmortems, or workflow rules
- task context is intentionally thin and does not automatically absorb lessons from completed work
- `Implementation Notes` exists as a storage surface, but there is no clear runtime path today that writes distilled lessons into it
- repeated lessons from chat/audits are not automatically promoted into checked-in guidance or reusable prompts

## Gap List

### Gap 1: Verification evidence is optional, not structural

Current behavior emphasizes code changes and audit verdicts. It does not require build/test command output or a structured evidence block before a run is treated as complete.

Consequence:

- "reviewed" can mean "looked consistent with the plan" rather than "proven to build and pass"

### Gap 2: Compound loop is manual and lossy

Current artifacts preserve some raw review history, but not a normalized "lesson learned" output that can feed future plans, prompts, or docs.

Consequence:

- the same workflow lessons can be rediscovered in chat multiple times

### Gap 3: Auto-implementation can outrun non-blocking concerns

Forge auto-implementation is intentionally permissive once there are no blocking findings.

Consequence:

- useful warnings are preserved, but they do not necessarily change behavior before implementation starts

### Gap 4: Portable core is documented, but scattered

Prompt layering, memory, runtime contracts, and runtime switching are documented, but across separate files.

Consequence:

- the system is portable in practice, but harder to explain as one coherent stack

## Recommended Follow-Ups

### Track A: Verification Evidence

Goal:

- make every agent-written run surface explicit proof of what was checked

Minimum scope:

- phase/run outputs should capture build/test/audit evidence in a stable format
- plan completion should distinguish code audit status from verification status

### Track B: Compound Lessons

Goal:

- turn repeated review outcomes into durable guidance

Minimum scope:

- define one artifact for distilled lessons
- define promotion rules from chat/audit/task output into that artifact

### Track C: Portable Core Overview

Goal:

- describe Discoclaw's portable architecture in one operator/maintainer doc

Minimum scope:

- prompt contract
- memory model
- runtime adapter and event contract
- provider/model switching surfaces

## Recommendation

Do not treat this as one big feature.

Split it into two implementation plans first:

1. `verification-evidence`
2. `compound-lessons`

Then add a small docs pass for the portable-core overview once the behavior changes are clear enough to document cleanly.
