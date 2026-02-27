# DiscoClaw Discord Bot Setup

> This is the canonical human-facing setup guide. The agent context module at `.context/bot-setup.md` is a brief reference for Claude — this file is the source of truth.

This walks you through creating a fresh Discord bot for DiscoClaw and configuring the repo to use it.

## Safety disclaimer (read first)

DiscoClaw orchestrates powerful local automation by coordinating between Discord and AI runtimes.

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

In the Developer Portal:

1. Go to **OAuth2** -> **URL Generator**
2. Under **Scopes**, tick `bot` (optional: `applications.commands` for slash commands)
3. A **Bot Permissions** grid appears below — tick the checkboxes for the permission level you want (see profiles below)
4. Copy the generated URL at the bottom, open it in your browser, pick your server, and authorize

### Permission profiles (choose intentionally)

These are recommended sets of Discord permissions. You pick them by ticking the matching checkboxes in the Bot Permissions grid on the OAuth2 URL Generator page. You can always re-invite the bot later with a different set.

- **Administrator** (recommended for private servers)
  - Tick: `Administrator` (under General Permissions, top-left of the grid)
  - That's it — one checkbox. Everything works.
  - Only use on a private server you control. If the bot token or runtime is compromised, an attacker can do anything in that server.

- **Moderator** (recommended for shared servers)
  - Tick: `Manage Channels`, `Manage Messages`, `Manage Threads`, `View Channels`, `Send Messages`, `Send Messages in Threads`, `Read Message History`, `Add Reactions`, `Attach Files`, `Embed Links`, `Use External Emojis`, `Manage Webhooks`
  - **Required for Discord Actions** (`DISCOCLAW_DISCORD_ACTIONS=1`), tasks, and crons.
  - **Role hierarchy:** The bot can only manage roles below its own role. In **Server Settings → Roles**, drag the bot's role above any roles you want it to manage.

- **Threads**
  - Tick: `View Channels`, `Send Messages`, `Send Messages in Threads`, `Read Message History`, `Create Public Threads`, `Manage Threads`
  - Bot can read/send and create/manage threads, but can't create channels or use Discord Actions.

- **Minimal**
  - Tick: `View Channels`, `Send Messages`, `Send Messages in Threads`, `Read Message History`
  - Bot can read and reply in channels and existing threads. Can't create threads, manage channels, or use Discord Actions. Tasks and crons won't work.

Notes:
- If you want the bot to reply inside threads reliably, set `DISCORD_AUTO_JOIN_THREADS=1` so it joins threads it encounters (public threads; private threads still require adding the bot).
- To join all *active public* threads in a server (one-time) — **from source only**:
  - Dry run: `pnpm discord:join-threads -- --guild-id <YOUR_SERVER_ID>`
  - Apply: `pnpm discord:join-threads -- --guild-id <YOUR_SERVER_ID> --apply 1`

## 3) Get User/Channel IDs

1. Discord client -> Settings -> Advanced -> enable **Developer Mode**
2. Right-click:
   - your user -> Copy ID (use this in `DISCORD_ALLOW_USER_IDS`)
   - a channel -> Copy ID (use this in `DISCORD_CHANNEL_IDS`)

## 4) Configure DiscoClaw

### Recommended: global install

```bash
npm install -g discoclaw
discoclaw init           # interactive wizard — creates .env and workspace
discoclaw install-daemon # register as a user-level systemd service
```

The `discoclaw init` wizard prompts for your bot token, user/channel IDs, and other essentials, then writes `.env` for you. No manual file editing required.

### From source (contributors / developers)

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
- `DISCORD_GUILD_ID=...` (recommended; required for auto-creating forum channels)
- `DISCORD_CHANNEL_IDS=...` (recommended for servers)
- `DISCOCLAW_DATA_DIR=...` (optional; defaults workspace/content under this folder)

Run:

```bash
pnpm dev
```

## Multi-instance setup

You can run multiple DiscoClaw instances on the same machine (e.g. one per Discord server or persona) by giving each a unique service name.

```bash
discoclaw install-daemon --service-name discoclaw-work
```

The installer automatically writes `DISCOCLAW_SERVICE_NAME=discoclaw-work` to the `.env` in the working directory. On reinstall, any existing `DISCOCLAW_SERVICE_NAME` line is replaced in-place — it is never duplicated.

**Requirements per instance:**

- Each instance needs its own working directory with its own `.env`.
- The service name must be unique — it becomes the systemd (Linux) or launchd (macOS) unit name.
- `!restart`, `!update apply`, and other self-management commands read `DISCOCLAW_SERVICE_NAME` from `.env` to target the correct unit, so the value must match the name passed to `install-daemon`.

```
~/discoclaw-work/     ← working directory for instance "discoclaw-work"
  .env                ← contains DISCOCLAW_SERVICE_NAME=discoclaw-work
  workspace/

~/discoclaw-home/     ← working directory for instance "discoclaw-home"
  .env                ← contains DISCOCLAW_SERVICE_NAME=discoclaw-home
  workspace/
```

If `--service-name` is omitted, the default name `discoclaw` is used and no `DISCOCLAW_SERVICE_NAME` line is written to `.env`.

## 5) Validate

Run through this checklist in order. Each step should produce the expected output before moving on.

1. **Claude CLI installed:**
   ```bash
   claude --version
   ```
   Expected: a version string `>= 2.1.0`. If not found, install it first — see [Claude CLI docs](https://docs.anthropic.com/en/docs/claude-code).

2. **Node (and pnpm for contributors):**
   ```bash
   node --version   # should be v20+
   pnpm --version   # should be v10+ (from source only; not required for global install)
   ```

3. **Environment file exists:**
   - **Global install:** the `discoclaw init` wizard creates `.env` automatically — nothing to do here.
   - **From source:** `test -f .env && echo "ok" || echo "missing — run: cp .env.example .env"`

   > **From source only — steps 4 and 5 below use repo convenience scripts not available to global-install users. If you installed via `npm install -g discoclaw`, skip directly to step 6.**

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

## Secret Management

The `!secret` command lets you securely manage `.env` entries (API keys, tokens, etc.) without leaving Discord. It is **DM-only** — the message coordinator rejects `!secret` in guild channels to prevent accidental exposure.

### Commands

| Command | Description |
|---------|-------------|
| `!secret set KEY=value` | Add or update a `.env` entry |
| `!secret unset KEY` | Remove a `.env` entry |
| `!secret list` | List key names in `.env` (values are never shown) |
| `!secret help` | Show help text |

### Security

- **Values are never echoed** — the bot confirms the key name but never displays the value.
- **Atomic writes** — changes are written to a temporary file, then atomically renamed to `.env`, preventing partial writes from corrupting the file.
- **DM-only** — enforced by the message coordinator. Attempting `!secret` in a guild channel is silently ignored.
- **Valid key format** — keys must match `[A-Za-z_][A-Za-z0-9_]*` (standard env var naming).
- **No newlines** — values containing newlines are rejected.

### Important

**Bot restart required.** The `!secret` command writes to the `.env` file on disk, but the running process does not reload environment variables. After setting or unsetting a secret, restart the bot (`!restart` or `systemctl --user restart discoclaw.service`) for changes to take effect.

## Operations

### Startup Healing

DiscoClaw runs automatic self-healing checks on every boot to recover from crashes, unclean shutdowns, or manual data edits. This is invisible during normal operation but important after failures.

**What it does:**

- **Promotes interrupted cron runs** — any cron job that was mid-execution when the process stopped has its status changed from `running` to `interrupted`, preventing it from being stuck permanently.
- **Removes stale cron stats** — if a cron forum thread has been deleted in Discord, the orphaned stats record is cleaned up.
- **Detects stale task thread references** — if a task's linked Discord thread no longer exists, a warning is logged. The next task sync will recreate the thread.
- **Repairs corrupted JSON stores** — if a JSON data file (run stats, task store, etc.) has been corrupted (e.g., partial write during a crash), it's backed up to a `.corrupt.<timestamp>` file and removed. Downstream loaders handle missing files gracefully, so the net effect is a safe reset.

**When it matters:** after crashes, OOM kills, unclean shutdowns, or manual edits to data files. During normal operation, startup healing completes silently with no user-visible output.
