# Plan & Forge — Command Reference

Canonical reference for DiscoClaw's `!plan` and `!forge` command systems.

---

## 1. Overview

**`!plan`** manages structured implementation plans — markdown files in `workspace/plans/` that track an idea from draft through approval, phase decomposition, and implementation.

**`!forge`** automates plan creation by orchestrating AI agents in a draft → audit → revise loop, producing a reviewed plan ready for human approval.

**When to use which:**

- `!plan <desc>` — you want to write or fill in the plan yourself
- `!forge <desc>` — you want the system to draft, audit, and refine the plan automatically
- After either, use `!plan approve` + `!plan run` to execute

---

## 2. `!plan` Command Reference

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
- `!plan show <plan-id|bead-id>` — show plan details
- `!plan approve <plan-id|bead-id>` — approve for implementation
- `!plan close <plan-id|bead-id>` — close/abandon a plan
- `!plan phases <plan-id>` — show/generate phase checklist
- `!plan run <plan-id>` — execute next pending phase
- `!plan skip <plan-id>` — skip a failed/in-progress phase
```

### `!plan <description>`

Create a new plan from a description. Creates a backing bead, generates a plan ID (`plan-NNN`), fills the plan template, and writes the file.

```
!plan Add webhook support for external notifications
```

**Output:**
```
Plan created: **plan-017** (bead: `abc123`)
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
- `plan-015` [APPROVED] — Implement phase manager (bead: `abc111`)
- `plan-016` [DONE] — Add forge orchestrator (bead: `abc222`)
- `plan-017` [DRAFT] — Add webhook support (bead: `abc333`)
```

### `!plan show <plan-id|bead-id>`

Show plan details: header fields, objective, and latest audit verdict. Accepts either a plan ID or a bead ID.

```
!plan show plan-017
```

**Output:**
```
**plan-017** — Add webhook support
Status: DRAFT
Bead: `abc333`
Project: discoclaw
Created: 2026-02-12

**Objective:** Add webhook endpoints for external notification delivery...

**Latest audit:** (no audit yet)
```

### `!plan approve <plan-id|bead-id>`

Set plan status to `APPROVED` and update the backing bead to `in_progress`. Blocked if the plan is currently `IMPLEMENTING`.

```
!plan approve plan-017
```

**Output:**
```
Plan **plan-017** approved for implementation.
```

### `!plan close <plan-id|bead-id>`

Set plan status to `CLOSED` and close the backing bead. Blocked if the plan is currently `IMPLEMENTING`.

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

Execute all pending phases sequentially (up to 50, safety cap). Acquires the workspace writer lock per-phase, validates staleness, then fires in the background. Stops on failure, audit deviation, staleness, or shutdown — resume with another `!plan run`.

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
Plan run stopped: Phase **phase-2** failed: Build error. 1/2 phases completed.
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

## 3. `!forge` Command Reference

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

Request cancellation of the running forge. The forge checks this flag at the top of each audit loop iteration.

```
!forge cancel
```

**Output:**
```
Forge cancel requested.
```

---

## 4. Plan Lifecycle

```
                  ┌─────────┐
  !plan <desc> ──►│  DRAFT  │◄──── error recovery (forge catch block)
  !forge <desc>   └────┬────┘
                       │
           forge completes / manual edit
                       │
                  ┌────▼────┐
                  │ REVIEW  │◄──── forge completion (normal + cap reached)
                  └────┬────┘
                       │
                !plan approve
                       │
                  ┌────▼─────┐
                  │ APPROVED │
                  └────┬─────┘
                       │
                 !plan run (phase execution)
                       │
              ┌────────▼──────────┐
              │  IMPLEMENTING     │  (set by phase runner)
              └────────┬──────────┘
                       │
              all phases complete
                       │
               ┌───────▼───────┐
               │   AUDITING    │  (post-implementation audit phase)
               └───────┬───────┘
                       │
                  ┌────▼────┐
                  │  DONE   │
                  └─────────┘

  At any point (except IMPLEMENTING):
  !plan close ──► CLOSED

  Forge cancellation:
  forge cancel ──► CANCELLED
```

**Status transitions by source:**

| Transition | Trigger | Source file |
|-----------|---------|-------------|
| → DRAFT | Plan creation | `plan-commands.ts` (template fill) |
| → DRAFT | Forge error recovery | `forge-commands.ts` (catch block) |
| → REVIEW | Forge normal completion | `forge-commands.ts` (`!lastVerdict.shouldLoop` exit) |
| → REVIEW | Forge cap reached | `forge-commands.ts` (post-loop block) |
| → APPROVED | `!plan approve` | `plan-commands.ts` |
| → CLOSED | `!plan close` | `plan-commands.ts` |
| → CANCELLED | Forge cancellation | `forge-commands.ts` (`cancelRequested` check) |

---

## 5. Forge Orchestration Loop

The forge runs a draft → audit → revise cycle:

```
1. Create plan file via !plan create
2. Load plan template + project context
3. DRAFT: Invoke drafter agent (reads codebase, fills template)
4. Write draft to plan file

   ┌─── while round < maxAuditRounds ───┐
   │                                      │
   │  Check cancel → CANCELLED if yes     │
   │                                      │
   │  AUDIT: Invoke auditor agent         │
   │  Parse verdict (parseAuditVerdict)   │
   │  Append audit notes to plan file     │
   │                                      │
   │  if shouldLoop = false → REVIEW      │──► exit (success)
   │                                      │
   │  REVISE: Invoke reviser agent        │
   │  Write revised plan to file          │
   │                                      │
   └──────────────────────────────────────┘
          │
          ▼ (loop exhausted)
   Append VERDICT: CAP_REACHED → REVIEW   ──► exit (cap reached)
```

### Verdict parsing

`parseAuditVerdict()` in `forge-commands.ts` determines whether to loop:

| Severity detected | `maxSeverity` | `shouldLoop` |
|-------------------|---------------|--------------|
| `severity: high` | `high` | `true` — revise and re-audit |
| `severity: medium` | `medium` | `true` — revise and re-audit |
| `severity: low` | `low` | `false` — stop, ready for review |
| "ready to approve" text | `low` | `false` — stop |
| No severity markers | `none` | `false` — stop (malformed → human review) |

### Status transitions during forge

- **Normal completion (audit passes):** Plan set to `REVIEW`. Happens when `shouldLoop` is false (low/none severity).
- **Cap reached:** `VERDICT: CAP_REACHED` appended to plan content, then status set to `REVIEW`. Concerns remain — manual review required.
- **Cancellation:** Status set to `CANCELLED` inside the `cancelRequested` check at the top of the while loop.
- **Error:** Status reset to `DRAFT` in the catch block (best-effort partial state save).

### Concurrent session constraint

Only one forge can run at a time per DM handler instance. The `forgeOrchestrator` variable in `discord.ts` is a module-level singleton. If you attempt a second forge while one is running, the handler returns a rejection message without creating a new orchestrator.

### Model and runtime selection

The drafter/reviser uses `FORGE_DRAFTER_MODEL` if set, otherwise the main `RUNTIME_MODEL`. The auditor uses `FORGE_AUDITOR_MODEL` if set, otherwise the main model. The drafter/reviser gets read-only tools (Read, Glob, Grep); the auditor also gets read-only tools when its runtime declares the `tools_fs` capability (Claude and Codex both do). Runtimes without `tools_fs` (e.g., the OpenAI HTTP adapter) get a text-only prompt instead.

**Multi-provider auditor:** The auditor can optionally use a non-Claude runtime via `FORGE_AUDITOR_RUNTIME`. Two adapters are available:

- `FORGE_AUDITOR_RUNTIME=codex` — routes through the Codex CLI adapter (`src/runtime/codex-cli.ts`), which shells out to `codex exec`. Auth is handled natively by the Codex CLI (`~/.codex/auth.json`). This is the recommended path for OpenAI models like `gpt-5.3-codex` that aren't available on the public chat completions API.
- `FORGE_AUDITOR_RUNTIME=openai` — routes through the OpenAI-compatible HTTP adapter (`src/runtime/openai-compat.ts`) using a static `OPENAI_API_KEY`. Works for models available on the `/v1/chat/completions` endpoint.

This enables cross-model auditing — the plan is drafted by one model family and audited by another.

When the auditor uses a non-Claude runtime:
- Tool access depends on the adapter's capabilities. The Codex CLI adapter declares `tools_fs` and receives read-only tools (Read, Glob, Grep) just like Claude. The OpenAI HTTP adapter does not — it gets a text-only "no codebase access" prompt instead.
- Session keys are not used (no multi-turn reuse)
- If `FORGE_AUDITOR_MODEL` is not set, the model defaults to the adapter's `defaultModel`: for codex, `CODEX_MODEL` (default `gpt-5.3-codex`); for openai, `OPENAI_MODEL` (default `gpt-4o`)

---

## 6. Phase Manager

The phase manager decomposes an approved plan into executable phases, manages dependencies, and runs them sequentially.

### Decomposition logic

`decomposePlan()` in `plan-manager.ts`:

1. Extract the `## Changes` section from the plan
2. Parse file paths from backtick-wrapped list items
3. Group files into batches (respecting `PLAN_PHASE_MAX_CONTEXT_FILES`)
   - Module + test file pairs are kept together
   - Remaining files grouped by directory
4. Generate one `implement` phase per batch
5. Append one `audit` phase that depends on all implement phases

If no file paths are found, a minimal 2-phase set is generated: `read` → `implement`.

### Phase kinds

| Kind | Description | Tools granted |
|------|-------------|---------------|
| `implement` | Make code changes | Read, Write, Edit, Glob, Grep, Bash |
| `read` | Read and analyze files | Read, Glob, Grep |
| `audit` | Audit implementation against plan | Read, Glob, Grep |

### Dependency chains

Phases declare dependencies via `dependsOn`. A phase can run only when all dependencies are `done` or `skipped`. The runner (`getNextPhase()`) prioritizes:

1. Resume any `in-progress` phase
2. Retry any `failed` phase
3. First `pending` phase with all deps met

### Staleness detection

Phases are generated with a `planContentHash` — a 16-character truncated SHA-256 of the plan file content at generation time, computed by `computePlanHash()` in `plan-manager.ts`.

Before running a phase, both `preparePlanRun()` (in `plan-commands.ts`) and `runNextPhase()` (in `plan-manager.ts`) call `checkStaleness()`, which recomputes the hash and compares. If they differ, the run is blocked:

```
Plan file has changed since phases were generated.
Run `!plan phases --regenerate <plan-id>` to update.
```

The remedy is always `!plan phases --regenerate <plan-id>`.

### Per-phase git commits

On successful `implement` phases, the runner:

1. Captures a git diff snapshot before and after execution
2. Stages only files that were modified by the phase
3. Commits with message: `{planId} {phaseId}: {title}`
4. Records the commit hash in the phases file

### Retry semantics

When retrying a failed phase:

1. Check that `modifiedFiles` and `failureHashes` are recorded (otherwise retry is blocked)
2. For each modified file, verify the current content hash matches the failure hash
3. Revert tracked files via `git checkout`, clean untracked files via `git clean`
4. Re-execute the phase

If a file has been modified since the failure, it's skipped during revert (the retry proceeds with current state).

### Skip semantics

`!plan skip` changes the first `in-progress` or `failed` phase to `skipped`. Downstream phases that depend on it can proceed (skipped counts as "met" for dependency resolution).

---

## 7. Plan File Format

Plans are markdown files in `workspace/plans/` named `plan-NNN-slug.md`.

### Header fields

```markdown
# Plan: <title>

**ID:** plan-NNN
**Bead:** <bead-id>
**Created:** YYYY-MM-DD
**Status:** DRAFT | REVIEW | APPROVED | IMPLEMENTING | AUDITING | DONE | CLOSED | CANCELLED
**Project:** discoclaw
```

**Parsing:** `parsePlanFileHeader()` in `plan-commands.ts` extracts these fields via regex.

**Status updates:** `updatePlanFileStatus()` in `plan-commands.ts` regex-replaces the `**Status:**` line.

### Template

The plan template source is `workspace/plans/.plan-template.md` (tried first). If the file is missing or unreadable, the inline `FALLBACK_TEMPLATE` in `plan-commands.ts` is used. As of this writing, the on-disk template does not exist — only the fallback is active. To customize, place a `.plan-template.md` file in `workspace/plans/`.

### Placeholder tokens

| Token | Replaced with |
|-------|---------------|
| `{{TITLE}}` | Plan description |
| `{{PLAN_ID}}` | Generated plan ID (e.g., `plan-017`) |
| `{{BEAD_ID}}` | Backing bead ID |
| `{{DATE}}` | ISO date (YYYY-MM-DD) |
| `{{PROJECT}}` | Hardcoded to `discoclaw` |

Additionally, the status line is normalized to just `DRAFT` (removes any options list from the template).

### Template sections

```markdown
## Objective
## Scope
## Changes        ← file-by-file changes (parsed by phase decomposition)
## Risks
## Testing
---
## Audit Log      ← forge appends audit rounds here
---
## Implementation Notes
```

---

## 8. Phases File Format

Phases are stored in `workspace/plans/plan-NNN-phases.md`, serialized by `serializePhases()` and deserialized by `deserializePhases()` in `plan-manager.ts`.

### Structure

```markdown
# Phases: plan-017 — workspace/plans/plan-017-slug.md
Created: 2026-02-12
Updated: 2026-02-12
Plan hash: a1b2c3d4e5f6g7h8

## phase-1: Implement src/webhook.ts
**Kind:** implement
**Status:** pending
**Context:** `src/webhook.ts`
**Depends on:** (none)

Implement changes for: `src/webhook.ts`

**Change spec:**
- `src/webhook.ts` — Create new webhook handler module...

---

## phase-2: Post-implementation audit
**Kind:** audit
**Status:** pending
**Context:** `src/webhook.ts`, `src/webhook.test.ts`
**Depends on:** phase-1

Audit all changes against the plan specification.

---
```

### Field reference

**Header fields:**

| Field | Description |
|-------|-------------|
| `planId` | Plan ID (e.g., `plan-017`) |
| `planFile` | Relative path to the plan file |
| `planContentHash` | 16-char truncated SHA-256 of plan content at generation time |
| `createdAt` | ISO date |
| `updatedAt` | ISO date (updated on each phase status change) |

**Per-phase fields (`PlanPhase` type):**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Phase ID (e.g., `phase-1`) |
| `title` | string | Human-readable title |
| `kind` | `implement` \| `read` \| `audit` | Phase type |
| `description` | string | What this phase does |
| `status` | `pending` \| `in-progress` \| `done` \| `failed` \| `skipped` | Current status |
| `dependsOn` | string[] | Phase IDs that must complete first |
| `contextFiles` | string[] | Files relevant to this phase |
| `changeSpec` | string? | Extracted change specification from plan |
| `output` | string? | Runtime output after execution |
| `error` | string? | Error message if failed |
| `gitCommit` | string? | Short commit hash if auto-committed |
| `modifiedFiles` | string[]? | Files changed during execution |
| `failureHashes` | Record<string, string>? | Content hashes of modified files at failure time (for safe retry) |

---

## 9. Configuration Reference

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
| `FORGE_PROGRESS_THROTTLE_MS` | `3000` | `parseNonNegativeInt` | Min interval between Discord progress message edits |
| `FORGE_TIMEOUT_MS` | `1800000` (30 min) | `parsePositiveNumber` | Per-agent-invocation timeout within forge |
| `FORGE_DRAFTER_MODEL` | *(empty)* | `parseTrimmedString` | Model override for drafter/reviser; falls back to main `RUNTIME_MODEL` |
| `FORGE_AUDITOR_MODEL` | *(empty)* | `parseTrimmedString` | Model override for auditor; falls back to main `RUNTIME_MODEL` |
| `FORGE_AUTO_IMPLEMENT` | `true` | `parseBoolean` | When true, sends a CTA prompt after successful forge completion suggesting `!plan approve` and `!plan run`. When false, the forge completes silently (plan summary is still posted). Does **not** auto-implement — the name is aspirational. |

### Multi-provider auditor

| Variable | Default | Parser | Description |
|----------|---------|--------|-------------|
| `FORGE_AUDITOR_RUNTIME` | *(empty)* | `parseTrimmedString` | Runtime adapter name for the auditor (`codex` or `openai`). When empty, the auditor uses the default Claude runtime. |
| `CODEX_BIN` | `codex` | `parseTrimmedString` | Path to the Codex CLI binary. |
| `CODEX_MODEL` | `gpt-5.3-codex` | `parseTrimmedString` | Default model for the Codex CLI adapter. Used when `FORGE_AUDITOR_MODEL` is not set. |
| `OPENAI_API_KEY` | *(empty)* | `parseTrimmedString` | API key for the OpenAI-compatible adapter. Required when `FORGE_AUDITOR_RUNTIME=openai`. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | `parseTrimmedString` | Base URL for the OpenAI-compatible API. Override for proxies or alternative providers (e.g., Azure OpenAI, Ollama). |
| `OPENAI_MODEL` | `gpt-4o` | `parseTrimmedString` | Default model for the OpenAI adapter. Used when `FORGE_AUDITOR_MODEL` is not set. |

---

## 10. Project Context

The file `.context/project.md` is auto-loaded as standing constraints for all forge agents:

- **Drafter:** Loaded via `ForgeOrchestrator.loadProjectContext()` and included in the context summary passed to `buildDrafterPrompt()` via `buildContextSummary()`.
- **Auditor:** Passed as the `projectContext` parameter to `buildAuditorPrompt()`. The auditor is instructed not to flag concerns that contradict these constraints.
- **Reviser:** Passed as the `projectContext` parameter to `buildRevisionPrompt()`. The reviser is instructed not to re-introduce complexity that contradicts these constraints.

Source: `ForgeOrchestrator.loadProjectContext()` in `forge-commands.ts` reads from `<cwd>/.context/project.md`.

---

## 11. Workspace Integration

### Bead backing

Every plan gets a backing bead created via `bdCreate()`. The bead ID is stored in the plan header. Status sync:

- `!plan approve` → bead updated to `in_progress`
- `!plan close` → bead closed with "Plan closed" message

Bead updates are best-effort — failures don't block plan operations.

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

## 12. Common Workflows

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
Phase **phase-2** failed: Build error in webhook.test.ts.
Use `!plan run plan-017` to retry or `!plan skip plan-017` to skip.
```

**Option A: Retry** — The runner auto-reverts files changed by the failed attempt, then re-executes:
```
!plan run plan-017
```

**Option B: Skip** — Move past the failed phase:
```
!plan skip plan-017
!plan run plan-017    ← continues with remaining phases
```

**Option C: Regenerate** — If the plan itself needs changes:
1. Edit the plan file
2. `!plan phases --regenerate plan-017`
3. `!plan run plan-017`

### Cancelling a forge mid-flight

```
!forge cancel
```
→ `Forge cancel requested.`

The forge checks the cancel flag at the start of each audit loop iteration. The plan status is set to `CANCELLED`.

### Attempting a second forge while one is running

```
!forge Add another feature
```
→ `A forge is already running. Use !forge cancel to stop it first.`

### Running a phase when phases are stale

```
!plan run plan-017
```
→ `Plan file has changed since phases were generated. Run !plan phases --regenerate plan-017 to update.`

```
!plan phases --regenerate plan-017
!plan run plan-017
```

---

## 13. Branch Workflow

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

1. **Pull main:** `git checkout main && git pull origin main`
2. **Delete local branch:** `git branch -d <branch-name>`
3. **Delete remote branch:** `git push origin --delete <branch-name>`

All three steps should happen together — don't leave stale branches on either side.

**Tip:** GitHub can auto-delete head branches on merge (Settings → General → "Automatically delete head branches"). When enabled, step 3 is handled automatically.

---

## 14. Architecture Notes

### Source file map

| File | Responsibility |
|------|---------------|
| `src/discord/plan-commands.ts` | Plan command parsing, plan file CRUD, phase CLI wrappers, `preparePlanRun()` |
| `src/discord/forge-commands.ts` | Forge command parsing, `ForgeOrchestrator` class, audit verdict parsing, prompt builders |
| `src/discord/plan-manager.ts` | Phase decomposition, serialization, staleness detection, phase execution, git integration |
| `src/discord.ts` | Discord message handler: command dispatch for both `!plan` and `!forge`, writer lock, forge lifecycle management |
| `src/config.ts` | All plan/forge env var parsing |
| `src/runtime/openai-compat.ts` | OpenAI-compatible runtime adapter (SSE streaming, text-only — no tool support) |
| `src/runtime/codex-cli.ts` | Codex CLI runtime adapter (subprocess, supports read-only tools via `tools_fs` capability) |
| `src/runtime/registry.ts` | Runtime adapter registry (name → adapter lookup) |
| `src/runtime/types.ts` | `RuntimeAdapter` interface, `EngineEvent` types |

### Concurrency model

- **Writer lock:** Promise-chain mutex (`workspaceWriterLock` in `discord.ts`) serializes all plan/forge file writes within a single process.
- **Forge singleton:** Only one `ForgeOrchestrator` instance can be running at a time (module-level variable in `discord.ts`).
- **Phase execution:** `!plan run` auto-chains all pending phases in a loop (up to `MAX_PLAN_RUN_PHASES` = 50). `!plan run-one` executes a single phase. Both are fire-and-forget from the Discord queue. The writer lock is acquired and released per-phase to avoid starvation.
- **Single-user design:** No multi-user concurrency guards. The Discord allowlist is the access boundary.

### Command dispatch split

`!plan` commands are dispatched in `discord.ts` but handled primarily by `plan-commands.ts`:
- `run`, `run-one`, `skip`, and `phases` are intercepted in `discord.ts` for lock acquisition and async execution
- All other subcommands pass through to `handlePlanCommand()` in `plan-commands.ts`

`!forge` commands are fully dispatched in `discord.ts`:
- Help text, status, cancel, and create are all handled inline
- `ForgeOrchestrator` is instantiated and run from `discord.ts`
- `forge-commands.ts` provides the orchestrator class and parsing utilities
