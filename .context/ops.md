# ops.md — Operations

## systemd (user service suggested)

Template unit: `systemd/discoclaw.service`

Common commands:
```bash
systemctl --user daemon-reload
systemctl --user restart discoclaw.service
systemctl --user status discoclaw.service
journalctl --user -u discoclaw.service -f
```

Build/deploy reminder:
- The service runs `dist/index.js`, so run `pnpm build` after code changes.

## Runtime Working Directory
- Default `WORKSPACE_CWD`:
  - `$DISCOCLAW_DATA_DIR/workspace` when `DISCOCLAW_DATA_DIR` is set
  - `./workspace` otherwise
- Optional group CWD: `USE_GROUP_DIR_CWD=1` and `GROUPS_DIR=...`

## PID Lock (Startup Guard)
- On startup, DiscoClaw writes its PID to `data/discoclaw.pid` and checks for an existing lock.
- If another live process holds the lock, startup is refused with an error.
- Stale locks (from `SIGKILL` or crashes) are detected via `kill(pid, 0)` and automatically overwritten.
- On `SIGTERM` or `SIGINT`, the lock file is released before exit.
- Implementation: `src/pidlock.ts`

## Safety
- Prefer running new behavior in a private channel first.
- Keep allowlist strict; do not run with an empty allowlist.
- Consider setting `DISCORD_CHANNEL_IDS` to limit where the bot can respond in guilds.
- Treat `WORKSPACE_CWD` as the boundary of what the runtime can read/write (especially with `CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=1`).
- Keep secrets out of the workspace; `.env` stays local and uncommitted.
- Watch logs during changes: `journalctl --user -u discoclaw.service -f` (or `pnpm dev` output in dev).

## Rollout Checklist
Preflight:
- Confirm legacy bots/gateways are stopped/disabled on this host. (The PID lock in `data/discoclaw.pid` will prevent a second discoclaw instance, but won't catch a different bot using the same token.)
- Confirm `.env` has `DISCORD_TOKEN` and a non-empty `DISCORD_ALLOW_USER_IDS` (fail-closed otherwise).
- If running in a server/guild, set `DISCORD_CHANNEL_IDS` to the minimum set of channels.
- Confirm `DISCORD_REQUIRE_CHANNEL_CONTEXT=1` and `DISCORD_AUTO_INDEX_CHANNEL_CONTEXT=1`.
- Run `pnpm sync:discord-context` to ensure channel context stubs exist and strip stale Includes blocks.
- *(Optional)* If browser automation is desired, confirm `agent-browser` is installed and on `PATH`.

Deploy:
- `pnpm build`
- `systemctl --user daemon-reload`
- `systemctl --user restart discoclaw.service`
- Tail logs: `journalctl --user -u discoclaw.service -f`

Validation:
- DM the bot (should respond only if allowlisted).
- Post in an allowlisted channel (should respond, and should read PA modules + channel context).
- Post in a non-allowlisted channel (should not respond).
- Create a new channel and post once (should auto-index + create a stub context file).
- If `DISCOCLAW_STATUS_CHANNEL` is set, confirm a green "Bot Online" embed appears on startup and a gray "Bot Offline" embed on shutdown.

## Known Footguns

- **Forgetting `daemon-reload`:** Editing `systemd/discoclaw.service` without running `systemctl --user daemon-reload` means systemd uses the stale cached unit. The restart will succeed but run the old config. Always reload before restart.
- **`systemctl --user` vs `sudo systemctl`:** DiscoClaw uses a *user* service. Running `sudo systemctl restart discoclaw.service` targets the system scope and will fail with "Unit discoclaw.service not found." Always use the `--user` flag.
- **Building after deploy:** The service runs `dist/index.js`. If you `systemctl --user restart` without running `pnpm build` first, the old compiled JS runs — your code changes are silently missing.
- **Lingering gateway session:** If a previous bot instance (or another bot) used the same `DISCORD_TOKEN`, Discord may still have an active gateway session. The new instance can connect but may miss events for 30-60 seconds until the old session times out. Stop the old process first, then start the new one.
- **Empty allowlist on first deploy:** If `.env` is missing `DISCORD_ALLOW_USER_IDS` or the value is blank, the bot starts successfully but silently ignores every message. Logs show no errors — check the allowlist first.

## Common Failure Modes

### Service won't start — "Address already in use" or PID lock refused
**Symptom:** `systemctl --user start discoclaw.service` exits immediately. Journal shows `pidlock: another instance is running (pid XXXXX)`.
**Cause:** A previous instance is still running, or crashed without releasing the lock.
**Recovery:**
```bash
# Check if the PID in the lock file is actually alive
cat data/discoclaw.pid
kill -0 $(cat data/discoclaw.pid) 2>/dev/null && echo "alive" || echo "stale"

# If stale — just restart; the lock auto-clears on stale detection
systemctl --user restart discoclaw.service

# If alive — stop the running instance first
systemctl --user stop discoclaw.service
systemctl --user start discoclaw.service
```

### Service starts but bot never comes online in Discord
**Symptom:** `systemctl --user status discoclaw.service` shows active/running, but the bot never appears online. No "Bot Online" in the status channel.
**Cause:** Invalid or expired `DISCORD_TOKEN`, or network issue.
**Recovery:**
```bash
# Check recent logs for auth errors
journalctl --user -u discoclaw.service -n 30 --no-pager

# Look for: "An invalid token was provided" or "Used disallowed intents"
# Fix: regenerate token in Discord Developer Portal, update .env, restart
```

### Service runs but bot ignores messages
**Symptom:** Bot shows as online in Discord but never responds to any messages.
**Cause:** Usually one of: empty allowlist, channel restriction mismatch, or missing channel context.
**Recovery:**
```bash
# Dump resolved config at startup to verify env loading
DISCOCLAW_DEBUG_RUNTIME=1 systemctl --user restart discoclaw.service
journalctl --user -u discoclaw.service -n 50 --no-pager

# Check these in order:
# 1. DISCORD_ALLOW_USER_IDS — must contain your Discord user ID
# 2. DISCORD_CHANNEL_IDS — if set, must include the channel you're posting in
# 3. DISCORD_REQUIRE_CHANNEL_CONTEXT — if 1, channel context file must exist
```

### Rollback to previous version
**Recovery:**
```bash
# Find the last known-good commit
git log --oneline -10

# Reset to it (keeps .env and data/ untouched)
git checkout <commit-hash> -- .
pnpm build
systemctl --user restart discoclaw.service
journalctl --user -u discoclaw.service -n 20 --no-pager
```

### systemd environment differs from shell
**Symptom:** Bot works with `pnpm dev` but behaves differently (wrong model, missing tools) under systemd.
**Cause:** systemd user services don't load `.bashrc` or shell profiles. The `.env` must be loaded by the service unit.
**Recovery:**
```bash
# Verify what env the service actually sees
DISCOCLAW_DEBUG_RUNTIME=1 systemctl --user restart discoclaw.service
journalctl --user -u discoclaw.service --since "1 min ago" --no-pager | head -30

# Compare with local dev
DISCOCLAW_DEBUG_RUNTIME=1 pnpm dev
# If they differ, check the EnvironmentFile= line in the .service unit
```
