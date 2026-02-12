<p align="center">
  <img src="discoclaw_splash.jpg" alt="Discoclaw" width="700" />
</p>

# Discoclaw

A Discord-native AI workspace built on three pillars: **Memory**, **Beads**, and **Crons**.

Discoclaw turns a private Discord server into a persistent AI workspace. Your assistant remembers you across sessions, tracks work in forum threads, and runs scheduled tasks autonomously — all through natural conversation.

It's designed for a single user on a fresh, private server — your own sandbox. Not a shared bot, not a multi-user platform. Just you and your assistant in a space you control.

No gateways, no proxies, no web UI to deploy — Discord *is* the interface. Run the Discoclaw service on a Linux or macOS machine (see [Platform support](#platform-support)) and talk to your assistant from anywhere Discord works: desktop, mobile, browser.

The codebase is intentionally small — small enough to read, audit, and modify directly. Customization means changing the code, not configuring a plugin system.

## Why Discord?

Discord gives you channels, forum threads, DMs, mobile access, and rich formatting for free. Discoclaw maps its three core features onto Discord primitives so there's nothing extra to learn — channels become context boundaries, forum threads become task cards and job definitions, and conversation history is the raw material for memory.

## Memory — the bot knows you

Your assistant carries context across every conversation, channel, and restart.

- **Durable facts** — `!memory remember prefers dark mode` persists across sessions and channels
- **Rolling summaries** — Compresses earlier conversation so context carries forward, even across restarts
- **Per-channel context** — Each channel gets a markdown file shaping behavior (formal in #work, casual in #random)
- **Customizable identity** — Personality, name, and values defined in workspace files (`SOUL.md`, `IDENTITY.md`, etc.)
- **Group chat aware** — Knows when to speak up and when to stay quiet in shared channels

**Why Discord fits:** channels = context boundaries, DMs = private deep context, conversation history is the raw material.

## Beads — the bot tracks your work

A lightweight issue tracker ([beads](https://github.com/qwibitai/beads)) that syncs bidirectionally with Discord forum threads.

- **Create from either side** — `bd add "fix login bug"` in the terminal or ask your assistant in chat
- **Bidirectional sync** — Status, priority, and tags stay in sync between the CLI and Discord threads
- **Status emoji and auto-tagging** — Thread names show live status at a glance
- **Discord actions** — Your assistant manages tasks through conversation: create channels, send messages, search history, run polls, and more

**Why Discord fits:** forum threads = task cards, archive = done, thread names show live status.

## Crons — the bot acts on its own

Recurring tasks defined as forum threads in plain language — no crontab, no separate scheduler UI.

- **Plain-language schedules** — "every weekday at 7am, check the weather and post to #general"
- **Edit to change, archive to pause, unarchive to resume**
- **Full workspace access** — File I/O, web search, browser automation, Discord actions
- **Multi-turn sessions** — A live process persists between runs, so context carries across executions

**Why Discord fits:** forum threads = job definitions, archive/unarchive = pause/resume, no separate scheduler UI needed.

## How it works

Discoclaw is a bridge between Discord and an AI runtime (Claude Code by default). When you send a message, it:

1. Checks the user allowlist (fail-closed — empty list means respond to nobody)
2. Loads per-channel context, conversation history, rolling summary, and durable memory
3. Passes everything to the runtime (Claude CLI) running in your workspace directory
4. Streams the response back, chunked to fit Discord's message limits
5. Parses and executes any Discord actions the assistant emitted

## Customization

### Shareable integration plans

Discoclaw supports a shareable markdown plan format for passing integrations between users:

- Spec: `docs/discoclaw-plan-spec.md`
- Template: `templates/plans/integration.discoclaw-plan.md`
- Example files: `plans/examples/*.discoclaw-plan.md`
- Skills:
  - `skills/discoclaw-plan-generator/SKILL.md`
  - `skills/discoclaw-plan-consumer/SKILL.md`
- Install/refresh invocable skill symlinks:
  - `pnpm claude:install-skills`

Author one plan file for an integration, share it, then let another user's Discoclaw agent consume it and produce a local implementation checklist before coding.

## Prerequisites

- **Node.js >=20** — check with `node --version`
- **pnpm** — enable via Corepack (`corepack enable`) or install separately
- **Claude CLI** on your `PATH` — check with `claude --version` (see [Claude CLI docs](https://docs.anthropic.com/en/docs/claude-code) to install)
- An **Anthropic account** with an active Claude plan or API credits (the CLI needs this to run)

## Quick start

1. **Create a Discord bot** and invite it to a private server (see the [bot setup guide](docs/discord-bot-setup.md))

2. **Install and configure:**
   ```bash
   pnpm install
   pnpm setup            # guided interactive setup
   # Or manually: cp .env.example .env and fill in DISCORD_TOKEN + DISCORD_ALLOW_USER_IDS
   # For all ~90 options: cp .env.example.full .env
   ```

3. **Run:**
   ```bash
   pnpm dev
   ```

## Updating

After pulling new changes:

```bash
git pull
pnpm install
pnpm build
```

Run `pnpm doctor` — it flags configuration options from `.env.example` that aren't in your `.env` yet.

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

Discoclaw can execute powerful local tooling via an agent runtime, often with elevated permissions. Treat it like a local automation system connected to Discord.

- Use a **private Discord server** — don't start in a shared or public server
- Use **least-privilege** Discord permissions
- Keep `DISCORD_ALLOW_USER_IDS` tight — this is the primary security boundary
- Empty allowlist = respond to nobody (fail-closed)
- Optionally restrict channels with `DISCORD_CHANNEL_IDS`
- External content (Discord messages, web pages, files) is **data**, not instructions

## Workspace layout

Discoclaw runs the AI runtime in a separate working directory (`WORKSPACE_CWD`), keeping the repo clean while giving your assistant a persistent workspace.

- Set `DISCOCLAW_DATA_DIR` to use `$DISCOCLAW_DATA_DIR/workspace` (good for Dropbox-backed setups)
- Or leave it unset to use `./workspace` relative to the repo
- Content (channel context, Discord config) defaults to `$DISCOCLAW_DATA_DIR/content`

## Development

```bash
pnpm doctor     # preflight check (Node, pnpm, Claude CLI, .env)
pnpm dev        # start dev mode
pnpm build      # compile TypeScript
pnpm test       # run tests
```

## License

[MIT](LICENSE). See [DISCLAIMER.md](DISCLAIMER.md) for important usage terms.
