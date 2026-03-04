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
3. `workspace/AGENTS.md` (user overrides)
4. memory/context sections

### What you need to do

- Keep personal rules and behavior overrides in `workspace/AGENTS.md`.
- If you previously edited `workspace/DISCOCLAW.md`, move those custom rules to `workspace/AGENTS.md`.
- Treat any existing `workspace/DISCOCLAW.md` as legacy reference only; it is not authoritative.
