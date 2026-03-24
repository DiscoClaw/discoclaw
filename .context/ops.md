# ops.md — Operations

## systemd (user service suggested)

Template unit: `systemd/discoclaw.service`

Common commands:
```bash
systemctl --user daemon-reload                    # reload unit files after editing .service
systemctl --user restart discoclaw.service        # stop + start (picks up new env/unit)
systemctl --user stop discoclaw.service           # graceful stop (releases PID lock)
systemctl --user start discoclaw.service          # start (fails if already running)
systemctl --user status discoclaw.service         # show state, PID, last log lines
systemctl --user reset-failed discoclaw.service   # clear "failed" state so restarts work again
journalctl --user -u discoclaw.service -f         # tail live logs
journalctl --user -u discoclaw.service -n 50      # last 50 lines
journalctl --user -u discoclaw.service --since "10 min ago"  # recent window
```

Build/deploy reminder:
- The service runs `dist/index.js`, so run `pnpm build` after code changes.
- TypeScript's `tsc` writes to `dist/` incrementally — renamed/deleted source files leave stale `.js` in `dist/`. When in doubt: `rm -rf dist && pnpm build`.

## Runtime Working Directory
- Default `WORKSPACE_CWD`:
  - `$DISCOCLAW_DATA_DIR/workspace` when `DISCOCLAW_DATA_DIR` is set
  - `./workspace` otherwise
- Optional group CWD: `USE_GROUP_DIR_CWD=1` and `GROUPS_DIR=...`

## PID Lock (Startup Guard)
- On startup, DiscoClaw creates a lock **directory** at `data/discoclaw.pid.lock/` containing `meta.json` (PID, token, timestamp, process start time). The directory-based lock uses `mkdir` for atomic acquisition.
- If another live process holds the lock, startup is refused with: `Another discoclaw instance is already running (PID XXXXX)`.
- Stale locks are detected via `kill(pid, 0)` and Linux `/proc/<pid>/stat` start-time comparison (catches PID reuse). Stale locks are automatically cleaned up and re-acquired.
- On `SIGTERM` or `SIGINT`, the lock directory is released (removed) before exit.
- A 2-second grace period prevents racing during initialization — if the lock dir exists but has no `meta.json` and is younger than 2 s, startup fails with `PID lock initializing`.
- Legacy flat-file locks (`data/discoclaw.pid`) are auto-migrated: if the flat file exists and the PID is dead, it's removed before the directory lock is attempted.
- Implementation: `src/pidlock.ts`

### `meta.json` format
```json
{"pid":4185760,"token":"2e5751c27d8f2b35369f211708b204e6","acquiredAt":"2026-03-24T22:36:12.793Z","startTime":45779798}
```
- `pid` — process ID of the lock holder
- `token` — random hex token; only the holder can release its own lock
- `acquiredAt` — ISO timestamp of lock acquisition
- `startTime` — Linux `/proc/<pid>/stat` field 22 (jiffies since boot); used to detect PID reuse

### PID lock inspection commands
```bash
# Check who holds the lock
cat data/discoclaw.pid.lock/meta.json | jq .

# Is the holder alive?
kill -0 $(jq -r .pid data/discoclaw.pid.lock/meta.json) 2>/dev/null && echo "alive" || echo "stale"

# Verify startTime matches (detects PID reuse)
PID=$(jq -r .pid data/discoclaw.pid.lock/meta.json)
LOCK_ST=$(jq -r .startTime data/discoclaw.pid.lock/meta.json)
PROC_ST=$(awk '{print $22}' /proc/$PID/stat 2>/dev/null)
[ "$LOCK_ST" = "$PROC_ST" ] && echo "genuine" || echo "PID reused — lock is stale"

# Check lock directory age
stat data/discoclaw.pid.lock/meta.json
```

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
- **`reset-failed` not run after crash loop:** The service unit has `StartLimitBurst=3` / `StartLimitIntervalSec=600`. After 3 failures in 10 minutes, systemd marks the unit as `failed` and refuses all start/restart attempts. `systemctl --user status discoclaw.service` shows `failed (Result: start-limit-hit)`. You must run `systemctl --user reset-failed discoclaw.service` before the next start. This catches people who fix the root cause but forget to clear the failure counter.
- **Stale `dist/` after file renames:** `tsc` writes to `dist/` incrementally. If you rename or delete a `.ts` source file, the old `.js` persists in `dist/` and may be imported at runtime. The service appears to start fine but runs old or orphaned code. Fix: `rm -rf dist && pnpm build` before restart.
- **Editing `.env` without restarting the service:** Changes to `.env` take effect only on the next service start. The `EnvironmentFile=` directive reads `.env` once at startup. Running `systemctl --user reload` does NOT re-read the environment file (reload is not supported for `Type=simple` services). You must `systemctl --user restart discoclaw.service`.

## Common Failure Modes

### Service won't start — PID lock refused
**Symptom:** `systemctl --user start discoclaw.service` exits immediately. Journal shows `Another discoclaw instance is already running (PID XXXXX)`.
**Cause:** A previous instance is still running, or crashed without releasing the lock directory.
**Recovery:**
```bash
# Check the lock directory and its metadata
cat data/discoclaw.pid.lock/meta.json
# Shows: {"pid":12345,"token":"...","acquiredAt":"...","startTime":...}

# Check if the PID is actually alive
kill -0 $(jq -r .pid data/discoclaw.pid.lock/meta.json) 2>/dev/null && echo "alive" || echo "stale"

# If stale — just restart; the lock auto-clears on stale detection
systemctl --user restart discoclaw.service

# If alive — stop the running instance first
systemctl --user stop discoclaw.service
systemctl --user start discoclaw.service

# Nuclear option: if the lock dir is corrupt and auto-detection fails
rm -rf data/discoclaw.pid.lock
systemctl --user start discoclaw.service
```

### Service stuck in "failed" state — start-limit-hit
**Symptom:** `systemctl --user start discoclaw.service` returns `Unit discoclaw.service not found` or `Failed to start discoclaw.service: Unit discoclaw.service has a start rate limit, refusing to start.` `systemctl --user status` shows `failed (Result: start-limit-hit)`.
**Cause:** The service crashed 3 times within 10 minutes (`StartLimitBurst=3` / `StartLimitIntervalSec=600`), and systemd refuses further starts until the failure counter is cleared.
**Recovery:**
```bash
# Check why it crashed
journalctl --user -u discoclaw.service -n 50 --no-pager

# Fix the root cause first (missing .env, bad token, stale dist, etc.)

# Clear the failure counter
systemctl --user reset-failed discoclaw.service

# Now start works again
systemctl --user start discoclaw.service

# Verify it's running
systemctl --user status discoclaw.service
journalctl --user -u discoclaw.service -n 10 --no-pager
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

### Service running stale code after deploy
**Symptom:** Code changes were merged and `pnpm build` succeeded, but the bot's behavior hasn't changed. No errors in logs.
**Cause:** Either `dist/` contains stale artifacts from a renamed/deleted file, or `pnpm build` was skipped, or the service wasn't restarted.
**Recovery:**
```bash
# Full clean rebuild
rm -rf dist
pnpm build

# Restart the service
systemctl --user restart discoclaw.service

# Verify the running code matches — check the build timestamp
ls -la dist/index.js
# Compare with current time; should be within the last few minutes

# Verify in logs that the new behavior is active
journalctl --user -u discoclaw.service -n 20 --no-pager
```

### `.env` changes not taking effect
**Symptom:** You updated `.env` (new token, new channel IDs, new model) but the bot still uses the old values.
**Cause:** The systemd service reads `.env` only at start time via `EnvironmentFile=`. Editing the file has no effect on a running service. `systemctl --user reload` does nothing for `Type=simple` services.
**Recovery:**
```bash
# Restart is the only way to pick up .env changes
systemctl --user restart discoclaw.service

# Verify the new env is loaded
DISCOCLAW_DEBUG_RUNTIME=1 systemctl --user restart discoclaw.service
journalctl --user -u discoclaw.service --since "1 min ago" --no-pager | head -30
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
