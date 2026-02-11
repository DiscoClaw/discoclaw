# runtime.md — Runtimes & Adapters

## Runtime Adapter Interface
- The Discord layer consumes a provider-agnostic event stream (`EngineEvent`).
- Each runtime adapter implements `RuntimeAdapter.invoke()` and declares capabilities.

See: `src/runtime/types.ts`

## Claude Code CLI Runtime (Current)
- Adapter: `src/runtime/claude-code-cli.ts`
- Invocation shape (full):
  ```
  claude -p --model <id|alias>
    [--dangerously-skip-permissions]          # when CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=1
    [--strict-mcp-config]                     # when CLAUDE_STRICT_MCP_CONFIG=1
    [--debug-file <path>]                     # when CLAUDE_DEBUG_FILE is set
    [--session-id <uuid>]                     # when sessions are enabled
    [--add-dir <dir> ...]                     # group CWD mode
    [--output-format text|stream-json]        # always passed
    [--include-partial-messages]              # when format is stream-json
    [--tools <comma-list>]                    # configurable tool surface
    -- <prompt>                               # POSIX terminator before prompt
  ```
- The `--` terminator prevents variadic flags (e.g. `--tools`, `--add-dir`) from consuming the positional prompt argument.
- Output modes:
  - `CLAUDE_OUTPUT_FORMAT=stream-json` (preferred; Discoclaw parses JSONL and streams text)
  - `CLAUDE_OUTPUT_FORMAT=text` (fallback if your local CLI doesn't support stream-json)

## Tool Surface
- Today Discoclaw passes a basic tool list and relies on `--dangerously-skip-permissions` in production.
- If/when we add OpenAI/Gemini adapters:
  - Start with **analysis-only** routes (no tools).
  - Add a tool layer only if we explicitly decide we need full parity.

## Per-Workspace Permissions
- `workspace/PERMISSIONS.json` controls the tool surface per workspace.
- Loaded per-invocation from `src/workspace-permissions.ts`.
- If the file doesn't exist, falls back to the `RUNTIME_TOOLS` env var (fully backward compatible).

Tiers:
| Tier | Tools |
|------|-------|
| `readonly` | `Read, WebSearch, WebFetch` |
| `standard` | `Read, Edit, WebSearch, WebFetch` |
| `full` | `Bash, Read, Edit, WebSearch, WebFetch` |
| `custom` | User-specified `tools` array in the JSON |

Example: `{ "tier": "standard", "note": "Never modify files outside workspace." }`

The optional `note` field is injected into the prompt as a soft behavioral constraint.
Custom tier example: `{ "tier": "custom", "tools": ["Read", "Edit", "Bash"] }`

## Session Scanning & Tool-Aware Streaming

Two opt-in features for better Discord UX during tool-heavy invocations:

| Env Var | Default | Purpose |
|---------|---------|---------|
| `DISCOCLAW_SESSION_SCANNING` | `0` | Tail Claude Code's JSONL session log to emit `tool_start`/`tool_end` events |
| `DISCOCLAW_TOOL_AWARE_STREAMING` | `0` | Buffer text during tool execution, show activity indicators, stream final answer cleanly |

Both require `CLAUDE_OUTPUT_FORMAT=stream-json` for structured events.

- **Session scanner** (`src/runtime/session-scanner.ts`): watches `~/.claude/projects/<escaped-cwd>/<session-id>.jsonl`, skips pre-existing content, degrades gracefully if the file never appears.
- **Tool-aware queue** (`src/discord/tool-aware-queue.ts`): state machine that suppresses narration text before tools, shows human-readable activity labels (from `src/runtime/tool-labels.ts`), and streams the final answer after all tool use completes.
- **Tool labels** (`src/runtime/tool-labels.ts`): maps tool names to labels like "Reading .../file.ts", "Running command...", etc.

## Multi-Turn (Long-Running Process)

Opt-in feature that keeps a long-running Claude Code subprocess alive per Discord session key using `--input-format stream-json`. Follow-up messages are pushed to the same process via stdin NDJSON, giving Claude Code native multi-turn context (tool results, file reads, edits persist across turns).

| Env Var | Default | Purpose |
|---------|---------|---------|
| `DISCOCLAW_MULTI_TURN` | `1` | Enable long-running process pool |
| `DISCOCLAW_MULTI_TURN_HANG_TIMEOUT_MS` | `60000` | Kill process if no stdout output for this long |
| `DISCOCLAW_MULTI_TURN_IDLE_TIMEOUT_MS` | `300000` | Kill idle process after 5 min of no messages |
| `DISCOCLAW_MULTI_TURN_MAX_PROCESSES` | `5` | Max concurrent long-running processes |

Key files:
- **Long-running process** (`src/runtime/long-running-process.ts`): manages a single subprocess with state machine (`idle` -> `busy` -> `idle` or `dead`), hang detection, idle timeout.
- **Process pool** (`src/runtime/process-pool.ts`): pool of `LongRunningProcess` instances keyed by session key, with LRU eviction.

Behavior:
- When enabled, `invoke()` tries the long-running process first for any call with a `sessionKey`.
- On hang detection or process crash, automatically falls back to the existing one-shot mode (unchanged).
- On shutdown, `killActiveSubprocesses()` cleans up the pool.

Known limitations:
- GitHub issue #3187 reports that multi-turn stdin can hang after the first message. Mitigated by automatic hang detection + fallback.
- Prompt construction is unchanged (full context sent every turn). Optimizing to skip redundant context is a follow-up.

## Image Pipeline

Any `image` content block in Claude Code's stream-json output is automatically captured and delivered as a Discord file attachment. Claude models don't natively generate images — images only appear when an MCP tool returns image content blocks.

### How it works

1. **Extraction** — `extractImageFromUnknownEvent()` in `claude-code-cli.ts` recognizes direct `{ type: 'image', source: { type: 'base64', media_type, data } }` blocks and `content_block_start` wrappers. `extractResultContentBlocks()` handles result events containing mixed text + image arrays.
2. **Dedup** — `imageDedupeKey()` builds a key from media type + base64 length + 64-char prefix. Each consumer tracks a `Set<string>` of seen keys so duplicates (common with multi-turn mirrors) are dropped.
3. **Delivery** — `buildAttachments()` in `output-common.ts` converts each `ImageData` to a Discord `AttachmentBuilder` (named `image-1.png`, etc.). The three consumer paths — message (`discord.ts`), reaction (`reaction-handler.ts`), and cron (`executor.ts`) — all collect images into an `ImageData[]` during streaming and pass them to the shared send helpers.

### Key files

| File | Role |
|------|------|
| `src/runtime/types.ts` | `ImageData` type, `image_data` EngineEvent variant |
| `src/runtime/claude-code-cli.ts` | Extraction, dedup key, per-invocation image counting |
| `src/runtime/long-running-process.ts` | Multi-turn mirror: dedup + emit for long-running sessions |
| `src/discord/output-common.ts` | `buildAttachments()`, attachment slicing across message chunks |
| `src/discord.ts` | Message path consumer |
| `src/discord/reaction-handler.ts` | Reaction path consumer |
| `src/cron/executor.ts` | Cron path consumer |

### Limits

| Limit | Value | Source |
|-------|-------|--------|
| Max base64 size per image | 25 MB | `MAX_IMAGE_BASE64_LEN` |
| Max images per invocation | 10 | `MAX_IMAGES_PER_INVOCATION` |
| Max attachments per Discord message | 10 | Discord API limit |

### Enabling image generation

Since Claude can't generate images directly, you need an MCP server that wraps an external image API (DALL-E, Replicate, Stability, etc.).

1. **Set up an MCP server** that exposes a tool (e.g. `generate_image`) returning an `image` content block with `{ type: 'base64', media_type, data }`. Any MCP server that returns image content blocks will work — the pipeline is format-driven, not tool-name-driven.
2. **Register it** in the workspace `.mcp.json` so Claude Code loads it on invocation.
3. **Add workspace instructions** (in `workspace/SOUL.md` or system prompt) telling the bot it can generate images and when to use the tool.

The rest is automatic: the runtime adapter extracts the image blocks, deduplicates them, and the Discord layer attaches them to the reply.
