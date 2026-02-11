# Context Modules

Modular context files loaded on-demand based on the task at hand.
Core instructions live in `CLAUDE.md` at the repo root.

## Loading Patterns

| When doing... | Read this first |
|---------------|-----------------|
| **PA behavior / formatting / memory** | `pa.md` |
| **Discord behavior + routing** | `discord.md` |
| **Discord bot setup (invite + env)** | `bot-setup.md` |
| **Development / build / test** | `dev.md` |
| **Runtime adapters (Claude CLI, OpenAI/Gemini later)** | `runtime.md` |
| **Ops / systemd service** | `ops.md` |
| **Architecture / system overview** | `architecture.md` |

## Context Hygiene (Strict)
- Read the minimum necessary modules for the task.
- Do not load modules "just in case."

## Quick Reference
- **pa.md** — PA behavioral rules, Discord formatting, memory, group chat etiquette
- **dev.md** — Commands, env, local dev loops, build/test
- **discord.md** — Allowlist gating, session keys, threading rules, output constraints
- **runtime.md** — Runtime adapter interface, Claude CLI flags, capability routing
- **ops.md** — systemd service notes, logs, restart workflow
- **architecture.md** — System overview, data flow, directory layout, key concepts
- **bot-setup.md** — One-time bot creation and invite guide
