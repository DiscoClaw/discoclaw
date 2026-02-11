# Architecture

Discoclaw is a minimal Discord bridge that routes messages to AI runtimes
(Claude Code first; others later). It emphasizes small, explicit, auditable code.

## Data Flow

```
Discord message
  → allowlist gate (DISCORD_ALLOW_USER_IDS)
  → session lookup/create (keyed by user+channel)
  → context assembly (PA files + base context + channel context + durable memory)
  → runtime adapter invocation (streaming)
  → streaming response → Discord message edits (chunked, code-block-aware)
  → optional: parse & execute discord actions from response
```

## Directory Layout

| Path | Purpose |
|------|---------|
| `src/index.ts` | Entry point — config, wiring, bot startup |
| `src/discord.ts` | Discord client, message handler, prompt assembly |
| `src/discord/` | Discord subsystems: actions, allowlist, channel context, memory, output |
| `src/runtime/` | Runtime adapters (Claude CLI), concurrency, process pool |
| `src/beads/` | Bead management — bd-cli wrapper, sync, auto-tagging |
| `src/cron/` | Cron scheduler, executor, forum sync, run stats |
| `src/observability/` | Metrics registry |
| `src/sessions.ts` | Session manager (maps session keys to runtime session IDs) |
| `content/discord/base/` | Base context files loaded for every message |
| `content/discord/channels/` | Per-channel context files |
| `workspace/` | Identity files (SOUL.md, IDENTITY.md, USER.md) — gitignored |
| `.context/` | Developer context modules (you are here) |

## Key Concepts

- **Channel context** — per-channel `.md` files injected into the prompt. Base files
  apply to all channels; channel-specific files add overrides.
- **Base context** — `content/discord/base/*.md` files (core, safety, autonomy, etc.)
  loaded alphabetically for every invocation.
- **Session keys** — `user:channel` composites that map to runtime sessions, giving
  each user+channel pair its own conversation continuity.
- **Runtime adapters** — pluggable interface (`src/runtime/types.ts`) that wraps an AI
  CLI/API. Currently only Claude Code CLI (`src/runtime/claude-code-cli.ts`).
- **Discord actions** — structured JSON actions the AI can emit in its response
  (send messages, create channels, manage beads, etc.), parsed and executed post-response.

## Entry Points

- `src/index.ts` — loads config, builds runtime + session manager + channel context,
  starts the Discord bot.
- `src/discord.ts` — creates the Discord client, registers event handlers,
  assembles prompts, streams responses.
