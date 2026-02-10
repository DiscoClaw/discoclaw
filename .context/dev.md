# dev.md — Development

## Install / Build / Run

```bash
cd /path/to/discoclaw
pnpm i
pnpm build
pnpm dev
```

## One-Off: Sync Discord Content

```bash
pnpm sync:discord-context
pnpm sync:discord-context -- --rewrite-index
pnpm sync:discord-context -- --add-channel 123456789012345678:my-channel
```

## One-Off: Migrate From Legacy Weston

```bash
pnpm migrate:weston-content -- --dry-run
pnpm migrate:weston-content -- --from ./legacy/weston
pnpm migrate:weston-content -- --overwrite
```

## Environment

Copy `.env.example` -> `.env`. See that file for inline comments.

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
| `DISCOCLAW_CONTENT_DIR` | *(empty)* | Channel-context content dir; defaults to `$DISCOCLAW_DATA_DIR/content` |
| `WORKSPACE_CWD` | `./workspace` | Runtime working directory (overrides the data-dir default) |
| `GROUPS_DIR` | `./groups` | Base directory for per-session working dirs |
| `USE_GROUP_DIR_CWD` | `0` | Enable nanoclaw-style group CWD per session |
| `LOG_LEVEL` | `info` | Pino log level |
| `DISCOCLAW_DEBUG_RUNTIME` | `0` | Dump resolved runtime config at startup (debugging systemd env issues) |

### Runtime Invocation
| Variable | Default | Description |
|----------|---------|-------------|
| `RUNTIME_MODEL` | `opus` | Model name or alias passed to the CLI |
| `RUNTIME_TOOLS` | `Bash,Read,Edit,WebSearch,WebFetch` | Comma-separated tool list |
| `RUNTIME_TIMEOUT_MS` | `600000` | Per-invocation timeout in milliseconds |
| `DISCOCLAW_RUNTIME_SESSIONS` | `1` | Persist Claude session IDs across messages |
| `DISCOCLAW_MESSAGE_HISTORY_BUDGET` | `3000` | Char budget for recent conversation history in prompts (0 = disabled) |
| `DISCOCLAW_SUMMARY_ENABLED` | `1` | Enable rolling conversation summaries (Haiku-generated) |
| `DISCOCLAW_SUMMARY_MODEL` | `haiku` | Model used for summarization |
| `DISCOCLAW_SUMMARY_MAX_CHARS` | `2000` | Max chars for the rolling summary text |
| `DISCOCLAW_SUMMARY_EVERY_N_TURNS` | `5` | Re-summarize every N messages per session |
| `DISCOCLAW_DURABLE_MEMORY_ENABLED` | `1` | Enable durable per-user memory (persistent facts/preferences) |
| `DISCOCLAW_DURABLE_INJECT_MAX_CHARS` | `2000` | Max chars for durable memory injected into prompts |
| `DISCOCLAW_DURABLE_MAX_ITEMS` | `200` | Max durable items per user |
| `DISCOCLAW_MEMORY_COMMANDS_ENABLED` | `1` | Enable `!memory` commands (show/remember/forget/reset) |
| `DISCOCLAW_STATUS_CHANNEL` | *(empty — disabled)* | Channel name or ID for status embeds (bot online/offline, errors) |
| `DISCOCLAW_CRON_ENABLED` | `0` | Master switch for the cron subsystem (forum-based scheduled tasks) |
| `DISCOCLAW_CRON_FORUM` | *(empty)* | Forum channel name or ID for cron definitions |
| `DISCOCLAW_CRON_MODEL` | `haiku` | Model used to parse natural-language cron definitions |

### Beads (Task Tracking)
| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_BEADS_ENABLED` | `0` | Master switch — loads beads module |
| `DISCOCLAW_BEADS_CWD` | `WORKSPACE_CWD` | Working directory for bd CLI |
| `DISCOCLAW_BEADS_FORUM` | *(empty)* | Forum channel name or ID for bead threads |
| `DISCOCLAW_BEADS_TAG_MAP` | `scripts/beads/bead-hooks/tag-map.json` | Path to tag-map.json |
| `DISCOCLAW_BEADS_MENTION_USER` | *(empty)* | User ID to @mention in new bead threads |
| `DISCOCLAW_BEADS_AUTO_TAG` | `1` | Enable Haiku auto-tagging |
| `DISCOCLAW_BEADS_AUTO_TAG_MODEL` | `haiku` | Model for auto-tagging |

## Debugging

### Where logs go

| Mode | Log destination |
|------|----------------|
| `pnpm dev` | stdout/stderr in your terminal |
| systemd service | journalctl (`journalctl --user -u discoclaw.service`) |

Discoclaw uses Pino for structured JSON logging. All app logs go to stdout.

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

## Notes
- Runtime invocation defaults are configurable via env (`RUNTIME_MODEL`, `RUNTIME_TOOLS`, `RUNTIME_TIMEOUT_MS`).
- If `pnpm dev` fails with "Missing DISCORD_TOKEN", your `.env` isn't loaded or the var is unset.
