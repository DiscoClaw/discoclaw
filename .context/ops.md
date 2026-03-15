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
