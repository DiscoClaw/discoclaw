---
name: discoclaw-discord-bot-setup
description: Create and invite a DiscoClaw Discord bot to a server, configure required intents/permissions, and generate/verify local .env settings for DiscoClaw. Use when setting up DiscoClaw for a new user/server, rotating bot tokens, debugging why the bot cannot read messages (Message Content Intent), or when generating an invite URL for a given client ID.
---

# DiscoClaw Discord Bot Setup

Keep this workflow safe and minimal: no secrets in git, fail-closed allowlists, and smallest required Discord permissions.

Safety disclaimer:
- Recommended: create a **standalone private Discord server** for DiscoClaw.
- Prefer **least privilege** permissions; avoid `Administrator` unless you explicitly need it.
- Keep `DISCORD_ALLOW_USER_IDS` and `DISCORD_CHANNEL_IDS` tight.

## Create Bot (Developer Portal)

1. Create application -> add bot.
2. Enable **Message Content Intent** (required for `GatewayIntentBits.MessageContent` to work in guilds).
3. Copy token:
   - Paste it into `DISCORD_TOKEN` in `.env` immediately (never commit).
   - Clipboard tip: don’t copy the Application/Client ID until after you’ve pasted the token, or you may overwrite it.
   - If the token is lost: reset it in the Developer Portal.
   - If rotating token: stop any running services first to avoid reconnect flapping.

## Invite Bot To Server

Preferred: use Discord Portal OAuth2 URL Generator.

Scopes:
- `bot`

Before generating an invite URL, **ask which permission profile they want**. Do not assume `minimal` unless they explicitly choose it (or they say they don’t care and you default to least-privilege).

Permission profiles (offer these options explicitly):
- `minimal` (recommended): View Channels, Send Messages, Send Messages in Threads, Read Message History
- `threads`: minimal + create/manage threads
- `moderator`: broad ops (manage channels/threads/messages/webhooks; not full admin)
- `admin`: `Administrator` permission (high risk; only use on a private server you control)

If they pick `admin`, require an explicit confirmation. Keep the warning to 1-2 short sentences that end with a period (avoid trailing clauses that can get clipped in UI). Example: "Admin grants full server control. Only use on a private server you control. Proceed?"

Optionally generate an invite URL via repo script:

```bash
pnpm discord:invite-url -- --client-id <CLIENT_ID> --profile minimal
pnpm discord:invite-url -- --client-id <CLIENT_ID> --profile minimal --guild-id <GUILD_ID> --disable-guild-select 1
```

Permission options (recommended to pick explicitly):
- Minimal (reply + read + reply in threads):
  - `pnpm discord:invite-url -- --client-id <CLIENT_ID> --profile minimal`
- Threads (create/archive/delete threads):
  - `pnpm discord:invite-url -- --client-id <CLIENT_ID> --profile threads`
- Moderator (manage channels/threads/messages/webhooks; not full admin):
  - `pnpm discord:invite-url -- --client-id <CLIENT_ID> --profile moderator`
- Admin (Administrator permission; high risk):
  - `pnpm discord:invite-url -- --client-id <CLIENT_ID> --profile admin`

Profile ramifications:
- `minimal`: least privilege; good for public/shared servers; more likely to hit "I can't do X" for admin tasks. Discord Actions (`DISCOCLAW_DISCORD_ACTIONS=1`) will not work — the bot lacks Manage Channels.
- `threads`: adds thread creation/management; higher risk than minimal; still not server admin. Discord Actions will not work.
- `moderator`: broad ops; meaningful blast radius; still safer than full admin. **Required for Discord Actions** (channel create/list) — includes Manage Channels.
- `admin`: least operational friction; highest blast radius if token/runtime compromised.

If you want slash commands, add the scope:
```bash
pnpm discord:invite-url -- --client-id <CLIENT_ID> --profile minimal --app-commands 1
```

Note: Discord does not expose the same full-text “search like the client” via the public bot API; if you want search, you generally need to log/index messages yourself.

## Configure DiscoClaw `.env`

Two setup tracks:

- **Global install (end users):** Run `discoclaw init` — interactive wizard creates and configures `.env`.
- **From source (contributors):** Run `pnpm setup` for guided interactive setup, or:
  `cp .env.example .env` (essentials) / `cp .env.example.full .env` (all options)

Key variables to set:
- `DISCORD_TOKEN=...`
- `DISCORD_ALLOW_USER_IDS=...` (required; empty means respond to nobody)
- `DISCORD_CHANNEL_IDS=...` (recommended for servers; keep minimal)
- `DISCOCLAW_DATA_DIR=...` (optional; content defaults under this)

Validation:
- Prefer `pnpm discord:smoke-test` (exits 0 after "Discord bot ready") to validate the token/auth without long-running processes/timeouts.
- If they want to confirm the bot is actually in their server, ask for the server (guild) ID and run:
  - `pnpm discord:smoke-test -- --guild-id <GUILD_ID>`
- Then `pnpm dev` for the real run.
- Confirm it responds only in allowlisted contexts.

Threads:
- If they want the bot to reliably reply inside threads, set `DISCORD_AUTO_JOIN_THREADS=1`.
- Private threads still require explicitly adding the bot to the thread.
- If they want to join all active public threads in a server, run:
  - `pnpm discord:join-threads -- --guild-id <GUILD_ID> --apply 1`

## Common Failures

- Bot responds to nobody:
  - `DISCORD_ALLOW_USER_IDS` is empty or malformed.
- Bot can't see message content in servers:
  - Message Content Intent not enabled in Developer Portal.
  - Or bot lacks permission to view/read the channel.
- Discord Actions fail with "Missing Permissions":
  - Bot was invited with `minimal` or `threads` profile (no Manage Channels).
  - Fix: re-invite with `moderator` profile, or grant Manage Channels to the bot's role via Server Settings → Roles.
