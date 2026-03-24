# automations.md — Cron & Scheduled Tasks

Quick-reference for automation behavior. For full primitive docs see
[docs/cron.md](../docs/cron.md); for worked examples and copy-pasteable recipes
see [docs/cron-patterns.md](../docs/cron-patterns.md).

## System Overview

Cron jobs are defined as forum threads in a dedicated Discord forum channel.
The scheduler registers in-process timers (via `croner`); on each tick the
executor assembles a prompt, invokes the AI runtime, and posts output to a
target channel.

Source: `src/cron/` — scheduler, executor, parser, forum sync, run stats,
job lock, chain, tag map.

## Job Lifecycle

| Thread state | Job state |
|--------------|-----------|
| Active | Registered and running |
| Archived | Paused (unregistered) |
| Unarchived | Resumed (re-registered) |
| Deleted | Removed; stats cleaned on next startup |

Jobs must be created through the bot (`cronCreate` action), not by manually
creating forum threads.

## Trigger Types

- **`schedule`** — standard 5-field cron expression
- **`webhook`** — external HTTP POST (requires `DISCOCLAW_WEBHOOK_ENABLED=true`)
- **`manual`** — explicit `cronTrigger` action only

## Key Primitives

| Primitive | Purpose |
|-----------|---------|
| `{{state}}` / `<cron-state>` | Persistent per-job key-value state across runs |
| `silent` mode | Suppress posting when output is a sentinel (`HEARTBEAT_OK` or `[]`) |
| `routingMode: "json"` | Multi-channel dispatch via JSON array of `{channel, content}` |
| `allowedActions` | Restrict which Discord action types a job may emit |
| `chain` | Fire downstream jobs on success, forwarding state via `__upstream` |
| `model` | Per-job model tier override (`fast` / `capable` / `deep`) |

## Safety Rails

- Cron jobs **cannot emit cron actions** — hard-coded, not configurable.
- Overlap guard: one execution per job at a time; concurrent ticks are skipped.
- Chain depth limit: **10** (prevents runaway cascades).
- Cycle detection at write time (BFS reachability check).
- `allowedActions` narrows only — cannot grant permissions the global config denies.

## State Essentials

- `<cron-state>` **replaces** the full state object (not a merge).
- `{{state}}` expands to `{}` on first run or after a reset.
- Reset state: `cronUpdate` with `state: "{}"`.
- The executor injects a "Persistent State" section capped at 4 000 chars.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `DISCOCLAW_CRON_ENABLED` | `true` | Enable the cron subsystem |
| `DISCOCLAW_CRON_FORUM` | — | Forum channel ID (auto-created if unset) |
| `DISCOCLAW_CRON_EXEC_MODEL` | `capable` | Default model tier for execution |
| `DISCOCLAW_CRON_MODEL` | `fast` | Model tier for definition parsing |
| `DISCOCLAW_CRON_AUTO_TAG` | `true` | Auto-tag cron forum threads |
| `DISCOCLAW_CRON_STATS_DIR` | — | Override stats storage directory |
| `DISCOCLAW_CRON_TAG_MAP` | — | Override tag map file path |
| `DISCOCLAW_WEBHOOK_ENABLED` | `false` | Enable the webhook server |
| `DISCOCLAW_WEBHOOK_CONFIG` | — | Path to webhook config JSON |

## Common Patterns (cheat sheet)

| Pattern | Key technique |
|---------|---------------|
| Stateful polling | `{{state}}` cursor + `<cron-state>` update |
| Silent monitoring | `silent: true` + `HEARTBEAT_OK` sentinel |
| Multi-channel fan-out | `routingMode: "json"` |
| Chained pipelines | `chain` field + `__upstream.state` handoff |
| Accumulation / rollup | State counter resets on cadence boundary |
| Webhook-triggered | Config file + HMAC-SHA256 verification |
| Gated actions | `allowedActions` for least-privilege |

See [docs/cron-patterns.md](../docs/cron-patterns.md) for full examples of each.

## Data Directory

Cron data lives in `data/cron/`:

| File/Dir | Contents |
|----------|----------|
| `cron-run-stats.json` | Per-job run statistics: run count, last run time/status, schedule, model, channel, projection state. Rewritten on every run completion. |
| `tag-map.json` | Maps tag names (e.g. `report`, `monitor`) to Discord forum tag snowflake IDs. Used for auto-tagging cron threads. |
| `locks/` | Per-job lock directories. Each active job gets `<sanitized-id>.<hash>.lock/meta.json`. Prevents overlap (concurrent execution of the same job). |

### Lock directory format
Each lock dir contains a `meta.json`:
```json
{"pid":12345,"token":"a1b2c3...","acquiredAt":"2026-03-24T15:00:00.009Z","startTime":45779798}
```
- `pid` — PID of the process holding the lock
- `token` — random token for safe release (prevents cross-process release)
- `startTime` — Linux `/proc/<pid>/stat` field 22 (jiffies); detects PID reuse

### Exact commands for data inspection
```bash
# View all job stats
jq . data/cron/cron-run-stats.json

# List jobs and their last run status
jq '.jobs | to_entries[] | {id: .key, status: .value.lastRunStatus, lastRun: .value.lastRunAt}' data/cron/cron-run-stats.json

# Check for stuck locks
ls -la data/cron/locks/

# Inspect a specific lock
cat data/cron/locks/*.lock/meta.json 2>/dev/null

# Check if a locked PID is still alive
for meta in data/cron/locks/*.lock/meta.json; do
  pid=$(jq -r .pid "$meta" 2>/dev/null)
  kill -0 "$pid" 2>/dev/null && echo "$meta: PID $pid alive" || echo "$meta: PID $pid STALE"
done

# View the tag map
jq . data/cron/tag-map.json

# Check run stats file size (large = many jobs or accumulating history)
ls -lh data/cron/cron-run-stats.json
```

## Known Footguns

- **`<cron-state>` replaces, does not merge:** If a job's state is `{"cursor": "abc", "count": 5}` and the AI outputs `<cron-state>{"cursor": "def"}</cron-state>`, the `count` key is lost. The AI must echo back all keys it wants to keep.
- **Manual thread creation is ignored:** Jobs must be created via the `cronCreate` action. Manually creating a forum thread will not register a job — the thread will sit inert. Use `cronCreate` or ask the bot to create it.
- **Archiving ≠ deleting:** The `cronDelete` action archives the thread (reversible). The job stops, but history is preserved. Actual thread deletion is permanent and removes all messages.
- **Chain depth silently caps at 10:** If a chain exceeds 10 hops, execution stops with no visible error in the target channel. Check the bot logs for `chain depth limit reached`.
- **Webhook jobs require `DISCOCLAW_WEBHOOK_ENABLED=true`:** Defining a webhook-triggered job without enabling the webhook server means the job exists but can never fire. No warning is logged at startup.
- **Timezone defaults to system timezone:** If `DEFAULT_TIMEZONE` is unset and the server's system timezone is UTC, all cron schedules without explicit timezones run in UTC. This catches people who expect local time.
- **Cron config changes in `.env` require restart:** Changing `DISCOCLAW_CRON_ENABLED`, `DISCOCLAW_CRON_FORUM`, or `DEFAULT_TIMEZONE` in `.env` has no effect until the service is restarted (`systemctl --user restart discoclaw.service`). The cron subsystem reads config once at startup.
- **`dist/` must be rebuilt for cron code changes:** Cron executor, parser, and scheduler code lives in `src/cron/`. After modifying these files, `pnpm build` must be run and the service restarted — the systemd service runs `dist/index.js`, not `src/`.

## Common Failure Modes

### Cron job not firing on schedule
**Symptom:** Job was created and confirmed, schedule looks correct, but no output appears at the expected time.
**Cause (in order of likelihood):**
1. Thread is archived (job is paused).
2. Timezone mismatch — job runs in UTC but user expects local time.
3. Previous run is still active (overlap guard skipped this tick).
4. `DISCOCLAW_CRON_ENABLED` is `0` or `DISCOCLAW_CRON_FORUM` is unset.
5. Service is in `failed` state after crash loop — cron timers are not running.
**Recovery:**
```bash
# First: is the service even running?
systemctl --user status discoclaw.service
# If "failed (Result: start-limit-hit)":
systemctl --user reset-failed discoclaw.service
systemctl --user start discoclaw.service

# Check if the thread is archived (in Discord, archived threads are hidden by default)
# Use the cronList action to see all jobs and their states

# Check bot logs for skip reasons
journalctl --user -u discoclaw.service --since "1 hour ago" --no-pager | grep -i "cron\|skip\|overlap"

# Verify cron config
grep -E 'DISCOCLAW_CRON_ENABLED|DISCOCLAW_CRON_FORUM|DEFAULT_TIMEZONE' .env

# Verify timezone
timedatectl | grep "Time zone"
```

### Cron job fires but output goes to wrong channel
**Symptom:** Job runs successfully but posts to the wrong Discord channel or to no channel.
**Cause:** The AI parsed the target channel incorrectly from the natural-language definition, or the channel ID in the parsed config is stale (channel was deleted/renamed).
**Recovery:**
```bash
# Use cronShow to inspect the parsed config
# Ask the bot: "show cron <job-name>"
# Check the targetChannel field

# Update by editing the starter message in the forum thread, then:
# Ask the bot: "trigger cron <job-name>" to test the new config
```

### State corruption — job keeps repeating or skipping work
**Symptom:** A stateful polling job re-processes old items, or skips new ones.
**Cause:** The AI's `<cron-state>` output replaced state instead of merging, or the state hit the 4000-char injection cap and was truncated.
**Recovery:**
```bash
# Check current state via cronShow
# Reset state by asking the bot:
# "update cron <job-name> with state {}"

# Or reset to a specific cursor:
# "update cron <job-name> with state {\"cursor\": \"known-good-value\"}"
```

### Cron job stuck — overlap guard never releases
**Symptom:** A job ran once and now never fires again. Logs show `Lock held by PID XXXXX` on every tick.
**Cause:** The previous execution crashed without releasing its lock in `data/cron/locks/`. The lock dir persists with a `meta.json` pointing to a dead (or reused) PID. Stale-lock detection usually catches this, but can fail if `/proc/<pid>/stat` is unreadable or the PID was reused by a long-lived process.
**Recovery:**
```bash
# List all lock dirs
ls -la data/cron/locks/

# Find the stuck lock (match the cron ID from the log message)
# Lock dirs are named <sanitized-id>.<hash>.lock
cat data/cron/locks/*.lock/meta.json 2>/dev/null

# Check if the PID is alive
kill -0 <pid> 2>/dev/null && echo "alive" || echo "stale"

# If stale: remove the lock dir, the next tick will acquire fresh
rm -rf data/cron/locks/<lock-dir-name>.lock

# If the PID is alive but belongs to a different process (PID reuse):
# compare the startTime in meta.json with /proc/<pid>/stat field 22
cat /proc/<pid>/stat | awk '{print $22}'
# If they differ, the lock is stale — safe to remove
```

### Chain cascade — downstream jobs keep firing
**Symptom:** A chained pipeline fires repeatedly or produces unexpected output.
**Cause:** Cycle in the chain graph (should be caught at write time, but can occur if jobs were edited after initial creation without re-validation).
**Recovery:**
```bash
# Check logs for chain-related entries
journalctl --user -u discoclaw.service --since "30 min ago" --no-pager | grep -i "chain"

# Break the cycle by removing the chain field from the looping job:
# "update cron <job-name> with chain: none"
# Then re-architect the chain graph
```
