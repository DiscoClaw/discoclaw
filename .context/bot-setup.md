# bot-setup.md — Discord Bot Setup (Agent Context)

> For the full human-facing setup guide, see `docs/discord-bot-setup.md`. This file is a brief reference for Claude when helping with bot setup tasks.

## Quick reference

1. **Developer Portal** → create application → Bot → enable **Message Content Intent** → copy token to `.env` (`DISCORD_TOKEN`).
2. **Invite** — quickest: `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot&permissions=0` (replace `CLIENT_ID`). For a permanent link with pre-set permissions, use the **Installation page** → set Install Link to "Discord Provided Link" → Default Install Settings → add scope `bot` and pick permissions (see profiles in `docs/discord-bot-setup.md`). The `bot` scope is required — `applications.commands` alone won't add the bot to a server.
3. **Configure `.env`**:
   - *Global install:* `discoclaw init` — wizard creates `.env` with `DISCORD_TOKEN`, `DISCORD_ALLOW_USER_IDS`, and `DISCORD_CHANNEL_IDS`.
   - *From source:* `pnpm setup` for guided configuration, or copy `.env.example` → `.env` and set `DISCORD_TOKEN`, `DISCORD_ALLOW_USER_IDS` (fail-closed if empty), `DISCORD_CHANNEL_IDS` (recommended).
4. **Validate**:
   - *Global install:* `discoclaw install-daemon` to register the systemd service, then DM the bot to confirm it responds.
   - *From source:* `pnpm dev`, DM the bot, post in allowed/disallowed channels.

## Exact Command Reference

### From source — setup and validation

```bash
# Guided interactive setup (creates .env)
pnpm setup

# Manual .env creation (essentials only)
cp .env.example .env

# Preflight check — validates env, token format, snowflake IDs, config doctor
pnpm preflight

# Preflight for a fresh clone (ignores shell env, reads only checkout .env)
pnpm preflight:blank-machine

# Discord smoke test — verifies bot token and gateway connection
pnpm discord:smoke-test

# Discord smoke test with guild membership check
pnpm discord:smoke-test -- --guild-id 123456789012345678

# Claude runtime auth check
pnpm claude:auth-smoke

# Start the bot in dev mode
pnpm dev
```

### Global install — setup and validation

```bash
# Interactive wizard — creates .env and workspace
discoclaw init

# Register as a user-level systemd service
discoclaw install-daemon

# Multi-instance: unique service name per instance
discoclaw install-daemon --service-name discoclaw-work

# Config/health check
discoclaw doctor

# Claude auth smoke test (npm-managed path)
discoclaw claude auth-smoke
```

### Discord smoke test arguments

```bash
# Print guild IDs the bot is in (useful for debugging guild-id mismatches)
pnpm discord:smoke-test -- --print-guilds

# Override timeout (default 12s)
DISCORD_SMOKE_TEST_TIMEOUT_MS=30000 pnpm discord:smoke-test
```

## Getting IDs

Discord client: Settings → Advanced → Developer Mode, then right-click a user/channel → Copy ID.

IDs are "snowflakes" — 17–20 digit numbers. The preflight check validates format:
```bash
# Preflight reports invalid snowflakes explicitly
pnpm preflight
# Example output: "DISCORD_ALLOW_USER_IDS contains invalid IDs: abc123"
```

## Known Footguns

- **Message Content Intent is invisible when missing.** If you skip enabling it in Developer Portal → Bot → Privileged Gateway Intents, the bot connects, appears online, and `msg.content` is silently empty in guild channels. No error is logged — the bot just ignores every guild message. DMs still work (they don't require the intent). This is the #1 setup failure mode.
- **`applications.commands` scope is not `bot` scope.** Using `scope=applications.commands` in the invite URL registers slash commands but does not add the bot to the server. The bot cannot connect, read messages, or respond. You must include `scope=bot` (or both).
- **Copying Application ID instead of Bot Token.** The Developer Portal shows the Application ID prominently on General Information. The Bot Token is on the Bot page. They look similar (long alphanumeric strings) but are not interchangeable. If you copy the Application ID into `DISCORD_TOKEN`, the bot fails at login with "An invalid token was provided."
- **Token revealed once, then hidden.** After creating the bot, the token is shown once. If you navigate away without copying it, you must click "Reset Token" to generate a new one — the old one is gone. Resetting invalidates the previous token immediately.
- **Empty `DISCORD_ALLOW_USER_IDS` = silent rejection.** The bot starts, connects, appears online, but responds to nobody. No error is logged. This is fail-closed by design, but it's surprising on first setup.
- **`DISCORD_CHANNEL_IDS` restricts guild channels only.** DMs always work regardless of this setting. If you set channel IDs and then test in a channel not in the list, the bot silently ignores you. Test in a listed channel or via DM.
- **`DISCORD_REQUIRE_CHANNEL_CONTEXT=1` (default) blocks unlisted channels.** Even if the channel is in `DISCORD_CHANNEL_IDS`, the bot won't respond in a guild channel without a matching context file under `content/discord/channels/`. Enable `DISCORD_AUTO_INDEX_CHANNEL_CONTEXT=1` (default) to auto-create stubs, or run `pnpm sync:discord-context` to scaffold them.
- **Role hierarchy blocks moderation actions.** The bot can only manage roles below its own role in Server Settings → Roles. If the bot role is at the bottom, actions like role assignment, timeout, and kick will fail with "Missing Permissions" even if the permission bits are granted.
- **Private threads require explicit addition.** The bot must be added to private threads manually regardless of its channel permissions. Public threads are auto-joined when `DISCORD_AUTO_JOIN_THREADS=1`.
- **Editing `.env.example` instead of `.env`.** `.env.example` is tracked in git and has no runtime effect. Your actual config is in `.env` (gitignored). A common mistake — changes to `.env.example` appear to do nothing.
- **`discoclaw install-daemon` PATH divergence.** The systemd service uses `/usr/bin/node` and a fixed `PATH`. The daemon may not find the same CLI binaries (e.g., `claude`, `codex`) that your interactive shell finds. Verify service logs after daemon install.

## Common Failure Modes

### Bot token rejected at login
**Symptom:** `pnpm dev` or the systemd service exits immediately. Logs show `Login failed: Error [TOKEN_INVALID]: An invalid token was provided.`
**Cause:** Wrong value in `DISCORD_TOKEN` — usually the Application ID was copied instead of the Bot Token, or the token was reset in the Developer Portal.
**Recovery:**
```bash
# Verify token is set and looks right (3 dot-separated base64url segments)
pnpm preflight

# If format is wrong: go to Developer Portal → Bot → Reset Token → copy new token
# Update .env:
#   DISCORD_TOKEN=<new-token>

# Verify again
pnpm preflight

# Restart
pnpm dev
```

### Bot online but ignores all guild messages (Message Content Intent)
**Symptom:** Bot appears online in Discord. DMs work. Guild channel messages are completely ignored — no response, no error in logs.
**Cause:** Message Content Intent not enabled in the Developer Portal. Without it, `msg.content` is empty for guild messages, so the bot sees every message as blank and drops it.
**Recovery:**
1. Go to Discord Developer Portal → your application → **Bot** → **Privileged Gateway Intents**
2. Enable **Message Content Intent**
3. Save Changes
4. Restart the bot:
```bash
# From source
pnpm dev

# Or systemd
systemctl --user restart discoclaw.service
```
No code or `.env` change is needed — this is purely a Developer Portal toggle.

### Bot online but ignores all messages (empty allowlist)
**Symptom:** Bot appears online. No response to DMs or guild messages. Logs show no errors.
**Cause:** `DISCORD_ALLOW_USER_IDS` is empty, missing, or set to a wrong user ID.
**Recovery:**
```bash
# Check what's configured
grep DISCORD_ALLOW_USER_IDS .env

# If empty or wrong: get your Discord user ID
# (Discord → Settings → Advanced → Developer Mode → right-click yourself → Copy ID)
# Update .env:
#   DISCORD_ALLOW_USER_IDS=123456789012345678

# Preflight validates the snowflake format
pnpm preflight

# Restart
pnpm dev
```

### Discord smoke test fails: "Used disallowed intents"
**Symptom:** `pnpm discord:smoke-test` exits with `Login failed: Error: Used disallowed intents`. Also appears in `journalctl` logs for the systemd service.
**Cause:** The bot requests `GatewayIntentBits.MessageContent` (a privileged intent) but the Developer Portal has it disabled.
**Recovery:** Same as "Bot online but ignores all guild messages" above — enable Message Content Intent in the Developer Portal. Then:
```bash
pnpm discord:smoke-test
# Expected: "Discord bot ready (guilds: N)"
```

### Discord smoke test fails: "guild_not_in_cache"
**Symptom:** `pnpm discord:smoke-test -- --guild-id <ID>` prints `Discord bot ready, but it does not appear to be in guild <ID>`.
**Cause:** The bot is not in that guild, or the guild ID is wrong.
**Recovery:**
```bash
# List guilds the bot is actually in
pnpm discord:smoke-test -- --print-guilds

# If the guild is missing: re-invite the bot to that server
# Use the invite URL from step 2 of the quick reference above

# If the guild ID is wrong: copy the correct one
# (right-click server name → Copy Server ID)
```

### Discord smoke test hangs then times out
**Symptom:** `pnpm discord:smoke-test` prints nothing for 12 seconds, then `Smoke test timed out after 12000ms`.
**Cause:** Network issue, firewall blocking Discord WebSocket, or the token is valid but the bot cannot establish a gateway connection.
**Recovery:**
```bash
# Increase timeout to rule out slow networks
DISCORD_SMOKE_TEST_TIMEOUT_MS=30000 pnpm discord:smoke-test

# If it still times out: check network/firewall
# Discord WebSocket connects to gateway.discord.gg on port 443
curl -s -o /dev/null -w "%{http_code}" https://discord.com/api/v10/gateway
# Expected: 200
```

### Preflight fails: "DISCORD_TOKEN format invalid"
**Symptom:** `pnpm preflight` reports `DISCORD_TOKEN format invalid: <reason>`.
**Cause:** Token is malformed — not three dot-separated base64url segments. Common when the Application ID was pasted, or extra whitespace/quotes were included.
**Recovery:**
```bash
# Check for accidental quotes or whitespace
grep DISCORD_TOKEN .env
# Must be: DISCORD_TOKEN=MTIz...abc (no quotes, no spaces)

# If the value looks wrong: regenerate in Developer Portal → Bot → Reset Token
# Paste the new token (no quotes around the value)
```

### Preflight fails: "DISCORD_ALLOW_USER_IDS contains invalid IDs"
**Symptom:** `pnpm preflight` reports specific IDs that are not valid snowflakes.
**Cause:** Non-numeric characters, a username instead of a numeric ID, or copy-paste artifacts (e.g., `<@123>` instead of `123`).
**Recovery:**
```bash
# Discord snowflakes are 17-20 digit numbers
# Get the correct ID: Discord → right-click user → Copy ID
# IDs are comma or space separated in .env:
#   DISCORD_ALLOW_USER_IDS=123456789012345678,987654321098765432
```

### Bot responds in DMs but not in guild channels
**Symptom:** DMs work. Guild channel messages are ignored. Message Content Intent is confirmed enabled.
**Cause:** `DISCORD_CHANNEL_IDS` is set but doesn't include the channel you're testing in, or `DISCORD_REQUIRE_CHANNEL_CONTEXT=1` and no context file exists for that channel.
**Recovery:**
```bash
# Check channel restrictions
grep DISCORD_CHANNEL_IDS .env
# If set: add the channel ID, or clear it to allow all channels

# Check channel context requirement
grep DISCORD_REQUIRE_CHANNEL_CONTEXT .env
# If 1: ensure a context file exists for the channel

# Auto-scaffold missing context files
pnpm sync:discord-context

# Or disable the requirement (not recommended for production)
#   DISCORD_REQUIRE_CHANNEL_CONTEXT=0
```

### Multi-instance: second instance uses wrong service name
**Symptom:** `!restart` or `!update apply` targets the wrong systemd unit. Or `discoclaw install-daemon --service-name X` doesn't take effect.
**Cause:** `DISCOCLAW_SERVICE_NAME` in `.env` doesn't match the name passed to `install-daemon`.
**Recovery:**
```bash
# Check what's in .env
grep DISCOCLAW_SERVICE_NAME .env

# Re-run install-daemon (it replaces the line in-place, never duplicates)
discoclaw install-daemon --service-name discoclaw-work

# Verify
grep DISCOCLAW_SERVICE_NAME .env
# Expected: DISCOCLAW_SERVICE_NAME=discoclaw-work

# Each instance needs its own working directory with its own .env
```

## Validation Checklist (quick)

After setup, run through these in order. Each step should pass before moving on.

```bash
# 1. Preflight — validates .env, token format, snowflake IDs
pnpm preflight               # from source
discoclaw doctor              # global install

# 2. Discord connection — verifies gateway login
pnpm discord:smoke-test      # from source only

# 3. Guild membership (optional)
pnpm discord:smoke-test -- --guild-id <YOUR_SERVER_ID>

# 4. Runtime auth (Claude path)
pnpm claude:auth-smoke        # from source
discoclaw claude auth-smoke   # global install

# 5. Live test — start the bot and interact
pnpm dev                      # from source
systemctl --user start discoclaw.service  # systemd

# Then in Discord:
# - DM the bot → should respond (if allowlisted)
# - Post in an allowlisted channel → should respond
# - Post in a non-allowlisted channel → should NOT respond
```
