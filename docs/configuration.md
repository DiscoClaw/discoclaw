# DiscoClaw Configuration Reference

All configuration is done through environment variables, typically set in a `.env` file. This document lists every variable, its default, and a brief description. For quick setup, see `.env.example` (essentials) or `.env.example.full` (all options).

Boolean values accept `0`/`1` or `true`/`false`.

## Discord

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_TOKEN` | — | **Required.** Discord bot token |
| `DISCORD_ALLOW_USER_IDS` | — | Comma-separated user IDs allowed to interact with the bot (fail-closed: empty = respond to nobody) |
| `DISCORD_ALLOW_BOT_IDS` | — | Comma-separated bot IDs trusted for message handling |
| `DISCORD_CHANNEL_IDS` | — | Comma-separated channel IDs the bot responds in (empty = all channels) |
| `DISCORD_GUILD_ID` | — | Server (guild) ID; required for auto-creating forum channels |
| `DISCORD_REQUIRE_CHANNEL_CONTEXT` | `true` | Require a channel context file before responding in a channel |
| `DISCORD_AUTO_INDEX_CHANNEL_CONTEXT` | `true` | Auto-create context files for new channels |
| `DISCORD_AUTO_JOIN_THREADS` | `true` | Auto-join public threads the bot encounters |

## Runtime

| Variable | Default | Description |
|----------|---------|-------------|
| `PRIMARY_RUNTIME` | `claude` | Runtime adapter: `claude`, `openai`, `openrouter`, `gemini`, `codex` |
| `RUNTIME_MODEL` | `capable` | Model tier for chat invocations |
| `RUNTIME_TOOLS` | `Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch` | Comma-separated tools available to the runtime |
| `RUNTIME_TIMEOUT_MS` | `1800000` (30 min) | Per-invocation timeout |
| `RUNTIME_FALLBACK_MODEL` | — | Fallback model if primary fails |
| `RUNTIME_MAX_BUDGET_USD` | — | Max budget per invocation (positive number) |
| `CLAUDE_APPEND_SYSTEM_PROMPT` | — | Additional system prompt appended to all invocations (max 4000 chars) |
| `DISCOCLAW_RUNTIME_SESSIONS` | `true` | Enable multi-turn session persistence |

### Global Runtime Supervisor

Runtime-wide wrapper for every invocation (`plan -> execute -> evaluate -> decide`). Disabled by default to preserve legacy behavior.

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_GLOBAL_SUPERVISOR_ENABLED` | `false` | Enable the runtime-wide supervisor wrapper. When `false`, invocations run through the legacy direct path. |
| `DISCOCLAW_GLOBAL_SUPERVISOR_AUDIT_STREAM` | `stderr` | Stream for per-cycle JSON audit events (`stdout` or `stderr`). |
| `DISCOCLAW_GLOBAL_SUPERVISOR_MAX_CYCLES` | `3` | Max supervisor cycles before bail. Must be `>= 1`. |
| `DISCOCLAW_GLOBAL_SUPERVISOR_MAX_RETRIES` | `2` | Max retries across cycles. Must be `>= 0`. Effective retries are capped by `maxCycles - 1`. |
| `DISCOCLAW_GLOBAL_SUPERVISOR_MAX_ESCALATION_LEVEL` | `2` | Max escalation level appended to the system prompt after retries. Must be `>= 0`. |
| `DISCOCLAW_GLOBAL_SUPERVISOR_MAX_TOTAL_EVENTS` | `5000` | Max total streamed runtime events across all cycles before bail. Must be `>= 1`. |
| `DISCOCLAW_GLOBAL_SUPERVISOR_MAX_WALL_TIME_MS` | `0` | Wall-time cap for the full supervisor loop. `0` disables the cap. Must be `>= 0`. |

If the supervisor bails, it emits a structured error handoff:

- Error prefix: `GLOBAL_SUPERVISOR_BAIL `
- Payload: JSON with `source: "global_supervisor"` plus `reason`, `cycle`, `retriesUsed`, `escalationLevel`, `failureKind`, `retryable`, `signature`, `lastError`, and `limits`.
- Bail reasons: `non_retryable_failure`, `deterministic_retry_blocked`, `max_cycles_exceeded`, `max_retries_exceeded`, `max_wall_time_exceeded`, `max_events_exceeded`.

### Claude CLI

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_BIN` | `claude` | Path to Claude CLI binary |
| `CLAUDE_OUTPUT_FORMAT` | `text` | Output format: `text` or `stream-json` |
| `CLAUDE_VERBOSE` | `false` | Enable verbose metadata (requires `stream-json` format) |
| `CLAUDE_ECHO_STDIO` | `false` | Echo runtime stdio to console |
| `CLAUDE_DEBUG_FILE` | — | Write debug output to this file |
| `CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS` | `false` | Skip runtime permission checks |
| `CLAUDE_STRICT_MCP_CONFIG` | `true` | Strict MCP config validation |

### OpenAI-Compatible

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | — | OpenAI API key |
| `OPENAI_BASE_URL` | — | Custom base URL for OpenAI-compatible API |
| `OPENAI_MODEL` | `gpt-4o` | Model ID for OpenAI-compatible adapter |
| `OPENAI_COMPAT_TOOLS_ENABLED` | `false` | Enable function-calling tool use |

### OpenRouter

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | — | OpenRouter API key |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter base URL |
| `OPENROUTER_MODEL` | `anthropic/claude-sonnet-4` | Default model via OpenRouter |

### Gemini CLI

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_BIN` | `gemini` | Path to Gemini CLI binary |
| `GEMINI_MODEL` | `gemini-2.5-pro` | Gemini model ID |

### Codex CLI

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_BIN` | `codex` | Path to Codex CLI binary |
| `CODEX_MODEL` | `gpt-5.3-codex` | Codex model ID |
| `CODEX_DANGEROUSLY_BYPASS_APPROVALS_AND_SANDBOX` | `false` | Skip Codex safety checks |
| `CODEX_DISABLE_SESSIONS` | `false` | Disable Codex session persistence |

## Memory

See [docs/memory.md](memory.md) for detailed descriptions of each layer.
Current durable-memory behavior is size-triggered hot-tier compaction: active items are kept near 25 items or ~2000 chars, and low-value items are demoted using `hitCount` + `lastHitAt` signals.

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_DURABLE_MEMORY_ENABLED` | `true` | Enable durable (long-term) memory |
| `DISCOCLAW_DURABLE_INJECT_MAX_CHARS` | `2000` | Max chars of durable memory per prompt |
| `DISCOCLAW_DURABLE_MAX_ITEMS` | `200` | Max durable items per user |
| `DISCOCLAW_DURABLE_DATA_DIR` | — | Override durable memory storage directory |
| `DISCOCLAW_DURABLE_SUPERSESSION_SHADOW` | `false` | Shadow mode: log supersession without acting |
| `DISCOCLAW_MEMORY_CONSOLIDATION_THRESHOLD` | `50` | Legacy consolidation threshold knob (parsed for compatibility; not wired to active hot-tier compaction) |
| `DISCOCLAW_MEMORY_CONSOLIDATION_MODEL` | `fast` | Legacy consolidation model knob (parsed for compatibility; no runtime effect in current hot-tier path) |
| `DISCOCLAW_MEMORY_COMMANDS_ENABLED` | `true` | Enable `!memory` bang commands |
| `DISCOCLAW_SUMMARY_ENABLED` | `true` | Enable rolling summaries |
| `DISCOCLAW_SUMMARY_MODEL` | `fast` | Model tier for summary generation |
| `DISCOCLAW_SUMMARY_MAX_CHARS` | `2000` | Max chars for rolling summary |
| `DISCOCLAW_SUMMARY_EVERY_N_TURNS` | `5` | Turns between summary refreshes |
| `DISCOCLAW_SUMMARY_MAX_TOKENS` | `1500` | Estimated-token threshold for rolling summary recompression (roughly `ceil(chars / 4)`) |
| `DISCOCLAW_SUMMARY_TARGET_RATIO` | `0.65` | Recompression target ratio; target tokens are `floor(DISCOCLAW_SUMMARY_MAX_TOKENS * ratio)` |
| `DISCOCLAW_SUMMARY_DATA_DIR` | — | Override summary storage directory |
| `DISCOCLAW_SUMMARY_TO_DURABLE_ENABLED` | `true` | Enable auto-extraction (user turn → durable memory) |
| `DISCOCLAW_MESSAGE_HISTORY_BUDGET` | `3000` | Character budget for message history |
| `DISCOCLAW_SHORTTERM_MEMORY_ENABLED` | `true` | Enable cross-channel short-term memory |
| `DISCOCLAW_SHORTTERM_MAX_ENTRIES` | `20` | Max short-term entries |
| `DISCOCLAW_SHORTTERM_MAX_AGE_HOURS` | `6` | Expiry in hours for short-term entries |
| `DISCOCLAW_SHORTTERM_INJECT_MAX_CHARS` | `1000` | Max chars for short-term injection |
| `DISCOCLAW_SHORTTERM_DATA_DIR` | — | Override short-term memory storage directory |

## Plan & Forge

See [docs/plan-and-forge.md](plan-and-forge.md) for usage details.

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_PLAN_COMMANDS_ENABLED` | `true` | Enable `!plan` bang commands |
| `PLAN_PHASES_ENABLED` | `true` | Enable plan phase execution |
| `PLAN_PHASE_MAX_CONTEXT_FILES` | `5` | Max context files per phase |
| `PLAN_PHASE_TIMEOUT_MS` | `1800000` (30 min) | Timeout per phase execution |
| `PLAN_PHASE_AUDIT_FIX_MAX` | `3` | Max audit-fix attempts per phase |
| `DISCOCLAW_FORGE_COMMANDS_ENABLED` | `true` | Enable `!forge` bang commands |
| `FORGE_MAX_AUDIT_ROUNDS` | `5` | Max audit rounds in forge |
| `FORGE_DRAFTER_MODEL` | — | Model override for forge drafter |
| `FORGE_AUDITOR_MODEL` | — | Model override for forge auditor |
| `FORGE_DRAFTER_RUNTIME` | — | Runtime override for forge drafter |
| `FORGE_AUDITOR_RUNTIME` | — | Runtime override for forge auditor |
| `FORGE_TIMEOUT_MS` | `1800000` (30 min) | Timeout for forge operations |
| `FORGE_PROGRESS_THROTTLE_MS` | `3000` | Throttle interval for forge progress messages |
| `FORGE_AUTO_IMPLEMENT` | `true` | Auto-run plan phases after forge approval |

## Cron & Automations

See [docs/cron.md](cron.md) for the operator guide.

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_CRON_ENABLED` | `true` | Enable the cron subsystem |
| `DISCOCLAW_CRON_FORUM` | — | Forum channel ID for cron job definitions (auto-created if missing) |
| `DISCOCLAW_CRON_MODEL` | `fast` | Model tier for cron definition parsing |
| `DISCOCLAW_CRON_EXEC_MODEL` | `capable` | Model tier for cron execution |
| `DISCOCLAW_CRON_AUTO_TAG` | `true` | Auto-tag cron forum threads |
| `DISCOCLAW_CRON_AUTO_TAG_MODEL` | `fast` | Model tier for cron auto-tagging |
| `DISCOCLAW_CRON_STATS_DIR` | — | Override cron stats storage directory |
| `DISCOCLAW_CRON_TAG_MAP` | — | Override cron tag map file path |

## Tasks

See [docs/tasks.md](tasks.md) for the operator guide.

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_TASKS_ENABLED` | `true` | Enable the task subsystem |
| `DISCOCLAW_TASKS_FORUM` | — | Forum channel ID for task threads (auto-created if missing) |
| `DISCOCLAW_TASKS_CWD` | — | Override task working directory |
| `DISCOCLAW_TASKS_TAG_MAP` | — | Override task tag map file path |
| `DISCOCLAW_TASKS_MENTION_USER` | — | User ID to @mention on task creation |
| `DISCOCLAW_TASKS_SIDEBAR` | `true` | Show tasks in forum sidebar |
| `DISCOCLAW_TASKS_AUTO_TAG` | `true` | Auto-tag task threads via AI |
| `DISCOCLAW_TASKS_AUTO_TAG_MODEL` | `fast` | Model tier for auto-tagging |
| `DISCOCLAW_TASKS_SYNC_SKIP_PHASE5` | `false` | Skip the reconcile phase in task sync |
| `DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_ENABLED` | `true` | Retry failed sync operations |
| `DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_DELAY_MS` | `30000` | Delay before retrying failed sync |
| `DISCOCLAW_TASKS_SYNC_DEFERRED_RETRY_DELAY_MS` | `30000` | Delay before retrying deferred sync |
| `DISCOCLAW_TASKS_PREFIX` | `ws` | Prefix for task IDs |

## Voice

See [docs/voice.md](voice.md) for the full setup guide and provider details.

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_VOICE_ENABLED` | `false` | Master switch for voice subsystem |
| `DISCOCLAW_VOICE_AUTO_JOIN` | `false` | Auto-join voice channels when users enter |
| `ANTHROPIC_API_KEY` | — | Anthropic API key (required for direct Messages API voice responses) |
| `DISCOCLAW_VOICE_MODEL` | — | Model override for voice responses |
| `DISCOCLAW_VOICE_SYSTEM_PROMPT` | — | System prompt override for voice (max 4000 chars) |
| `DISCOCLAW_STT_PROVIDER` | `deepgram` | Speech-to-text provider: `deepgram`, `whisper`, `openai` |
| `DISCOCLAW_TTS_PROVIDER` | `cartesia` | Text-to-speech provider: `cartesia`, `deepgram`, `kokoro`, `openai` |
| `DISCOCLAW_VOICE_HOME_CHANNEL` | — | Voice channel name or ID for prompt context |
| `DISCOCLAW_VOICE_LOG_CHANNEL` | `voice-log` | Text channel for transcript mirror |
| `DEEPGRAM_API_KEY` | — | Deepgram API key (required for Deepgram STT/TTS) |
| `DEEPGRAM_STT_MODEL` | `nova-3-general` | Deepgram STT model |
| `DEEPGRAM_TTS_VOICE` | `aura-2-asteria-en` | Deepgram TTS voice |
| `DEEPGRAM_TTS_SPEED` | `1.3` | Deepgram TTS playback speed multiplier (0.5–1.5) |
| `CARTESIA_API_KEY` | — | Cartesia API key (required for Cartesia TTS) |

## Webhook

See [docs/webhook-exposure.md](webhook-exposure.md) for setup and security details.

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_WEBHOOK_ENABLED` | `false` | Enable the webhook HTTP server |
| `DISCOCLAW_WEBHOOK_PORT` | `9400` | Port for the webhook server |
| `DISCOCLAW_WEBHOOK_CONFIG` | — | Path to webhook config file |

## Actions

Master switch and per-category flags for Discord actions. See [docs/discord-actions.md](discord-actions.md).

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_DISCORD_ACTIONS` | `true` | Master switch for all Discord actions |
| `DISCOCLAW_DISCORD_ACTIONS_CHANNELS` | `true` | Channel management actions |
| `DISCOCLAW_DISCORD_ACTIONS_MESSAGING` | `true` | Messaging actions (send, edit, delete, react) |
| `DISCOCLAW_DISCORD_ACTIONS_GUILD` | `true` | Guild/server actions (roles, members) |
| `DISCOCLAW_DISCORD_ACTIONS_MODERATION` | `false` | Moderation actions (kick, ban, timeout) |
| `DISCOCLAW_DISCORD_ACTIONS_POLLS` | `true` | Poll actions |
| `DISCOCLAW_DISCORD_ACTIONS_TASKS` | `true` | Task actions |
| `DISCOCLAW_DISCORD_ACTIONS_CRONS` | `true` | Cron actions |
| `DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE` | `true` | Bot profile actions (status, activity, nickname) |
| `DISCOCLAW_DISCORD_ACTIONS_FORGE` | `true` | Forge actions |
| `DISCOCLAW_DISCORD_ACTIONS_PLAN` | `true` | Plan actions |
| `DISCOCLAW_DISCORD_ACTIONS_MEMORY` | `true` | Memory actions |
| `DISCOCLAW_DISCORD_ACTIONS_DEFER` | `true` | Deferred (scheduled) actions |
| `DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN` | `false` | Image generation actions |
| `DISCOCLAW_DISCORD_ACTIONS_VOICE` | `false` | Voice actions |
| `DISCOCLAW_DISCORD_ACTIONS_SPAWN` | `true` | Spawn parallel sub-agent invocations |
| `DISCOCLAW_SENDFILE_ALLOWED_DIRS` | `/tmp` | Comma-separated absolute directory paths allowed for the `sendFile` action. `DISCOCLAW_DATA_DIR` and `WORKSPACE_CWD` are auto-included when set. Symlinks are resolved via `fs.realpath()` before checking. |
| `DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_DELAY_SECONDS` | `1800` | Max delay for deferred actions |
| `DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_CONCURRENT` | `5` | Max concurrent deferred actions |
| `DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_DEPTH` | `4` | Max nesting depth for nested defers |
| `DISCOCLAW_DISCORD_ACTIONS_SPAWN_MAX_CONCURRENT` | `8` | Max concurrent spawned agents |
| `DISCOCLAW_ACTION_FOLLOWUP_DEPTH` | `3` | Max follow-up depth for action chains |

## Image Generation

| Variable | Default | Description |
|----------|---------|-------------|
| `IMAGEGEN_GEMINI_API_KEY` | — | Gemini API key for image generation |
| `IMAGEGEN_DEFAULT_MODEL` | — | Default imagegen model (auto-detected from available keys) |

## Bot Appearance

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_BOT_NAME` | — | Override the bot's display name |
| `DISCOCLAW_BOT_STATUS` | — | Bot status: `online`, `idle`, `dnd`, `invisible` |
| `DISCOCLAW_BOT_ACTIVITY` | — | Bot activity text (e.g., "Listening to music") |
| `DISCOCLAW_BOT_ACTIVITY_TYPE` | `Playing` | Activity type: `Playing`, `Listening`, `Watching`, `Competing`, `Custom` |
| `DISCOCLAW_BOT_AVATAR` | — | Bot avatar URL or absolute file path |

## Operations

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_DATA_DIR` | — | Root data directory (workspace, content, memory under this) |
| `DISCOCLAW_CONTENT_DIR` | — | Override content directory |
| `WORKSPACE_CWD` | — | Override workspace working directory |
| `GROUPS_DIR` | — | Override groups directory |
| `USE_GROUP_DIR_CWD` | `false` | Use group directory as runtime CWD |
| `DISCOCLAW_STATUS_CHANNEL` | — | Channel ID for boot/status messages |
| `DISCOCLAW_SERVICE_NAME` | `discoclaw` | systemd service name (for multi-instance setups) |
| `DISCOCLAW_HEALTH_COMMANDS_ENABLED` | `true` | Enable `!health` bang command |
| `DISCOCLAW_HEALTH_VERBOSE_ALLOWLIST` | — | User IDs allowed verbose health output |
| `DISCOCLAW_SESSION_SCANNING` | `true` | Enable session scanning |
| `DISCOCLAW_TOOL_AWARE_STREAMING` | `true` | Enable tool-aware streaming |
| `DISCOCLAW_STREAM_PREVIEW_RAW` | `false` | Render a denser `Thinking...` preview when `true` (14-line tail, 120-char width, richer runtime signals). `false` keeps compact mode (8-line tail, 72-char width). Preview text remains sanitized in both modes (`<discord-action>` tags, including partial trailing tags, are stripped). |
| `DISCOCLAW_MULTI_TURN` | `true` | Enable multi-turn sessions |
| `DISCOCLAW_MULTI_TURN_HANG_TIMEOUT_MS` | `60000` | Timeout for hung multi-turn sessions |
| `DISCOCLAW_MULTI_TURN_IDLE_TIMEOUT_MS` | `300000` | Idle timeout for multi-turn sessions |
| `DISCOCLAW_MULTI_TURN_MAX_PROCESSES` | `5` | Max concurrent multi-turn processes |
| `DISCOCLAW_STREAM_STALL_TIMEOUT_MS` | `600000` | Timeout for stalled streams |
| `DISCOCLAW_PROGRESS_STALL_TIMEOUT_MS` | `300000` | Timeout for stalled progress |
| `DISCOCLAW_STREAM_STALL_WARNING_MS` | `300000` | Warning threshold for stalled streams |
| `DISCOCLAW_MAX_CONCURRENT_INVOCATIONS` | `0` (unlimited) | Max concurrent AI invocations |
| `DISCOCLAW_DEBUG_RUNTIME` | `false` | Enable runtime debug logging |
| `DISCOCLAW_COMPLETION_NOTIFY` | `true` | Notify on long completion |
| `DISCOCLAW_COMPLETION_NOTIFY_THRESHOLD_MS` | `30000` | Threshold for completion notification |
| `DISCOCLAW_BOT_MESSAGE_MEMORY_WRITE` | `false` | Write bot messages to memory |

## Reactions

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_REACTION_HANDLER` | `true` | Enable reaction handler |
| `DISCOCLAW_REACTION_REMOVE_HANDLER` | `false` | Enable reaction-remove handler |
| `DISCOCLAW_REACTION_MAX_AGE_HOURS` | `24` | Max age for reactable messages |
