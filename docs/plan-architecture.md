# Plan & Forge Architecture

> Part of the [Plan & Forge](plan-and-forge.md) documentation.

---

## Forge Orchestration Loop

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

### Severity Model

The audit system uses a four-tier severity model:

| Level | Triggers loop? | Description |
|-------|---------------|-------------|
| `blocking` | **Yes** | Correctness bugs, security issues, architectural flaws, missing critical functionality. The plan cannot ship with this unresolved. |
| `medium` | No | Substantive improvements that would make the plan better but aren't showstoppers. Missing edge case handling, incomplete error paths. |
| `minor` | No | Small issues: naming, style, minor clarity gaps. Worth noting, not worth looping over. |
| `suggestion` | No | Ideas for future improvement. Not problems with the current plan. |

Only `blocking` findings trigger the revision loop. All other severities are noted in the audit log but auto-approved.

**Backward compatibility:** Old `high` markers are treated as `blocking`, old `low` markers as `minor`. Case-insensitive matching is preserved (`HIGH`, `High`, `high` all work).

### Verdict parsing

`parseAuditVerdict()` in `forge-commands.ts` determines whether to loop:

| Severity detected | `maxSeverity` | `shouldLoop` |
|-------------------|---------------|--------------|
| `severity: blocking` | `blocking` | `true` — revise and re-audit |
| `severity: high` (backward compat) | `blocking` | `true` — revise and re-audit |
| `severity: medium` | `medium` | `false` — stop, ready for review |
| `severity: minor` | `minor` | `false` — stop, ready for review |
| `severity: low` (backward compat) | `minor` | `false` — stop, ready for review |
| `severity: suggestion` | `suggestion` | `false` — stop, ready for review |
| "ready to approve" text | `minor` | `false` — stop |
| "needs revision" text (no markers) | `blocking` | `true` — stop |
| No severity markers | `none` | `false` — stop (malformed → human review) |

### Status transitions during forge

- **Normal completion (audit passes):** Plan set to `REVIEW`. Happens when `shouldLoop` is false (any non-blocking severity).
- **Cap reached:** `VERDICT: CAP_REACHED` appended to plan content, then status set to `REVIEW`. Concerns remain — manual review required.
- **Cancellation:** Status set to `CANCELLED` when the forge's `AbortSignal` is raised. The signal interrupts the active AI invocation immediately — the forge does not finish the current audit/draft/revise call before stopping. Triggered by `!forge cancel`, the 🛑 reaction on the progress message, or `!stop`.
- **Error:** Status reset to `DRAFT` in the catch block (best-effort partial state save).

### Concurrent session constraint

Only one forge can run at a time per DM handler instance. The `forgeOrchestrator` variable in `discord.ts` is a module-level singleton. If you attempt a second forge while one is running, the handler returns a rejection message without creating a new orchestrator.

### Model and runtime selection

The drafter/reviser uses `FORGE_DRAFTER_MODEL` if set, otherwise the main `RUNTIME_MODEL`. The auditor uses `FORGE_AUDITOR_MODEL` if set, otherwise the main model. The drafter/reviser gets read-only tools (Read, Glob, Grep); the auditor also gets read-only tools when its runtime declares the `tools_fs` capability (Claude and Codex both do). Runtimes without `tools_fs` (e.g., the OpenAI HTTP adapter when `OPENAI_COMPAT_TOOLS_ENABLED` is off) get a text-only prompt instead.

**Multi-provider auditor:** The auditor can optionally use a non-Claude runtime via `FORGE_AUDITOR_RUNTIME`. Two adapters are available:

- `FORGE_AUDITOR_RUNTIME=codex` — routes through the Codex CLI adapter (`src/runtime/codex-cli.ts`), which shells out to `codex exec`. Auth is handled natively by the Codex CLI (`~/.codex/auth.json`). This is the recommended path for OpenAI models like `gpt-5.3-codex` that aren't available on the public chat completions API.
- `FORGE_AUDITOR_RUNTIME=openai` — routes through the OpenAI-compatible HTTP adapter (`src/runtime/openai-compat.ts`) using a static `OPENAI_API_KEY`. Works for models available on the `/v1/chat/completions` endpoint.

This enables cross-model auditing — the plan is drafted by one model family and audited by another.

When the auditor uses a non-Claude runtime:
- Tool access depends on the adapter's capabilities. The Codex CLI adapter declares `tools_fs` and receives read-only tools (Read, Glob, Grep) just like Claude. The OpenAI HTTP adapter gets a text-only "no codebase access" prompt by default; when `OPENAI_COMPAT_TOOLS_ENABLED=1` it declares `tools_fs` + `tools_exec` and receives tools like the other adapters.
- Session persistence depends on the adapter's capabilities. Adapters that declare the `sessions` capability (Claude and Codex CLI) maintain conversation context across audit rounds — the auditor remembers previous concerns and the drafter remembers previous revisions. The Codex CLI adapter maps session keys to Codex thread IDs in memory, using `codex exec resume <thread_id>` for subsequent calls. Session state is in-memory only and resets on service restart. Adapters without `sessions` (e.g., the OpenAI HTTP adapter) start fresh each round.
- If `FORGE_AUDITOR_MODEL` is not set, the model defaults to the adapter's `defaultModel`: for codex, `CODEX_MODEL` (default `gpt-5.3-codex`); for openai, `OPENAI_MODEL` (default `gpt-4o`)

---

## Phase Manager

The phase manager decomposes an approved plan into executable phases, manages dependencies, and runs them sequentially.

### Decomposition logic

`decomposePlan()` in `plan-manager.ts`:

1. Extract the `## Changes` section from the plan
2. Parse file paths from the section by looking for backtick-wrapped entries in list items, headings, and the bolded file headers used in the file-by-file breakdowns
3. Group files into batches (respecting `PLAN_PHASE_MAX_CONTEXT_FILES`)
   - Module + test file pairs are kept together
   - Remaining files grouped by directory
4. Generate one `implement` phase per batch
5. Append one `audit` phase that depends on all implement phases (the post-implementation audit is always generated, even when the phase list falls back to the read/implement flow)

When `extractFilePaths()` yields nothing, the fallback phases are now `read` → `implement` → `audit`, so the plan manager always includes a post-implementation audit even for plans that don't enumerate specific files.

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
Plan file has changed since phases were generated — the existing phases may not match the current plan intent and cannot run safely.

**Fix:** `!plan phases --regenerate <plan-id>`

This regenerates phases from the current plan content. All phase statuses are reset to `pending` — previously completed phases will be re-executed. Git commits from completed phases are preserved on the branch, but the phase tracker loses their `done` status.
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

## Plan File Format

Plans are markdown files in `workspace/plans/` named `plan-NNN-slug.md`.

### Header fields

```markdown
# Plan: <title>

**ID:** plan-NNN
**Task:** <task-id>
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
| `{{TASK_ID}}` | Backing task ID |
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

### Required sections (human drafter guide)

When writing a plan manually (via `!plan <desc>` or by editing the file directly), the following sections are required for the plan to pass the structural audit gate and for phase decomposition to work correctly:

| Section | Required | Purpose |
|---------|----------|---------|
| `## Objective` | Yes | One paragraph: what problem this plan solves and why. |
| `## Scope` | Yes | What is in scope and explicitly what is out of scope. Helps the auditor and the phase runner bound the work. |
| `## Changes` | Yes | File-by-file change specifications. Parsed by the phase decomposer — format matters (see below). |
| `## Risks` | Yes | Known risks, failure modes, and mitigations. Required by the structural pre-flight check. |
| `## Testing` | Yes | How the changes will be verified. At minimum: what commands to run, what to look for. |
| `## Audit Log` | Yes (auto-filled) | Appended by the forge auditor and `!plan audit`. Leave the heading present; the bot fills the content. |
| `## Implementation Notes` | Yes (can be empty) | Scratch space for the implementor: notes that don't fit in the main plan but should travel with it. |

Missing any of the first five sections (`Objective`, `Scope`, `Changes`, `Risks`, `Testing`) will cause the structural pre-flight check in `!plan audit` to report a `high` severity finding and abort before the AI audit runs.

### What the phase decomposer needs from `## Changes`

`decomposePlan()` calls `extractFilePathsDeterministic()` (plus a legacy fallback) to find file paths in the `## Changes` section. It matches **backtick-wrapped paths** in three line types only — all other lines are ignored:

1. **List item lines** — lines starting with `-`, `*`, or `+`

   ```markdown
   - `src/webhook.ts` — Create new webhook handler with rate limiting.
   - `src/webhook.test.ts` — Unit tests for the rate limiter.
   ```

2. **Markdown heading lines** — lines starting with `#`

   ```markdown
   ### `src/webhook.ts`
   ```

3. **Bold entry lines** — lines where the first non-whitespace token is a bold-wrapped backtick path (`**\`path\`**` or `***\`path\`***`)

   ```markdown
   **`src/webhook.ts`** — New module.
   **`src/config.ts`** — Add `WEBHOOK_RATE_LIMIT_RPM` env var.
   ```

Paths that are not backtick-wrapped, or that appear in plain prose lines, are **not** picked up by the decomposer. If the decomposer finds no paths anywhere (including the Change Manifest below), it falls back to a generic `read → implement → audit` phase sequence rather than file-specific phases.

**`isLikelyFilePath` filter:** The decomposer also rejects tokens that look like config keys (`ALL_CAPS`), PascalCase type names, quoted strings, or single words without a path separator or file extension. Tokens must contain `/` or a `.ext` to pass.

### `## Change Manifest` alternative

If your plan's `## Changes` section is prose-heavy, you can add a separate `## Change Manifest` section containing a JSON array of file paths. The decomposer checks this section first: if it finds a valid JSON array with at least one path, those paths are used instead of anything parsed from `## Changes`.

```markdown
## Change Manifest

```json
["src/webhook.ts", "src/webhook.test.ts", "src/config.ts"]
```
```

Rules:
- The section must contain a bare JSON array (no wrapping object).
- Paths are still filtered by `isLikelyFilePath` — plain strings without `/` or a file extension are ignored.
- `## Change Manifest` takes **precedence** over `## Changes` for file discovery. The `## Changes` prose is still used to extract per-file change specs for phase prompts, so keep it even when using a manifest.
- Use this when you want a clean, machine-readable file list decoupled from the narrative change description.

---

## Phases File Format

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
