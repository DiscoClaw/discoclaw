# Plan & Forge Workflows

> Part of the [Plan & Forge](plan-and-forge.md) documentation.

---

## Project Context

The file `.context/project.md` is auto-loaded as standing constraints for all forge agents:

- **Drafter:** Loaded via `ForgeOrchestrator.loadProjectContext()` and included in the context summary passed to `buildDrafterPrompt()` via `buildContextSummary()`.
- **Auditor:** Passed as the `projectContext` parameter to `buildAuditorPrompt()`. The auditor is instructed not to flag concerns that contradict these constraints.
- **Reviser:** Passed as the `projectContext` parameter to `buildRevisionPrompt()`. The reviser is instructed not to re-introduce complexity that contradicts these constraints.

Source: `ForgeOrchestrator.loadProjectContext()` in `forge-commands.ts` reads from `<cwd>/.context/project.md`.

---

## Workspace Integration

### Task backing

Every plan gets a backing task. The task ID is stored in the plan header. Backing-task acquisition follows a three-tier strategy:

1. **Task thread context** — if the command is issued in a task forum thread (`existingTaskId` is set), that task is reused directly. A `plan` label is added (best-effort) via `taskStore.addLabel()`.
2. **Title-match dedup** — if no `existingTaskId`, `taskStore.list({ label: 'plan' })` is queried and filtered for non-closed tasks whose title matches the plan description (case-insensitive, trimmed). If a match is found, it is reused.
3. **Create new** — if no match is found, `taskStore.create()` creates a fresh task with the `plan` label.

All three operations use the in-process `TaskStore` — no subprocess is spawned. The `TaskStore` instance is passed in as `taskStore` (a `HandlePlanCommandOpts` field).

Status sync:

- `!plan approve` → `taskStore.update(taskId, { status: 'in_progress' })`
- `!plan close` → `taskStore.close(taskId, 'Plan closed')`
- All phases complete (auto-close) → `taskStore.close(taskId, 'All phases complete')`

Task updates are best-effort — failures don't block plan operations.

### Lookup behavior

`findPlanFile()` resolves by either plan ID or backing task ID.

### File storage

Plans live in `workspace/plans/`:
- `plan-NNN-slug.md` — the plan file
- `plan-NNN-phases.md` — the phase decomposition (generated on demand)
- `.plan-template.md` — optional custom template (not present by default)

### Writer lock

The `workspaceWriterLock` in `discord.ts` is a promise-chain-based mutex that serializes all plan/forge/phase writes. It prevents concurrent modifications to plan and phase files.

Operations that acquire the lock:
- `!plan run` (held for the duration of phase execution)
- `!plan skip`
- `!plan phases` (for generation/regeneration)
- `!forge <desc>` (held for the entire forge run)

The lock is module-level in `discord.ts` — it covers all sessions within a single bot process.

---

## Common Workflows

### Quick manual plan

```
!plan Add rate limiting to webhook endpoint
```
1. Edit the plan file at `workspace/plans/plan-NNN-slug.md` — fill in Objective, Scope, Changes, etc.
2. `!plan approve plan-NNN`
3. Implement manually or use `!plan run plan-NNN` to execute phases

### Fully automated (forge → approve → run)

```
!forge Add rate limiting to webhook endpoint
```
1. Forge drafts the plan, audits it, revises if needed
2. Review the plan: `!plan show plan-NNN`
3. `!plan approve plan-NNN`
4. `!plan run plan-NNN` — executes all phases automatically, stops on failure
5. Review the final audit phase output

### Recovering from a failed phase

```
!plan run plan-017
```
Phase fails →
```
Plan run stopped: Phase **phase-2** failed: Build error in webhook.test.ts. 1/2 phases completed.
Convergence guard/manual intervention: review `!plan phases plan-017`, then use `!plan run-phase plan-017 <phase-id>` or `!plan skip-to plan-017 <phase-id>` to resume safely.
```

**Option A: Targeted retry** — Re-run only the blocked phase (preferred when prior phases are valid):
```
!plan run-phase plan-017 phase-2
```

**Option B: Skip ahead intentionally** — If you accept bypassing failed work:
```
!plan skip-to plan-017 phase-3
!plan run-phase plan-017 phase-3
```

**Option C: Edit plan + resequence while preserving completed phases (preferred over full replay):**
1. Edit the plan file
2. `!plan phases --regenerate --keep-done plan-017`
3. Inspect kept/dropped phase summary from the command output
4. Resume exactly where needed:
```
!plan run-phase plan-017 <phase-id>
```

**Option D: Full regenerate replay** — Use only when resequencing drops too much prior progress:
```
!plan phases --regenerate plan-017
!plan run plan-017
```

### Recovering from convergence-guarded audit replay

When audit fix/re-audit loops converge on the same failing signature, the runner stops with a convergence guard message instead of looping indefinitely.

Recommended recovery:
1. `!plan phases plan-017` — inspect failed audit phase and dependencies
2. Apply manual code fixes or adjust plan intent
3. If the plan changed: `!plan phases --regenerate --keep-done plan-017`
4. Resume narrowly:
```
!plan run-phase plan-017 <audit-phase-id>
```
5. If needed, bypass to a later phase:
```
!plan skip-to plan-017 <phase-id>
!plan run-phase plan-017 <phase-id>
```

### Cancelling a forge mid-flight

```
!forge cancel
```
→ `Forge cancel requested.`

Cancellation raises an `AbortSignal` that interrupts the active AI invocation immediately — the forge does not wait until the next audit loop boundary. The plan status is set to `CANCELLED`.

The 🛑 reaction on the forge progress message and the `!stop` command trigger the same signal, so all three methods produce the same clean halt.

### Attempting a second forge while one is running

```
!forge Add another feature
```
→ `A forge is already running. Use !forge cancel to stop it first.`

### Running a phase when phases are stale

```
!plan run plan-017
```
```
Plan file has changed since phases were generated — the existing phases may not match the current plan intent and cannot run safely.

**Fix:** `!plan phases --regenerate plan-017`

This regenerates phases from the current plan content. All phase statuses are reset to `pending` — previously completed phases will be re-executed. Git commits from completed phases are preserved on the branch, but the phase tracker loses their `done` status.
```

Preferred recovery (preserve prior done phases when safe):
```
!plan phases --regenerate --keep-done plan-017
!plan run-phase plan-017 <next-phase-id>
```

Fallback (full replay):
```
!plan phases --regenerate plan-017
!plan run plan-017
```

### DRAFT: Runtime Event Text Adapter Rollout

Goal: keep Discord progress text concise and human-readable without changing internal event contracts.

Adapter boundary and invariants:

1. Runtime and phase engines continue emitting typed internal payloads (`EngineEvent`, `PlanRunEvent`). `EngineEvent` now carries structured runtime failure data via `type: 'runtime_failure'` and optional `error.failure`, but the preview adapter boundary stays presentation-only.
2. A presentation adapter (`adaptRuntimeEventText`, `adaptPlanRunEventText`) maps selected events to short Discord-safe text.
3. Structured payload fragments (JSON-like runtime logs and action tags) are redacted from previews.
4. Internal payloads remain available to internal consumers and logs; only adapted text is user-facing.

Current rollout status: **DRAFT** pending review sign-off on wording quality and redaction behavior.

### Runtime Failure Envelope (Plan 1)

Goal: converge pipeline-tool failures, global-supervisor bailouts, and raw runtime strings onto one structured `RuntimeFailure` contract before broader Discord consumer wiring.

Plan 1 ownership and invariants:

1. `src/runtime/runtime-failure.ts` is the only place that classifies runtime failures and derives `userMessage`, `retryable`, and structured metadata.
2. Normalization accepts legacy pipeline JSON payloads, legacy `GLOBAL_SUPERVISOR_BAIL ...` strings, raw runtime strings, and already-normalized `RuntimeFailure` objects.
3. Runtime emitters may continue yielding `type: 'error'`, but they should attach the normalized `failure` object and serialize the same envelope into `message` with the `RUNTIME_FAILURE ` prefix.
4. `type: 'runtime_failure'` exists on `EngineEvent` for structured consumers and tests; presentation adapters must treat it as internal event data, not raw user-facing text.
5. Discord-facing consumer rewiring is intentionally separate work. Plan 2 covers `message-coordinator`, `reaction-handler`, `deferred-runner`, `cron/executor`, and status-channel/reporting surfaces.

---

## Branch Workflow

All non-trivial changes go through a feature branch → PR → merge cycle. No direct commits to `main`.

### Branch naming

Use descriptive prefixes:

| Prefix | Use case | Example |
|--------|----------|---------|
| `fix/` | Bug fixes | `fix/wire-plan-phase-config` |
| `feat/` | New features | `feat/webhook-support` |
| `refactor/` | Code restructuring | `refactor/extract-phase-runner` |
| `docs/` | Documentation only | `docs/update-timeout-reference` |
| `plan-NNN/` | Plan implementation (auto or manual) | `plan-075/cron-retry-logic` |

### Workflow

1. **Create branch** from up-to-date `main`
2. **Commit** changes with clear messages (plan phases auto-commit as `{planId} {phaseId}: {title}`)
3. **Audit** the diff before pushing — either manually or via `!plan audit`
4. **Push** the branch and open a PR via `gh pr create`
5. **Review and merge** via GitHub

### Post-merge cleanup

After a PR is merged to `main`, always clean up both sides:

1. **Pull main:** `git checkout main && git reset --hard origin/main`
   - Use `reset --hard` rather than `pull` — if commits were squash-merged, the local branch may show as diverged and `pull` will refuse without a reconcile strategy.
2. **Delete local branch:** `git branch -D <branch-name>`
   - Use `-D` (force) rather than `-d`. When GitHub squash-merges a PR, the individual commits on the local branch don't appear in the merge commit, so git reports the branch as "not fully merged" even though the work is on `main`.
3. **Delete remote branch:** `git push origin --delete <branch-name>`
   - If GitHub is configured to auto-delete head branches on merge (Settings → General → "Automatically delete head branches"), this step will fail with "remote ref does not exist" — that's fine, the branch is already gone.

All three steps should happen together — don't leave stale branches on either side.

### Local cleanup & verification

Documented rebuild/checks keep your workspace aligned with `main`. After the branch is merged, run the following before starting the next plan work:

1. **Refresh refs:** `git fetch --prune origin` so stale remotes are discarded.
2. **Rebase main:** `git checkout main && git pull --rebase origin main` to match the merged state exactly.
3. **Verify dependencies:** `pnpm install` (a no-op when nothing changed, but safe after merges that touch lockfiles).
4. **Confirm the build/tests:** `pnpm build` (and `pnpm test` if you normally run it) on the refreshed `main` to prove the workspace is stable.
5. **Status check:** `git status` should report a clean tree before you start on the next plan; fix any leftover artifacts before branching again.

These steps mirror the rebuild workflow in `AGENTS.md`/`TOOLS.md` and ensure we catch integration issues early, rather than carrying them into the next feature branch.

---

## Architecture Notes

### Source file map

| File | Responsibility |
|------|---------------|
| `src/discord/plan-commands.ts` | Plan command parsing, plan file CRUD, phase CLI wrappers, `preparePlanRun()` |
| `src/discord/forge-commands.ts` | Forge command parsing, `ForgeOrchestrator` class, audit verdict parsing, prompt builders |
| `src/discord/plan-manager.ts` | Phase decomposition, serialization, staleness detection, phase execution, git integration |
| `src/discord/runtime-event-text-adapter.ts` | Presentation-layer runtime/plan text adapter (`EngineEvent`/`PlanRunEvent` → concise Discord progress text) with structured-payload redaction; does not mutate event payload contracts |
| `src/discord/streaming-progress.ts` | `createStreamingProgress()` — reusable controller that wires a `ToolAwareQueue` to a Discord progress message; drives live tool-activity labels and streaming text preview via `selectStreamingOutput` at 1250ms; used by forge create, forge resume, and plan-run paths in `discord.ts` |
| `src/discord.ts` | Discord message handler: command dispatch for both `!plan` and `!forge`, writer lock, forge lifecycle management |
| `src/config.ts` | All plan/forge env var parsing |
| `src/runtime/openai-compat.ts` | OpenAI-compatible runtime adapter (SSE streaming; optional function-calling tool use when `OPENAI_COMPAT_TOOLS_ENABLED=1`) |
| `src/runtime/openai-tool-exec.ts` | Server-side OpenAI tool handlers; emits pipeline-tool failures in the unified `RuntimeFailure` shape |
| `src/runtime/codex-cli.ts` | Codex CLI runtime adapter (subprocess, supports read-only tools via `tools_fs` and session persistence via `sessions` capability) |
| `src/runtime/global-supervisor.ts` | Runtime-wide supervisor loop; emits `GLOBAL_SUPERVISOR_BAIL` metadata through serialized `RuntimeFailure` errors |
| `src/runtime/registry.ts` | Runtime adapter registry (name → adapter lookup) |
| `src/runtime/runtime-failure.ts` | Canonical `RuntimeFailure` envelope, legacy normalizers, serialization helpers, and user-message mapping |
| `src/runtime/types.ts` | `RuntimeAdapter` interface, `EngineEvent` types, `RuntimeFailure`/`RuntimeFailureEvent` contracts |
| `src/discord/user-errors.ts` | Thin Discord shim over `mapRuntimeFailureToUserMessage()`; classification no longer lives here |

### Concurrency model

- **Writer lock:** Promise-chain mutex (`workspaceWriterLock` in `discord.ts`) serializes all plan/forge file writes within a single process.
- **Forge singleton:** Only one `ForgeOrchestrator` instance can be running at a time (module-level variable in `discord.ts`).
- **Phase execution:** `!plan run` auto-chains pending phases in a loop (up to `MAX_PLAN_RUN_PHASES` = 50). `!plan run-one` and `!plan run-phase` execute one phase. All are fire-and-forget from the Discord queue. The writer lock is acquired and released per-phase to avoid starvation.
- **Single-user design:** No multi-user concurrency guards. The Discord allowlist is the access boundary.

### Command dispatch split

`!plan` commands are dispatched in `discord.ts` but handled primarily by `plan-commands.ts`:
- `run`, `run-one`, `run-phase`, `skip`, `skip-to`, and `phases` are intercepted in `discord.ts` for lock acquisition and async execution
- All other subcommands pass through to `handlePlanCommand()` in `plan-commands.ts`

`!forge` commands are fully dispatched in `discord.ts`:
- Help text, status, cancel, and create are all handled inline
- `ForgeOrchestrator` is instantiated and run from `discord.ts`
- `forge-commands.ts` provides the orchestrator class and parsing utilities
