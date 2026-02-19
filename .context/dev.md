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

Run `pnpm setup` for guided configuration, or copy `.env.example` -> `.env` for essentials only. For all ~90 options, use `.env.example.full`. See those files for inline comments.

### Discord
| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_TOKEN` | **(required)** | Bot token |
| `DISCORD_ALLOW_USER_IDS` | **(required)** | Comma/space-separated Discord user IDs; fail-closed if empty |
| `DISCORD_CHANNEL_IDS` | *(empty — all channels)* | Restrict the bot to specific guild channel IDs (DMs still allowed) |
| `DISCORD_REQUIRE_CHANNEL_CONTEXT` | `1` | Require a per-channel context file before responding |
| `DISCORD_AUTO_INDEX_CHANNEL_CONTEXT` | `1` | Auto-create stub context files for new channels |
| `DISCORD_AUTO_JOIN_THREADS` | `0` | Best-effort auto-join threads so the bot can respond inside them |
| `DISCOCLAW_DISCORD_ACTIONS` | `0` | Master switch for Discord server actions |
| `DISCOCLAW_DISCORD_ACTIONS_CHANNELS` | `1` | Channel management (create/edit/delete/list/info, categoryCreate) |
| `DISCOCLAW_DISCORD_ACTIONS_MESSAGING` | `0` | Messaging (send/edit/delete/read messages, react, threads, pins) |
| `DISCOCLAW_DISCORD_ACTIONS_GUILD` | `0` | Guild info (memberInfo, roleInfo, roleAdd/Remove, events, search) |
| `DISCOCLAW_DISCORD_ACTIONS_MODERATION` | `0` | Moderation (timeout, kick, ban) |
| `DISCOCLAW_DISCORD_ACTIONS_POLLS` | `0` | Poll creation |
| `DISCOCLAW_DISCORD_ACTIONS_BEADS` | `0` | Bead task tracking (create/update/close/show/list/sync) |

### Claude CLI
| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_BIN` | `claude` | Path/name of the Claude CLI binary |
| `CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS` | `0` | Pass `--dangerously-skip-permissions` to the CLI |
| `CLAUDE_OUTPUT_FORMAT` | `text` | `text` or `stream-json` (preferred for smoother streaming) |
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
| `RUNTIME_MODEL` | `capable` | Model tier (`fast`, `capable`) or concrete model name passed to the CLI |
| `RUNTIME_TOOLS` | `Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch` | Comma-separated tool list |
| `RUNTIME_TIMEOUT_MS` | `600000` | Per-invocation timeout in milliseconds |
| `DISCOCLAW_RUNTIME_SESSIONS` | `1` | Persist Claude session IDs across messages |
| `DISCOCLAW_MESSAGE_HISTORY_BUDGET` | `3000` | Char budget for recent conversation history in prompts (0 = disabled) |
| `DISCOCLAW_SUMMARY_ENABLED` | `1` | Enable rolling conversation summaries |
| `DISCOCLAW_SUMMARY_MODEL` | `fast` | Model tier or concrete name for summarization |
| `DISCOCLAW_SUMMARY_MAX_CHARS` | `2000` | Max chars for the rolling summary text |
| `DISCOCLAW_SUMMARY_EVERY_N_TURNS` | `5` | Re-summarize every N messages per session |
| `DISCOCLAW_DURABLE_MEMORY_ENABLED` | `1` | Enable durable per-user memory (persistent facts/preferences) |
| `DISCOCLAW_DURABLE_INJECT_MAX_CHARS` | `2000` | Max chars for durable memory injected into prompts |
| `DISCOCLAW_DURABLE_MAX_ITEMS` | `200` | Max durable items per user |
| `DISCOCLAW_MEMORY_COMMANDS_ENABLED` | `1` | Enable `!memory` commands (show/remember/forget/reset) |
| `DISCOCLAW_STATUS_CHANNEL` | *(empty — disabled)* | Channel name or ID for status embeds (bot online/offline, errors) |
| `RUNTIME_FALLBACK_MODEL` | *(unset)* | Auto-fallback model when primary is overloaded (e.g. `sonnet`) |
| `RUNTIME_MAX_BUDGET_USD` | *(unset)* | Max USD per CLI process; one-shot = per invocation, multi-turn = per session lifetime |
| `CLAUDE_APPEND_SYSTEM_PROMPT` | *(unset)* | Append to system prompt (max 4000 chars); skips workspace PA file reads when set |
| `DISCOCLAW_CRON_ENABLED` | `1` | Master switch for the cron subsystem (forum-based scheduled tasks) |
| `DISCOCLAW_CRON_FORUM` | **(required when enabled)** | Forum channel ID (snowflake) for cron definitions |
| `DISCOCLAW_CRON_MODEL` | `fast` | Model tier or concrete name for parsing cron definitions |

### Browser Automation
| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_BROWSER_EXECUTABLE_PATH` | *(empty)* | Path to the browser binary for `agent-browser` (e.g. Chromium). If unset, agent-browser uses its bundled default. |

### Beads (Task Tracking)
| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_BEADS_ENABLED` | `1` | Master switch — loads beads module |
| `BD_BIN` | `bd` | Path to the `bd` CLI binary |
| `DISCOCLAW_BEADS_CWD` | `WORKSPACE_CWD` | Working directory for bd CLI |
| `DISCOCLAW_BEADS_FORUM` | **(required when enabled)** | Forum channel ID (snowflake) for bead threads |
| `DISCOCLAW_BEADS_TAG_MAP` | `scripts/beads/bead-hooks/tag-map.json` | Path to tag-map.json |
| `DISCOCLAW_BEADS_MENTION_USER` | *(empty)* | User ID to @mention in new bead threads |
| `DISCOCLAW_BEADS_SIDEBAR` | `0` | When `1` + `MENTION_USER` set, persists @mention in open bead starters for sidebar visibility |
| `DISCOCLAW_BEADS_AUTO_TAG` | `1` | Enable AI auto-tagging |
| `DISCOCLAW_BEADS_AUTO_TAG_MODEL` | `fast` | Model tier or concrete name for auto-tagging |

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

## Bead Auto-Sync

When the bot is running, external bead changes are detected automatically:

- **Startup sync:** On boot, a fire-and-forget full sync runs to catch any drift that occurred while the bot was down.
- **File watcher:** Watches `.beads/last-touched` for changes. When `bd` CLI modifies beads from a terminal or another Claude Code session, the watcher triggers a sync after a 2s debounce. Uses `fs.watch` with a stat-polling fallback.
- **Coordinator:** All sync paths (watcher, startup, manual `beadSync` action) share a `BeadSyncCoordinator` that prevents concurrent syncs and invalidates the bead thread cache. Auto-triggered syncs are silent; only manual `beadSync` posts to the status channel.

No extra env vars are needed — auto-sync activates whenever `DISCOCLAW_BEADS_ENABLED=1` and a guild is available.

## Bead Close Sync (Claude Code Hook)

When `bd close` is run from a Claude Code session, a PostToolUse hook syncs the Discord forum thread immediately (archives it with a close message). This is faster than waiting for the file watcher's 2s debounce, but both paths are idempotent.

**How it works:** `.claude/hooks/bead-close-sync.sh` detects successful `bd close` commands, verifies the bead is actually closed, then calls `scripts/beads/bead-hooks/on-close.sh` which delegates to the TS implementation.

**Setup** (`.claude/settings.local.json` is gitignored — add this on each machine):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash .claude/hooks/bead-close-sync.sh",
            "timeout": 30000
          }
        ]
      }
    ]
  }
}
```

**Required env vars in `.env`:** `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `DISCOCLAW_BEADS_FORUM`.

The hook is idempotent — if the thread is already closed (e.g. bot already synced it), it's a no-op.

## Smoke Tests

The smoke-test suite validates each configured model tier end-to-end — verifying API keys, tier mappings, system prompts, and binary availability — before real users encounter a broken model path.

It exercises `RuntimeAdapter.invoke()` → `EngineEvent` pipeline with a curated set of prompt categories (basic Q&A, tool use, streaming). Tests are **opt-in** and skipped by default in CI unless `SMOKE_TEST_TIERS` is set.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SMOKE_TEST_TIERS` | *(unset — skips smoke tests)* | Comma-separated list of tier names (`fast`, `capable`) or literal model IDs to test (e.g. `fast,capable` or `claude-haiku-4-5-20251001`) |
| `SMOKE_TEST_TIMEOUT_MS` | `60000` | Per-invocation timeout for each smoke-test prompt, in milliseconds |

### Usage

```bash
# Run smoke tests against the fast and capable tiers
SMOKE_TEST_TIERS=fast,capable pnpm test

# Run against a specific model ID
SMOKE_TEST_TIERS=claude-sonnet-4-6 pnpm test

# Adjust timeout (e.g. slower network)
SMOKE_TEST_TIERS=fast SMOKE_TEST_TIMEOUT_MS=120000 pnpm test
```

The suite uses your real `.env` — the same config that runs the bot is sufficient. No separate test credentials are needed.

## Notes
- Runtime invocation defaults are configurable via env (`RUNTIME_MODEL`, `RUNTIME_TOOLS`, `RUNTIME_TIMEOUT_MS`).
- If `pnpm dev` fails with "Missing DISCORD_TOKEN", your `.env` isn't loaded or the var is unset.
