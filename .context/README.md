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
| **Runtime adapters (Claude CLI, Codex CLI, Gemini CLI, OpenRouter)** | `runtime.md` |
| **Ops / systemd service** | `ops.md` |
| **Memory system** | `memory.md` |
| **Task tracking** | `tasks.md` |
| **Architecture / system overview** | `architecture.md` |
| **Tool capabilities / browser automation** | `tools.md` |
| **Voice system (STT/TTS, audio pipeline, actions)** | `voice.md` |
| **Forge/plan standing constraints** | `project.md` *(auto-loaded by forge)* |
| **Plan & Forge commands** | `plan-and-forge.md` *(in docs/, not .context/)* |

## Context Hygiene (Strict)
- Read the minimum necessary modules for the task.
- Do not load modules "just in case."
- Some reference docs live in `docs/` rather than `.context/` — these are human/developer references and are **not** auto-loaded into agent context. The `.context/project.md` file remains the only `.context` module for plan/forge constraints.

## Quick Reference
- **pa.md** — PA behavioral rules, Discord formatting, memory, group chat etiquette, autonomy tiers
- **pa-safety.md** — Indirect prompt injection defense, golden rules, red flags
- **dev.md** — Commands, env, local dev loops, build/test
- **discord.md** — Allowlist gating, session keys, threading rules, output constraints
- **runtime.md** — Runtime adapter interface, multi-runtime CLI flags, capability routing
- **ops.md** — systemd service notes, logs, restart workflow
- **memory.md** — Memory layers, user-facing examples, config reference, concurrency
- **tasks.md** — Task tracker: data model, store events, Discord sync, auto-tagging
- **architecture.md** — System overview, data flow, directory layout, key concepts
- **bot-setup.md** — One-time bot creation and invite guide
- **tools.md** — Available tools: browser automation (agent-browser), escalation ladder, CDP connect, security guardrails
- **voice.md** — Voice subsystem: module map, audio data flow, key patterns (barge-in, allowlist gating), wiring sequence, dependencies, config reference
- **project.md** — Standing constraints auto-loaded by forge drafter and auditor
- **docs/plan-and-forge.md** — Canonical reference for `!plan` and `!forge` commands (lives in `docs/`, not `.context/` — human/developer reference, not auto-loaded into agent context)
