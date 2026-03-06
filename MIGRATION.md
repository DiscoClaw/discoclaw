# Migration Guide

This document tracks breaking changes and migration steps for discoclaw operators upgrading between versions.

---

## agents → automations rename (PR #349)

**Affects:** Existing deployments with the cron/automations subsystem enabled.

### What changed

The "agents" terminology for scheduled cron tasks has been renamed to "automations" throughout the codebase, CLI, and Discord channel structure.

### What you need to do

**Nothing for env vars.** No environment variable keys were renamed. `DISCOCLAW_CRON_FORUM` is still the correct key.

**Discord channel is auto-migrated.** On next startup after pulling this change, the bot's bootstrap routine will automatically rename your `agents` forum channel to `automations`. No manual action required.

If you have `DISCOCLAW_CRON_FORUM=<channel-id>` set explicitly, that value remains valid — the channel ID does not change when the name is updated.

### Summary of renamed identifiers

| What | Before | After |
|------|--------|-------|
| Discord forum channel name | `agents` | `automations` |
| `.env.example` comment | `# Agents forum channel ID` | `# Automations forum channel ID` |
| Startup log warning | `no agents forum was resolved` | `no automations forum was resolved` |
| CLI / setup prompts | references to "agents" | references to "automations" |

No env var keys, no database schema changes, no API surface changes.

---

## workspace `DISCOCLAW.md` deprecation (tracked defaults + `AGENTS.md` override)

**Affects:** Existing deployments that previously customized `workspace/DISCOCLAW.md`.

### What changed

Default system instructions are no longer read from a workspace-managed
`workspace/DISCOCLAW.md` file. They now come from a tracked runtime-injected
defaults layer in the repository (`templates/instructions/SYSTEM_DEFAULTS.md`).

Prompt precedence is now deterministic:

1. immutable security policy
2. tracked defaults
3. tracked tools
4. `workspace/AGENTS.md` (user overrides)
5. `workspace/TOOLS.md` (optional user override layer)
6. memory/context sections

### What you need to do

- Keep personal rules and behavior overrides in `workspace/AGENTS.md`.
- If you previously edited `workspace/DISCOCLAW.md`, move those custom rules to `workspace/AGENTS.md`.
- Treat any existing `workspace/DISCOCLAW.md` as legacy reference only; it is not authoritative.

---

## tracked `TOOLS.md` runtime injection (tracked tools + workspace override)

**Affects:** Existing deployments with `workspace/TOOLS.md`.

### What changed

Default tool and environment guidance is no longer expected to live only in a workspace-scaffolded `workspace/TOOLS.md`.

DiscoClaw now injects a tracked tools layer from the repository at runtime:

- `templates/instructions/TOOLS.md` is the canonical tracked tools source.
- `workspace/TOOLS.md`, when present, is treated as an optional user-override layer loaded after the tracked version.

Prompt precedence is now:

1. immutable security policy
2. tracked defaults
3. tracked tools
4. `workspace/AGENTS.md`
5. `workspace/TOOLS.md` (optional)
6. memory/context sections

### What you need to do

- If your `workspace/TOOLS.md` is just the old scaffolded copy and you have not customized it, delete `workspace/TOOLS.md`.
- If you have custom tool or environment guidance, keep only your local deltas in `workspace/TOOLS.md`.
- Treat `templates/instructions/TOOLS.md` as the tracked base that will now receive product updates automatically.
