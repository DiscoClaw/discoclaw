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
