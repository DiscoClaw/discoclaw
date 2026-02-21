# DiscoClaw Core Inventory

What ships with the standard project, what's done, and what's left for MVP.

Legend: **done** | *stub* | ~~cut~~

---

## 1. Bot Core

| Component | File(s) | Status |
|-----------|---------|--------|
| Entry point & env loading | `src/index.ts` | **done** |
| Discord message handler | `src/discord.ts` (wire-up), `src/discord/message-coordinator.ts` (handler logic) | **done** |
| Session key routing (DM/channel/thread) | `src/sessions.ts`, `src/discord/session-key.ts` | **done** |
| Per-session queue (serial execution) | `src/group-queue.ts` | **done** |
| PID lock (single instance) | `src/pidlock.ts` | **done** |
| Graceful shutdown | `src/index.ts` | **done** |
| Streaming + fence-safe chunking (2 000 char) | `src/discord.ts` (wire-up), `src/discord/message-coordinator.ts` (handler logic) | **done** |
| Image input (Discord attachments → Claude) | `src/discord/image-download.ts` | **done** |

## 2. Security

| Component | File(s) | Status |
|-----------|---------|--------|
| User allowlist (fail-closed) | `src/discord/allowlist.ts` | **done** |
| Channel allowlist (optional) | `src/discord/allowlist.ts` | **done** |
| Workspace permissions (readonly/standard/full/custom) | `src/workspace-permissions.ts` | **done** |
| External content = data, not instructions | CLAUDE.md + prompts | **done** |
| Image download SSRF protection (host allowlist, redirect rejection) | `src/discord/image-download.ts` | **done** |

## 3. Runtime Adapters (`src/runtime/`)

| Component | File(s) | Status |
|-----------|---------|--------|
| `RuntimeAdapter` interface | `src/runtime/types.ts` | **done** |
| Claude Code CLI adapter (text + stream-json) | `src/runtime/claude-code-cli.ts` | **done** |
| OpenAI-compatible adapter (SSE streaming, text-only, API key) | `src/runtime/openai-compat.ts` | **done** |
| Codex CLI adapter (subprocess, `tools_fs` capable) | `src/runtime/codex-cli.ts` | **done** |
| Runtime registry (name → adapter lookup) | `src/runtime/registry.ts` | **done** |
| Adapter selection via env (`FORGE_AUDITOR_RUNTIME`) | `src/index.ts` | **done** |
| Gemini adapter | — | *stub — not started* |

## 4. Memory Systems

| Component | File(s) | Status |
|-----------|---------|--------|
| Message history (budget-based) | `src/discord/message-history.ts` | **done** |
| Rolling summaries (AI-generated, per-session) | `src/discord/summarizer.ts` | **done** |
| Durable memory (facts/preferences/constraints) | `src/discord/durable-memory.ts` | **done** |
| Memory commands (`!memory show/remember/forget/reset`) | `src/discord/memory-commands.ts` | **done** |

## 5. Channel Context

| Component | File(s) | Status |
|-----------|---------|--------|
| Per-channel context files | `src/discord/channel-context.ts` | **done** |
| PA context modules (pa + safety) | `.context/pa.md`, `.context/pa-safety.md` | **done** |
| Auto-scaffold on first message | `src/discord/channel-context.ts` | **done** |
| Thread inherits parent channel context | `src/discord/channel-context.ts` | **done** |
| DM context | `content/discord/channels/dm.md` | **done** |

## 6. Discord Actions (`src/discord/actions*.ts`)

All actions are gated by category env flags (off by default except channels).

| Category | Action types | File | Status |
|----------|-------------|------|--------|
| Core dispatcher + parser | — | `actions.ts` | **done** |
| Channel management | create, edit, delete, list, info, categoryCreate, threadEdit, forumTagCreate, forumTagDelete, forumTagList | `actions-channels.ts` | **done** |
| Messaging | send, edit, delete, react, pin, fetch | `actions-messaging.ts` | **done** |
| Guild/server | roles, members | `actions-guild.ts` | **done** |
| Moderation | kick, ban, timeout, warn | `actions-moderation.ts` | **done** |
| Polls | create, manage | `actions-poll.ts` | **done** |
| Tasks (task tracking) | create, update, close, show, list, sync | `actions-tasks.ts` | **done** |
| Crons (scheduled tasks) | create, update, list, show, pause, resume, delete, trigger, sync, tagMapReload | `actions-crons.ts` | **done** |
| Bot profile | setStatus, setActivity, setNickname | `actions-bot-profile.ts` | **done** |
| Forge (autonomous plan drafting) | create, resume, status, cancel | `actions-forge.ts` | **done** |
| Plan management (autonomous) | list, show, approve, close, create, run | `actions-plan.ts` | **done** |
| Memory (durable memory mutation) | remember, forget, show | `actions-memory.ts` | **done** |

## 7. Task Sync Subsystem (`src/tasks/`)

| Component | File(s) | Status |
|-----------|---------|--------|
| Discord forum thread sync helpers | `src/tasks/discord-sync.ts` | **done** |
| Full task ↔ thread sync engine | `src/tasks/task-sync-engine.ts` | **done** |
| Sync coordinator (concurrency guard + cache) | `src/tasks/sync-coordinator.ts` | **done** |
| Store-event watcher (triggers sync on every `TaskStore` mutation) | `src/tasks/sync-watcher.ts` | **done** |
| Task thread cache | `src/tasks/thread-cache.ts` | **done** |
| Forum guard + startup checks | `src/tasks/forum-guard.ts`, `src/tasks/initialize.ts` | **done** |
| Auto-tag (AI classification) | `src/tasks/auto-tag.ts` | **done** |
| Task sync CLI entrypoint | `src/tasks/task-sync-cli.ts` | **done** |

## 8. Legacy Bridge Artifacts

| Component | File(s) | Status |
|-----------|---------|--------|
| Runtime compatibility shims (`src/beads/*`) | removed | **done** |
| Legacy bridge scripts (`scripts/beads/*`) | removed | **done** |
| Canonical task wrapper scripts | `scripts/tasks/` | **done** |

## 9. Task Store + Migration (`src/tasks/`)

In-process task store that replaces the external `bd` CLI dependency for the read/write
path. See `docs/tasks-migration.md` for migration details.

| Component | File(s) | Status |
|-----------|---------|--------|
| Task types (`TaskData`, `TaskStatus`, `STATUS_EMOJI`, param types) | `src/tasks/types.ts` | **done** |
| `TaskStore` (EventEmitter-backed Map, JSONL persistence) | `src/tasks/store.ts` | **done** |
| One-shot bd → JSONL migration helper | `src/tasks/migrate.ts` | **done** |

## 10. Cron Subsystem (`src/cron/`)

| Component | File(s) | Status |
|-----------|---------|--------|
| Scheduler (croner) | `src/cron/scheduler.ts` | **done** |
| Executor (invoke runtime, post results) | `src/cron/executor.ts` | **done** |
| Forum sync (thread → cron def) | `src/cron/forum-sync.ts` | **done** |
| Parser (schedule + timezone + channel) | `src/cron/parser.ts` | **done** |

## 11. Workspace Bootstrap

| Component | File(s) | Status |
|-----------|---------|--------|
| First-run scaffolding | `src/workspace-bootstrap.ts` | **done** |
| Templates (SOUL, IDENTITY, USER, AGENTS, TOOLS, HEARTBEAT) | `templates/workspace/` | **done** |
| Dropbox-backed symlinks (content, workspace, exports) | filesystem | **done** |

## 12. Status & Observability

| Component | File(s) | Status |
|-----------|---------|--------|
| Status channel messages (boot-report/offline/error) | `src/discord/status-channel.ts` | **done** |
| Pino structured logging | throughout | **done** |
| Metrics / dashboard | — | *stub — not started* |

## 13. Ops & Deploy

| Component | File(s) | Status |
|-----------|---------|--------|
| systemd user service | `systemd/discoclaw.service` | **done** |
| Restart-on-failure (backoff) | `systemd/discoclaw.service` | **done** |
| Bot setup skill (invite + env) | `.claude/skills/` | **done** |
| Setup guide | `docs/discord-bot-setup.md` | **done** |

## 13. Tests

| Area | Files | Status |
|------|-------|--------|
| Core (pidlock, bootstrap, permissions) | 3 tests | **done** |
| Discord subsystem | 14 tests | **done** |
| Runtime adapters (Claude CLI + OpenAI-compat + Codex CLI + registry) | 4 tests | **done** |
| Beads subsystem | 3 test files | **done** |
| Tasks subsystem (`TaskStore`, migration) | 2 test files | **done** |
| Cron subsystem | 3 tests | **done** |
| Integration (fail-closed, prompt-context, status, channel-context) | 4 tests | **done** |
| Pipeline engine | 51 tests | **done** |

## 14. Documentation

| Doc | File | Status |
|-----|------|--------|
| Project instructions | `CLAUDE.md` | **done** |
| Philosophy | `docs/philosophy.md` | **done** |
| Bot setup guide | `docs/discord-bot-setup.md` | **done** |
| Discord actions | `docs/discord-actions.md` | **done** |
| Context modules | `.context/*.md` | **done** |
| Token usage & efficiency | `docs/token-efficiency.md` | **done** |
| Plan & Forge reference | `docs/plan-and-forge.md` | **done** |
| Tasks migration (bd CLI → TaskStore) | `docs/tasks-migration.md` | **done** |
| This inventory | `docs/INVENTORY.md` | **done** |
| README for new users | `README.md` | *needs rewrite for MVP audience* |

## 15. Pipeline Engine (`src/pipeline/`)

General-purpose step-chaining primitive. Each step sends a prompt to a runtime adapter; its text output is injected as context for the next step. Foundational building block for composable action chaining.

| Component | File(s) | Status |
|-----------|---------|--------|
| `StepContext` / `PromptStep` types | `src/pipeline/engine.ts` | **done** |
| `PipelineDef` / `PipelineResult` types | `src/pipeline/engine.ts` | **done** |
| `runPipeline` — sequential step executor | `src/pipeline/engine.ts` | **done** |
| `collectText` — event-stream drainer (`text_final` \| `text_delta`) | `src/pipeline/engine.ts` | **done** |
| Template interpolation (`{{prev.output}}`, `{{steps.<id>.output}}`) | `src/pipeline/engine.ts` | **done** |
| Named step IDs (`id` field) + duplicate ID validation | `src/pipeline/engine.ts` | **done** |
| Per-step model override | `src/pipeline/engine.ts` | **done** |
| Per-step runtime override (`runtime` field) | `src/pipeline/engine.ts` | **done** |
| Error handling: fail-fast (default) or skip-on-error per step (`onError`) | `src/pipeline/engine.ts` | **done** |
| Progress reporting via callback (`onProgress`) | `src/pipeline/engine.ts` | **done** |
| Dynamic prompt via `(ctx: StepContext) => string` callback | `src/pipeline/engine.ts` | **done** |
| `AbortSignal` support (pre-check + mid-stream) — undocumented addition; not in plan scope | `src/pipeline/engine.ts` | **done** |
| Shell step kind (`kind: "shell"`) | `src/pipeline/engine.ts` | **done** |
| `ShellStep` type | `src/pipeline/engine.ts` | **done** |
| `confirmAllowed` gate (blocks destructive commands without explicit opt-in) | `src/pipeline/engine.ts` | **done** |
| Discord-action step kind | `src/pipeline/engine.ts` | **done** |

## 16. Transport Abstraction

Platform-agnostic message normalization layer (Phase 1 of transport portability). Downstream consumers can be migrated off discord.js types incrementally.

| Component | File(s) | Status |
|-----------|---------|--------|
| `PlatformMessage` type (normalized chat message shape) | `src/transport/types.ts` | **done** |
| discord.js `Message` → `PlatformMessage` mapper | `src/discord/platform-message.ts` | **done** |
| Mapper unit tests | `src/discord/platform-message.test.ts` | **done** |

---

## MVP Gaps (what's left)

### Must-have for MVP

- [ ] **README rewrite** — current README is developer-internal; needs a clear "what is this / quickstart / how to run" for anyone cloning the repo.
- [x] **`.env.example`** — slimmed to essentials; `.env.example.full` has all ~90 options.
- [x] **First-run experience** — `pnpm setup` provides guided interactive configuration; `pnpm preflight` validates the result.
- [x] **Graceful degradation when external prerequisites missing** — tasks no longer require the `bd` CLI at runtime (the in-process `TaskStore` is the live path); `bd` is only needed for one-time data migration. Cron requires a forum channel. Clean errors / skip when prerequisites aren't configured.

### Nice-to-have before MVP

- [ ] **Observability beyond status channel** — basic metrics (messages handled, errors, latency) to stdout or a simple dashboard.
- [ ] **Content dir without Dropbox** — make Dropbox symlinks fully optional; default to a local `data/content/` tree.

### Post-MVP

- [x] **OpenAI-compatible runtime adapter** — `src/runtime/openai-compat.ts` with registry and forge auditor routing via `FORGE_AUDITOR_RUNTIME`.
- [x] **Codex CLI runtime adapter** — `src/runtime/codex-cli.ts` shells out to `codex exec` for models that aren't available on the public completions API (e.g., `gpt-5.3-codex`). Selectable via `FORGE_AUDITOR_RUNTIME=codex`. Supports session persistence (`sessions` capability) — maps session keys to Codex thread IDs in memory, using `codex exec resume` for multi-turn conversations within a forge run.
- [ ] **Additional runtime adapters** — Gemini adapter so the project supports three model families.
- [ ] **Full runtime selection for all roles** — currently only the forge auditor can be routed to a non-Claude runtime. The Codex CLI adapter now supports read-only tools (`tools_fs`), but extending to drafter/reviser would require write tool support. Cron executor and message handler still need evaluation.
- [ ] Discord-native dashboard (status embeds, config commands, health checks in a dedicated channel)
- [x] Shareable PRD packs — `docs/discoclaw-recipe-spec.md`, `templates/recipes/integration.discoclaw-recipe.md`, and `skills/discoclaw-recipe-{generator,consumer}/` define exchangeable `recipes/*.discoclaw-recipe.md` artifacts
