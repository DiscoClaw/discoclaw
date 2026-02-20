# DiscoClaw Discord Actions

DiscoClaw supports "Discord Actions": structured JSON blocks embedded in the AI runtime's response that the orchestrator parses and executes against the Discord API.

This is intentionally not slash commands. Actions are internal plumbing that let the AI runtime do things like create channels, read messages, manage roles, etc, when enabled. The orchestrator handles parsing, dispatch, and result reporting.

## Quick Overview

- Action blocks look like:

```text
<discord-action>{"type":"channelList"}</discord-action>
```

- The orchestrator strips these blocks out of the message before posting, executes them, then appends a short "Done:" or "Failed:" line for each action.
- Actions are only available in guild contexts (not DMs), and only if enabled via env flags.

## Where Things Live

Core parsing, dispatch, and prompt text:
- `src/discord/actions.ts`

Action categories (each module defines types, an executor, and prompt examples):
- `src/discord/actions-channels.ts`
- `src/discord/actions-messaging.ts`
- `src/discord/actions-guild.ts`
- `src/discord/actions-moderation.ts`
- `src/discord/actions-poll.ts`
- `src/discord/actions-tasks.ts`
- `src/discord/actions-crons.ts`
- `src/discord/actions-bot-profile.ts`
- `src/discord/actions-forge.ts`
- `src/discord/actions-plan.ts`
- `src/discord/actions-memory.ts`

Channel action types (in `src/discord/actions-channels.ts`):
- `channelList`, `channelCreate`, `channelDelete`, `channelEdit`, `channelInfo`, `channelMove`
- `threadListArchived`, `threadEdit`
- `forumTagCreate`, `forumTagDelete`, `forumTagList`

Cron action types (in `src/discord/actions-crons.ts`):
- `cronCreate`, `cronUpdate`, `cronList`, `cronShow`, `cronPause`, `cronResume`, `cronDelete`, `cronTrigger`, `cronSync`, `cronTagMapReload`

Bot profile action types (in `src/discord/actions-bot-profile.ts`):
- `botSetStatus`, `botSetActivity`, `botSetNickname`

Forge action types (in `src/discord/actions-forge.ts`):
- `forgeCreate`, `forgeResume`, `forgeStatus`, `forgeCancel`

Plan action types (in `src/discord/actions-plan.ts`):
- `planList`, `planShow`, `planApprove`, `planClose`, `planCreate`, `planRun`

Memory action types (in `src/discord/actions-memory.ts`):
- `memoryRemember`, `memoryForget`, `memoryShow`

Task action types (in `src/discord/actions-tasks.ts`):
- `taskCreate`, `taskUpdate`, `taskClose`, `taskShow`, `taskList`, `taskSync`, `tagMapReload`

> **Task References:** Task IDs are the stable identifier for cross-task interaction. When interacting with another task (e.g. reading its content, posting an update, or closing it), always use `taskShow`/`taskUpdate`/etc. with the task ID. Do not use channel-name based messaging actions for task threads.

Query actions (read-only actions that can trigger an auto-follow-up loop):
- `src/discord/action-categories.ts`

Integration points (where actions are included in the prompt and executed):
- `src/discord.ts` (normal message handling)
- `src/cron/executor.ts` (cron jobs)

Env wiring:
- `.env.example` / `.env.example.full`
- `src/index.ts`

## Enabling And Gating

Actions are controlled by a master switch plus per-category switches:

- Master: `DISCOCLAW_DISCORD_ACTIONS=1`
- Categories (only relevant if master is 1):
  - `DISCOCLAW_DISCORD_ACTIONS_CHANNELS` (default 1)
  - `DISCOCLAW_DISCORD_ACTIONS_MESSAGING`
  - `DISCOCLAW_DISCORD_ACTIONS_GUILD`
  - `DISCOCLAW_DISCORD_ACTIONS_MODERATION`
  - `DISCOCLAW_DISCORD_ACTIONS_POLLS`
  - `DISCOCLAW_DISCORD_ACTIONS_TASKS` (also requires tasks subsystem enabled/configured)
  - `DISCOCLAW_DISCORD_ACTIONS_CRONS` (default 1; also requires cron subsystem enabled)
  - `DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE` (default 0)
  - `DISCOCLAW_DISCORD_ACTIONS_FORGE` (default 0; also requires forge commands enabled)
  - `DISCOCLAW_DISCORD_ACTIONS_PLAN` (default 0; also requires plan commands enabled)
  - `DISCOCLAW_DISCORD_ACTIONS_MEMORY` (default 0; also requires durable memory enabled)

Those env vars get translated into an `ActionCategoryFlags` object (see `src/discord/actions.ts`) and passed down from `src/index.ts` into the Discord handler and cron executor.

Important behavioral notes:
- Even if a category is implemented, it is not usable unless its flag is enabled.
- Actions are not advertised to the model in DMs: `src/discord.ts` only appends the actions prompt section for non-DM messages, and execution requires `msg.guild`.

## Action Lifecycle (End To End)

1. Prompt injection:
  - The model is taught the available actions via `discordActionsPromptSection(...)` in `src/discord/actions.ts`.
  - Each category contributes examples via its `*ActionsPromptSection()` function.

2. Model emits action blocks:
  - It includes one or more `<discord-action>...</discord-action>` blocks in its response.

3. Parse:
  - `parseDiscordActions(text, flags)` in `src/discord/actions.ts` extracts JSON blocks.
  - It drops malformed JSON silently.
  - It drops actions whose `type` is not enabled by the current flags.
  - It returns `{ cleanText, actions, strippedUnrecognizedTypes }` where `cleanText` has the blocks removed.

4. Execute:
  - `executeDiscordActions(actions, ctx, log, subsystemContexts)` in `src/discord/actions.ts` dispatches to the right category module based on `action.type`.
  - Subsystem contexts (`taskCtx`, `cronCtx`, `forgeCtx`, `planCtx`, `memoryCtx`) are passed as a `SubsystemContexts` bag. Actions requiring a missing context return a "not configured" error.
  - Each action returns `{ ok: true, summary }` or `{ ok: false, error }`.

5. Post-processing:
  - The bot appends "Done:" / "Failed:" lines after `cleanText` and posts the result.

6. Optional auto-follow-up:
  - If any action type is listed in `QUERY_ACTION_TYPES` (`src/discord/action-categories.ts`) and at least one of those query actions succeeded, `src/discord.ts` can automatically invoke the model again with the results.
  - This is intended for "read/list/info" actions where the model needs returned data to keep reasoning.

## Autonomous Action Categories

The forge, plan, and memory categories enable the AI runtime to self-initiate operations that previously required human `!` commands. Combined with cron jobs, these enable fully autonomous workflows: crons that check for approved plans and forge them, post-forge memory updates, bot-initiated planning from task context, etc.

### Forge Actions (`actions-forge.ts`)

Allow the model to start, monitor, and cancel forge runs (plan drafting + audit loops) without a human `!forge` command.

| Action | Description | Mutating? | Async? |
|--------|-------------|-----------|--------|
| `forgeCreate` | Start a new forge run from a description | Yes | Yes (fire-and-forget; progress posted to channel) |
| `forgeResume` | Re-enter the audit/revise loop for an existing plan | Yes | Yes (fire-and-forget) |
| `forgeStatus` | Check if a forge is currently running | No | No |
| `forgeCancel` | Cancel the running forge | Yes | No (sets cancel flag) |

Env: `DISCOCLAW_DISCORD_ACTIONS_FORGE` (default 0, requires `DISCOCLAW_FORGE_COMMANDS_ENABLED`).
Context: Requires `ForgeContext` with an `orchestratorFactory`, plans directory, and progress callback.
Concurrency: Only one forge at a time (module-level singleton via `forge-plan-registry.ts`). Acquires the workspace writer lock for the duration of the run.
Recursion guard: `forgeCreate` and `forgeResume` are blocked at `depth >= 1` to prevent forge-initiated forges.

### Plan Actions (`actions-plan.ts`)

Allow the model to create, inspect, approve, and close plans without a human `!plan` command.

| Action | Description | Mutating? |
|--------|-------------|-----------|
| `planCreate` | Create a new plan file + backing task | Yes |
| `planList` | List plans, optionally filtered by status | No (query) |
| `planShow` | Show plan details (header, status, task) | No (query) |
| `planApprove` | Set plan status to APPROVED, update backing task | Yes |
| `planClose` | Set plan status to CLOSED, close backing task | Yes |
| `planRun` | Execute all remaining phases of a plan (fire-and-forget); posts a live-updating status message to the channel reflecting the current phase and final outcome (unless `skipCompletionNotify` is set) | Yes |

Env: `DISCOCLAW_DISCORD_ACTIONS_PLAN` (default 0, requires `DISCOCLAW_PLAN_COMMANDS_ENABLED`).
Context: Requires `PlanContext` with plans directory, workspace CWD, runtime, and model.

Note: `planApprove` and `planClose` are blocked while a plan is `IMPLEMENTING`.
Recursion guard: `planRun` is blocked at `depth >= 1` to prevent plan runs from spawning nested plan runs.
Status gate: `planRun` requires the plan to be in `APPROVED` or `IMPLEMENTING` status.
Auto-close: When all phases complete (done or skipped), `planRun` automatically closes the plan and its backing task via `closePlanIfComplete`.

### Memory Actions (`actions-memory.ts`)

Allow the model to read and mutate the user's durable memory (facts, preferences, projects, constraints) without a human `!memory` command.

| Action | Description | Mutating? |
|--------|-------------|-----------|
| `memoryRemember` | Store a fact/preference/note | Yes |
| `memoryForget` | Deprecate items matching a substring | Yes |
| `memoryShow` | Show current durable memory items | No (query) |

Env: `DISCOCLAW_DISCORD_ACTIONS_MEMORY` (default 0, requires durable memory enabled).
Context: Requires `MemoryContext` with user ID, data directory, and capacity limits.
Concurrency: Writes are serialized per-user via `durableWriteQueue`.

### Cron Actions (`actions-crons.ts`)

Allow the model to manage scheduled tasks: create, update, pause/resume, delete, trigger, and sync crons.

| Action | Description | Mutating? |
|--------|-------------|-----------|
| `cronCreate` | Create a new scheduled task (forum thread + scheduler registration) | Yes |
| `cronUpdate` | Update a cron's schedule, prompt, model, or tags | Yes |
| `cronList` | List all registered cron jobs with status | No (query) |
| `cronShow` | Show full details for a specific cron | No (query) |
| `cronPause` | Pause a cron (stops scheduling, cancels in-flight run) | Yes |
| `cronResume` | Resume a paused cron | Yes |
| `cronDelete` | Remove a cron and archive its forum thread | Yes |
| `cronTrigger` | Manually fire a cron job immediately | Yes |
| `cronSync` | Run full bidirectional sync (tags, names, status messages) | Yes |
| `cronTagMapReload` | Reload the tag map from disk | Yes |

Env: `DISCOCLAW_DISCORD_ACTIONS_CRONS` (default 1, requires cron subsystem enabled).
Context: Requires `CronContext` with scheduler, forum channel, tag map, stats store, and runtime.
Cron-to-cron restriction: Cron jobs themselves cannot emit cron actions (the `crons` flag is forced to `false` in the cron executor's action flags to prevent self-modification loops).

### Bot Profile Actions (`actions-bot-profile.ts`)

Allow the model to change the bot's Discord presence and nickname.

| Action | Description | Mutating? |
|--------|-------------|-----------|
| `botSetStatus` | Change online status (online/idle/dnd/invisible) | Yes |
| `botSetActivity` | Set activity text (Playing/Listening/Watching/Competing/Custom) | Yes |
| `botSetNickname` | Change server nickname | Yes |

Env: `DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE` (default 0 — opt-in only).
No subsystem context required (uses the Discord client directly).
Excluded from cron flows to avoid rate-limit and abuse issues.

### Cron Flow Restrictions

When actions are executed within a cron job (via `src/cron/executor.ts`), the following categories are always disabled regardless of env flags:

- `crons` — prevents cron jobs from mutating cron state (self-modification loops)
- `botProfile` — prevents rate-limit and abuse issues
- `memory` — no user context in cron flows

The following categories are **enabled** in cron flows (gated by their respective env flags):

- `forge` — enables cron → forge autonomous workflows (e.g., scheduled plan drafting)
- `plan` — enables cron → plan autonomous workflows (e.g., check for approved plans and run them)

## Adding A New Action (Existing Category)

Example: add a new messaging action.

Checklist:

1. Add a new union variant to the category request type.
  - Example file: `src/discord/actions-messaging.ts` (`export type MessagingActionRequest = ...`)

2. Register the type string in that module's `*_ACTION_TYPES` set.
  - Most modules build this from a `*_TYPE_MAP` object. Ensure your new type key is present.

3. Implement the executor branch.
  - Add a `case 'yourType':` to the `switch (action.type)` inside `execute*Action(...)`.
  - Validate required fields and return a helpful `{ ok: false, error: '...' }` when inputs are missing.

4. Update the prompt examples.
  - Add a short example block and parameter notes to `*ActionsPromptSection()`.
  - This is what teaches the model the action shape.

5. Decide if it is a query action.
  - If the action returns information that the model should process in an automatic follow-up, add its type to `QUERY_ACTION_TYPES` in `src/discord/action-categories.ts`.
  - If it mutates state (create/edit/delete/moderate), it should usually NOT be a query action.

6. Add tests.
  - Parser/flag gating tests live in `src/discord/actions.test.ts`.
  - If your action has non-trivial logic, add a focused unit test for its executor behavior.

## Adding A New Category (New Module)

If the new actions do not fit an existing category, create a new category module and wire it into the dispatcher and env flags.

Steps:

1. Create `src/discord/actions-yourcategory.ts` following an existing module pattern.
  - Export:
    - `export type YourCategoryActionRequest = ...`
    - `export const YOURCATEGORY_ACTION_TYPES = new Set<string>(...)`
    - `export async function executeYourCategoryAction(...)`
    - `export function yourCategoryActionsPromptSection(): string`

2. Wire it into the dispatcher and parser gating in `src/discord/actions.ts`.
  - Add imports for `YOURCATEGORY_ACTION_TYPES`, `executeYourCategoryAction`, and the prompt section.
  - Extend `ActionCategoryFlags` with a boolean for the new category.
  - Extend `DiscordActionRequest` union.
  - Update `buildValidTypes(...)` to include the new type set when enabled.
  - Add a dispatch branch in `executeDiscordActions(...)`.
  - Add prompt section inclusion in `discordActionsPromptSection(...)`.

3. Add env flag plumbing in `src/index.ts` and `.env.example` / `.env.example.full`.
  - Add a `DISCOCLAW_DISCORD_ACTIONS_YOURCATEGORY` env var (default should be conservative: typically `0`).
  - Ensure the new boolean flows into the `actionFlags` object passed into both Discord message handling and cron context.

4. If needed, add query-action types to `src/discord/action-categories.ts`.

5. Add tests.
  - Parser gating (disabled category types should be skipped) should be covered.
  - If you add dispatcher wiring, include at least one smoke test that the dispatcher reaches your executor.

## Permissions

These actions require Discord role permissions, not Developer Portal settings.

If an action fails with "Missing Permissions" or "Missing Access", update the bot's role in:
- Server Settings -> Roles -> (bot role) -> enable the required permissions

See `docs/discord-bot-setup.md` for recommended permission profiles and the note about `DISCOCLAW_DISCORD_ACTIONS=1` needing broader permissions (for example Manage Channels for channel actions).

## Running Tests

```bash
pnpm test
```
