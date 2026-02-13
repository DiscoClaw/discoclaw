# Context Modules

Modular context files loaded on-demand based on the task at hand.
Core instructions live in `CLAUDE.md` at the repo root.

## Loading Patterns

| When doing... | Read this first |
|---------------|-----------------|
| **PA behavior / formatting / memory** | `pa.md` |
| **PA safety / injection defense** | `pa-safety.md` |
| **Discord behavior + routing** | `discord.md` |
| **Discord bot setup (invite + env)** | `bot-setup.md` |
| **Development / build / test** | `dev.md` |
| **Runtime adapters (Claude CLI, OpenAI/Gemini later)** | `runtime.md` |
| **Ops / systemd service** | `ops.md` |
| **Memory system** | `memory.md` |
| **Beads / task tracking / bd CLI** | `beads.md` |
| **Architecture / system overview** | `architecture.md` |
| **Forge/plan standing constraints** | `project.md` *(auto-loaded by forge)* |

## Context Hygiene (Strict)
- Read the minimum necessary modules for the task.
- Do not load modules "just in case."

## Quick Reference
- **pa.md** — PA behavioral rules, Discord formatting, memory, group chat etiquette, autonomy tiers
- **pa-safety.md** — Indirect prompt injection defense, golden rules, red flags
- **dev.md** — Commands, env, local dev loops, build/test
- **discord.md** — Allowlist gating, session keys, threading rules, output constraints
- **runtime.md** — Runtime adapter interface, Claude CLI flags, capability routing
- **ops.md** — systemd service notes, logs, restart workflow
- **memory.md** — Memory layers, user-facing examples, config reference, concurrency
- **beads.md** — Bead task tracker: data model, bd CLI, hooks, Discord sync, auto-tagging
- **architecture.md** — System overview, data flow, directory layout, key concepts
- **bot-setup.md** — One-time bot creation and invite guide
- **project.md** — Standing constraints auto-loaded by forge drafter and auditor
