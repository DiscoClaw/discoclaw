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
