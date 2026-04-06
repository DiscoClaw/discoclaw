# Official Documentation Index

Maintainer-facing index of primary documentation for DiscoClaw integrations. Use this before changing integration code, model IDs, API parameters, dependency behavior, auth flows, or provider-specific feature flags.

Completeness pass for this index was cross-checked against:

- `package.json`
- `.context/runtime.md`
- `src/voice/audio-pipeline.ts`
- `src/voice/providers/gemini-live-provider.ts`
- `src/cold-storage/embeddings.ts`
- `src/cold-storage/openai-compat.ts`
- `src/discord/actions-imagegen.ts`

## How to use this index

- Consult these links before changing integration code, model names, request bodies, headers, URL paths, SDK behavior, or provider feature toggles.
- Prefer official docs, API references, package homepages, and maintainer-owned repos over blog posts, forum answers, or memory.
- If a package does not have a dedicated docs site, treat the maintainer-owned repository and README as the authoritative source.
- `.context/runtime.md` remains the short runtime reminder. This file is the longer source-of-truth index for official references.

## AI Model Providers

| Provider | What DiscoClaw uses | Official docs |
|----------|----------------------|---------------|
| Anthropic | Claude model families via `src/runtime/anthropic-rest.ts` and Claude Code CLI runtime | Models overview: <https://docs.anthropic.com/en/docs/about-claude/models/overview><br>Messages API: <https://platform.claude.com/docs/en/api/messages><br>Claude Code docs: <https://code.claude.com/docs/en/overview> |
| OpenAI | OpenAI-compatible runtime, Codex runtime docs, embeddings, and image generation | Model IDs: <https://developers.openai.com/api/model-ids/><br>API reference overview: <https://platform.openai.com/docs/api-reference><br>Codex docs: <https://developers.openai.com/codex/><br>Codex app-server API: <https://developers.openai.com/codex/app-server> |
| Google | Gemini API runtime, Gemini Live voice, and Gemini/Imagen image generation | Gemini models: <https://ai.google.dev/models/gemini><br>Gemini API docs: <https://ai.google.dev/gemini-api/docs><br>Gemini Live API: <https://ai.google.dev/gemini-api/docs/live> |
| OpenRouter | OpenRouter runtime through `src/runtime/openai-compat.ts` | Model list: <https://openrouter.ai/models><br>API docs: <https://openrouter.ai/docs/api/reference/overview> |

## Discord

| Surface | What DiscoClaw uses | Official docs |
|---------|----------------------|---------------|
| Discord Developer Portal | App/bot setup, intents, OAuth, tokens | <https://discord.com/developers/applications> |
| Discord API docs | Platform behavior beyond SDK wrappers | <https://docs.discord.com/developers/intro> |
| discord.js guide | Discord bot patterns and library usage | <https://discordjs.guide> |
| discord.js API docs | `discord.js` production dependency | <https://discord.js.org/docs/packages/discord.js/main> |
| `@discordjs/voice` | Voice gateway, connection, player, and receiver APIs used by `src/voice/connection-manager.ts`, `src/voice/audio-pipeline.ts`, `src/voice/audio-receiver.ts`, and `src/voice/voice-responder.ts` | Package docs: <https://discord.js.org/docs/packages/voice/stable><br>Maintainer source: <https://github.com/discordjs/discord.js/tree/main/packages/voice><br>npm package: <https://www.npmjs.com/package/@discordjs/voice> |
| `@discordjs/opus` | Native Opus encoder/decoder addon used by `src/voice/opus.ts` and required by the Discord voice stack | Maintainer repo + README: <https://github.com/discordjs/opus><br>Releases: <https://github.com/discordjs/opus/releases><br>npm package: <https://www.npmjs.com/package/@discordjs/opus> |
| Discord Voice E2EE (DAVE protocol) | End-to-end voice encryption surface underlying DiscoClaw's Discord voice receive path and `@snazzah/davey` dependency | Discord voice docs: <https://discord.com/developers/docs/topics/voice-connections#endtoend-encryption-dave-protocol><br>Protocol site: <https://daveprotocol.com/><br>Discord maintainer repo (`libdave`): <https://github.com/discord/libdave> |

## MCP (Model Context Protocol)

| Surface | What DiscoClaw uses | Official docs |
|---------|----------------------|---------------|
| MCP specification | Protocol semantics and transport rules | <https://modelcontextprotocol.io/specification/2025-06-18> |
| `@modelcontextprotocol` GitHub org | Official SDKs and server implementations | <https://github.com/modelcontextprotocol> |
| Servers repo | Maintainer-owned server implementations | <https://github.com/modelcontextprotocol/servers> |
| Filesystem server example | Matches the scaffold in `templates/mcp.json` | <https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem> |

## Voice/Audio Providers

| Provider | Used in DiscoClaw | Official docs |
|----------|-------------------|---------------|
| Gemini Live | `src/voice/audio-pipeline.ts` and the Gemini Live provider handle speech recognition, reasoning, and speech synthesis in one session | Live API overview: <https://ai.google.dev/gemini-api/docs/live><br>Realtime guide: <https://ai.google.dev/gemini-api/docs/live-guide> |
| Anthropic Messages API (optional voice runtime) | `!models set voice claude-api` can switch voice response generation to direct Anthropic API calls while Discord audio transport stays on Gemini Live | API overview: <https://docs.anthropic.com/en/api/messages> |

## Image Generation

| Surface / model family | Used in DiscoClaw | Official docs |
|------------------------|-------------------|---------------|
| OpenAI Images API | `src/discord/actions-imagegen.ts` posts to `/images/generations` for OpenAI-backed image generation | API reference: <https://platform.openai.com/docs/api-reference/images/create> |
| OpenAI GPT Image family | `src/discord/actions-imagegen.ts` accepts `gpt-image-*` model IDs (currently `gpt-image-1`) | Image generation guide: <https://platform.openai.com/docs/guides/image-generation><br>Models overview: <https://platform.openai.com/docs/models> |
| OpenAI DALL-E family | `src/discord/actions-imagegen.ts` accepts `dall-e-*` model IDs (currently defaulting to `dall-e-3`) | Image generation guide: <https://platform.openai.com/docs/guides/image-generation><br>Images API reference: <https://platform.openai.com/docs/api-reference/images/create> |
| Google Gemini native image generation | `src/discord/actions-imagegen.ts` calls `:generateContent` for `gemini-*` image-output models such as `gemini-3.1-flash-image-preview` | Gemini image generation guide: <https://ai.google.dev/gemini-api/docs/image-generation><br>Gemini model docs: <https://ai.google.dev/gemini-api/docs/models> |
| Google Imagen family | `src/discord/actions-imagegen.ts` calls `:predict` for `imagen-*` models such as `imagen-4.0-generate-001` | Imagen docs: <https://ai.google.dev/gemini-api/docs/imagen><br>Gemini image generation guide: <https://ai.google.dev/gemini-api/docs/image-generation> |

## Embedding Providers

| Provider | Used in DiscoClaw | Official docs |
|----------|-------------------|---------------|
| OpenAI Embeddings API | `src/cold-storage/embeddings.ts` defaulting to `text-embedding-3-small` | Embeddings API reference: <https://platform.openai.com/docs/api-reference/embeddings/create> |
| Ollama (OpenAI-compatible) | Supported through `src/cold-storage/openai-compat.ts` | OpenAI compatibility: <https://ollama.com/blog/openai-compatibility><br>API docs: <https://github.com/ollama/ollama/blob/main/docs/api.md> |
| vLLM (OpenAI-compatible) | Supported through `src/cold-storage/openai-compat.ts` | OpenAI-compatible server docs: <https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html> |
| LM Studio (OpenAI-compatible) | Supported through `src/cold-storage/openai-compat.ts` | OpenAI compatibility docs: <https://lmstudio.ai/docs/developer/openai-compat> |
| Together (OpenAI-compatible / embeddings) | Supported through `src/cold-storage/openai-compat.ts` | Embeddings docs: <https://docs.together.ai/docs/embeddings-overview><br>API reference: <https://docs.together.ai/reference> |

## Core Dependencies

Production dependencies from `package.json` are split across sections:

- Discord packages are covered in the Discord section above.
- The remaining shipped production dependencies are indexed here.

| Dependency | Purpose in DiscoClaw | Official docs / repo |
|------------|----------------------|----------------------|
| `better-sqlite3` | Native SQLite binding for local state and cold-storage persistence | <https://github.com/WiseLibs/better-sqlite3> |
| `sqlite-vec` | SQLite vector extension used for embedding search | <https://alexgarcia.xyz/sqlite-vec/> |
| `croner` | Cron parsing and scheduling for automations | <https://croner.56k.guru> |
| `execa` | Subprocess execution for runtime CLIs and helper commands | <https://github.com/sindresorhus/execa> |
| `pino` | Structured logging | <https://getpino.io> |
| `sharp` | Image transformation pipeline | <https://sharp.pixelplumbing.com> |
| `dotenv` | `.env` loading at process startup | <https://github.com/motdotla/dotenv> |
| `ws` | WebSocket client support used by voice integrations | <https://github.com/websockets/ws> |
| `sodium-native` | Native libsodium binding used by Discord voice encryption stack | <https://github.com/holepunchto/sodium-native> |
| `prism-media` | Audio demuxing/transcoding helpers for the voice pipeline | <https://github.com/hydrabolt/prism-media> |
| `youtube-transcript-plus` | Transcript retrieval for YouTube URL ingestion | <https://github.com/ericmmartin/youtube-transcript-plus> |
| `@snazzah/davey` | Node DAVE protocol implementation used by the Discord voice stack | npm package: <https://www.npmjs.com/package/@snazzah/davey><br>Maintainer repo + README: <https://github.com/Snazzah/davey><br>Node usage README: <https://github.com/Snazzah/davey/blob/master/davey-node/README.md><br>Usage docs: <https://github.com/Snazzah/davey/blob/master/docs/USAGE.md><br>Type definitions: <https://github.com/Snazzah/davey/blob/master/index.d.ts> |

## Dev Toolchain

| Tool | Purpose | Official docs / repo |
|------|---------|----------------------|
| TypeScript | Compiler and typechecker (`pnpm build`) | <https://www.typescriptlang.org/> |
| Vitest | Test runner (`pnpm test`) | <https://vitest.dev> |
| `tsx` | TypeScript execution for scripts and local entrypoints | <https://tsx.is> |
| pnpm | Package manager and script runner | <https://pnpm.io> |
| `simple-git-hooks` | Local pre-push hook wiring | <https://github.com/toplenboren/simple-git-hooks> |

## Infrastructure

| Surface | Why it matters | Official docs |
|---------|----------------|---------------|
| systemd user services | DiscoClaw ships a user service in `systemd/discoclaw.service` | `systemd.service`: <https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html><br>`systemd.unit`: <https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html> |
| Tailscale Funnel | External webhook/dashboard publishing and exposure guidance referenced from `docs/webhook-exposure.md` and `docs/dashboard-tailscale.md` | Funnel docs: <https://tailscale.com/docs/features/tailscale-funnel><br>Tailscale Serve/Funnel overview: <https://tailscale.com/docs/features/tailscale-serve> |

## Operational Hardening — Top 5 Context Modules

Cross-reference of exact commands, known footguns, failure modes, and recovery steps for the five most-referenced operational `.context/` modules. Each module's own Known Footguns / Common Failure Modes sections have the full detail — this section is the consolidated quick-reference for operators.

Modules covered (by reference frequency):
1. `.context/dev.md` — build, test, local dev
2. `.context/ops.md` — systemd, deploy, PID lock
3. `.context/runtime.md` — CLI adapters, model routing, streaming
4. `.context/discord.md` — access control, actions, channel context
5. `.context/memory.md` — memory layers, consolidation, prompt assembly

---

### 1. dev.md — Build / Test / Local Dev

#### Exact commands

```bash
# Full build (clean)
rm -rf dist && pnpm build

# Run tests
pnpm test

# Local dev with dotenv
pnpm dev

# Dev with debug runtime dump
DISCOCLAW_DEBUG_RUNTIME=1 pnpm dev

# Dev with Claude CLI debug log
CLAUDE_DEBUG_FILE=/tmp/claude-debug.log pnpm dev

# Sync Discord channel context stubs
pnpm sync:discord-context
pnpm sync:discord-context -- --rewrite-index
pnpm sync:discord-context -- --add-channel 123456789012345678:my-channel

# Smoke tests (opt-in, uses real API keys from .env)
SMOKE_TEST_TIERS=fast,capable pnpm test
GEMINI_SMOKE_TEST_TIERS=fast pnpm test
OPENAI_SMOKE_TEST_TIERS=fast pnpm test
```

#### Known footguns

| Footgun | Symptom | Fix |
|---------|---------|-----|
| `tsc` leaves stale `.js` in `dist/` after file renames | `Cannot find module` errors, or old behavior persists after source changes | `rm -rf dist && pnpm build` after any branch switch, file rename, or structure change |
| `.env` not loaded by raw `node dist/index.js` | Env vars appear unset; bot fails with missing token | Always use `pnpm dev` or `pnpm start` — they load `.env` via dotenv |
| `pnpm i` skipped after branch switch | Unexpected import errors from stale `node_modules` | Run `pnpm i` after any checkout that changes `package.json` or `pnpm-lock.yaml` |
| Port conflict on webhook server | `EADDRINUSE` crash on startup | `lsof -i :9400` to find the conflicting process; change `DISCOCLAW_WEBHOOK_PORT` or kill it |
| Editing `.env.example` instead of `.env` | Config changes appear in `git diff` but have no runtime effect | `.env` is gitignored and never shows in `git diff`; `.env.example` is tracked and has no runtime effect |
| `.env` values with `#` or unquoted spaces | Values truncated at `#` (dotenv treats as inline comment); spaces break parsing | Wrap values in double quotes: `VAR="value with # and spaces"` |
| PID lock contention during rapid restarts | `PID lock initializing` error on `pnpm dev` | Wait 2 seconds after Ctrl-C, or `rm -rf data/discoclaw.pid.lock` if stale |

#### Common failure modes

| Failure | Symptom | Recovery |
|---------|---------|----------|
| Build type errors | `tsc` exits non-zero with type errors in `src/` | `rm -rf dist && pnpm i && pnpm build` — if errors persist in unchanged files, check `git diff pnpm-lock.yaml` for dep type changes |
| Missing `DISCORD_TOKEN` | Process exits within 1 second: `Missing required env: DISCORD_TOKEN` | Verify `.env` exists and contains `DISCORD_TOKEN=<your-token>` (not commented out) |
| Claude CLI not found | Bot responds with "Runtime invocation failed" or logs `spawn claude ENOENT` | `which claude && claude --version` — if using a custom path, set `CLAUDE_BIN=/path/to/claude` in `.env` |
| Tests crash with module resolution errors | `pnpm test` fails before any tests run | `rm -rf dist && pnpm i && pnpm build && pnpm test` |
| Ghost files in `dist/` | Runtime imports a module that no longer exists in `src/`; `pnpm build` succeeds | `rm -rf dist && pnpm build` — `tsc` incremental compilation never deletes old output |
| PID lock refused on `pnpm dev` | `Another discoclaw instance is already running (PID XXXXX)` or `PID lock initializing (dir age: Xms)` | Check `cat data/discoclaw.pid.lock/meta.json`; if PID is dead: `rm -rf data/discoclaw.pid.lock && pnpm dev` |

---

### 2. ops.md — systemd / Deploy / PID Lock

#### Exact commands

```bash
# Service lifecycle
systemctl --user daemon-reload                     # MUST run after editing .service file
systemctl --user start discoclaw.service
systemctl --user stop discoclaw.service
systemctl --user restart discoclaw.service
systemctl --user status discoclaw.service
systemctl --user reset-failed discoclaw.service    # clear start-limit-hit state

# Logs
journalctl --user -u discoclaw.service -f          # tail live
journalctl --user -u discoclaw.service -n 50       # last 50 lines
journalctl --user -u discoclaw.service --since "10 min ago"
journalctl --user -u discoclaw.service -b           # since last boot

# PID lock inspection
cat data/discoclaw.pid.lock/meta.json | jq .
kill -0 $(jq -r .pid data/discoclaw.pid.lock/meta.json) 2>/dev/null && echo "alive" || echo "stale"

# Verify startTime matches (detects PID reuse)
PID=$(jq -r .pid data/discoclaw.pid.lock/meta.json)
LOCK_ST=$(jq -r .startTime data/discoclaw.pid.lock/meta.json)
PROC_ST=$(awk '{print $22}' /proc/$PID/stat 2>/dev/null)
[ "$LOCK_ST" = "$PROC_ST" ] && echo "genuine" || echo "PID reused — lock is stale"

# Full deploy sequence
pnpm build && systemctl --user daemon-reload && systemctl --user restart discoclaw.service
journalctl --user -u discoclaw.service -n 20

# Debug resolved env under systemd
DISCOCLAW_DEBUG_RUNTIME=1 systemctl --user restart discoclaw.service
journalctl --user -u discoclaw.service --since "1 min ago" --no-pager | head -30

# Rollback to known-good commit
git log --oneline -10
git checkout <commit-hash> -- .
pnpm build && systemctl --user restart discoclaw.service
```

#### Known footguns

| Footgun | Symptom | Fix |
|---------|---------|-----|
| Forgetting `daemon-reload` | `systemctl --user restart` succeeds but runs old `.service` config | Always `daemon-reload` before `restart` after editing the unit file |
| `sudo systemctl` instead of `systemctl --user` | `Unit discoclaw.service not found` | DiscoClaw is a *user* service — always use `--user` |
| Deploy without `pnpm build` | Service restarts but runs old compiled JS; no errors, just stale behavior | Always `pnpm build` before `systemctl --user restart` |
| Lingering Discord gateway session | New instance connects but misses events for 30-60 s | Stop the old process first, wait a few seconds, then start the new one |
| Empty allowlist on first deploy | Bot starts successfully but silently ignores every message; no errors in logs | Verify `DISCORD_ALLOW_USER_IDS` is set and non-empty in `.env` |
| `reset-failed` not run after crash loop | `StartLimitBurst=3` / `StartLimitIntervalSec=600` — after 3 failures in 10 min, systemd refuses all starts | `systemctl --user reset-failed discoclaw.service` before the next start |
| Stale `dist/` after file renames | Service starts but runs orphaned code from deleted/renamed source files | `rm -rf dist && pnpm build` before restart |
| Editing `.env` without restarting | `EnvironmentFile=` reads `.env` once at startup; `reload` is not supported for `Type=simple` | `systemctl --user restart discoclaw.service` is the only way to pick up `.env` changes |

#### Common failure modes

| Failure | Symptom | Recovery |
|---------|---------|----------|
| PID lock refused | Journal: `Another discoclaw instance is already running (PID XXXXX)` | Check lock metadata → if PID is stale, `systemctl --user restart` auto-clears it; if alive, stop the running instance first; nuclear: `rm -rf data/discoclaw.pid.lock` |
| start-limit-hit | `systemctl --user status` shows `failed (Result: start-limit-hit)` | Fix the root cause → `systemctl --user reset-failed discoclaw.service` → `systemctl --user start discoclaw.service` |
| Bot never comes online | Service shows active/running but bot absent from Discord; no "Bot Online" embed | Check journal for `An invalid token was provided` or `Used disallowed intents` — regenerate token in Developer Portal, update `.env`, restart |
| Bot ignores messages | Online in Discord but never responds | Check in order: (1) `DISCORD_ALLOW_USER_IDS` contains your ID, (2) `DISCORD_CHANNEL_IDS` includes the channel, (3) `DISCORD_REQUIRE_CHANNEL_CONTEXT=1` and context file exists |
| Running stale code after deploy | Behavior doesn't match merged changes; no errors | `rm -rf dist && pnpm build && systemctl --user restart discoclaw.service` — verify with `ls -la dist/index.js` (timestamp should be recent) |
| systemd env differs from shell | Bot works with `pnpm dev` but behaves differently under systemd (wrong model, missing tools) | `DISCOCLAW_DEBUG_RUNTIME=1` restart and compare output with local dev; check `EnvironmentFile=` in the `.service` unit |

---

### 3. runtime.md — CLI Adapters / Model Routing / Streaming

#### Exact commands

```bash
# Claude Code CLI invocation shape (full)
claude -p --model <id|alias> \
  [--dangerously-skip-permissions] \
  [--strict-mcp-config] \
  [--fallback-model <alias>] \
  [--max-budget-usd <number>] \
  [--append-system-prompt <text>] \
  [--debug-file <path>] \
  [--session-id <uuid>] \
  [--add-dir <dir> ...] \
  [--output-format text|stream-json] \
  [--include-partial-messages] \
  [--tools <comma-list>] \
  -- <prompt>           # POSIX terminator — required

# Gemini CLI invocation shape
gemini --model <id> -- <prompt>

# Codex CLI invocation shape
codex exec -- <prompt>
codex exec resume --session-id <id> -- <prompt>

# Verify Claude CLI is available
which claude && claude --version

# Check what PATH the systemd service sees
systemctl --user show discoclaw.service | grep -i environment

# Debug resolved model/runtime config
DISCOCLAW_DEBUG_RUNTIME=1 pnpm dev

# Check models.json tier mapping
cat models.json

# Check runtime overrides
cat runtime-overrides.json
```

#### Known footguns

| Footgun | Symptom | Fix |
|---------|---------|-----|
| CLI shorthand (`sonnet`/`opus`/`haiku`) ≠ model ID | Model silently changes on CLI update | Use full model IDs in `models.json` and env vars (e.g., `claude-sonnet-4-6`) for deterministic behavior |
| `RUNTIME_MODEL` is deprecated | Conflicts with `models.json`; `models.json` wins silently | Migrate to `models.json` for tier-to-model mapping; remove `RUNTIME_MODEL` from `.env` |
| Missing `--` terminator in Claude invocation | Prompts starting with `-` misinterpreted as flags | The adapter always emits `--` before the prompt — but manual CLI testing must include it |
| `CLAUDE_APPEND_SYSTEM_PROMPT` skips workspace files | `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `TOOLS.md`, and `BOOTSTRAP.md` are not loaded from disk | Only set this after first-run bootstrap is complete; verify workspace files are embedded in the appended prompt |
| OpenRouter model IDs are provider-namespaced | Bare names like `claude-sonnet-4-6` fail silently or pick wrong model with OpenRouter | Always use `anthropic/claude-sonnet-4.6` format for OpenRouter |
| Multi-turn image limitation on Codex | Adapter resets to fresh session; prior conversation context is lost | User sees a notification but context loss is not recoverable; no workaround except avoiding images in resumed Codex turns |
| Stream stall timeout kills the entire subprocess | In-flight tool execution or file writes interrupted mid-operation | Set `DISCOCLAW_STREAM_STALL_TIMEOUT_MS` high enough for long tool runs (default 120 s → consider 300 s) |
| `.env` runtime config requires restart | Changing `RUNTIME_MODEL`, `RUNTIME_TOOLS`, `PRIMARY_RUNTIME` has no effect until restart | Restart the service or dev process after any runtime env change |

#### Common failure modes

| Failure | Symptom | Recovery |
|---------|---------|----------|
| `spawn claude ENOENT` | Every message gets an error reply; logs show `spawn claude ENOENT` | `which claude && claude --version`; for systemd, check `CLAUDE_BIN` and the service's `PATH` |
| Model overloaded (529 / `overloaded_error`) | Intermittent failures, more common with Opus | Set `RUNTIME_FALLBACK_MODEL=sonnet` in `.env` and restart; if crash-looped, `reset-failed` first |
| Multi-turn process hangs | First message works; follow-ups get no response, eventually time out | Auto-detected via hang timeout → falls back to one-shot; reduce `DISCOCLAW_MULTI_TURN_HANG_TIMEOUT_MS` or set `DISCOCLAW_MULTI_TURN=0` to disable |
| Stream stall — bot goes silent mid-response | Bot starts responding then goes silent for minutes | Check `journalctl ... \| grep -i "tool\|stall"` — stalls during tool execution are normal; if genuinely hung, the stall timeout kills the process automatically |
| Wrong model used | Response quality or cost doesn't match expectations | `DISCOCLAW_DEBUG_RUNTIME=1 pnpm dev` → check resolved model; verify `models.json` and `runtime-overrides.json`; use `!models` in Discord to inspect at runtime |
| OpenAI-compat tool loop hits 25-round safety cap | Response ends abruptly with tool loop cap note | Hardcoded limit — simplify the prompt or break the task into smaller steps; check logs for which tools looped |

---

### 4. discord.md — Access Control / Actions / Channel Context

#### Exact commands

```bash
# Verify channel context stubs exist
ls data/content/discord/channels/

# Regenerate all channel context stubs
pnpm sync:discord-context

# Check access control config
grep -E 'DISCORD_ALLOW_USER_IDS|DISCORD_CHANNEL_IDS|DISCORD_REQUIRE_CHANNEL_CONTEXT' .env

# Check action flags
grep DISCOCLAW_DISCORD_ACTIONS .env

# Check status channel config
grep DISCOCLAW_STATUS_CHANNEL .env

# Debug why bot ignores messages
DISCOCLAW_DEBUG_RUNTIME=1 pnpm dev

# Check bot role permissions in logs
journalctl --user -u discoclaw.service --since "5 min ago" --no-pager | grep -i "permission\|action\|status"
```

#### Known footguns

| Footgun | Symptom | Fix |
|---------|---------|-----|
| Thread name + archive in one API call | Archive flag silently dropped; thread stays unarchived | Must be separate API calls with a short delay — affects task sync and cron archive operations |
| Bot permissions are role-based, not OAuth scope-based | "Missing Permissions" error on channel/role operations | Fix in Server Settings → Roles → [Bot Role]; the bot role must be ABOVE target roles in hierarchy |
| DMs bypass `DISCORD_CHANNEL_IDS` | Users in allowlist can always DM the bot, even with channel restrictions | By design — set `DISCORD_ALLOW_USER_IDS` strictly if DM access is a concern |
| `DISCORD_REQUIRE_CHANNEL_CONTEXT=1` silently drops messages | Bot ignores messages in channels without a context file; no error logged | Run `pnpm sync:discord-context` to pre-create stubs; enable `DISCORD_AUTO_INDEX_CHANNEL_CONTEXT=1` (default) |
| Auto-follow-up depth causes cost spikes | A single user message triggers up to 4 runtime invocations (initial + 3 follow-ups) | Set `DISCOCLAW_ACTION_FOLLOWUP_DEPTH=1` if cost is a concern |
| Reaction handler age gate | Reactions on messages older than 24 h silently ignored | Increase `DISCOCLAW_REACTION_MAX_AGE_HOURS` or set to `0` to disable the gate |

#### Common failure modes

| Failure | Symptom | Recovery |
|---------|---------|----------|
| Bot responds in some channels but not others | Works in DMs and some guild channels; silent in others | Check in order: (1) `DISCORD_CHANNEL_IDS` includes the channel, (2) context file exists for the channel (`ls data/content/discord/channels/`), (3) private threads require manually adding the bot |
| Discord action "Missing Permissions" | Bot replies with "Action failed: Missing Permissions" | Server Settings → Roles → enable needed permission: `channelCreate` → Manage Channels, `roleAdd` → Manage Roles, `kick` → Kick Members, etc.; bot role must be above target role in hierarchy |
| Follow-ups produce empty responses | Bot invokes a query action, gets results, but follow-up is empty or truncated | Trivial-response filter (<50 chars) suppressed it, or depth limit reached; increase `DISCOCLAW_ACTION_FOLLOWUP_DEPTH` if needed |
| Status channel messages not appearing | `DISCOCLAW_STATUS_CHANNEL` is set but no embeds appear | Use a channel ID (snowflake) instead of a name; verify bot has Send Messages permission in that channel; check `journalctl ... \| grep -i "status"` |
| Task sync threads out of sync | Forum threads show stale data, wrong status, or duplicates | Ask bot "sync tasks" for manual sync; if thread cache is stale, restart the bot (cache clears on startup) |
| Messages split awkwardly | Bot replies split mid-sentence or mid-code-block across Discord's 2000-char limit | Known limitation; no config knob — ask the bot for shorter responses or use thread replies |

---

### 5. memory.md — Memory Layers / Consolidation / Prompt Assembly

#### Exact commands

```bash
# Discord commands (sent as chat messages)
!memory                    # alias for !memory show
!memory show               # display all durable items + rolling summary
!memory remember <text>    # store a new fact
!memory forget <substring> # deprecate matching items (60% text-length match required)
!memory reset rolling      # clear rolling summary for the current session

# Inspect stored memory files on disk
cat data/memory/durable/<user-id>.json | jq .
cat data/memory/rolling/<session-key>.json | jq .
ls data/memory/shortterm/

# Check memory config
grep -E 'DISCOCLAW_DURABLE|DISCOCLAW_SHORTTERM|DISCOCLAW_SUMMARY|DISCOCLAW_MEMORY' .env

# Count a user's active durable items (to gauge consolidation proximity)
jq '[.items[] | select(.status == "active")] | length' data/memory/durable/<user-id>.json
```

#### Known footguns

| Footgun | Symptom | Fix |
|---------|---------|-----|
| Consolidation threshold triggers large-scale pruning | At 100 active items (default), a model call revises the entire durable list — may deprecate items you wanted to keep | Raise `DISCOCLAW_DURABLE_CONSOLIDATION_THRESHOLD` if 100 is too aggressive; the 50% floor prevents catastrophic loss, but review `!memory show` after consolidation |
| Auto-extraction creates unwanted facts | Bot passively extracts facts from user messages every 5 turns; may store things the user didn't intend as persistent memory | Disable with `DISCOCLAW_SUMMARY_TO_DURABLE_ENABLED=false`; or use `!memory forget <substring>` to remove unwanted items |
| Supersession deprecates the wrong item | Extraction model returns a `supersedes` substring that matches an unrelated item | Enable shadow mode first: `DISCOCLAW_DURABLE_SUPERSESSION_SHADOW=1` — logs what would be superseded without actually deprecating; review logs before going live |
| `!memory forget` requires 60% text-length match | Short substrings match too broadly; long substrings don't match at all | Use a distinctive substring of the item text; check `!memory show` first to see exact wording |
| Durable items silently excluded from prompts | Items exist in the JSON file but never appear in prompts | Budget cap (`DISCOCLAW_DURABLE_INJECT_MAX_CHARS=2000`) selects items by blended score (recency + hit frequency); low-scoring items are silently dropped; increase the budget or `!memory forget` stale items to make room |
| Rolling summary loses nuance over time | Summary is regenerated every N turns and is inherently lossy; recent messages take precedence over the summary | By design — summaries are compressed; use `!memory remember` for facts that must persist precisely |
| Memory commands consumed by runtime instead of intercepted | `! memory show` (with a space) or ` !memory` (with a leading space) bypasses the interceptor | Commands must be exactly `!memory` at the start of the message with no leading whitespace |
| Short-term memory only logs public guild channels | DM context and private channel context are not captured in short-term memory | By design — privacy-preserving; use durable memory (`!memory remember`) for cross-channel DM facts |

#### Common failure modes

| Failure | Symptom | Recovery |
|---------|---------|----------|
| Durable memory file corrupted | Bot logs JSON parse errors on startup or memory commands; user's memory appears empty | Durable writes use atomic `.tmp.${pid}` + `rename()` — corruption is rare; if it happens, restore from the previous good state or delete the file (user starts fresh) |
| Consolidation aborted — 50% floor hit | Log warning: consolidation returned fewer items than the floor; no items deprecated | This is a safety guard — the model tried to prune too aggressively; raise `DISCOCLAW_DURABLE_CONSOLIDATION_THRESHOLD` to defer consolidation, or manually `!memory forget` stale items |
| Memory budget silently drops important items | Bot doesn't reference a known fact even though `!memory show` lists it | The blended score (recency + `hitCount`) determines injection order; items at the bottom of the list are dropped when budget is full; `!memory forget` low-value items or increase `DISCOCLAW_DURABLE_INJECT_MAX_CHARS` |
| Auto-extraction duplicates existing facts | Same fact appears multiple times in `!memory show` | Content-hash dedup should catch exact duplicates; near-duplicates accumulate until consolidation merges them; manual `!memory forget` for the duplicate, or lower the consolidation threshold to trigger merging sooner |
| Rolling summary not updating | Bot doesn't seem to remember recent conversation despite `DISCOCLAW_SUMMARY_ENABLED=true` | Summary updates every N turns (`DISCOCLAW_SUMMARY_EVERY_N_TURNS`, default 5); check that enough turns have elapsed; summary generation failures are logged but non-blocking — check logs for errors |
| Short-term entries expired prematurely | Bot loses cross-channel awareness faster than expected | Default `DISCOCLAW_SHORTTERM_MAX_AGE_HOURS=6`; increase if needed; entries are also capped at `DISCOCLAW_SHORTTERM_MAX_ENTRIES=20` — oldest evicted first |

---

### Quick Diagnostic Flowchart

```
Bot not responding?
├── Check DISCORD_ALLOW_USER_IDS → must contain your Discord user ID
├── Check DISCORD_CHANNEL_IDS → if set, must include the channel
├── Check DISCORD_REQUIRE_CHANNEL_CONTEXT → if 1, run: pnpm sync:discord-context
├── Check logs → journalctl --user -u discoclaw.service -n 30
│   ├── "Missing DISCORD_TOKEN" → .env is missing or token is commented out
│   ├── "spawn claude ENOENT" → Claude CLI not installed or CLAUDE_BIN wrong
│   ├── "An invalid token was provided" → regenerate token in Developer Portal
│   ├── "overloaded_error" / 529 → set RUNTIME_FALLBACK_MODEL=sonnet
│   ├── "PID lock" → check data/discoclaw.pid.lock/meta.json
│   └── "start-limit-hit" → systemctl --user reset-failed discoclaw.service
└── Dump resolved config → DISCOCLAW_DEBUG_RUNTIME=1 (restart required)
```

## Secondary References

Blog posts, Stack Overflow answers, GitHub issues, Discord threads, and LLM training data are secondary references. They are useful for troubleshooting, but official docs and maintainer-owned repos are the authoritative source for model IDs, API parameters, auth requirements, and dependency behavior.
