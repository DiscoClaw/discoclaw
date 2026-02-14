# DiscoClaw Discord Bot Setup

> This is the canonical human-facing setup guide. The agent context module at `.context/bot-setup.md` is a brief reference for Claude — this file is the source of truth.

This walks you through creating a fresh Discord bot for DiscoClaw and configuring the repo to use it.

## Safety disclaimer (read first)

DiscoClaw can drive powerful local automation through an agent runtime connected to Discord.

Recommended starting point:
- Create a **standalone private Discord server** for DiscoClaw.
- Use **least privilege** bot permissions (avoid `Administrator` unless you explicitly need it).
- Keep allowlists tight: `DISCORD_ALLOW_USER_IDS` and `DISCORD_CHANNEL_IDS`.

## 0) Get a private server

If you don't have a private Discord server yet, click the **+** button at the bottom of Discord's server list to create one. Use this dedicated server for DiscoClaw — don't start in a shared or public server.

## 1) Create The Bot

1. Go to the Discord Developer Portal and create a new application.
2. Open the application -> **Bot** -> **Add Bot**.
3. Turn on:
   - **Message Content Intent** (required for reading message content in guild channels)

   > **Warning — this is the #1 setup failure mode.** If you skip this, the bot will connect and appear online, but `msg.content` will be empty in guild channels. The bot will silently ignore every message with no error. You'll find it under the **Bot** page → **Privileged Gateway Intents** → **Message Content Intent**.

4. Copy the bot token and paste it into your local `.env` immediately (`DISCORD_TOKEN=...`).
   - Clipboard tip: don’t copy the Application ID until after you’ve pasted the token, or you may overwrite it.
   - If you lose it: go back to the Bot page and **Reset Token**.

## 2) Invite The Bot To Your Server

Use the Developer Portal:

1. OAuth2 -> URL Generator
2. Scopes:
   - `bot`
3. Bot permissions (minimal recommended):
   - View Channels
   - Send Messages
   - Read Message History
   - Send Messages in Threads
4. Open the generated URL, pick your server, and authorize.

### Permission profiles (choose intentionally)

DiscoClaw has 4 common “permission profiles”. You can always re-invite the bot later with a different permission set.

- **Minimal** (recommended default)
  - What works: read/send messages in channels it can see; reply inside threads it can see.
  - What won't work: creating/archiving/deleting threads; moderating; changing channels/roles; Discord Actions.
  - Pros: lowest blast radius, easier to recommend publicly.
  - Cons: more "it can't do X" situations if you want it to administer Discord.
- **Threads**
  - Adds: thread creation + thread management.
  - Pros: "works in threads" even when you want the bot to create/manage them.
  - Cons: higher risk than minimal; still not "server admin". Discord Actions won't work (no Manage Channels).
- **Moderator**
  - Adds: channel management, message management, thread management, webhooks, uploads, etc. (still not `Administrator`).
  - Pros: broad ops capabilities while avoiding full admin. **Required for Discord Actions** (`DISCOCLAW_DISCORD_ACTIONS=1`) — includes Manage Channels permission.
  - Cons: meaningful blast radius if the bot is misconfigured/compromised; still may hit edge cases that require admin.
  - **Role hierarchy:** The bot can only manage roles below its own role. In **Server Settings → Roles**, drag the bot's role above any roles you want it to manage.
- **Administrator**
  - Pros: lowest operational friction; “everything will always work” (as far as Discord permissions go).
  - Cons: highest blast radius. Only use on a private server you control. If the bot token or runtime is compromised, an attacker can do essentially anything in that server.

Notes:
- “Work inside threads” means: being able to read/respond **in** threads. Minimal covers this for threads the bot can see. Private threads may require additional permission or being explicitly added.
- If you want slash commands: add the `applications.commands` scope.
- Discord does not expose the same full-text “search like the client” via the public bot API; if you want search, you generally need to log/index messages yourself.
- If you want the bot to reply inside threads reliably, set `DISCORD_AUTO_JOIN_THREADS=1` so it joins threads it encounters (public threads; private threads still require adding the bot).
- To join all *active public* threads in a server (one-time):
  - Dry run: `pnpm discord:join-threads -- --guild-id <YOUR_SERVER_ID>`
  - Apply: `pnpm discord:join-threads -- --guild-id <YOUR_SERVER_ID> --apply 1`

## 3) Get User/Channel IDs

1. Discord client -> Settings -> Advanced -> enable **Developer Mode**
2. Right-click:
   - your user -> Copy ID (use this in `DISCORD_ALLOW_USER_IDS`)
   - a channel -> Copy ID (use this in `DISCORD_CHANNEL_IDS`)

## 4) Configure DiscoClaw

```bash
pnpm i
pnpm setup     # guided interactive setup
# Or manually:
cp .env.example .env   # quick start (essentials only)
# cp .env.example.full .env   # all ~90 options
```

Edit `.env`:
- `DISCORD_TOKEN=...`
- `DISCORD_ALLOW_USER_IDS=...` (required; if empty, the bot responds to nobody)
- `DISCOCLAW_BEADS_FORUM=...` (required when beads enabled; enabled by default)
- `DISCOCLAW_CRON_FORUM=...` (required when crons enabled; enabled by default)
- `DISCORD_CHANNEL_IDS=...` (recommended for servers)
- `DISCOCLAW_DATA_DIR=...` (optional; defaults workspace/content under this folder)

Run:

```bash
pnpm dev
```

## 5) Validate

Run through this checklist in order. Each step should produce the expected output before moving on.

1. **Claude CLI installed:**
   ```bash
   claude --version
   ```
   Expected: a version string `>= 2.1.0`. If not found, install it first — see [Claude CLI docs](https://docs.anthropic.com/en/docs/claude-code).

2. **Node and pnpm:**
   ```bash
   node --version   # should be v20+
   pnpm --version   # should be v10+
   ```

3. **Environment file exists:**
   ```bash
   test -f .env && echo "ok" || echo "missing — run: cp .env.example .env"
   ```

4. **Smoke test (bot token + connection):**
   ```bash
   pnpm discord:smoke-test
   ```
   Expected: `Discord bot ready`. If it hangs or errors, double-check `DISCORD_TOKEN` in `.env`.

5. **Smoke test with guild verification:**
   ```bash
   pnpm discord:smoke-test -- --guild-id <YOUR_SERVER_ID>
   ```
   Expected: `Discord bot ready (guild ok: ...)`.

6. **Live test:**
   - DM the bot → it should respond (if your user ID is in `DISCORD_ALLOW_USER_IDS`).
   - Post in an allowlisted channel → it should respond.
   - Post in a non-allowlisted channel → it should **not** respond.

7. **Channel context auto-scaffold (optional):**
   - Create a new channel and post once. DiscoClaw should auto-create a stub context file under `content/discord/channels/` and add it to `content/discord/DISCORD.md`.
