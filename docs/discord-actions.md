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
- `src/tasks/task-action-contract.ts` (task action request/type set)
- `src/tasks/task-action-executor.ts` (task action dispatcher)
- `src/tasks/task-action-mutations.ts` (task create/update/close handlers)
- `src/tasks/task-action-thread-sync.ts` (task thread lifecycle helpers for mutation handlers)
- `src/tasks/task-action-mutation-helpers.ts` (shared mutation helpers)
- `src/tasks/task-action-read-ops.ts` (task show/list/sync/tag-map handlers)
- `src/tasks/task-action-runner-types.ts` (shared task action runner contracts)
- `src/tasks/task-action-prompt.ts` (task action prompt section)
- `src/discord/actions-crons.ts`
- `src/discord/actions-bot-profile.ts`
- `src/discord/actions-forge.ts`
- `src/discord/actions-plan.ts`
- `src/discord/actions-memory.ts`
- `src/discord/actions-defer.ts`
- `src/discord/defer-scheduler.ts` (defer scheduler implementation)
- `src/discord/actions-config.ts`
- `src/discord/actions-imagegen.ts`
- `src/discord/actions-voice.ts`
- `src/discord/reaction-prompts.ts`

Channel action types (in `src/discord/actions-channels.ts`):
- `channelList`, `channelCreate`, `channelDelete`, `channelEdit`, `channelInfo`, `channelMove`
- `threadListArchived`, `threadEdit`
- `forumTagCreate`, `forumTagDelete`, `forumTagList`

Messaging action types (in `src/discord/actions-messaging.ts`):
- `sendMessage`, `sendFile`, `react`, `unreact`, `readMessages`, `fetchMessage`
- `editMessage`, `deleteMessage`, `bulkDelete`, `crosspost`, `threadCreate`
- `pinMessage`, `unpinMessage`, `listPins`

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

Task action types (in `src/tasks/task-action-contract.ts`):
- `taskCreate`, `taskUpdate`, `taskClose`, `taskShow`, `taskList`, `taskSync`, `tagMapReload`

Defer action types (in `src/discord/actions-defer.ts`):
- `defer`

Config action types (in `src/discord/actions-config.ts`):
- `modelSet`, `modelShow`

Imagegen action types (in `src/discord/actions-imagegen.ts`):
- `generateImage`

Voice action types (in `src/discord/actions-voice.ts`):
- `voiceJoin`, `voiceLeave`, `voiceStatus`, `voiceMute`, `voiceDeafen`

Reaction prompt types (in `src/discord/reaction-prompts.ts`):
- `reactionPrompt` (gated under messaging flag — only available when messaging actions are enabled)

> **Task References:** Task IDs are the stable identifier for cross-task interaction. When interacting with another task (e.g. reading its content, posting an update, or closing it), always use `taskShow`/`taskUpdate`/etc. with the task ID. Do not use channel-name based messaging actions for task threads.

Query actions (read-only actions that can trigger an auto-follow-up loop):
- `src/discord/action-categories.ts`

Integration points (where actions are included in the prompt and executed):
- `src/discord.ts` (normal message handling)
- `src/cron/executor.ts` (cron jobs)
- `src/discord/deferred-runner.ts` (deferred action execution)
- `src/discord/reaction-handler.ts` (reaction-based prompt resolution)

Env wiring:
- `.env.example` / `.env.example.full`
- `src/index.ts`

## Enabling And Gating

Actions are controlled by a master switch plus per-category switches:

- Master: `DISCOCLAW_DISCORD_ACTIONS` (default 1 — on by default)
- Categories (only relevant if master is 1):
  - `DISCOCLAW_DISCORD_ACTIONS_CHANNELS` (default 1)
  - `DISCOCLAW_DISCORD_ACTIONS_MESSAGING` (default 1)
  - `DISCOCLAW_DISCORD_ACTIONS_GUILD` (default 1)
  - `DISCOCLAW_DISCORD_ACTIONS_MODERATION` (default 0)
  - `DISCOCLAW_DISCORD_ACTIONS_POLLS` (default 1)
  - `DISCOCLAW_DISCORD_ACTIONS_TASKS` (default 1; also requires tasks subsystem enabled/configured)
  - `DISCOCLAW_DISCORD_ACTIONS_CRONS` (default 1; also requires cron subsystem enabled)
  - `DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE` (default 1)
  - `DISCOCLAW_DISCORD_ACTIONS_FORGE` (default 1; also requires forge commands enabled)
  - `DISCOCLAW_DISCORD_ACTIONS_PLAN` (default 1; also requires plan commands enabled)
  - `DISCOCLAW_DISCORD_ACTIONS_MEMORY` (default 1; also requires durable memory enabled)
  - `DISCOCLAW_DISCORD_ACTIONS_DEFER` (default 1; sub-config: `DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_DELAY_SECONDS` default 1800, `DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_CONCURRENT` default 5)
  - `DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN` (default 0; requires at least one of `OPENAI_API_KEY` or `IMAGEGEN_GEMINI_API_KEY`)
  - `config` (`modelSet`/`modelShow`) — no separate env flag; always enabled when master switch is on
  - `reactionPrompt` — no separate env flag; gated under `DISCOCLAW_DISCORD_ACTIONS_MESSAGING`

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

Env: `DISCOCLAW_DISCORD_ACTIONS_FORGE` (default 1, requires `DISCOCLAW_FORGE_COMMANDS_ENABLED`).
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

Env: `DISCOCLAW_DISCORD_ACTIONS_PLAN` (default 1, requires `DISCOCLAW_PLAN_COMMANDS_ENABLED`).
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

Env: `DISCOCLAW_DISCORD_ACTIONS_MEMORY` (default 1, requires durable memory enabled).
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

#### `cronCreate` / `cronUpdate` Fields

Both actions share the same writeable field set:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes (create) | Human-readable name for the cron job |
| `schedule` | Yes (create) | Cron expression (e.g. `"0 9 * * 1"`) |
| `prompt` | Yes (create) | Prompt text sent to the AI runtime at each execution |
| `channel` | Yes (create) | Target channel name or ID for output |
| `model` | No | Model override for this job |
| `tags` | No | Forum thread tags to apply |
| `routingMode` | No | Set to `"json"` to enable JSON routing mode (see below) |
| `allowedActions` | No | Comma-separated action types permitted during execution (see below) |

`cronUpdate` additionally requires `id` (the cron job ID to update). Only supplied fields are changed.

`cronShow` output includes `routingMode` and `allowedActions` when set on the job.

#### JSON Routing Mode

When `routingMode: "json"` is set on a cron job, the executor instructs the AI runtime to return output as a JSON array of `{"channel", "content"}` objects instead of posting a single reply to the job's default channel.

Example response the AI is expected to produce:

```json
[
  {"channel": "general", "content": "Good morning! Today's summary: ..."},
  {"channel": "alerts",  "content": "Heads-up: threshold exceeded"}
]
```

The orchestrator iterates the array and sends each `content` string to the named `channel`. If JSON parsing fails or every entry fails to send, raw output falls back to the default channel.

#### Channel Placeholder Expansion

Cron prompts support two built-in placeholders that are expanded at execution time:

| Placeholder | Expands to |
|-------------|------------|
| `{{channel}}` | The job's target channel name |
| `{{channelId}}` | The job's target channel ID |

These allow prompts to reference their own delivery context without hardcoding channel names or IDs.

#### `allowedActions` Semantics

- **Format:** comma-separated action type name strings, e.g. `"sendMessage,taskCreate,taskUpdate"`. Whitespace around commas is ignored.
- **Narrowing only:** `allowedActions` can only restrict the set that global env flags permit. Listing a type that is disabled by its env flag (or excluded from cron flows entirely) has no effect — those types remain unavailable.
- **Clearing:** set `allowedActions` to `""` (empty string) on `cronUpdate` to remove the restriction. When cleared, the job inherits the full set of globally-enabled, cron-permitted action types.
- **Enforcement:** the cron executor (`src/cron/executor.ts`) reads the stored `allowedActions` value at execution time and intersects it with the global `cronActionFlags` before building the action prompt and running the job.

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

Env: `DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE` (default 1).
No subsystem context required (uses the Discord client directly).
Excluded from cron flows to avoid rate-limit and abuse issues.

### Defer Actions (`actions-defer.ts`)

Allow the model to schedule a deferred follow-up invocation in a target channel after a delay.

| Action | Description | Mutating? | Async? |
|--------|-------------|-----------|--------|
| `defer` | Schedule a delayed re-invocation of the runtime in a named channel | Yes | Yes (in-process timer; fires after `delaySeconds`) |

Fields: `channel` (channel name or ID), `prompt` (text sent as the user message when the timer fires), `delaySeconds` (positive number).

Env: `DISCOCLAW_DISCORD_ACTIONS_DEFER` (default 1).
`DeferScheduler` constraints: delays are capped at `DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_DELAY_SECONDS` (default 1800 s); at most `DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_CONCURRENT` (default 5) timers may be pending simultaneously. Timers are in-process only — they do not survive a restart.
Execution flow: when the timer fires, `deferred-runner.ts` resolves the channel, builds a prompt (PA preamble + deferred header + user prompt text), invokes the runtime directly, then parses any action blocks from the response and posts the result to the target channel. This is a direct runtime invocation, not a replay through the Discord message handler.

### Config Actions (`actions-config.ts`)

Allow the model to inspect and update live model assignments for all runtime roles without restarting the bot.

| Action | Description | Mutating? |
|--------|-------------|-----------|
| `modelSet` | Change the model for a named role (takes effect immediately, reverts on restart) | Yes |
| `modelShow` | Show current model assignments for all roles | No (query) |

Roles: `chat`, `fast`, `forge-drafter`, `forge-auditor`, `summary`, `cron`, `cron-exec`.
Changes are **ephemeral** — use env vars for persistent configuration.
No subsystem context required beyond `ConfigContext` (holds `botParams` and the runtime adapter).
No separate env flag — config actions are always enabled when the master switch is on.
`modelShow` is a query action: it triggers the auto-follow-up loop so the model can read and reason about the current configuration.

### Imagegen Actions (`actions-imagegen.ts`)

Allow the model to generate images via OpenAI or Gemini and post them to a Discord channel.

| Action | Description | Mutating? |
|--------|-------------|-----------|
| `generateImage` | Generate an image and post it to a channel | Yes |

Fields: `prompt` (required), `channel` (optional — defaults to current channel), `model` (optional), `provider` (optional: `openai` or `gemini`, auto-detected from model prefix), `size` (optional), `quality` (optional: `standard` or `hd`, dall-e-3 only), `caption` (optional).

Available models:
- OpenAI: `dall-e-3`, `gpt-image-1`
- Gemini: `imagen-4.0-generate-001`, `imagen-4.0-fast-generate-001`, `imagen-4.0-ultra-generate-001`

Default model is auto-detected from available API keys: if only `IMAGEGEN_GEMINI_API_KEY` is set → `imagen-4.0-generate-001`; otherwise → `dall-e-3`. Override with `IMAGEGEN_DEFAULT_MODEL`.

Valid sizes:
- OpenAI dall-e-3: `1024x1024` (default), `1024x1792`, `1792x1024`, `256x256`, `512x512`
- OpenAI gpt-image-1: same as above, plus `auto`
- Gemini: `1:1` (default), `3:4`, `4:3`, `9:16`, `16:9`

Env: `DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN` (default 0). Requires at least one of `OPENAI_API_KEY` or `IMAGEGEN_GEMINI_API_KEY` to be set; the action will fail at runtime if neither is present.
Context: Requires `ImagegenContext` with `apiKey` (OpenAI), `geminiApiKey`, `baseUrl`, and `defaultModel`.
Available in cron flows when `DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN=1` is set — follows the env flag rather than being hardcoded off.

### Voice Actions (`actions-voice.ts`)

Allow the model to control voice channel presence and state.

| Action | Description | Mutating? |
|--------|-------------|-----------|
| `voiceJoin` | Join a voice channel by name or ID | Yes |
| `voiceLeave` | Leave the current voice connection | Yes |
| `voiceStatus` | Check current voice connection state | No |
| `voiceMute` | Mute or unmute the bot in voice | Yes |
| `voiceDeafen` | Deafen or undeafen the bot in voice | Yes |

Env: `DISCOCLAW_DISCORD_ACTIONS_VOICE` (default 0, requires `DISCOCLAW_VOICE_ENABLED=1`).
Context: Requires `VoiceContext` with a `VoiceConnectionManager` instance.
Disabled in cron flows — voice actions require a live Discord guild context.

### Reaction Prompt Actions (`reaction-prompts.ts`)

Allow the model to present an emoji-based multiple-choice question to the user without requiring a typed reply.

| Action | Description | Mutating? |
|--------|-------------|-----------|
| `reactionPrompt` | Send a question message, add emoji reactions as choices, and await the user's reaction | Yes |

Fields: `question` (string displayed as the bot message), `choices` (2–9 emoji strings added as reactions).
Gated under the `messaging` flag — no separate env var.
Prompt store lifecycle: `registerPrompt` records the pending prompt keyed by message ID; `tryResolveReactionPrompt` (called from `reaction-handler.ts`) matches incoming reactions to the stored record, returns the resolved choice, and deletes the record. Bypasses the normal reaction staleness guard since the prompt message is always fresh.
When the user reacts, `reaction-handler.ts` detects the match and re-invokes the runtime with a system message conveying the user's choice.

### Cron Flow Restrictions

When actions are executed within a cron job (via `src/cron/executor.ts`), the following categories are always disabled regardless of env flags:

- `crons` — prevents cron jobs from mutating cron state (self-modification loops)
- `botProfile` — prevents rate-limit and abuse issues
- `memory` — no user context in cron flows
- `config` — no relevant runtime context in cron flows
- `defer` — deferred runs target Discord message flows, not cron flows
- `voice` — voice actions require a live Discord guild context

The following categories are **enabled** in cron flows (gated by their respective env flags):

- `forge` — enables cron → forge autonomous workflows (e.g., scheduled plan drafting)
- `plan` — enables cron → plan autonomous workflows (e.g., check for approved plans and run them)
- `imagegen` — enables cron-triggered image generation (e.g., weather-image automations); requires `DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN=1` and an API key

**Principle:** A feature gated by an env flag should follow that flag everywhere. We don't hardcode it off in an additional place — if the user configured it, crons can use it.

### Deferred Runner (`deferred-runner.ts`)

The deferred runner is the integration point that fires scheduled follow-ups queued by the `defer` action. It wires `DeferScheduler` timers to full AI invocations. The sole export is `configureDeferredScheduler`, which returns a configured `DeferScheduler` instance.

Execution flow (runs when a deferred timer fires):

1. **Channel resolution** — resolves the target channel (by name or ID from the original `defer` action) on the guild stored in the original action context.
2. **Channel allowlist** — if `DISCORD_CHANNEL_IDS` is configured, the target channel (or its thread parent) must be present; otherwise the run is dropped with a warning.
3. **Channel context** — resolves the per-channel `DiscordChannelContext` for prompt building (used for context path and content directory).
4. **Context inlining** — loads workspace PA files and inlines any matching context files for the target channel.
5. **Prompt construction** — builds: PA preamble + `---\nDeferred follow-up scheduled for <#channel> (runs at HH:MM).\n---\nUser message:\n{prompt}`. If `discordActionsEnabled`, appends the full actions prompt section.
6. **Tool resolution** — applies workspace permissions and runtime capabilities to produce the effective tool list.
7. **Runtime invocation** — invokes the runtime directly. This is not replayed through the normal Discord message handler.
8. **Action parsing and execution** — parses action blocks (`parseDiscordActions`) and executes them (`executeDiscordActions`) with a synthetic action context (`messageId: "defer-<timestamp>"`).
9. **Output assembly** — combines clean prose with display lines and posts to the target channel with `allowedMentions: { parse: [] }`.

Action flag overrides (always applied, regardless of env):
- `memory`: `false` — deferred runs carry no user identity.
- `defer`: `false` — prevents chaining; a deferred run cannot schedule further deferred runs.

All other categories (`channels`, `messaging`, `guild`, `moderation`, `polls`, `tasks`, `crons`, `botProfile`, `forge`, `plan`, `config`) follow their env flags.

Configuration:
- `DISCOCLAW_DISCORD_ACTIONS_DEFER` (default 1) — master switch for the defer action.
- `DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_DELAY_SECONDS` (default 1800) — maximum allowed delay in seconds; enforced by `DeferScheduler`.
- `DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_CONCURRENT` (default 5) — maximum number of pending timers.

Timers are in-process only and do not survive a bot restart.

### Reaction Handler (`reaction-handler.ts`)

The reaction handler creates the `messageReactionAdd` and `messageReactionRemove` event listeners. Both modes share a single `createReactionHandler(mode, params, queue, statusRef)` implementation.

Exported entry points:
- `createReactionAddHandler` — handler for `messageReactionAdd`.
- `createReactionRemoveHandler` — handler for `messageReactionRemove`.

Handler step sequence (for each incoming reaction event):

1. **Self-reaction guard** — ignores reactions emitted by the bot itself (infinite-loop prevention).
2. **Partial fetch** — fetches the reaction and message objects if either is a Discord partial.
3. **Guild-only** — ignores reactions in DMs (`guildId == null`).
4. **Allowlist check** — ignores reactions from users not in `DISCORD_ALLOW_USER_IDS`.
5. **Reaction prompt interception** — before the staleness guard, checks whether the reaction resolves a pending `reactionPrompt` (add mode only). If it does, `resolvedPrompt` is set and the staleness guard is bypassed.
6. **Abort intercept** — if the emoji is 🛑 and the reacted message is a bot reply, cancels all active runtime streams and any running forge plan (add mode), or silently consumes the event (remove mode). Skipped when `resolvedPrompt` is non-null.
7. **Staleness guard** — drops reactions on messages older than `DISCOCLAW_REACTION_MAX_AGE_HOURS`. Bypassed when `resolvedPrompt` is set.
8. **Channel restriction** — if `DISCORD_CHANNEL_IDS` is configured, ignores reactions outside allowlisted channels or their thread parents.
9. **Session key + queue** — serializes per-`(channelId, userId)` session; all remaining work runs inside the queue callback.

Inside the queue callback (AI invocation flow):
- Optionally joins the thread if `autoJoinThreads` is enabled and the bot has not yet joined.
- Posts a `**Thinking...**` placeholder reply.
- Loads workspace PA files, context files, durable memory section, and task thread section.
- Builds the prompt: PA preamble + task section + durable memory + reaction event line (or resolved-prompt line when `resolvedPrompt` is set) + original message content + attachment text + embeds + guidance line + actions prompt section.
- Downloads image attachments and non-image text attachments from the reacted-to message.
- Streams the runtime response with keepalive ticks (every 5 s) and stall warnings.
- Parses and executes action blocks. A per-event `memoryCtx` is constructed with the reacting user's ID so memory actions target the correct user.
- Runs the auto-follow-up loop (up to `DISCOCLAW_ACTION_FOLLOWUP_DEPTH` iterations).
- Edits the placeholder reply with the final output, or deletes it for trivial or action-only responses.

No action categories are force-disabled in reaction flows — all follow their env flags, identical to normal Discord message handling.

Configuration:
- `DISCOCLAW_REACTION_HANDLER` (default 1) — enables `messageReactionAdd`; when off, emoji reactions do not trigger AI invocations.
- `DISCOCLAW_REACTION_REMOVE_HANDLER` (default 0) — enables `messageReactionRemove`; off by default since remove events are rarely actionable.
- `DISCOCLAW_REACTION_MAX_AGE_HOURS` (default 24) — staleness cutoff in hours. Set to `0` to disable the guard entirely.

Special behaviors:
- **🛑 abort intercept:** Reacting with 🛑 to a bot reply cancels all active runtime streams and any running forge plan. In remove mode the event is silently consumed. The abort check is skipped when the reaction resolves a pending `reactionPrompt`.
- **Staleness guard bypass:** Reactions that resolve a pending `reactionPrompt` always bypass the staleness guard, regardless of `DISCOCLAW_REACTION_MAX_AGE_HOURS`. The age check would otherwise reject reactions on prompt messages that aged out between emission and the user's response.
- **Guild-only:** Reactions in DMs are always ignored (no action flags are evaluated and no AI invocation occurs).

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
