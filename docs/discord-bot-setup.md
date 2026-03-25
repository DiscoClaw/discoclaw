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

The simplest way to invite the bot is the **quick invite URL** — just replace `YOUR_CLIENT_ID` with your Application ID from the Developer Portal's General Information page:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=0
```

This adds the bot with the `bot` scope and no special permissions. Discord will prompt you to pick a server. You can grant additional permissions via Server Settings → Roles after the bot joins, or use the Installation page method below to bake permissions into the invite link.

> **Important:** The `bot` scope is required. Using only `applications.commands` (slash commands) will not add the bot to your server — it registers commands but the bot cannot connect, read messages, or respond.

### Recommended: use the Installation page

For a reusable, permanent invite link with permissions pre-configured, use Discord's built-in **Installation** page:

1. Go to **Installation** (left sidebar in the Developer Portal)
2. Set **Install Link** to **Discord Provided Link**
3. Under **Default Install Settings**, click **Add** next to Guild Install
4. Add the scope **`bot`** (required). Optionally add `applications.commands` if you want slash commands.
5. A **Permissions** selector appears — pick the permissions for the level you want (see profiles below)
6. **Save Changes** at the bottom of the page
7. Copy the **Install Link** shown at the top, open it in your browser, pick your server, and authorize

> **Tip:** This install link is permanent. You can share it or bookmark it. To change permissions later, update the Installation page and re-invite — existing server members get the new permissions.

> **Legacy alternative:** The **OAuth2 → URL Generator** page still works if you need a one-off URL with non-default scopes or permissions, but the Installation page is simpler for most setups.

### Permission profiles (choose intentionally)

These are recommended sets of Discord permissions. You pick them in the Permissions selector on the Installation page's Default Install Settings. You can always re-invite the bot later with a different set.

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

For npm-managed installs, that `.env` creation step is config setup, not full provider-readiness proof. Before treating the global-install path as ready, follow the audit and proof gate that matches the runtime path you actually plan to use: [docs/audit/claude-npm-managed-path.md](audit/claude-npm-managed-path.md) for Claude, or [docs/audit/codex-npm-managed-path.md](audit/codex-npm-managed-path.md) for Codex and the optional OpenAI fast/alternate runtime path.

### From source (contributors / developers)

```bash
pnpm i
pnpm run setup # guided interactive setup
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

For the blessed Claude source-checkout validation path, keep one real clone-local `.env` in the checkout you are testing. `pnpm preflight:blank-machine` only reads that checkout's own `.env`; it does not inherit runtime config from your normal shell.

If you are validating from a machine that already has DiscoClaw or Claude state, isolate `DISCOCLAW_DATA_DIR`, `WORKSPACE_CWD`, `GROUPS_DIR`, and `BEADS_DIR` to throwaway paths before you claim fresh-clone or stranger-path evidence. If you copied an existing maintainer `.env` or another provider's config, force `PRIMARY_RUNTIME=claude-cli` before auditing the blessed Claude path.

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

1. **Provider baseline installed or selected intentionally:**
   Run the command for the provider path you plan to use:
   ```bash
   claude --version
   ```
   or
   ```bash
   codex --version
   ```
   Expected:
   - If you plan to use Claude, `claude --version` should print a version string `>= 2.1.0`.
   - If you plan to use Codex, `codex --version` should print a version string.
   - If you plan to use the OpenAI adapter, there is no local CLI baseline, but `OPENAI_API_KEY` presence alone is still not proof of runtime readiness.
   - If you plan to use the OpenRouter adapter, there is no local CLI baseline, and `OPENROUTER_API_KEY` presence alone is still not proof of runtime readiness.

2. **Node (and pnpm for contributors):**
   ```bash
   node --version   # should be v20+
   pnpm --version   # should be v10+ (from source only; not required for global install)
   ```

3. **Environment file exists:**
   - **Global install:** the `discoclaw init` wizard creates `.env` automatically — nothing to do here.
   - **From source:** `test -f .env && echo "ok" || echo "missing — run: cp .env.example .env"`
   - **Blessed Claude source-checkout audit:** do not skip this. A fresh clone without a real clone-local `.env` does not satisfy `pnpm preflight:blank-machine`, because that command only reads the checkout's own `.env`.

4. **Install-mode-specific provider proof gate:**
   - Before following a provider-specific path below, read the consolidated [provider/auth 1.0 matrix](audit/provider-auth-1.0-matrix.md). It is the authoritative verdict for which paths are the blessed default, the supported secondary path, and which current paths remain `PARTIAL` or `OUT OF SCOPE`.
   - **Any install mode + OpenAI or Gemini path:**
     - Use the matrix above first.
     - `openai` remains a narrower manual/proof-gated path rather than a blanket one-command setup claim.
     - `discoclaw init` scaffolds `gemini-api` as the Gemini runtime path.
   - **Global install (`npm install -g discoclaw`) + Claude path:**
     - Read [docs/audit/claude-npm-managed-path.md](audit/claude-npm-managed-path.md).
     - Run:
       ```bash
       discoclaw claude auth-smoke
       ```
     - Treat a successful result here as shell-level Claude auth evidence only.
   - **Global install (`npm install -g discoclaw`) + Codex path:**
     - Read [docs/audit/codex-npm-managed-path.md](audit/codex-npm-managed-path.md).
     - Follow its manual Codex session-auth gate with:
       ```bash
       codex exec -m gpt-5.4 --skip-git-repo-check --ephemeral -s read-only -- "Reply with OK"
       ```
     - If the install also routes fast/alternate work through OpenAI, do not stop at key presence alone; confirm the live runtime-visible `openai-key: ok` evidence described in that audit after startup.
   - **Global install (`npm install -g discoclaw`) + OpenRouter path:**
     - `discoclaw init` only writes the existing `OPENROUTER_API_KEY` env-key path.
     - Run `discoclaw doctor` if you want the shipped config/bootstrap check for this install mode.
     - Start DiscoClaw and confirm `!status` or the startup credential report shows `openrouter-key: ok`.
     - Treat `discoclaw doctor` as config-only and treat that live `openrouter-key: ok` signal as the current proof gate for npm-managed installs.
   - **From source + Claude path:**
     - Supply a real clone-local `.env` first. `pnpm preflight:blank-machine` ignores inherited shell env and only reads the checkout's own `.env`.
     - If you are auditing from a machine with existing DiscoClaw or Claude state, isolate `DISCOCLAW_DATA_DIR`, `WORKSPACE_CWD`, `GROUPS_DIR`, and `BEADS_DIR` to throwaway paths before you claim fresh-clone or stranger-path evidence.
     - If the source `.env` came from another provider path or an older maintainer copy, force `PRIMARY_RUNTIME=claude-cli` before testing this blessed path.
     - Run:
       ```bash
       pnpm preflight:blank-machine
       ```
     - If preflight fails, record the exact config issue and fix the clone-local `.env` before continuing. Example from the 2026-03-22 throwaway run: a copied legacy `.env` still had deprecated `RUNTIME_MODEL`, so preflight failed until that clone-local drift was removed.
     - From a shell or account with no active Claude session, run:
       ```bash
       pnpm claude:auth-smoke
       ```
     - Confirm the expected pre-login result contains `Claude CLI appears installed but not authenticated.`
     - Complete interactive login in that same shell or account:
       ```bash
       claude
       ```
     - Rerun in that same shell or account:
       ```bash
       pnpm claude:auth-smoke
       ```
     - Confirm the expected post-login result contains `Claude CLI answered the minimal prompt.`
     - Use the source-checkout readiness contract in [docs/audit/claude-blank-machine-readiness.md](audit/claude-blank-machine-readiness.md).
     - Only close the first-login stranger gate if the pre-login failure, interactive `claude` login, and post-login rerun all happened in that same no-session shell or account. If the passing smoke came from an already logged-in shell, keep the claim narrowed to `fresh-clone post-login path only`.
   - **From source + Codex path:**
     - Run:
       ```bash
       pnpm preflight:blank-machine
       ```
     - Then follow the Codex session-auth and optional OpenAI proof gates in [docs/audit/codex-blank-machine-readiness.md](audit/codex-blank-machine-readiness.md).
     - When source-checkout routing uses OpenAI, use the repo smoke harness rather than key presence alone:
       ```bash
       OPENAI_SMOKE_TEST_TIERS=fast pnpm test
       ```
   - **From source + OpenRouter path:**
     - Run:
       ```bash
       pnpm preflight:blank-machine
       ```
     - Treat `pnpm preflight:blank-machine` as setup/bootstrap evidence only for the OpenRouter path.
     - Start DiscoClaw and confirm `!status` or the startup credential report shows `openrouter-key: ok`.
     - If you need to claim an OpenRouter-backed workload from a source checkout, run the repo smoke harness against the exact OpenRouter-backed route or model you intend to use; that smoke path is the shipped workload-proof surface for this install mode.
   - Repo-owned source helpers such as `pnpm claude:auth-smoke` and `pnpm discord:smoke-test` are unavailable in the published npm package by design; `package.json.files` ships the compiled CLI and selected docs/assets, not the repo `scripts/` tree.
   - If you plan to use `discoclaw install-daemon`, note the current service caveat: the installer writes a service that uses `/usr/bin/node` and a fixed service `PATH`, so the daemon can still diverge from the interactive shell you just validated. Verify service logs before assuming daemon parity.

   > **From source only — steps 5 and 6 below use repo smoke harnesses not available to global-install users. If you installed via `npm install -g discoclaw`, finish step 4 and continue to step 7.**

5. **From source: Discord smoke test (bot token + connection):**
   ```bash
   pnpm discord:smoke-test
   ```
   Expected: `Discord bot ready`. If it hangs or errors, double-check `DISCORD_TOKEN` in `.env`.

6. **From source: Discord smoke test with guild verification:**
   ```bash
   pnpm discord:smoke-test -- --guild-id <YOUR_SERVER_ID>
   ```
   Expected: `Discord bot ready (guild ok: ...)`.

7. **Live test:**
   - DM the bot → it should respond (if your user ID is in `DISCORD_ALLOW_USER_IDS`).
   - Post in an allowlisted channel → it should respond.
   - Post in a non-allowlisted channel → it should **not** respond.

8. **Channel context auto-scaffold (optional):**
   - Create a new channel and post once. DiscoClaw should auto-create a stub context file under `content/discord/channels/` and add it to `content/discord/DISCORD.md`.

## Canvas Activities (optional)

Canvas lets DiscoClaw launch interactive HTML artifacts (calculators, charts, diffs, dashboards) as Discord Activities — panels that open inside the Discord client.

Start by opting in explicitly:
- Set `DISCOCLAW_CANVAS_ENABLED=1` in `.env`.
- Restart the bot.
- Then complete the manual Discord setup below.

Canvas is experimental and disabled by default. Fresh installs and upgraded installs both require that explicit opt-in. If you were already using canvas before this default changed, add `DISCOCLAW_CANVAS_ENABLED=1` explicitly to keep it available after upgrading.

If you skip this section, the bot will still work normally without canvas. Interactive canvas launches stay unavailable until you opt in, and explicit canvas requests surface setup guidance instead of opening an Activity.

### Prerequisites

1. **Add a URL Mapping manually in the Developer Portal** — In the Developer Portal, open your application → **Activities** → add a URL Mapping:
   - **Prefix:** `/`
   - **Target:** your public HTTPS endpoint that reaches the canvas server (default `127.0.0.1:9402`)

   The canvas server listens on localhost. Discord needs a publicly reachable HTTPS URL to load the Activity iframe. Options for exposing it:
   - **Tailscale Funnel** (recommended for private use): `tailscale funnel --bg 9402`
   - **ngrok**: `ngrok http 9402`
   - **Caddy reverse proxy**: see `docs/webhook-exposure.md` for a similar pattern

   Use the resulting public URL as the URL Mapping target.

2. **Enable Activities manually in the Developer Portal** — Still in the Activities section, toggle Activities on. (Discord requires the URL Mapping before it allows enabling Activities.)

   Optionally, check **iOS** and **Android** under **Supported Platforms** on the same page if you want canvas to work on mobile Discord. Only **Web** is enabled by default.

That's it. No OAuth client secret or redirect URI is required — DiscoClaw uses pre-authenticated activity context by default.

### Optional: OAuth authentication

If you prefer full OAuth verification (instead of the default pre-auth flow), also:
- Add `https://127.0.0.1` as an OAuth redirect URI in the Developer Portal.
- Set `DISCORD_ACTIVITY_CLIENT_SECRET` in `.env` to the application's client secret.

### Verification

After setting `DISCOCLAW_CANVAS_ENABLED=1`, completing setup, and restarting the bot, ask it to launch a canvas (e.g. "make me a calculator"). The bot should post a button; clicking it should open the Activity panel.

If the button shows "Discord rejected the Activity launch request", Activities are not enabled on the application — revisit step 1 above.

### Before This Should Become Default Again

- Developer Portal work is still manual. DiscoClaw can tell you what to configure, but it does not create the URL Mapping or enable Activities for you.
- Public HTTPS exposure is still required. The local readiness checks only verify local prerequisites; Discord still needs a reachable external HTTPS endpoint for the Activity iframe.
- Current readiness/setup checks are intentionally limited. DiscoClaw verifies local prerequisites and returns static external setup instructions, but it does not validate your Developer Portal configuration or your public HTTPS exposure end-to-end.

### Configuration

Canvas-related environment variables (all optional, sensible defaults):

- `DISCOCLAW_CANVAS_ENABLED` — Opt-in master switch for the experimental canvas subsystem (default: `false`; set to `1` to opt in, and set it explicitly on upgraded installs if you want to keep canvas enabled)
- `DISCOCLAW_CANVAS_PORT` — Canvas server port (default: `9402`)
- `DISCOCLAW_CANVAS_WRITE_BRIDGE_ENABLED` — Allow artifacts to export files to disk (default: `true`)
- `DISCOCLAW_CANVAS_MAX_ARTIFACTS` — LRU artifact cap (default: `1000`)

See `docs/configuration.md` and `.env.example.full` for the full list.

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
