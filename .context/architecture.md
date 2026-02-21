# Architecture

DiscoClaw is a personal AI orchestrator that coordinates between Discord, AI runtimes
(Claude Code, OpenAI, Codex), and local system resources — managing conversation state,
task routing, scheduling, and tool access. It emphasizes small, explicit, auditable code.

## Data Flow

```
Discord message
  → allowlist gate (DISCORD_ALLOW_USER_IDS)
  → session lookup/create (keyed by user+channel)
  → context assembly (PA files + PA modules + channel context + durable memory)
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
| `src/tasks/` | In-process task data model + store + migration helpers |
| `src/beads/` | Retired legacy shim namespace (runtime shims removed in hard-cut) |
| `src/cron/` | Cron scheduler, executor, forum sync, run stats |
| `src/observability/` | Metrics registry |
| `src/sessions.ts` | Session manager (maps session keys to runtime session IDs) |
| `content/discord/channels/` | Per-channel context files |
| `workspace/` | Identity files (SOUL.md, IDENTITY.md, USER.md) — gitignored |
| `.context/` | Developer context modules (you are here) |

## Key Concepts

- **Channel context** — per-channel `.md` files injected into the prompt. PA modules
  apply to all channels; channel-specific files add overrides.
- **PA context modules** — `.context/pa.md` and `.context/pa-safety.md`, loaded for
  every invocation. Fail-closed: missing modules crash the bot at startup.
- **Session keys** — `user:channel` composites that map to runtime sessions, giving
  each user+channel pair its own conversation continuity.
- **Runtime adapters** — pluggable interface (`src/runtime/types.ts`) that wraps an AI
  CLI/API. The orchestrator routes to the appropriate adapter based on context (message
  handling, forge drafting, auditing). Available: Claude Code CLI, OpenAI HTTP, Codex CLI.
- **Discord actions** — structured JSON actions the AI can emit in its response
  (send messages, create channels, manage tasks, etc.), parsed and executed post-response.
- **Tasks** — built-in task tracker backed by in-process `TaskStore`, synced to Discord forum threads.
- **Cron** — forum-based scheduled tasks. Each forum thread defines a job;
  archive to pause, unarchive to resume. Enabled by default.

## Entry Points

- `src/index.ts` — loads config, wires up runtime adapters + session manager + channel
  context, starts the orchestrator.
- `src/discord.ts` — Discord interface layer: event handlers, context assembly, prompt
  routing, response streaming.
