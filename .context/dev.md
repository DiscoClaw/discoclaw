# dev.md — Development

## Install / Build / Run

```bash
cd /path/to/discoclaw
pnpm i
pnpm build
pnpm dev
```

**Optional tools:** Install [`agent-browser`](https://github.com/anthropics/agent-browser) if browser automation is needed. It must be on `PATH` for Claude CLI to launch it. After installing, run `agent-browser install` to fetch a bundled Chromium (or set `AGENT_BROWSER_EXECUTABLE_PATH` to use a system browser).

## One-Off: Sync Discord Content

```bash
pnpm sync:discord-context
pnpm sync:discord-context -- --rewrite-index
pnpm sync:discord-context -- --add-channel 123456789012345678:my-channel
```

## Environment

Two setup paths:

- **Global install (end users):** Run `discoclaw init` — interactive wizard creates and configures `.env`.
- **From source (contributors):** Run `pnpm setup` for guided configuration, or copy `.env.example` → `.env` for essentials only. For all ~90 options, use `.env.example.full`. See those files for inline comments.

### Discord
| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_TOKEN` | **(required)** | Bot token |
| `DISCORD_ALLOW_USER_IDS` | **(required)** | Comma/space-separated Discord user IDs; fail-closed if empty |
| `DISCORD_CHANNEL_IDS` | *(empty — all channels)* | Restrict the bot to specific guild channel IDs (DMs still allowed) |
| `DISCORD_GUILD_ID` | *(empty)* | Optional guild snowflake; required for some guild-scoped features |
| `DISCORD_REQUIRE_CHANNEL_CONTEXT` | `1` | Require a per-channel context file before responding |
| `DISCORD_AUTO_INDEX_CHANNEL_CONTEXT` | `1` | Auto-create stub context files for new channels |
| `DISCORD_AUTO_JOIN_THREADS` | `1` | Best-effort auto-join threads so the bot can respond inside them |
| `DISCOCLAW_DISCORD_ACTIONS` | `1` | Master switch for Discord server actions |
| `DISCOCLAW_DISCORD_ACTIONS_CHANNELS` | `1` | Channel management (create/edit/delete/list/info, categoryCreate) |
| `DISCOCLAW_DISCORD_ACTIONS_MESSAGING` | `1` | Messaging (send/edit/delete/read messages, react, threads, pins) |
| `DISCOCLAW_DISCORD_ACTIONS_GUILD` | `1` | Guild info (memberInfo, roleInfo, roleAdd/Remove, events, search) |
| `DISCOCLAW_DISCORD_ACTIONS_MODERATION` | `0` | Moderation (timeout, kick, ban) |
| `DISCOCLAW_DISCORD_ACTIONS_POLLS` | `1` | Poll creation |
| `DISCOCLAW_DISCORD_ACTIONS_TASKS` | `1` | Task tracking (create/update/close/show/list/sync) |
| `DISCOCLAW_DISCORD_ACTIONS_CRONS` | `1` | Cron/automation forum actions |
| `DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE` | `1` | Bot profile management (display name, avatar, status) |
| `DISCOCLAW_DISCORD_ACTIONS_FORGE` | `1` | Forge actions (file drafting and implementation) |
| `DISCOCLAW_DISCORD_ACTIONS_PLAN` | `1` | Plan command actions |
| `DISCOCLAW_DISCORD_ACTIONS_MEMORY` | `1` | Memory management actions |
| `DISCOCLAW_DISCORD_ACTIONS_DEFER` | `1` | Deferred/background action execution |
| `DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_DELAY_SECONDS` | `1800` | Max wait in seconds before a deferred action times out |
| `DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_CONCURRENT` | `5` | Max concurrent deferred actions |

### Claude CLI
| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_BIN` | `claude` | Path/name of the Claude CLI binary |
| `CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS` | `0` | Pass `--dangerously-skip-permissions` to the CLI |
| `CLAUDE_OUTPUT_FORMAT` | `text` | `text` or `stream-json` (preferred for smoother streaming) |
| `CLAUDE_VERBOSE` | `0` | Pass `--verbose` to the CLI; only effective when `CLAUDE_OUTPUT_FORMAT=stream-json` |
| `CLAUDE_ECHO_STDIO` | `0` | Forward raw CLI stdout/stderr lines into Discord output |
| `CLAUDE_DEBUG_FILE` | *(empty)* | Write Claude CLI debug logs to this file path |
| `CLAUDE_STRICT_MCP_CONFIG` | `1` | Pass `--strict-mcp-config` to skip slow MCP plugin init |

### App
| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_DATA_DIR` | *(empty)* | Optional data root; sets default `WORKSPACE_CWD` to `$DISCOCLAW_DATA_DIR/workspace` |
| `DISCOCLAW_CONTENT_DIR` | *(empty)* | Channel-context content dir (per-channel files only; PA modules always load from `.context/` in repo root); defaults to `$DISCOCLAW_DATA_DIR/content` |
| `WORKSPACE_CWD` | `./workspace` | Runtime working directory (overrides the data-dir default) |
| `GROUPS_DIR` | `./groups` | Base directory for per-session working dirs |
| `USE_GROUP_DIR_CWD` | `0` | Enable nanoclaw-style group CWD per session |
| `LOG_LEVEL` | `info` | Pino log level |
| `DISCOCLAW_DEBUG_RUNTIME` | `0` | Dump resolved runtime config at startup (debugging systemd env issues) |

### Runtime Invocation
| Variable | Default | Description |
|----------|---------|-------------|
| `PRIMARY_RUNTIME` | `claude` | Runtime engine (`claude`, `openai`, `openrouter`, `gemini`, `codex`) |
| `RUNTIME_MODEL` | `capable` | Model tier (`fast`, `capable`) or concrete model name passed to the CLI |
| `RUNTIME_TOOLS` | `Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch` | Comma-separated tool list |
| `RUNTIME_TIMEOUT_MS` | `1800000` | Per-invocation timeout in milliseconds |
| `RUNTIME_FALLBACK_MODEL` | *(unset)* | Auto-fallback model when primary is overloaded (e.g. `sonnet`) |
| `RUNTIME_MAX_BUDGET_USD` | *(unset)* | Max USD per CLI process; one-shot = per invocation, multi-turn = per session lifetime |
| `DISCOCLAW_FAST_MODEL` | `fast` | Default "fast" model tier alias used for summarization, auto-tag, and cron parsing |
| `DISCOCLAW_RUNTIME_SESSIONS` | `1` | Persist Claude session IDs across messages |
| `DISCOCLAW_SESSION_SCANNING` | `1` | Enable session ID scanning for resume detection |
| `DISCOCLAW_ACTION_FOLLOWUP_DEPTH` | `3` | Max depth for chained action follow-ups |
| `DISCOCLAW_MESSAGE_HISTORY_BUDGET` | `3000` | Char budget for recent conversation history in prompts (0 = disabled) |
| `DISCOCLAW_SUMMARY_ENABLED` | `1` | Enable rolling conversation summaries |
| `DISCOCLAW_SUMMARY_MODEL` | `fast` | Model tier or concrete name for summarization |
| `DISCOCLAW_SUMMARY_MAX_CHARS` | `2000` | Max chars for the rolling summary text |
| `DISCOCLAW_SUMMARY_EVERY_N_TURNS` | `5` | Re-summarize every N messages per session |
| `DISCOCLAW_DURABLE_MEMORY_ENABLED` | `1` | Enable durable per-user memory (persistent facts/preferences) |
| `DISCOCLAW_DURABLE_INJECT_MAX_CHARS` | `2000` | Max chars for durable memory injected into prompts |
| `DISCOCLAW_DURABLE_MAX_ITEMS` | `200` | Max durable items per user |
| `DISCOCLAW_MEMORY_COMMANDS_ENABLED` | `1` | Enable `!memory` commands (show/remember/forget/reset) |
| `DISCOCLAW_STATUS_CHANNEL` | *(empty — disabled)* | Channel name or ID for status messages (bot online/offline, errors) |
| `CLAUDE_APPEND_SYSTEM_PROMPT` | *(unset)* | Append to system prompt (max 4000 chars); skips workspace PA file reads when set |

### Browser Automation
| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_BROWSER_EXECUTABLE_PATH` | *(empty)* | Path to the browser binary for `agent-browser` (e.g. Chromium). If unset, agent-browser uses its bundled default. |

### Cron
| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_CRON_ENABLED` | `1` | Master switch for the cron subsystem (forum-based scheduled tasks) |
| `DISCOCLAW_CRON_FORUM` | **(required when enabled)** | Automations forum channel ID (snowflake) for cron/automation definitions |
| `DISCOCLAW_CRON_MODEL` | `fast` | Model tier or concrete name for parsing cron definitions |
| `DISCOCLAW_CRON_AUTO_TAG` | `1` | Enable AI auto-tagging of cron threads |
| `DISCOCLAW_CRON_AUTO_TAG_MODEL` | `fast` | Model tier or concrete name for cron auto-tagging |
| `DISCOCLAW_CRON_STATS_DIR` | *(empty)* | Override directory for cron run stats (defaults to data dir) |
| `DISCOCLAW_CRON_TAG_MAP` | *(empty)* | Override path to cron forum tag map JSON |

### Tasks (Task Tracking)
| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_TASKS_ENABLED` | `1` | Master switch — loads tasks subsystem |
| `DISCOCLAW_TASKS_FORUM` | **(required when enabled)** | Forum channel ID (snowflake) for task threads |
| `DISCOCLAW_TASKS_CWD` | `<WORKSPACE_CWD>` | Tasks workspace override (legacy import/migration path) |
| `DISCOCLAW_TASKS_TAG_MAP` | `data/tasks/tag-map.json` | Path to task forum tag map |
| `DISCOCLAW_TASKS_MENTION_USER` | *(empty)* | User ID to @mention in new task threads |
| `DISCOCLAW_TASKS_SIDEBAR` | `1` | When `1` + `MENTION_USER` set, persists @mention in open task starters for sidebar visibility |
| `DISCOCLAW_TASKS_AUTO_TAG` | `1` | Enable AI auto-tagging |
| `DISCOCLAW_TASKS_AUTO_TAG_MODEL` | `fast` | Model tier or concrete name for auto-tagging |
| `DISCOCLAW_TASKS_SYNC_SKIP_PHASE5` | `0` | Disable phase-5 reconciliation during sync |
| `DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_ENABLED` | `1` | Retry a failed Discord sync on the next mutation |
| `DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_DELAY_MS` | `30000` | Delay in ms before retrying a failed sync |
| `DISCOCLAW_TASKS_SYNC_DEFERRED_RETRY_DELAY_MS` | `30000` | Delay in ms for deferred sync retries when Discord is busy |
| `DISCOCLAW_TASKS_PREFIX` | `ws` | Prefix for generated task IDs (e.g. `ws-001`) |

### Short-Term Memory
| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_SHORTTERM_MEMORY_ENABLED` | `1` | Enable ephemeral short-term memory (cross-session recency context) |
| `DISCOCLAW_SHORTTERM_MAX_ENTRIES` | `20` | Max entries kept in the short-term memory store |
| `DISCOCLAW_SHORTTERM_MAX_AGE_HOURS` | `6` | Max age in hours before a short-term entry expires |
| `DISCOCLAW_SHORTTERM_INJECT_MAX_CHARS` | `1000` | Max chars for short-term memory injected into prompts |
| `DISCOCLAW_SHORTTERM_DATA_DIR` | *(empty)* | Override directory for short-term memory storage |
| `DISCOCLAW_SUMMARY_TO_DURABLE_ENABLED` | `1` | Promote significant summary content into durable memory |
| `DISCOCLAW_SUMMARY_DATA_DIR` | *(empty)* | Override directory for rolling summary storage |
| `DISCOCLAW_DURABLE_DATA_DIR` | *(empty)* | Override directory for durable memory storage |

### Reaction Handler
| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_REACTION_HANDLER` | `1` | Enable reaction-add event handler |
| `DISCOCLAW_REACTION_REMOVE_HANDLER` | `0` | Enable reaction-remove event handler |
| `DISCOCLAW_REACTION_MAX_AGE_HOURS` | `24` | Max age in hours of a message that will trigger a reaction event |

### Bot Identity
| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_BOT_NAME` | *(empty)* | Override the bot's display name in Discord |
| `DISCOCLAW_BOT_STATUS` | *(empty — Discord default)* | Presence status: `online`, `idle`, `dnd`, or `invisible` |
| `DISCOCLAW_BOT_ACTIVITY` | *(empty)* | Activity text shown in Discord presence (e.g. `with fire`) |
| `DISCOCLAW_BOT_ACTIVITY_TYPE` | `Playing` | Activity verb: `Playing`, `Listening`, `Watching`, `Competing`, or `Custom` |
| `DISCOCLAW_BOT_AVATAR` | *(empty)* | Absolute file path or URL for the bot's avatar image |

### Health/Status
| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_HEALTH_COMMANDS_ENABLED` | `1` | Enable `!health` command (uptime, memory, runtime status) |
| `DISCOCLAW_HEALTH_VERBOSE_ALLOWLIST` | *(empty — falls back to `DISCORD_ALLOW_USER_IDS`)* | Space/comma-separated user IDs that can request verbose health output |

### Plan & Forge
| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_PLAN_COMMANDS_ENABLED` | `1` | Enable plan commands (`!plan`, `!plan phase`, etc.) |
| `PLAN_PHASES_ENABLED` | `1` | Enable phase-by-phase plan execution |
| `PLAN_PHASE_MAX_CONTEXT_FILES` | `5` | Max `.context/` files injected per plan phase |
| `PLAN_PHASE_TIMEOUT_MS` | `1800000` | Per-phase timeout in milliseconds |
| `PLAN_PHASE_AUDIT_FIX_MAX` | `3` | Max audit-fix attempts per phase before giving up |
| `DISCOCLAW_FORGE_COMMANDS_ENABLED` | `1` | Enable forge commands (`!forge`) |
| `FORGE_MAX_AUDIT_ROUNDS` | `5` | Max audit rounds before forge accepts the draft |
| `FORGE_DRAFTER_MODEL` | *(empty — uses `RUNTIME_MODEL`)* | Override model for the forge drafter step |
| `FORGE_AUDITOR_MODEL` | *(empty — uses `RUNTIME_MODEL`)* | Override model for the forge auditor step |
| `FORGE_TIMEOUT_MS` | `1800000` | Per-forge-session timeout in milliseconds |
| `FORGE_PROGRESS_THROTTLE_MS` | `3000` | Min ms between forge progress Discord updates |
| `FORGE_AUTO_IMPLEMENT` | `1` | Automatically implement the approved forge plan without a separate confirm step |
| `FORGE_DRAFTER_RUNTIME` | *(empty — uses `PRIMARY_RUNTIME`)* | Runtime adapter for the forge drafter (e.g. `openai`, `claude`) |
| `FORGE_AUDITOR_RUNTIME` | *(empty — uses `PRIMARY_RUNTIME`)* | Runtime adapter for the forge auditor |

### Multi-Provider Adapters
| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | *(empty)* | OpenAI API key; required when `PRIMARY_RUNTIME=openai` or `FORGE_*_RUNTIME=openai` |
| `OPENAI_BASE_URL` | *(empty — OpenAI default)* | OpenAI-compatible API base URL override (e.g. for local models) |
| `OPENAI_MODEL` | `gpt-4o` | Default model for the OpenAI adapter |
| `OPENROUTER_API_KEY` | *(empty)* | OpenRouter API key; required when `PRIMARY_RUNTIME=openrouter` |
| `OPENROUTER_BASE_URL` | *(empty — OpenRouter default)* | OpenRouter API base URL override |
| `OPENROUTER_MODEL` | `anthropic/claude-sonnet-4` | Default model for the OpenRouter adapter |
| `GEMINI_BIN` | `gemini` | Path/name of the Gemini CLI binary |
| `GEMINI_MODEL` | `gemini-2.5-pro` | Default model for the Gemini adapter |
| `CODEX_BIN` | `codex` | Path/name of the Codex CLI binary |
| `CODEX_MODEL` | `gpt-5.3-codex` | Default model for the Codex adapter |
| `CODEX_DANGEROUSLY_BYPASS_APPROVALS_AND_SANDBOX` | `0` | Pass the bypass-approvals flag to Codex (use with caution) |
| `CODEX_DISABLE_SESSIONS` | `0` | Disable session persistence for the Codex adapter |

### Webhooks
| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_WEBHOOK_ENABLED` | `0` | Enable the inbound webhook HTTP server |
| `DISCOCLAW_WEBHOOK_PORT` | `9400` | Port for the webhook HTTP server |
| `DISCOCLAW_WEBHOOK_CONFIG` | *(empty)* | Path to webhook route config JSON |

### Streaming & Multi-Turn
| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_MULTI_TURN` | `1` | Enable multi-turn (persistent subprocess) mode |
| `DISCOCLAW_MULTI_TURN_HANG_TIMEOUT_MS` | `60000` | Timeout in ms to detect a hung multi-turn process |
| `DISCOCLAW_MULTI_TURN_IDLE_TIMEOUT_MS` | `300000` | Idle timeout in ms before a multi-turn process is recycled |
| `DISCOCLAW_MULTI_TURN_MAX_PROCESSES` | `5` | Max concurrent multi-turn processes |
| `DISCOCLAW_TOOL_AWARE_STREAMING` | `1` | Parse tool-use events during streaming for better progress reporting |
| `DISCOCLAW_STREAM_STALL_TIMEOUT_MS` | `300000` | Timeout in ms before a stalled stream is aborted |
| `DISCOCLAW_PROGRESS_STALL_TIMEOUT_MS` | `300000` | Timeout in ms before a stalled progress indicator is shown |
| `DISCOCLAW_STREAM_STALL_WARNING_MS` | `150000` | Warn in Discord after this many ms of stream inactivity |
| `DISCOCLAW_MAX_CONCURRENT_INVOCATIONS` | `0` | Max concurrent runtime invocations (0 = unlimited) |

## Debugging

### Where logs go

| Mode | Log destination |
|------|----------------|
| `pnpm dev` | stdout/stderr in your terminal |
| systemd service | journalctl (`journalctl --user -u discoclaw.service`) |

DiscoClaw uses Pino for structured JSON logging. All app logs go to stdout.

### Quick commands

```bash
# Local dev — logs stream to terminal automatically
pnpm dev

# Production — tail live logs
journalctl --user -u discoclaw.service -f

# Production — last 50 lines
journalctl --user -u discoclaw.service -n 50

# Production — logs since last boot
journalctl --user -u discoclaw.service -b

# Production — logs from the last 10 minutes
journalctl --user -u discoclaw.service --since "10 min ago"
```

### Increasing verbosity

Set `LOG_LEVEL` in `.env` to get more detail. Levels: `fatal`, `error`, `warn`, `info`, `debug`, `trace`.

```bash
LOG_LEVEL=debug pnpm dev
```

### Claude CLI debug output

To capture raw Claude CLI stdin/stdout for diagnosing runtime issues:

```bash
# Write CLI debug logs to a file
CLAUDE_DEBUG_FILE=/tmp/claude-debug.log pnpm dev

# Echo raw CLI output into Discord (noisy, useful for live debugging)
CLAUDE_ECHO_STDIO=1 pnpm dev
```

### Startup / env issues

If the bot starts but behaves unexpectedly (wrong model, missing tools, wrong CWD):

```bash
# Dump resolved runtime config at startup
DISCOCLAW_DEBUG_RUNTIME=1 pnpm dev
```

This is especially useful for systemd, where env loading can differ from your shell.

### What to look for

- **Bot not responding:** Check allowlist (`DISCORD_ALLOW_USER_IDS`), channel restrictions (`DISCORD_CHANNEL_IDS`), and channel context requirement (`DISCORD_REQUIRE_CHANNEL_CONTEXT`).
- **Claude CLI errors:** Look for `runtime` or `spawn` in logs. Use `CLAUDE_DEBUG_FILE` to capture full CLI output.
- **Timeout issues:** Look for `timeout` in logs. Adjust `RUNTIME_TIMEOUT_MS` if needed.
- **PID lock conflicts:** Look for `pidlock` in logs. See ops.md for stale lock handling.

## Task Auto-Sync

When the bot is running, task changes trigger Discord sync immediately via in-process events:

- **Startup sync:** On boot, a fire-and-forget full sync runs to catch any drift that occurred while the bot was down.
- **Synchronous events:** The in-process task store emits events on every write (`created`, `updated`, `closed`, `labeled`). Discord sync subscribers handle each event immediately — no file watcher, no debounce, no subprocess spawning.
- **Coordinator:** All sync paths (event-driven, startup, manual `taskSync` action) share a `TaskSyncCoordinator` that prevents concurrent syncs and invalidates the thread cache. Auto-triggered syncs are silent; only manual sync posts to the status channel.

No extra env vars are needed — auto-sync activates whenever `DISCOCLAW_TASKS_ENABLED=1` and a guild is available.

## Smoke Tests

The smoke-test suite validates each configured model tier end-to-end — verifying API keys, tier mappings, system prompts, and binary availability — before real users encounter a broken model path.

It exercises `RuntimeAdapter.invoke()` → `EngineEvent` pipeline with a curated set of prompt categories (basic Q&A, tool use, streaming). Tests are **opt-in** and skipped by default in CI unless `SMOKE_TEST_TIERS` is set.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SMOKE_TEST_TIERS` | *(unset — skips smoke tests)* | Comma-separated list of tier names (`fast`, `capable`) or literal model IDs to test for Claude Code (e.g. `fast,capable` or `claude-haiku-4-5-20251001`) |
| `GEMINI_SMOKE_TEST_TIERS` | *(unset — skips Gemini smoke tests)* | Comma-separated tier names or model IDs for Gemini smoke tests (requires `GEMINI_API_KEY`) |
| `OPENAI_SMOKE_TEST_TIERS` | *(unset — skips OpenAI smoke tests)* | Comma-separated tier names or model IDs for OpenAI smoke tests (requires `OPENAI_API_KEY`) |
| `CODEX_SMOKE_TEST_TIERS` | *(unset — skips Codex smoke tests)* | Comma-separated tier names or model IDs for Codex smoke tests (requires `codex` binary on `PATH`) |
| `SMOKE_TEST_TIMEOUT_MS` | `60000` | Per-invocation timeout for each smoke-test prompt, in milliseconds (applies to all providers) |

### Usage

```bash
# Run Claude Code smoke tests against the fast and capable tiers
SMOKE_TEST_TIERS=fast,capable pnpm test

# Run against a specific Claude model ID
SMOKE_TEST_TIERS=claude-sonnet-4-6 pnpm test

# Run Gemini smoke tests for the fast tier
GEMINI_SMOKE_TEST_TIERS=fast pnpm test

# Run OpenAI smoke tests (requires OPENAI_API_KEY)
OPENAI_SMOKE_TEST_TIERS=fast pnpm test

# Run Codex smoke tests (requires codex binary on PATH)
CODEX_SMOKE_TEST_TIERS=fast pnpm test

# Adjust timeout (e.g. slower network)
SMOKE_TEST_TIERS=fast SMOKE_TEST_TIMEOUT_MS=120000 pnpm test
```

The suite uses your real `.env` — the same config that runs the bot is sufficient. No separate test credentials are needed.

## Notes
- Runtime invocation defaults are configurable via env (`RUNTIME_MODEL`, `RUNTIME_TOOLS`, `RUNTIME_TIMEOUT_MS`).
- If `pnpm dev` fails with "Missing DISCORD_TOKEN", your `.env` isn't loaded or the var is unset.
