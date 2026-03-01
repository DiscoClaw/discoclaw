# DiscoClaw Cron System

The cron system lets you define recurring tasks as forum threads in plain language. DiscoClaw parses the schedule, registers a timer, and executes the prompt on each tick — posting results to a target Discord channel.

## How It Works

1. **You ask the bot** (in chat or via a `cronCreate` action) to create a cron job. Example: "every weekday at 7am, check the weather and post to #general".
2. **The bot parses the definition** — an AI call extracts the cron schedule, timezone, target channel, and prompt from your natural-language description.
3. **A forum thread is created** in the cron forum channel. The thread title is the job name, and the starter message contains the parsed definition (schedule, timezone, channel, prompt) plus a stable `cronId`.
4. **A croner timer is registered** in-process. On each tick, the executor assembles a prompt, invokes the AI runtime, and posts the output to the target channel.
5. **The thread stays synced** — archiving the thread pauses the job; unarchiving resumes it. Editing the starter message updates the definition on the next sync.

### Forum Thread ↔ Job Lifecycle

| Thread state | Job state |
|-------------|-----------|
| Active thread | Registered and running |
| Archived thread | Unregistered (paused) |
| Unarchived thread | Re-registered (resumed) |
| Deleted thread | Removed from scheduler, stats cleaned up on next startup |

Manually creating a forum thread in the cron channel is rejected — the bot posts a notice and archives it. Cron jobs must be created through the bot.

## Writing Effective Cron Prompts

The prompt is the instruction the AI follows on each execution. Write it as a direct instruction:

- **Good:** "Check the weather forecast for San Francisco and post a brief morning summary."
- **Bad:** "I want you to sometimes tell me about the weather."

### Placeholders

Cron prompts support three placeholders:
- `{{channel}}` — expands to the target channel name
- `{{channelId}}` — expands to the target channel snowflake ID
- `{{state}}` — expands to the job's persisted state as JSON (see [Job State](#job-state))

These are useful when the prompt needs to reference the output channel or recall previous run context.

## Job State

Each cron job has a persistent key-value `state` object that survives across executions. This lets jobs remember what happened on previous runs — enabling delta tracking, deduplication, accumulation, and smarter silent-mode suppression.

### `{{state}}` Placeholder

Cron prompts can include a `{{state}}` placeholder, which expands to a JSON representation of the job's current state object at execution time. If the job has no state yet, it expands to `{}`.

Example prompt:
```
Check for new GitHub releases. Previous state: {{state}}
Only report releases newer than the "lastSeenTag" in state.
```

### Writing State Back: `<cron-state>`

The AI runtime writes state back by including a `<cron-state>` block in its response. The executor parses this block, replaces the job's persisted state with the parsed JSON object, and strips the block from the posted output.

```text
<cron-state>{"lastSeenTag": "v2.3.1", "lastChecked": "2026-02-28T07:00:00Z"}</cron-state>
```

The replacement is full — the emitted object becomes the new state. Keys not included in the emitted object are dropped. To preserve existing keys, include them in every `<cron-state>` emission (the `{{state}}` placeholder makes this easy).

If JSON parsing fails, the state update is skipped and a warning is logged. The rest of the job output is still posted normally.

### Manual State Management via `cronUpdate`

State can also be set or reset manually using the `cronUpdate` action with a `state` field. This is useful for:
- Seeding initial state before a job's first run
- Resetting state after a schema change
- Debugging by inspecting or overriding persisted values

Setting `state` to `{}` on `cronUpdate` clears all stored state.

### Use Cases

| Pattern | How state helps |
|---------|----------------|
| **Delta tracking** | Store a cursor (timestamp, ID, tag) and only report items newer than the cursor on the next run |
| **Deduplication** | Track seen item IDs to avoid re-posting the same alert twice |
| **Accumulation** | Aggregate counts or summaries across runs, then emit a rollup on a cadence boundary |
| **Silent-mode suppression** | Track consecutive no-op runs; only break silence when something genuinely changes |

## Advanced Options

These options are set in the cron run-stats record (typically via the `cronCreate` or `cronUpdate` action).

### `routingMode: 'json'`

Instead of posting prose to a single channel, the AI returns a JSON array of `{ channel, content }` objects, and the router sends each entry to its target channel. Useful for jobs that need to post to multiple channels per run.

If JSON parsing fails or all entries fail to send, the raw output falls back to the default channel. An empty array (`[]`) is treated as a successful no-op.

### `allowedActions`

Restricts which Discord action types the AI may emit during this job. When set to an array of action type strings (e.g., `["send", "react"]`), only those types are permitted. When unset, all enabled action types are available.

### `silent`

When `true`, the AI is instructed to respond with a sentinel value (`HEARTBEAT_OK` in default mode, `[]` in JSON routing mode) if there's nothing actionable to report. The executor detects these sentinels and skips posting to Discord, keeping channels clean.

### Trigger Types

Jobs support three trigger types:
- `schedule` — standard cron timer (5-field cron expression)
- `webhook` — triggered by an external HTTP POST (see [docs/webhook-exposure.md](webhook-exposure.md))
- `manual` — triggered only by explicit `cronTrigger` action

## Run Stats and Cadence Tracking

Each job has a persistent run-stats record tracking:
- `runCount` — total executions
- `lastRunAt` — timestamp of last run
- `lastRunStatus` — `success`, `error`, `running`, or `interrupted`
- `cadence` — auto-detected frequency tag: `frequent`, `hourly`, `daily`, `weekly`, `monthly`, `yearly`
- `purposeTags` — AI-classified tags describing the job's purpose

A status message is maintained in the cron forum thread (created or updated after each run) showing the latest run result and next scheduled time.

## Debugging Stuck or Failed Jobs

**Job isn't running:**
1. Check the forum thread — is it archived? Archived = paused.
2. Check `!health` output for cron stats — is the job registered?
3. Verify `DISCOCLAW_CRON_ENABLED=true` and `DISCOCLAW_CRON_FORUM` points to the right channel.

**Job runs but output is wrong:**
1. Edit the starter message in the forum thread to refine the prompt.
2. Use `cronTrigger` to test immediately without waiting for the next scheduled tick.
3. Check the run-stats status message in the thread for error details.

**Job shows `interrupted` status:**
- This means the bot was restarted or crashed during execution. Startup healing automatically promotes `running` records to `interrupted`. The job will execute normally on its next scheduled tick.

**Overlap guard:**
- Only one execution per job runs at a time. If a tick fires while the previous run is still active, it's skipped.

## Tag Map Configuration

Forum tags on cron threads are managed via a tag map file (`DISCOCLAW_CRON_TAG_MAP`). This is a JSON file mapping tag names to forum tag IDs. When auto-tagging is enabled (`DISCOCLAW_CRON_AUTO_TAG=true`), the AI classifies each job and applies matching tags.

Reload the tag map at runtime with the `cronTagMapReload` action.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_CRON_ENABLED` | `true` | Enable the cron subsystem |
| `DISCOCLAW_CRON_FORUM` | — | Forum channel ID (auto-created if not set) |
| `DISCOCLAW_CRON_MODEL` | `fast` | Model tier for definition parsing |
| `DISCOCLAW_CRON_EXEC_MODEL` | `capable` | Model tier for job execution |
| `DISCOCLAW_CRON_AUTO_TAG` | `true` | Auto-tag cron forum threads |
| `DISCOCLAW_CRON_AUTO_TAG_MODEL` | `fast` | Model tier for auto-tagging |
| `DISCOCLAW_CRON_STATS_DIR` | — | Override stats storage directory |
| `DISCOCLAW_CRON_TAG_MAP` | — | Override tag map file path |
