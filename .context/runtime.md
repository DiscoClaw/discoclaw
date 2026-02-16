# runtime.md — Runtimes & Adapters

## Runtime Adapter Interface
- The orchestrator consumes a provider-agnostic event stream (`EngineEvent`) from any adapter.
- Each runtime adapter implements `RuntimeAdapter.invoke()` and declares capabilities.
- The orchestrator routes to adapters based on context: message handling, forge drafting/auditing, cron execution.

See: `src/runtime/types.ts`

## Claude Code CLI Runtime (Current)
- Adapter: `src/runtime/claude-code-cli.ts`
- Invocation shape (full):
  ```
  claude -p --model <id|alias>
    [--dangerously-skip-permissions]          # when CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=1
    [--strict-mcp-config]                     # when CLAUDE_STRICT_MCP_CONFIG=1
    [--fallback-model <alias>]               # when RUNTIME_FALLBACK_MODEL is set
    [--max-budget-usd <number>]              # when RUNTIME_MAX_BUDGET_USD is set
    [--append-system-prompt <text>]          # when CLAUDE_APPEND_SYSTEM_PROMPT is set
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
  - `CLAUDE_OUTPUT_FORMAT=stream-json` (preferred; DiscoClaw parses JSONL and streams text)
  - `CLAUDE_OUTPUT_FORMAT=text` (fallback if your local CLI doesn't support stream-json)

## Tool Surface
- Default tools: `Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch` (8 tools).
- `Glob` + `Grep` are purpose-built for file search — faster than `find`/`grep` via Bash.
- `Write` enables proper file creation (previously required Bash echo/cat workarounds).
- Non-Claude adapters use a **capability gate** (`tools_fs`) to determine tool access:
  - Codex CLI adapter: declares `tools_fs` — receives read-only tools (Read, Glob, Grep) in auditor role.
  - OpenAI HTTP adapter: text-only (`streaming_text` only) — no tool execution.
  - Future adapters (Gemini, etc.): declare capabilities as appropriate.

## Per-Workspace Permissions
- `workspace/PERMISSIONS.json` controls the tool surface per workspace.
- Loaded per-invocation from `src/workspace-permissions.ts`.
- If the file doesn't exist, falls back to the `RUNTIME_TOOLS` env var (fully backward compatible).

Tiers:
| Tier | Tools |
|------|-------|
| `readonly` | `Read, Glob, Grep, WebSearch, WebFetch` |
| `standard` | `Read, Edit, Glob, Grep, WebSearch, WebFetch` |
| `full` | `Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch` |
| `custom` | User-specified `tools` array in the JSON |

Note: `Write` is excluded from `standard` tier (non-destructive). Included in `full` alongside Bash.

Example: `{ "tier": "standard", "note": "Never modify files outside workspace." }`

The optional `note` field is injected into the prompt as a soft behavioral constraint.
Custom tier example: `{ "tier": "custom", "tools": ["Read", "Edit", "Bash"] }`

## Streaming & Reply Pacing (Discord)

Key settings for block streaming:
- `blockStreaming: true` — chunks output so user sees progress instead of silence then wall of text
- `blockStreamingCoalesce: {minChars:100, maxChars:600, idleMs:800}` — merges tiny fragments; 800ms idle = natural paragraph breaks
- `blockStreamingBreak: text_end` — flushes after each text block (between paragraphs, before/after tool calls)
- `toolStatusUpdates: true` — shows "Running tool..." during tool calls
- `reasoningStreaming: false` — reasoning tokens stay hidden for casual use

Tuning: too chattery? increase `minChars` or `idleMs`. Too slow? decrease `maxChars` or `idleMs`.

## Stream Stall Detection

Two-layer protection against hung Claude Code processes:

| Env Var | Default | Purpose |
|---------|---------|---------|
| `DISCOCLAW_STREAM_STALL_TIMEOUT_MS` | `120000` | Kill one-shot process if no stdout/stderr for this long. `0` disables. |
| `DISCOCLAW_STREAM_STALL_WARNING_MS` | `60000` | Show user-visible warning in Discord after this many ms of no events. `0` disables. |

**Runtime layer** (`src/runtime/claude-code-cli.ts`): resets a timer on every stdout/stderr `data` event. On timeout, emits a `stream stall: no output for ${ms}ms` error and kills the process. Applies to both `text` and `stream-json` output formats.

**Discord layer** (`src/discord.ts`, `src/discord/reaction-handler.ts`): both message and reaction handlers track `lastEventAt` and `activeToolCount` in their streaming loops. When stall threshold is exceeded and no tools are active, appends a warning to `deltaText`. Enable `DISCOCLAW_SESSION_SCANNING=1` for tool-aware stall suppression (warnings suppressed during tool execution).

## Session Scanning & Tool-Aware Streaming

Two opt-in features for better Discord UX during tool-heavy invocations:

| Env Var | Default | Purpose |
|---------|---------|---------|
| `DISCOCLAW_SESSION_SCANNING` | `0` | Tail Claude Code's JSONL session log to emit `tool_start`/`tool_end` events |
| `DISCOCLAW_TOOL_AWARE_STREAMING` | `0` | Buffer text during tool execution, show activity indicators, stream final answer cleanly |

Both require `CLAUDE_OUTPUT_FORMAT=stream-json` for structured events.

## Resilience & Cost Controls

| Env Var | Default | Purpose |
|---------|---------|---------|
| `RUNTIME_FALLBACK_MODEL` | *(unset)* | Auto-fallback model when primary is overloaded (e.g. `sonnet`) |
| `RUNTIME_MAX_BUDGET_USD` | *(unset)* | Max USD per CLI process. One-shot = per invocation. Multi-turn = per session lifetime |
| `CLAUDE_APPEND_SYSTEM_PROMPT` | *(unset)* | Append text to Claude's system prompt (max 4000 chars) |

**Budget semantics:** For multi-turn sessions, budget accumulates across turns and cannot be reset mid-session. Recommend $5-10 for multi-turn.

**Append system prompt:** When set, workspace PA files (SOUL.md, IDENTITY.md, USER.md, TOOLS.md) are skipped from the context file list (their content is already in the system prompt). PA context modules (`.context/pa.md`, `.context/pa-safety.md`) and channel-specific context are unaffected. **Note:** Do not set this on first run before `workspace/BOOTSTRAP.md` has been consumed — the skip logic also bypasses BOOTSTRAP.md loading.

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

## Image Input (Discord → Claude)

When a Discord message or reaction target has image attachments (PNG, JPEG, WebP, GIF), they are downloaded and sent to Claude Code as base64-encoded image content blocks via `--input-format stream-json` stdin.

### How it works

1. **Filtering** — `resolveMediaType()` checks the attachment's `contentType` (lowercased) or falls back to file extension. Non-image attachments are surfaced as plain URLs in the prompt text.
2. **Validation** — Host allowlist (`cdn.discordapp.com`, `media.discordapp.net`), HTTPS-only, redirect rejection (`redirect: 'error'`), per-image and total size caps.
3. **Download** — `downloadAttachment()` fetches the image with a 10 s timeout, post-checks actual size, and returns base64.
4. **Delivery** — The runtime adapter writes a `stream-json` stdin message containing `[{ type: 'text', text: prompt }, { type: 'image', source: { type: 'base64', ... } }, ...]`. When images are present, `--output-format` is forced to `stream-json` regardless of the configured format.

### Security controls

| Control | Detail |
|---------|--------|
| Host allowlist | Only Discord CDN hosts are permitted (SSRF protection) |
| HTTPS only | HTTP URLs are rejected |
| Redirect rejection | `fetch()` uses `redirect: 'error'` — no following redirects to internal hosts |
| Per-image size cap | 20 MB (`MAX_IMAGE_BYTES`), checked from metadata pre-download and from buffer post-download |
| Total size cap | 50 MB across all images in one message (`MAX_TOTAL_BYTES`) |
| Per-invocation cap | 10 images (`MAX_IMAGES_PER_INVOCATION`) |
| Download timeout | 10 s per image (`DOWNLOAD_TIMEOUT_MS`) |
| Filename sanitization | Control chars stripped, truncated to 100 chars in error messages |

### Key files

| File | Role |
|------|------|
| `src/discord/image-download.ts` | Download, validate, base64-encode Discord attachments |
| `src/runtime/claude-code-cli.ts` | Stdin pipe construction, `effectiveOutputFormat` override |
| `src/discord.ts` | Message handler: download images, pass to runtime, images only on initial turn |
| `src/discord/reaction-handler.ts` | Reaction handler: same download flow, also surfaces non-image attachment URLs |

### Follow-up depth gating

Images are only sent on the initial invocation (`followUpDepth === 0`). Auto-follow-up turns (triggered by query actions) are text-only — re-downloading images would waste time and bandwidth.

## Image Output (Claude → Discord)

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
