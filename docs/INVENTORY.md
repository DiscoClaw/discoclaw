# DiscoClaw Core Inventory

What ships with the standard project, what's done, and what's left for MVP.

Legend: **done** | *stub* | ~~cut~~

---

## 1. Bot Core

| Component | File(s) | Status |
|-----------|---------|--------|
| Entry point & env loading | `src/index.ts` | **done** |
| Discord message handler | `src/discord.ts` | **done** |
| Session key routing (DM/channel/thread) | `src/sessions.ts`, `src/discord/session-key.ts` | **done** |
| Per-session queue (serial execution) | `src/group-queue.ts` | **done** |
| PID lock (single instance) | `src/pidlock.ts` | **done** |
| Graceful shutdown | `src/index.ts` | **done** |
| Streaming + fence-safe chunking (2 000 char) | `src/discord.ts` | **done** |
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
| Beads (task tracking) | create, update, close, show, list, sync | `actions-beads.ts` | **done** |
| Crons (scheduled tasks) | create, update, list, show, pause, resume, delete, trigger, sync, tagMapReload | `actions-crons.ts` | **done** |
| Bot profile | setStatus, setActivity, setNickname | `actions-bot-profile.ts` | **done** |
| Forge (autonomous plan drafting) | create, resume, status, cancel | `actions-forge.ts` | **done** |
| Plan management (autonomous) | list, show, approve, close, create, run | `actions-plan.ts` | **done** |
| Memory (durable memory mutation) | remember, forget, show | `actions-memory.ts` | **done** |

## 7. Beads Subsystem (`src/beads/`)

| Component | File(s) | Status |
|-----------|---------|--------|
| Bead types + status model | `src/beads/types.ts` | **done** |
| `bd` CLI wrapper | `src/beads/bd-cli.ts` | **done** |
| Discord forum thread sync | `src/beads/discord-sync.ts` | **done** |
| Auto-tag (AI classification) | `src/beads/auto-tag.ts` | **done** |
| Full bead ↔ thread sync | `src/beads/bead-sync.ts` | **done** |
| Sync coordinator (concurrency guard + cache) | `src/beads/bead-sync-coordinator.ts` | **done** |
| File watcher (auto-sync on external changes) | `src/beads/bead-sync-watcher.ts` | **done** |
| Bead thread cache | `src/beads/bead-thread-cache.ts` | **done** |
| Hook scripts (on-create, on-update, etc.) | `scripts/beads/` | **done** |

## 8. Cron Subsystem (`src/cron/`)

| Component | File(s) | Status |
|-----------|---------|--------|
| Scheduler (croner) | `src/cron/scheduler.ts` | **done** |
| Executor (invoke runtime, post results) | `src/cron/executor.ts` | **done** |
| Forum sync (thread → cron def) | `src/cron/forum-sync.ts` | **done** |
| Parser (schedule + timezone + channel) | `src/cron/parser.ts` | **done** |

## 9. Workspace Bootstrap

| Component | File(s) | Status |
|-----------|---------|--------|
| First-run scaffolding | `src/workspace-bootstrap.ts` | **done** |
| Templates (SOUL, IDENTITY, USER, AGENTS, TOOLS, HEARTBEAT) | `templates/workspace/` | **done** |
| Dropbox-backed symlinks (content, workspace, exports) | filesystem | **done** |

## 10. Status & Observability

| Component | File(s) | Status |
|-----------|---------|--------|
| Status channel embeds (boot-report/offline/error) | `src/discord/status-channel.ts` | **done** |
| Pino structured logging | throughout | **done** |
| Metrics / dashboard | — | *stub — not started* |

## 11. Ops & Deploy

| Component | File(s) | Status |
|-----------|---------|--------|
| systemd user service | `systemd/discoclaw.service` | **done** |
| Restart-on-failure (backoff) | `systemd/discoclaw.service` | **done** |
| Bot setup skill (invite + env) | `.claude/skills/` | **done** |
| Setup guide | `docs/discord-bot-setup.md` | **done** |

## 12. Tests

| Area | Files | Status |
|------|-------|--------|
| Core (pidlock, bootstrap, permissions) | 3 tests | **done** |
| Discord subsystem | 14 tests | **done** |
| Runtime adapters (Claude CLI + OpenAI-compat + Codex CLI + registry) | 4 tests | **done** |
| Beads subsystem | 6 tests | **done** |
| Cron subsystem | 3 tests | **done** |
| Integration (fail-closed, prompt-context, status, channel-context) | 4 tests | **done** |

## 13. Documentation

| Doc | File | Status |
|-----|------|--------|
| Project instructions | `CLAUDE.md` | **done** |
| Philosophy | `docs/philosophy.md` | **done** |
| Bot setup guide | `docs/discord-bot-setup.md` | **done** |
| Discord actions | `docs/discord-actions.md` | **done** |
| Context modules | `.context/*.md` | **done** |
| Token usage & efficiency | `docs/token-efficiency.md` | **done** |
| Plan & Forge reference | `docs/plan-and-forge.md` | **done** |
| This inventory | `docs/INVENTORY.md` | **done** |
| README for new users | `README.md` | *needs rewrite for MVP audience* |

---

## MVP Gaps (what's left)

### Must-have for MVP

- [ ] **README rewrite** — current README is developer-internal; needs a clear "what is this / quickstart / how to run" for anyone cloning the repo.
- [x] **`.env.example`** — slimmed to essentials; `.env.example.full` has all ~90 options.
- [x] **First-run experience** — `pnpm setup` provides guided interactive configuration; `pnpm preflight` validates the result.
- [x] **Graceful degradation when external prerequisites missing** — beads requires `bd` CLI, cron requires a forum channel. Ensure clean errors / skip when these aren't configured.

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
