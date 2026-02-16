# DiscoClaw Discord Actions

DiscoClaw supports "Discord Actions": structured JSON blocks embedded in the model's response that the bot parses and executes against the Discord API.

This is intentionally not slash commands. Actions are internal plumbing that let the model do things like create channels, read messages, manage roles, etc, when enabled.

## Quick Overview

- Action blocks look like:

```text
<discord-action>{"type":"channelList"}</discord-action>
```

- The bot strips these blocks out of the message before posting, executes them, then appends a short "Done:" or "Failed:" line for each action.
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
- `src/discord/actions-beads.ts`

Channel action types (in `src/discord/actions-channels.ts`):
- `channelList`, `channelCreate`, `channelDelete`, `channelEdit`, `channelInfo`, `channelMove`
- `threadListArchived`
- `forumTagCreate`, `forumTagDelete`, `forumTagList`

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
  - `DISCOCLAW_DISCORD_ACTIONS_BEADS` (also requires beads subsystem enabled/configured)

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
  - It returns `{ cleanText, actions }` where `cleanText` has the blocks removed.

4. Execute:
  - `executeDiscordActions(actions, ctx, log, beadCtx)` in `src/discord/actions.ts` dispatches to the right category module based on `action.type`.
  - Each action returns `{ ok: true, summary }` or `{ ok: false, error }`.

5. Post-processing:
  - The bot appends "Done:" / "Failed:" lines after `cleanText` and posts the result.

6. Optional auto-follow-up:
  - If any action type is listed in `QUERY_ACTION_TYPES` (`src/discord/action-categories.ts`) and at least one of those query actions succeeded, `src/discord.ts` can automatically invoke the model again with the results.
  - This is intended for "read/list/info" actions where the model needs returned data to keep reasoning.

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

