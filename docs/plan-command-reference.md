# Plan & Forge Command Reference

> Part of the [Plan & Forge](plan-and-forge.md) documentation.

---

## `!plan` Command Reference

### Auto implementation (default)

With `FORGE_AUTO_IMPLEMENT=1` (the default), `!forge` still walks every plan through the DRAFT → REVIEW lifecycle, but once REVIEW finishes without blocking findings, a `CAP_REACHED` verdict, or stale workspace context, the bot auto-approves the plan and immediately fires `!plan run`. The completion post still surfaces any medium/minor/suggestion severity warnings in the channel message and audit log so the team can trace remaining concerns even though the plan is now executing. If the gating check fails (blocking findings, cap, stale context, etc.) or you explicitly opt out, the manual CTA described below is used instead.

#### Manual implementation (opt-out)

Set `FORGE_AUTO_IMPLEMENT=0` (see the configuration entry below) to keep the manual CTA. In this mode the forge stops after posting the plan summary, lists any severity warnings that forced the manual path, and explicitly tells you to run `!plan approve <id>` and `!plan run <id>`.

### `!plan` / `!plan help`

Show available plan commands.

```
!plan
```

**Output:**
```
**!plan commands:**
- `!plan <description>` — create a new plan
- `!plan list` — list active plans
- `!plan show <plan-id|task-id>` — show plan details
- `!plan approve <plan-id|task-id>` — approve for implementation
- `!plan close <plan-id|task-id>` — close/abandon a plan
- `!plan phases <plan-id>` — show/generate phase checklist
- `!plan run <plan-id>` — execute all remaining phases
- `!plan run-one <plan-id>` — execute next pending phase only
- `!plan skip <plan-id>` — skip a failed/in-progress phase
- `!plan audit <plan-id>` — run a standalone audit against a plan
```

### `!plan <description>`

Create a new plan from a description. Generates a plan ID (`plan-NNN`), fills the plan template, and writes the file.

**Task dedup:** When invoked outside a task forum thread (no `existingTaskId`), the command checks for an existing open task with a matching title (case-insensitive, trimmed) before creating a new one. If a match is found, the existing task is reused — no duplicate is created. This prevents orphaned forum threads from accidental double-invocations or pre-created tasks. The lookup calls `taskStore.list({ label: 'plan' })` and excludes `closed` tasks.

When invoked inside a task forum thread, the thread's task is reused directly (no dedup check needed).

**Context injection:** `!plan <description>` now auto-injects the replied-to message, thread starter/recent posts, and fallback history when nothing else is available. This is powered by the shared `gatherConversationContext()` helper, which `!forge` also uses, so `!plan fix this` and other plan commands tap the same replied-to/thread context that the forge prompt receives.

```
!plan Add webhook support for external notifications
```

**Output:**
```
Plan created: **plan-017** (task: `abc123`)
File: `workspace/plans/plan-017-add-webhook-support-for-external-notifications.md`
Description: Add webhook support for external notifications
```

### `!plan list`

List all plans with their status.

```
!plan list
```

**Output:**
```
- `plan-015` [APPROVED] — Implement phase manager (task: `abc111`)
- `plan-016` [DONE] — Add forge orchestrator (task: `abc222`)
- `plan-017` [DRAFT] — Add webhook support (task: `abc333`)
```

### `!plan show <plan-id|task-id>`

Show plan details: header fields, objective, and latest audit verdict. Accepts either a plan ID or a task ID.

```
!plan show plan-017
```

**Output:**
```
**plan-017** — Add webhook support
Status: DRAFT
Task: `abc333`
Project: discoclaw
Created: 2026-02-12

**Objective:** Add webhook endpoints for external notification delivery...

**Latest audit:** (no audit yet)
```

### `!plan approve <plan-id|task-id>`

Set plan status to `APPROVED` and update the backing task to `in_progress`. Blocked if the plan is currently `IMPLEMENTING`.

```
!plan approve plan-017
```

**Output:**
```
Plan **plan-017** approved for implementation.
```

### `!plan close <plan-id|task-id>`

Set plan status to `CLOSED` and close the backing task. Blocked if the plan is currently `IMPLEMENTING`.

```
!plan close plan-017
```

**Output:**
```
Plan **plan-017** closed.
```

### `!plan phases <plan-id>`

Show or generate the phase decomposition for a plan. If no phases file exists, generates one automatically.

```
!plan phases plan-017
```

**Output:**
```
**Phases for plan-017** (hash: `a1b2c3d4e5f6g7h8`)

[ ] **phase-1:** Implement src/webhook.ts [implement]
[ ] **phase-2:** Implement src/webhook.test.ts [implement] (depends: phase-1)
[ ] **phase-3:** Post-implementation audit [audit] (depends: phase-1, phase-2)
```

**Status indicators:** `[ ]` pending, `[~]` in-progress, `[x]` done, `[!]` failed, `[-]` skipped

### `!plan phases --regenerate <plan-id>`

Regenerate phases from the current plan content, overwriting the existing phases file. Use after editing the plan file.

```
!plan phases --regenerate plan-017
```

### `!plan run <plan-id>`

Execute all pending phases sequentially (up to 50, safety cap). Requires the plan to be in `APPROVED` or `IMPLEMENTING` status. Acquires the workspace writer lock per-phase, validates staleness, then fires in the background. Stops on failure, audit deviation, staleness, or shutdown — resume with another `!plan run`.

**Auto-close:** When all phases reach a terminal status (done or skipped), the plan is automatically set to `CLOSED` and its backing task is closed. This happens in both the command path (`!plan run` in Discord) and the action path (`planRun` via Discord actions).

```
!plan run plan-017
```

**Output (progress message, updated as phases run):**
```
Running all phases for **plan-017** — starting phase-1: Implement src/webhook.ts...
Phase **phase-1** done. Next: phase-2: Implement src/webhook.test.ts...
```

**On completion (all phases):**
```
Plan run complete for **plan-017**: 3 phases executed (87s)
[x] phase-1: Implement src/webhook.ts (32s)
[x] phase-2: Implement src/webhook.test.ts (28s)
[x] phase-3: Post-implementation audit (27s)
```

**On failure (stops at the failed phase):**
```
Plan run stopped: Phase **phase-2** timed out after 30 minutes. 1/2 phases completed.
Use `!plan run plan-017` to retry or `!plan skip plan-017` to skip.
```

### `!plan run-one <plan-id>`

Execute only the next pending phase (single-phase mode). Same validation and locking as `!plan run`, but stops after one phase regardless of outcome.

```
!plan run-one plan-017
```

**Output:**
```
Running phase-1: Implement src/webhook.ts...
Phase **phase-1** done: Implement src/webhook.ts
```

### `!plan skip <plan-id>`

Skip the current in-progress or failed phase. Useful when a phase is stuck or not needed.

```
!plan skip plan-017
```

**Output:**
```
Skipped **phase-1**: Implement src/webhook.ts (was failed)
```

### `!plan audit <plan-id>`

Run a standalone audit against an existing plan. Performs a two-stage review:

1. **Structural pre-flight** (instant) — checks for required sections (Objective, Scope, Changes, Risks, Testing), placeholder text, and missing file paths. If high or medium severity issues are found, the audit stops here and reports them without invoking the AI.
2. **AI-powered audit** (30-60s) — invokes an adversarial auditor agent that deep-reviews the plan for correctness, completeness, risk gaps, and test coverage. Only runs if the structural check passes (or has only low-severity concerns).

Both results are appended as a single review entry in the plan's Audit Log section.

```
!plan audit plan-017
```

**Output (progress message, updated on completion):**
```
Auditing **plan-017**...
```

**On success:**
```
Audit complete for **plan-017** — review 1, verdict: **low** (ready to approve). See `!plan show plan-017` for details.
```

**On failure (structural gate):**
```
Audit complete for **plan-017** — review 1, verdict: **high** (needs revision). See `!plan show plan-017` for details.
```

**Configuration:** Uses `FORGE_AUDITOR_MODEL` for the AI agent (falls back to `RUNTIME_MODEL`). Timeout follows `FORGE_TIMEOUT_MS`.

### `!plan cancel`

**Known gap:** `cancel` is listed in the `RESERVED_SUBCOMMANDS` set in `plan-commands.ts` and is parsed as a valid subcommand, but has no handler implementation. It falls through to the default case and returns:

```
Unknown plan command. Try `!plan` for help.
```

---

## `!forge` Command Reference

### `!forge` / `!forge help`

Show available forge commands.

```
!forge
```

**Output:**
```
**!forge commands:**
- `!forge <description>` — auto-draft and audit a plan
- `!forge status` — check if a forge is running
- `!forge cancel` — cancel the running forge
```

> **Architecture note:** The `!forge help` text is defined inline in `discord.ts` (inside the `forgeCmd.action === 'help'` branch), not in `forge-commands.ts`. All `!forge` command dispatch happens in `discord.ts` rather than in the commands module — this is a known architectural quirk, not a recommended pattern.

**Context alignment:** When a `!forge` is started, the drafter prompt is fed the task description and any pinned thread posts via the same shared `gatherConversationContext()` helper that `!plan` uses. That helper also captures replied-to messages, starter/recent thread posts, and fallback history, so both commands always reference the same conversation context even inside an existing task thread.

### `!forge <description>`

Create a plan and automatically draft, audit, and revise it. Runs in the background; progress is reported by editing a Discord message.

```
!forge Add rate limiting to the webhook endpoint
```

**Progress messages (edited in-place):**
```
Starting forge: Add rate limiting to the webhook endpoint
Forging plan-018... Drafting (reading codebase)
Forging plan-018... Draft complete. Audit round 1/5...
Forging plan-018... Audit round 1 found medium concerns. Revising...
Forging plan-018... Revision complete. Audit round 2/5...
Forge complete. Plan plan-018 ready for review (2 rounds, 87s)
```

**Concurrent session rejection:** Only one forge can run at a time. Issuing `!forge <desc>` while a forge is running returns:

```
A forge is already running. Use `!forge cancel` to stop it first.
```

This is checked in `discord.ts` via the `forgeOrchestrator?.isRunning` guard. Additionally, `ForgeOrchestrator.run()` throws if called while `running === true` as defense-in-depth.

### `!forge status`

Check if a forge is currently running.

```
!forge status
```

**Output:**
```
A forge is currently running.
```
or
```
No forge running.
```

### `!forge cancel`

Request cancellation of the running forge. Cancellation interrupts the active AI invocation immediately via `AbortSignal` — the forge does not wait until the next audit loop boundary. The plan status is set to `CANCELLED`.

The same cancellation signal is also raised by the 🛑 reaction on the forge progress message and by the `!stop` command, so all three methods produce the same clean halt.

```
!forge cancel
```

**Output:**
```
Forge cancel requested.
```

---

## Configuration Reference

All env vars that control plan/forge behavior, verified against `config.ts`:

### Plan commands

| Variable | Default | Parser | Description |
|----------|---------|--------|-------------|
| `DISCOCLAW_PLAN_COMMANDS_ENABLED` | `true` | `parseBoolean` | Enable/disable `!plan` commands |
| `PLAN_PHASES_ENABLED` | `true` | `parseBoolean` | Enable/disable phase decomposition (`!plan phases`, `!plan run`, `!plan skip`) |
| `PLAN_PHASE_MAX_CONTEXT_FILES` | `5` | `parsePositiveInt` | Max files per phase batch |
| `PLAN_PHASE_TIMEOUT_MS` | `1800000` (30 min) | `parsePositiveNumber` | Per-phase execution timeout |
| `PLAN_PHASE_AUDIT_FIX_MAX` | `2` | `parseNonNegativeInt` | Max audit-fix attempts per phase before marking failed |

### Forge commands

| Variable | Default | Parser | Description |
|----------|---------|--------|-------------|
| `DISCOCLAW_FORGE_COMMANDS_ENABLED` | `true` | `parseBoolean` | Enable/disable `!forge` commands |
| `FORGE_MAX_AUDIT_ROUNDS` | `5` | `parsePositiveInt` | Max draft-audit-revise loops before CAP_REACHED |
| `FORGE_PROGRESS_THROTTLE_MS` | `3000` | `parseNonNegativeInt` | Min interval between static phase-transition progress edits. Streaming preview edits during active tool/text output use a separate faster interval (1250ms) independent of this setting. |
| `FORGE_TIMEOUT_MS` | `1800000` (30 min) | `parsePositiveNumber` | Per-agent-invocation timeout within forge |
| `FORGE_DRAFTER_MODEL` | *(empty)* | `parseTrimmedString` | Model override for drafter/reviser; falls back to main `RUNTIME_MODEL` |
| `FORGE_AUDITOR_MODEL` | *(empty)* | `parseTrimmedString` | Model override for auditor; falls back to main `RUNTIME_MODEL` |
| `FORGE_AUTO_IMPLEMENT` | `true` | `parseBoolean` | When true, reviews that pass the gating criteria (no blocking verdict, no `CAP_REACHED`, pristine context) are auto-approved and `!plan run` starts immediately; the completion message still highlights any severity warnings so they stay visible. When false, the manual CTA described above is retained and explicitly guides the team to `!plan approve` + `!plan run` (severity warnings are still listed). |

### Multi-provider auditor

| Variable | Default | Parser | Description |
|----------|---------|--------|-------------|
| `FORGE_AUDITOR_RUNTIME` | *(empty)* | `parseTrimmedString` | Runtime adapter name for the auditor (`codex` or `openai`). When empty, the auditor uses the default Claude runtime. |
| `CODEX_BIN` | `codex` | `parseTrimmedString` | Path to the Codex CLI binary. |
| `CODEX_MODEL` | `gpt-5.3-codex` | `parseTrimmedString` | Default model for the Codex CLI adapter. Used when `FORGE_AUDITOR_MODEL` is not set. |
| `OPENAI_API_KEY` | *(empty)* | `parseTrimmedString` | API key for the OpenAI-compatible adapter. Required when `FORGE_AUDITOR_RUNTIME=openai`. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | `parseTrimmedString` | Base URL for the OpenAI-compatible API. Override for proxies or alternative providers (e.g., Azure OpenAI, Ollama). |
| `OPENAI_MODEL` | `gpt-4o` | `parseTrimmedString` | Default model for the OpenAI adapter. Used when `FORGE_AUDITOR_MODEL` is not set. |

### Task sync

| Variable | Default | Parser | Description |
|----------|---------|--------|-------------|
| `DISCOCLAW_TASKS_SYNC_SKIP_PHASE5` | `false` | `parseBoolean` | Disable Phase 5 (thread reconciliation) of the task sync cycle. When `true`, the sync will not archive orphaned forum threads or reconcile thread state against tasks. Recommended for shared-forum deployments where multiple bot instances or manual Discord activity may create threads that should not be auto-archived. Passed through to sync options in `src/tasks/task-sync-engine.ts`. |
| `DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_ENABLED` | `true` | `parseBoolean` | Enable/disable failure-triggered retries in `TaskSyncCoordinator` when a sync run throws. |
| `DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_DELAY_MS` | `30000` | `parsePositiveInt` | Delay before running a failure retry after a sync error. |
| `DISCOCLAW_TASKS_SYNC_DEFERRED_RETRY_DELAY_MS` | `30000` | `parsePositiveInt` | Delay before running deferred-close retries when sync reports `closesDeferred > 0`. |
