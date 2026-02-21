# Tasks Ground-Zero Refactor (Post Hard-Cut)

## Objective

Rebuild the tasks subsystem around one explicit domain contract and one authoritative execution flow, while preserving production behavior until intentional contract changes are approved.

## Outcomes

- One mutation path (`TaskService`) for all task writes.
- One sync pipeline with deterministic replay behavior.
- Explicit ownership and lifecycle invariants enforced by tests.
- Better observability and lower sync/runtime overhead.

## Tracks

| Track | Name | Status | Notes |
| --- | --- | --- | --- |
| 1 | Contract + Characterization | DONE | Canonical contract file and baseline characterization tests landed in `src/tasks/`. |
| 2 | Core Service Extraction | DONE | `TaskService` introduced in `src/tasks/service.ts`; mutation callsites migrated from adapters/sync engine/CLI. |
| 3 | Sync Pipeline Rebuild | IN_PROGRESS | Stage scaffolding started with explicit ingest/normalize/diff helpers and idempotent operation planning in sync engine. |
| 4 | Performance + Operability | TODO | Optimize hot paths and add transition-level metrics/failure handling. |

## Track 1 Scope (Complete)

- Define lifecycle and sync ownership contract as code in `src/tasks/architecture-contract.ts`.
- Freeze current `TaskStore` behavior with characterization tests.
- Freeze current store-event -> sync trigger behavior with characterization tests.

## Track 2 Scope (Next)

- Add `TaskService` interface and concrete implementation.
- Route action handlers through `TaskService` only.
- Keep behavior parity with Track 1 characterization tests.

## Guardrails

- No behavior-changing refactors without explicit contract updates.
- Keep PRs small and auditable.
- Required gates for each track PR: `pnpm build`, `pnpm test`, `pnpm guard:legacy`.

## Progress Log

- 2026-02-21: Created this post-hard-cut ground-zero plan.
- 2026-02-21: Completed Track 1 with a canonical architecture contract and baseline characterization tests.
- 2026-02-21: Completed Track 2 with `TaskService` extraction and migration of all non-test mutation callsites (`actions-tasks`, `task-sync-engine`, `task-cli`).
- 2026-02-21: Started Track 3 by extracting sync pipeline helpers (`ingest -> normalize -> diff`) in `src/tasks/task-sync-pipeline.ts` and wiring operation planning into `runTaskSync`.
- 2026-02-21: Continued Track 3 by extracting Stage 4 apply-phase executors in `task-sync-engine` (Phase 1-4) with shared counter state, preserving current sync behavior while making apply flow explicit.
- 2026-02-21: Continued Track 3 by extracting Phase 5 reconciliation into an explicit apply executor (`applyPhase5ReconcileThreads`) so all sync phases now run through staged apply helpers.
- 2026-02-21: Continued Track 3 by switching Stage 4 phase dispatch to ordered operation lists from the diff plan (`operationTaskIdList`), so apply execution is directly plan-driven.
- 2026-02-21: Continued Track 3 by making apply-phase executors consume task lookups from the operation-plan order directly (`tasksById` + `operationTaskIdList`), with added dispatch-order tests.
- 2026-02-21: Continued Track 3 by routing Phase 5 reconcile operations through a declarative action->executor map (`RECONCILE_EXECUTORS`) so reconciliation apply flow matches the staged pipeline pattern.
- 2026-02-21: Continued Track 3 by introducing explicit apply-phase planning (`planTaskApplyPhases`) and refactoring Stage 4 execution to iterate a declarative phase->executor map in `task-sync-engine`.
- 2026-02-21: Continued Track 3 by extracting Phase 5 thread ingest/merge normalization (`ingestTaskThreadSnapshots`) into `task-sync-pipeline`, keeping active-thread precedence behavior explicit and test-covered.
