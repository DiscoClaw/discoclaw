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
| 3 | Sync Pipeline Rebuild | DONE | Sync flow now runs through explicit ingest/normalize/diff/apply helpers with phase-5 fetch/plan/apply boundaries and characterization coverage. |
| 4 | Performance + Operability | DONE | Coordinator-level sync lifecycle/transition/retry/tag-map metrics are instrumented and surfaced in `!health verbose` with coverage. |

## Track 1 Scope (Complete)

- Define lifecycle and sync ownership contract as code in `src/tasks/architecture-contract.ts`.
- Freeze current `TaskStore` behavior with characterization tests.
- Freeze current store-event -> sync trigger behavior with characterization tests.

## Track 2 Scope (Complete)

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
- 2026-02-21: Continued Track 3 by extracting Phase 5 reconcile diff planning from the engine into `planTaskReconcileFromSnapshots`, so phase-5 task+thread diff logic is fully pipeline-owned.
- 2026-02-21: Continued Track 3 by composing phase-5 thread-source ingest + diff planning in pipeline (`planTaskReconcileFromThreadSources`), reducing phase-5 planning glue in `task-sync-engine`.
- 2026-02-21: Continued Track 3 by extracting phase-5 thread-source fetch behavior into `fetchPhase5ThreadSources` in `task-sync-engine` and adding characterization coverage for archived-fetch fallback behavior.
- 2026-02-21: Continued Track 3 by adding `planTaskSyncApplyExecution` in pipeline to compose Stage 2-4 normalize/diff/apply planning, reducing planning glue in `runTaskSync`.
- 2026-02-21: Continued Track 3 by splitting phase-5 execution into explicit plan/apply steps in engine (`applyPhase5ReconcileOperations`) and adding a guard test ensuring `skipPhase5` avoids thread-source fetches.
- 2026-02-21: Continued Track 3 by extracting phase-5 reconcile planning in engine into `planPhase5ReconcileOperations`, making phase-5 fetch/plan/apply boundaries explicit.
- 2026-02-21: Continued Track 3 by extracting stage dispatch helpers in engine (`applyPlannedSyncPhases`, `runPhase5IfEnabled`) so `runTaskSync` reads as explicit stage orchestration.
- 2026-02-21: Closed out Track 3 by adding characterization coverage for cross-phase apply ordering (phase1 external-ref link before phase2 blocked-status fix) and marking Sync Pipeline Rebuild as DONE.
- 2026-02-21: Started Track 4 by adding task-sync coordinator metrics for run lifecycle (`started/coalesced/succeeded/failed`), duration totals, transition counters, and retry/follow-up failure signals with coverage in `src/tasks/sync-coordinator.test.ts`.
- 2026-02-21: Continued Track 4 by surfacing `tasks.sync.*` lifecycle/transition/retry counters in `!health verbose` with focused coverage in `src/discord/health-command.test.ts`.
- 2026-02-21: Continued Track 4 by surfacing `tasks.sync.failure_retry.*` counters in `!health verbose` so scheduled/failed post-failure retries are operator-visible.
- 2026-02-21: Continued Track 4 by guarding deferred-close retry scheduling in `TaskSyncCoordinator` (single pending timer + `tasks.sync.retry.coalesced` metric) and surfacing that coalescing signal in `!health verbose`.
- 2026-02-21: Continued Track 4 by adding `tasks.sync.failure_retry.coalesced` when failure retries are already pending and surfacing that signal in `!health verbose`.
- 2026-02-21: Continued Track 4 by canceling stale pending retry timers on recovery (`tasks.sync.retry.canceled`, `tasks.sync.failure_retry.canceled`) and surfacing canceled counts in `!health verbose`.
- 2026-02-21: Continued Track 4 by canceling pending deferred-close retries when sync failures occur, so failure-retry becomes the single active retry path during error recovery.
- 2026-02-21: Continued Track 4 by wiring sync retry policy into config/env (`DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_*`, `DISCOCLAW_TASKS_SYNC_DEFERRED_RETRY_DELAY_MS`) and plumbing those values through task initialization into `TaskSyncCoordinator`.
- 2026-02-21: Continued Track 4 by surfacing configured task sync retry policy (`failureRetry on/off`, failure/deferred retry delays) in `!health verbose` configuration output.
- 2026-02-21: Continued Track 4 by adding retry execution counters (`tasks.sync.retry.triggered`, `tasks.sync.failure_retry.triggered`) and surfacing scheduled/triggered/failed triples in `!health verbose`.
- 2026-02-21: Continued Track 4 by adding `tasks.sync.failure_retry.disabled` for explicit no-retry operation when failure retries are turned off, and surfacing that counter in `!health verbose`.
- 2026-02-21: Continued Track 4 by attributing retry-failure cause classes (`tasks.sync.retry.error_class.*`, `tasks.sync.failure_retry.error_class.*`) for deferred and failure-retry paths.
- 2026-02-21: Continued Track 4 by adding `tasks.sync.follow_up.triggered` and surfacing follow-up scheduled/triggered/failed triples in `!health verbose`.
- 2026-02-21: Continued Track 4 by attributing follow-up failure cause classes (`tasks.sync.follow_up.error_class.*`) with coordinator and health-output coverage.
- 2026-02-21: Continued Track 4 by adding `tasks.sync.follow_up.succeeded` and surfacing follow-up scheduled/triggered/succeeded/failed visibility in `!health verbose`.
- 2026-02-21: Continued Track 4 by surfacing full transition counters in `!health verbose` (`renamed`, `starter`, `statuses`, `tags`) to match coordinator metrics coverage.
- 2026-02-21: Continued Track 4 by adding tag-map reload metrics (`tasks.sync.tag_map_reload.{attempted,succeeded,failed}`) and surfacing reload outcomes in `!health verbose`.
- 2026-02-21: Closed out Track 4 and marked Performance + Operability as DONE.
- 2026-02-21: Started post-Track-4 architecture cleanup by removing unused `src/tasks/sync-watcher.ts` and consolidating on canonical store-event sync triggers in `src/tasks/task-sync.ts`.
- 2026-02-21: Continued post-Track-4 cleanup by removing unused `src/tasks/bead-sync.ts` and normalizing remaining runtime log/comment wording from watcher terms to sync-trigger terminology.
- 2026-02-21: Continued post-Track-4 cleanup by removing unused `tasksCwd` from `wireTaskSync` options/callers and deriving sync-wiring log context from `taskCtx`.
- 2026-02-21: Continued post-Track-4 cleanup by removing unused `sidebarMentionUserId` wire-time override from `wireTaskSync`; coordinator mention behavior is now sourced only from initialized `taskCtx`.
- 2026-02-21: Continued post-Track-4 cleanup by removing unused sync-retry wire-time override options from `wireTaskSync`; retry policy now flows only from initialized `taskCtx`.
