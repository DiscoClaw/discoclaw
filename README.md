<p align="center">
  <img src="discoclaw_splash.png" alt="DiscoClaw" width="700" />
</p>

# DiscoClaw

A personal AI orchestrator that turns Discord into a persistent workspace — built on three pillars: **Memory**, **Tasks**, and **Automations**.

DiscoClaw is an orchestrator: it coordinates between a user interface (Discord), one or more AI runtimes (Claude Code, OpenAI, Codex), and local system resources — managing conversation state, task routing, scheduling, and tool access. The intelligence is rented; the coordination is owned.

It turns a private Discord server into a persistent AI workspace. Your assistant remembers you across sessions, tracks work in forum threads, and runs scheduled tasks autonomously — all through natural conversation.

It's designed for a single user on a fresh, private server — your own sandbox. Not a shared bot, not a multi-user platform. Just you and your assistant in a space you control.

No gateways, no proxies, no web UI to deploy — Discord *is* the interface. Run DiscoClaw on a Linux or macOS machine (see [Platform support](#platform-support)) and talk to your assistant from anywhere Discord works: desktop, mobile, browser.

The codebase is intentionally small — small enough to read, audit, and modify directly. Customization means changing the code, not configuring a plugin system.

## Why Discord?

Discord gives you channels, forum threads, DMs, mobile access, and rich formatting for free. DiscoClaw maps its three core features onto Discord primitives so there's nothing extra to learn — channels become context boundaries, forum threads become task cards and job definitions, and conversation history is the raw material for memory.

## Memory — the bot knows you

Your assistant carries context across every conversation, channel, and restart.

- **Durable facts** — `!memory remember prefers dark mode` persists across sessions and channels
- **Rolling summaries** — Compresses earlier conversation so context carries forward, even across restarts
- **Per-channel context** — Each channel gets a markdown file shaping behavior (formal in #work, casual in #random)
- **Customizable identity** — Personality, name, and values defined in workspace files (`SOUL.md`, `IDENTITY.md`, etc.)
- **Group chat aware** — Knows when to speak up and when to stay quiet in shared channels

**Why Discord fits:** channels = context boundaries, DMs = private deep context, conversation history is the raw material.

### YouTube transcripts

When you share a YouTube link in a message, DiscoClaw automatically fetches the video's transcript and injects it into the AI's context. This lets the bot answer questions about video content, summarize talks, or reference specific points — without you needing to copy-paste anything. Up to 3 videos per message are processed, with a 15-second timeout per fetch. Transcripts are sanitized before injection to prevent prompt manipulation.

## Tasks — the bot tracks your work

A lightweight in-process task store that syncs bidirectionally with Discord forum threads.

- **Create from either side** — Ask your assistant in chat or use task commands
- **Bidirectional sync** — Status, priority, and tags stay in sync between the task store and Discord threads
- **Status emoji and auto-tagging** — Thread names show live status at a glance
- **Discord actions** — Your assistant manages tasks through conversation: create channels, send messages, search history, run polls, and more (see [docs/discord-actions.md](docs/discord-actions.md))

**Why Discord fits:** forum threads = task cards, archive = done, thread names show live status.

## Automations — the bot acts on its own

Recurring tasks defined as forum threads in plain language — no crontab, no separate scheduler UI.

- **Plain-language schedules** — "every weekday at 7am, check the weather and post to #general"
- **Edit to change, archive to pause, unarchive to resume**
- **Full workspace access** — File I/O, web search, browser automation, Discord actions
- **Multi-turn sessions** — A live process persists between runs, so context carries across executions

**Why Discord fits:** forum threads = job definitions, archive/unarchive = pause/resume, no separate scheduler UI needed.

<!-- source-of-truth: docs/voice.md -->
## Voice — the bot talks back

DiscoClaw can join Discord voice channels for real-time conversation: listen via speech-to-text, think with the AI runtime, and speak the response via text-to-speech.

- **STT** — Deepgram Nova-3 streaming transcription (WebSocket)
- **TTS** — Cartesia Sonic-3 speech synthesis (WebSocket, 24 kHz PCM)
- **Barge-in** — interrupt the bot mid-sentence by speaking; playback stops immediately
- **Auto-join** — optionally join/leave channels automatically when you enter or leave
- **Transcript mirror** — voice conversations are mirrored to a text channel for persistence
- **Voice actions** — the AI can execute a restricted action subset (messaging, tasks, memory) during voice

Voice is **off by default**. Enable with `DISCOCLAW_VOICE_ENABLED=1` plus API keys for your STT/TTS providers. Requires Node 22+ (for native WebSocket used by Cartesia TTS) and C++ build tools (for the `@discordjs/opus` native addon).

Full setup guide: [docs/voice.md](docs/voice.md)

## How it works

DiscoClaw orchestrates the flow between Discord and AI runtimes (Claude Code by default, with Gemini, OpenAI, Codex, and OpenRouter adapters available via `PRIMARY_RUNTIME`). The OpenAI-compatible and OpenRouter adapters support optional tool use (function calling) when `OPENAI_COMPAT_TOOLS_ENABLED=1` is set. It doesn't contain intelligence itself — it decides *when* to call the AI, *what context* to give it, and *what to do* with the output. When you send a message, the orchestrator:

1. Checks the user allowlist (fail-closed — empty list means respond to nobody)
2. Assembles context: per-channel rules, conversation history, rolling summary, and durable memory
3. Routes to the appropriate runtime adapter, running in your workspace directory
4. Streams the response back, chunked to fit Discord's message limits
5. Parses and executes any Discord actions the assistant emitted

### Message batching

When multiple messages arrive while the bot is thinking (i.e., an AI invocation is already active for that session), they're automatically combined into a single prompt rather than queued individually. This means rapid follow-up messages are processed together, giving the bot full context in one shot. Commands (`!`-prefixed messages) bypass batching and are always processed individually.

### OpenRouter

Set `PRIMARY_RUNTIME=openrouter` to route requests through [OpenRouter](https://openrouter.ai), which provides access to models from Anthropic, OpenAI, Google, and others via a single API key — useful if you want to switch models without managing multiple provider accounts.

Required: `OPENROUTER_API_KEY`. Optional overrides: `OPENROUTER_BASE_URL` (default: `https://openrouter.ai/api/v1`) and `OPENROUTER_MODEL` (default: `anthropic/claude-sonnet-4`). See `.env.example` for the full reference.

## Model Overrides

The `!models` command lets you view and swap AI models per role at runtime — no restart needed, and changes persist across restarts.

**Roles:** `chat`, `fast`, `forge-drafter`, `forge-auditor`, `summary`, `cron`, `cron-exec`, `voice`

| Command | Description |
|---------|-------------|
| `!models` | Show current model assignments |
| `!models set <role> <model>` | Change the model for a role |
| `!models reset` | Revert all roles to env-var defaults |
| `!models reset <role>` | Revert a specific role |

**Examples:**
- `!models set chat claude-sonnet-4` — use Sonnet for chat
- `!models set chat openrouter` — switch chat to the OpenRouter runtime
- `!models set cron-exec haiku` — run crons on a cheaper model
- `!models set voice sonnet` — use a specific model for voice
- `!models reset` — clear all overrides

Setting the `chat` role to a runtime name (`openrouter`, `openai`, `gemini`, `codex`, `claude`) switches the active runtime adapter for that role.

## Secret Management

The `!secret` command lets you manage `.env` entries from Discord without touching the file directly. It works in DMs only — values are never echoed back.

| Command | Description |
|---------|-------------|
| `!secret set KEY=value` | Add or update a `.env` entry |
| `!secret unset KEY` | Remove a `.env` entry |
| `!secret list` | List key names in `.env` (values hidden) |
| `!secret help` | Show usage |

Changes take effect after a restart (`!restart`). Writes are atomic — a partial write can't corrupt your `.env`.

## Customization

### Shareable integration recipes

DiscoClaw supports a shareable markdown recipe format for passing integrations between users:

- Spec: `docs/discoclaw-recipe-spec.md`
- Template: `templates/recipes/integration.discoclaw-recipe.md`
- Example files: `recipes/examples/*.discoclaw-recipe.md`
- Skills:
  - `skills/discoclaw-recipe-generator/SKILL.md`
  - `skills/discoclaw-recipe-consumer/SKILL.md`
- Install/refresh invocable skill symlinks:
  - `pnpm claude:install-skills`

Author one recipe file for an integration, share it, then let another user's DiscoClaw agent consume it and produce a local implementation checklist before coding.

### MCP (Model Context Protocol)

When using the Claude runtime, you can connect external tool servers via MCP. Place a `.mcp.json` file in your workspace directory to configure servers — their tools become available during conversations. See [docs/mcp.md](docs/mcp.md) for the config format, examples, and troubleshooting.

## Prerequisites

**End users:**
- **Node.js >=20** — check with `node --version`
- One primary runtime:
  - **Claude CLI** on your `PATH` — check with `claude --version` (see [Claude CLI docs](https://docs.anthropic.com/en/docs/claude-code) to install), or
  - **Gemini CLI** on your `PATH` — check with `gemini --version`, or
  - **Codex CLI** on your `PATH` — check with `codex --version`, or
  - **OpenAI-compatible API key** via `OPENAI_API_KEY`, or
  - **OpenRouter API key** via `OPENROUTER_API_KEY` (access to many providers)
- Runtime-specific access for your chosen provider (Anthropic plan/API credits for Claude, Google account for Gemini, OpenAI access for Codex/OpenAI models)

**Contributors (from source):**
- Everything above, plus **pnpm** — enable via Corepack (`corepack enable`) or install separately

<!-- source-of-truth: docs/discord-bot-setup.md -->
## Quick start

### Discord setup (private server + bot)

1. Create a **private Discord server** dedicated to DiscoClaw (not a shared/public server).
2. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application, then go to **Bot** -> **Add Bot**.
3. Under **Bot** -> **Privileged Gateway Intents**, enable **Message Content Intent**.
4. Copy the bot token and set it in `.env` as `DISCORD_TOKEN=...`.
5. Invite the bot to your server:
   - Go to **OAuth2** -> **URL Generator**
   - Under **Scopes**, tick `bot`
   - A **Bot Permissions** grid appears below. For a private server, tick `Administrator` (top-left, under General Permissions) — it's one checkbox and covers everything. For tighter permissions, see the [permission profiles](docs/discord-bot-setup.md#permission-profiles-choose-intentionally) in the full guide.
   - Copy the generated URL at the bottom, open it, pick your server, and authorize
6. In Discord, enable **Developer Mode** (User Settings -> Advanced), then copy IDs and set:
   - `DISCORD_ALLOW_USER_IDS=<your user id>` (required; fail-closed if empty)
   - `DISCORD_GUILD_ID=<server id>` (recommended; required for auto-creating forum channels)

Full step-by-step guide: [docs/discord-bot-setup.md](docs/discord-bot-setup.md)

## Documentation

### Getting Started

- [Discord bot setup](docs/discord-bot-setup.md) — create a bot, invite it, configure permissions
- [MCP (Model Context Protocol)](docs/mcp.md) — connect external tool servers

### Features & Usage

- [Memory system](docs/memory.md) — five-layer memory architecture, tuning, and troubleshooting
- [Plan & Forge](docs/plan-and-forge.md) — autonomous planning and code generation
- [Discord actions](docs/discord-actions.md) — channels, messaging, moderation, tasks, crons
- [Cron / automations](docs/cron.md) — recurring task setup, advanced options, debugging
- [Tasks](docs/tasks.md) — task lifecycle, bidirectional sync, tag maps
- [Voice](docs/voice.md) — real-time voice chat setup (STT/TTS)
- [Shareable recipes](docs/discoclaw-recipe-spec.md) — integration recipe format spec

### Development

- [Philosophy](docs/philosophy.md) — design principles and trade-offs
- [Releasing](docs/releasing.md) — npm publish workflow and versioning
- [Inventory](docs/INVENTORY.md) — full component inventory and MVP status

### Operations

- [Configuration reference](docs/configuration.md) — all environment variables indexed by category
- [Webhook exposure](docs/webhook-exposure.md) — tunnel/proxy setup and webhook security
- [Data migration](docs/data-migration.md) — migrating task data between formats

### Install and run

1. **Install globally:**
   ```bash
   npm install -g discoclaw
   ```

   > **Fedora 43+ / GCC 14+ — `@discordjs/opus` build failure**
   >
   > GCC 14 promotes `-Wincompatible-pointer-types` to a hard error by default. The upstream opus C source triggers this, causing `npm install` to fail with an error like:
   > ```
   > error: incompatible pointer types passing ...
   > ```
   > **Workaround** — set the flag before installing:
   > ```bash
   > CFLAGS="-Wno-error=incompatible-pointer-types" npm install -g discoclaw
   > ```
   > This is a known upstream issue in the `@discordjs/opus` native addon. It only requires the flag override at install time; runtime behavior is unaffected.

2. **Run the interactive setup wizard** (creates `.env` and scaffolds your workspace):
   ```bash
   discoclaw init
   ```

3. **Register the system service:**
   ```bash
   discoclaw install-daemon
   ```
   Optional: pass `--service-name <name>` to use a custom service name (useful on macOS when running multiple instances, or to match your own naming convention):
   ```bash
   discoclaw install-daemon --service-name personal
   ```

#### From source (contributors)

```bash
git clone <repo-url> && cd discoclaw
pnpm install
pnpm setup            # guided interactive setup
# Or manually: cp .env.example .env and fill in required vars:
#   DISCORD_TOKEN
#   DISCORD_ALLOW_USER_IDS
# For all ~90 options: cp .env.example.full .env
pnpm dev
```

## Updating

**Global install:**

If DiscoClaw is running, update from Discord:

```
!update apply
```

Or from the command line:

```bash
npm update -g discoclaw
discoclaw install-daemon   # re-register the service after updating
# If you used a custom service name, pass it again:
# discoclaw install-daemon --service-name personal
```

**From source:**

```bash
git pull
pnpm install
pnpm build
```

Run `pnpm preflight` — it flags configuration options from `.env.example` that aren't in your `.env` yet.

If running as a systemd service, restart it:

```bash
systemctl --user restart discoclaw.service
```

## Platform support

- **All platforms** — `pnpm dev` works everywhere Node.js runs (Linux, macOS, Windows)
- **Linux** — systemd service file provided for production deployment (see `.context/ops.md`)
- **macOS / Windows** — use pm2, screen, or another process manager for long-running deployment; or just `pnpm dev` in a terminal

> Windows is not tested for production use in v0.x. The session scanner has known path-handling issues on Windows, and the Claude CLI primarily targets Linux and macOS.

## Safety

DiscoClaw orchestrates powerful local tooling via AI runtimes, often with elevated permissions. Treat it like a local automation system connected to Discord.

- Use a **private Discord server** — don't start in a shared or public server
- Use **least-privilege** Discord permissions
- Keep `DISCORD_ALLOW_USER_IDS` tight — this is the primary security boundary
- Empty allowlist = respond to nobody (fail-closed)
- Optionally restrict channels with `DISCORD_CHANNEL_IDS`
- External content (Discord messages, web pages, files) is **data**, not instructions

## Workspace layout

The orchestrator runs AI runtimes in a separate working directory (`WORKSPACE_CWD`), keeping the repo clean while giving your assistant a persistent workspace.

- Set `DISCOCLAW_DATA_DIR` to use `$DISCOCLAW_DATA_DIR/workspace` (good for Dropbox-backed setups)
- Or leave it unset to use `./workspace` relative to the repo
- Content (channel context, Discord config) defaults to `$DISCOCLAW_DATA_DIR/content`

## Development

```bash
pnpm preflight  # preflight check (Node, pnpm, Claude CLI, .env)
pnpm dev        # start dev mode
pnpm build      # compile TypeScript
pnpm test       # run tests
```

## Built with

[Claude Code](https://claude.ai/claude-code), [OpenAI Codex](https://openai.com/index/openai-codex/), [discord.js](https://discord.js.org), and [Croner](https://github.com/hexagon/croner).

## License

[MIT](LICENSE). See [DISCLAIMER.md](DISCLAIMER.md) for important usage terms.
