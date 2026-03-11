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
| Presentation-layer runtime text adapter (concise Discord-safe runtime/plan progress text; internal event payloads remain unchanged/internal-only) | `src/discord/runtime-event-text-adapter.ts`, `src/discord/message-coordinator.ts` | **DRAFT** |
| Image input (Discord attachments → Claude) | `src/discord/image-download.ts` | **done** |
| Message batching (combine queued messages into single prompt during active invocation) | `src/discord/message-batching.ts` | **done** |
| Startup self-healing (missing workspace files, stale cron/task thread refs, corrupted JSON stores) | `src/health/startup-healing.ts`, `src/workspace-bootstrap.ts` | **done** |
| YouTube transcript fetching (auto-fetch transcripts from YouTube URLs in messages, inject into prompt) | `src/discord/youtube-transcript.ts` | **done** |
| Prompt section token-estimate logging (per-section `chars` + `Math.ceil(chars / 4)` estimates at prompt assembly time across message/reaction/defer/voice flows) | `src/discord/prompt-common.ts`, `src/discord/message-coordinator.ts`, `src/discord/reaction-handler.ts`, `src/discord/deferred-runner.ts`, `src/voice/voice-prompt-builder.ts`, `src/index.ts` | **done** |

## 2. Security

| Component | File(s) | Status |
|-----------|---------|--------|
| User allowlist (fail-closed) | `src/discord/allowlist.ts` | **done** |
| Channel allowlist (optional) | `src/discord/allowlist.ts` | **done** |
| Workspace permissions (readonly/standard/full/custom) | `src/workspace-permissions.ts` | **done** |
| External content = data, not instructions | CLAUDE.md + prompts | **done** |
| Image download SSRF protection (host allowlist, redirect rejection) | `src/discord/image-download.ts` | **done** |
| YouTube transcript injection scanning (sanitize fetched transcript content before prompt injection) | `src/discord/youtube-transcript.ts` | **done** |

## 3. Runtime Adapters (`src/runtime/`)

| Component | File(s) | Status |
|-----------|---------|--------|
| `RuntimeAdapter` interface | `src/runtime/types.ts` | **done** |
| Claude Code CLI adapter (text + stream-json) | `src/runtime/claude-code-cli.ts` | **done** |
| OpenAI-compatible adapter (SSE streaming, optional function-calling tool use, API key) | `src/runtime/openai-compat.ts` | **done** |
| OpenAI tool schemas (tool definitions & name mappings for function-calling) | `src/runtime/openai-tool-schemas.ts` | **done** |
| OpenAI tool execution (server-side tool handlers with path security) | `src/runtime/openai-tool-exec.ts` | **done** |
| Codex CLI adapter (subprocess, `tools_fs` capable) | `src/runtime/codex-cli.ts` | **done** |
| Runtime registry (name → adapter lookup) | `src/runtime/registry.ts` | **done** |
| Adapter selection via env (`FORGE_AUDITOR_RUNTIME`) | `src/index.ts` | **done** |
| Gemini CLI adapter (subprocess) | `src/runtime/gemini-cli.ts` | **done** |
| Universal CLI adapter factory (spawns any CLI runtime via strategy) | `src/runtime/cli-adapter.ts` | **done** |
| CLI strategy interface (contract for Claude/Codex/Gemini strategies) | `src/runtime/cli-strategy.ts` | **done** |
| Template strategy (documents how to add a new CLI runtime) | `src/runtime/strategies/template-strategy.ts` | **done** |
| OpenRouter runtime (OpenAI-compat adapter at `openrouter.ai/api/v1`, `id: 'openrouter'`) | `src/runtime/openai-compat.ts`, `src/health/credential-check.ts` | **done** |
| Loop detector (detects runaway tool-calling patterns and aborts degenerate runs) | `src/runtime/loop-detector.ts`, `src/runtime/loop-detector.test.ts` | **done** |
| Global supervisor wrapper (runtime-wide `plan -> execute -> evaluate -> decide` loop with retries/escalation, deterministic retry blocking, structured bail handoff, and cycle audit events) | `src/runtime/global-supervisor.ts`, `src/index.runtime.ts`, `src/index.ts` | **done** |
| Runtime failure normalization (`RuntimeFailure` envelope, legacy payload parsing, centralized user-message mapping) | `src/runtime/runtime-failure.ts`, `src/runtime/runtime-failure.test.ts`, `src/discord/user-errors.ts` | **done** |

## 4. Memory Systems

| Component | File(s) | Status |
|-----------|---------|--------|
| Message history (budget-based) | `src/discord/message-history.ts` | **done** |
| Rolling summaries (AI-generated, per-session, with one-pass token-cap recompression when threshold is exceeded) | `src/discord/summarizer.ts`, `src/discord/message-coordinator.ts` | **done** |
| Durable memory (facts/preferences/constraints) | `src/discord/durable-memory.ts` | **done** |
| Memory commands (`!memory show/remember/forget/reset`) | `src/discord/memory-commands.ts` | **done** |
| Short-term memory (cross-channel recent excerpts, time-based expiry, character-budget injection) | `src/discord/shortterm-memory.ts`, `src/discord/shortterm-memory.test.ts` | **done** |
| Auto-extraction / user-turn-to-durable (AI fact extraction → durable memory, dedup, async write queue) | `src/discord/user-turn-to-durable.ts`, `src/discord/user-turn-to-durable.test.ts`, `src/discord/durable-write-queue.ts` | **done** |
| Durable memory hot-tier compaction (auto-demotes low-value active items when active set exceeds 25 items or ~2000 chars; uses `hitCount`/`lastHitAt` access signals) | `src/discord/durable-memory.ts`, `src/discord/prompt-common.ts` | **done** |
| Summary archive (append-only JSONL log of replaced rolling summaries, `memory/summary-archive/YYYY-MM-DD.jsonl`) | `src/discord/summarizer.ts` | **done** |
| Open-tasks prompt injection (live open-task summary from TaskStore injected into every prompt at invocation time) | `src/discord/prompt-common.ts` | **done** |

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
| Tiered action schema injection (core/always + channel-contextual + keyword-triggered prompt subsets) | — | `actions.ts`, `message-coordinator.ts`, `reaction-handler.ts`, `deferred-runner.ts`, `index.ts` | **done** |
| Channel management | create, edit, delete, list, info, categoryCreate, threadEdit, forumTagCreate, forumTagDelete, forumTagList | `actions-channels.ts` | **done** |
| Messaging | send, edit, delete, react, pin, fetch, sendFile | `actions-messaging.ts` | **done** |
| Guild/server | roles, members | `actions-guild.ts` | **done** |
| Moderation | kick, ban, timeout, warn | `actions-moderation.ts` | **done** |
| Polls | create, manage | `actions-poll.ts` | **done** |
| Tasks (task tracking) | create, update, close, show, list, sync | `task-action-contract.ts`, `task-action-executor.ts`, `task-action-mutations.ts`, `task-action-thread-sync.ts`, `task-action-mutation-helpers.ts`, `task-action-read-ops.ts`, `task-action-runner-types.ts`, `task-action-prompt.ts` | **done** |
| Crons (scheduled tasks) | create, update, list, show, pause, resume, delete, trigger, sync, tagMapReload | `actions-crons.ts` | **done** |
| Bot profile | setStatus, setActivity, setNickname | `actions-bot-profile.ts` | **done** |
| Forge (autonomous plan drafting) | create, resume, status, cancel | `actions-forge.ts` | **done** |
| Plan management (autonomous) | list, show, approve, close, create, run (full-loop execution; shares phase runner with targeted resume + convergence guard paths) | `actions-plan.ts` | **done** |
| Memory (durable memory mutation) | remember, forget, show | `actions-memory.ts` | **done** |
| Reaction prompts (durable pending wait persistence across restarts) | `reactionPrompt` | `reaction-prompts.ts`, `reaction-prompt-store.ts`, `reaction-handler.ts`, `index.ts` | **done** |
| Defer scheduler (in-process timers with concurrency limits) | — | `src/discord/defer-scheduler.ts` | **done** |
| Deferred runner (wires defer action type into action/runtime pipeline) | — | `src/discord/deferred-runner.ts` | **done** |
| Loop actions (first-class repeating scheduled self-invocations with inspectable metadata) | `loopCreate`, `loopList`, `loopCancel` | `actions-loop.ts` | **done** |
| Voice (session control) | join, leave, status, mute, deafen | `actions-voice.ts` | **done** |
| Spawn (parallel sub-agent invocations) | spawnAgent | `actions-spawn.ts` | **done** |

## 7. Task Sync Subsystem (`src/tasks/`)

| Component | File(s) | Status |
|-----------|---------|--------|
| Discord forum thread sync helpers | `src/tasks/thread-helpers.ts`, `src/tasks/thread-forum-ops.ts`, `src/tasks/thread-lifecycle-ops.ts`, `src/tasks/thread-ops.ts` (facade), `src/tasks/tag-map.ts` | **done** |
| Full task ↔ thread sync engine | `src/tasks/task-sync-engine.ts` | **done** |
| Sync pipeline stage helpers (ingest/normalize/diff planning) | `src/tasks/task-sync-pipeline.ts` (facade), `src/tasks/task-sync-apply-plan.ts`, `src/tasks/task-sync-reconcile-plan.ts` | **done** |
| Sync apply/reconcile phase executors | `src/tasks/task-sync-apply-types.ts`, `src/tasks/task-sync-phase-apply.ts`, `src/tasks/task-sync-reconcile.ts` | **done** |
| Sync coordinator (concurrency guard + cache) | `src/tasks/sync-coordinator.ts`, `src/tasks/sync-coordinator-metrics.ts`, `src/tasks/sync-coordinator-retries.ts` | **done** |
| Store-event sync triggers (subscribes to contract-defined `TaskStore` mutation events) | `src/tasks/task-sync.ts` | **done** |
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

## 9. Task Store (`src/tasks/`)

In-process task store that replaced the external `bd` CLI dependency for the read/write path.

| Component | File(s) | Status |
|-----------|---------|--------|
| Task types (`TaskData`, `TaskStatus`, `STATUS_EMOJI`, param types) | `src/tasks/types.ts` | **done** |
| `TaskStore` (EventEmitter-backed Map, JSONL persistence) | `src/tasks/store.ts` | **done** |
| `TaskService` mutation facade | `src/tasks/service.ts` | **done** |

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
| Workspace templates scaffolded on first run (BOOTSTRAP, SOUL, IDENTITY, USER, AGENTS, MEMORY) | `templates/workspace/`, `src/workspace-bootstrap.ts` | **done** |
| Tracked default instructions (runtime-injected `SYSTEM_DEFAULTS.md`, not workspace-managed) | `templates/instructions/SYSTEM_DEFAULTS.md`, `src/discord/prompt-common.ts` | **done** |
| Tracked tool instructions (runtime-injected `TOOLS.md`, loaded before any workspace overrides) | `templates/instructions/TOOLS.md`, `src/discord/prompt-common.ts` | **done** |
| Deterministic text-prompt precedence — preamble contract (`ROOT_POLICY` > tracked defaults > tracked tools > `workspace/AGENTS.md` > optional `workspace/TOOLS.md` > memory/context) and post-preamble section ordering (primacy/recency optimized; voice intentionally skips tracked/workspace TOOLS; see `docs/prompt-ordering.md`) | `src/discord/prompt-common.ts`, `CLAUDE.md`, `docs/prompt-ordering.md`, `src/voice/voice-prompt-builder.ts` | **done** |
| MCP config template | `templates/mcp.json` | **done** |
| Dropbox-backed symlinks (content, workspace, exports) | filesystem | **done** |

## 12. Status & Observability

| Component | File(s) | Status |
|-----------|---------|--------|
| Status channel messages (boot-report/offline/error) | `src/discord/status-channel.ts` | **done** |
| MCP server detection (startup health logging) | `src/mcp-detect.ts`, `src/mcp-detect.test.ts` | **done** |
| MCP detection in boot report | `src/discord/status-channel.ts`, `src/index.ts`, `src/index.post-connect.ts` | **done** |
| Pino structured logging | throughout | **done** |
| Per-run trace store (structured invoke/tool/action/error/outcome events keyed by `traceId`; currently instrumented for message flow with operator inspection via `!trace`) | `src/observability/trace-store.ts`, `src/observability/trace-store.test.ts`, `src/discord/trace-command.ts`, `src/discord/trace-command.test.ts`, `src/discord/message-coordinator.ts` | **done** |
| Admin dashboard (terminal UI + loopback-by-default web UI for service state, config doctor, model overrides, MCP server detection/validation status, and service actions; supports private Tailscale access through trusted host allowlisting) | `src/cli/dashboard.ts`, `src/cli/dashboard.test.ts`, `src/dashboard/server.ts`, `src/dashboard/page.ts`, `src/service-control.ts`, `src/health/config-doctor.ts` | **done** |
| Metrics | — | *stub — not started* |

## 13. Ops & Deploy

| Component | File(s) | Status |
|-----------|---------|--------|
| systemd user service | `systemd/discoclaw.service` | **done** |
| Restart-on-failure (backoff) | `systemd/discoclaw.service` | **done** |
| Bot setup skill (invite + env) | `.claude/skills/` | **done** |
| Setup guide | `docs/discord-bot-setup.md` | **done** |

## 14. Tests

| Area | Files | Status |
|------|-------|--------|
| Core (pidlock, bootstrap, permissions) | 3 tests | **done** |
| Discord subsystem | 14 tests | **done** |
| Runtime adapters (Claude CLI + OpenAI-compat + Codex CLI + registry + tool schemas + tool exec) | 6 tests | **done** |
| Global supervisor wrapper coverage (loop/bail semantics + runtime wiring) | `src/runtime/global-supervisor.test.ts`, `src/index.runtime.test.ts` | **done** |
| Beads subsystem | 3 test files | **done** |
| Tasks subsystem (`TaskStore`, migration) | 2 test files | **done** |
| Cron subsystem | 3 tests | **done** |
| Integration (fail-closed, prompt-context, status, channel-context) | 4 tests | **done** |
| Pipeline engine | 51 tests | **done** |
| Runtime-event text adapter coverage (runtime signal redaction/truncation and plan phase lifecycle phrasing) | `src/discord/runtime-event-text-adapter.test.ts` | **done** |

## 15. Documentation

| Doc | File | Status |
|-----|------|--------|
| Project instructions | `CLAUDE.md` | **done** |
| Philosophy | `docs/philosophy.md` | **done** |
| Bot setup guide | `docs/discord-bot-setup.md` | **done** |
| Discord actions | `docs/discord-actions.md` | **done** |
| Context modules | `.context/*.md` | **done** |
| Plan & Forge reference | `docs/plan-and-forge.md` | **done** |
| Webhook exposure guide | `docs/webhook-exposure.md` | **done** |
| MCP guide (config, examples, troubleshooting) | `docs/mcp.md` | **done** |
| MCP server feasibility audit (gap analysis, defer recommendation) | `docs/mcp-audit.md` | **done** |
| MCP example template | `templates/mcp.json` | **done** |
| Releasing / npm publish guide | `docs/releasing.md` | **done** |
| Voice setup guide | `docs/voice.md` | **done** |
| Cron patterns cookbook | `docs/cron-patterns.md` | **done** |
| Prompt ordering (primacy/recency zone optimization) | `docs/prompt-ordering.md` | **done** |
| Configuration reference (all env vars) | `docs/configuration.md` | **done** |
| Official integration docs index | `docs/official-docs.md` | **done** |
| Canonical runtime/model switching operator guide (startup defaults, live overrides, OpenRouter tier override workflow) | `docs/runtime-switching.md` | **done** |
| Dashboard Tailscale access guide | `docs/dashboard-tailscale.md` | **done** |
| Compound lessons artifact (ownership, promotion rules, promotion workflow) | `docs/compound-lessons.md` | **done** |
| This inventory | `docs/INVENTORY.md` | **done** |
| README for new users | `README.md` | **done** |

## 16. Cold Storage (`src/cold-storage/`)

Semantic search over conversation history. SQLite + sqlite-vec for vector storage, FTS5 for keyword search, Reciprocal Rank Fusion for hybrid retrieval. Standalone, fully testable modules — not yet wired into the live message path.

| Component | File(s) | Status |
|-----------|---------|--------|
| Shared types (`Chunk`, `ChunkMetadata`, `SearchResult`, `SearchFilters`, `deriveJumpUrl`) | `src/cold-storage/types.ts` | **done** |
| Chunker (thread message grouping, sliding-window overlap, code-block-safe splitting) | `src/cold-storage/chunker.ts`, `src/cold-storage/chunker.test.ts` | **done** |
| OpenAI embedding provider (batched `text-embedding-3-small` via native fetch) | `src/cold-storage/embeddings.ts`, `src/cold-storage/embeddings.test.ts` | **done** |
| OpenAI-compatible embedding provider (Ollama, vLLM, LM Studio, Together — no `dimensions` in request body, model prefix stripping) | `src/cold-storage/openai-compat.ts`, `src/cold-storage/openai-compat.test.ts` | **done** |
| Store (SQLite + sqlite-vec + FTS5, hybrid vector/keyword search, RRF merge, insert/search/delete) | `src/cold-storage/store.ts`, `src/cold-storage/store.test.ts` | **done** |
| Prompt section builder (formats search results into budget-capped prompt text) | `src/cold-storage/prompt-section.ts`, `src/cold-storage/prompt-section.test.ts` | **done** |
| Barrel + factory (`createColdStorage()`, re-exports) | `src/cold-storage/index.ts`, `src/cold-storage/index.test.ts` | **done** |

Config: `DISCOCLAW_COLD_STORAGE_ENABLED`, `COLD_STORAGE_PROVIDER`, `COLD_STORAGE_API_KEY`, `COLD_STORAGE_MODEL`, `COLD_STORAGE_DIMENSIONS`, `COLD_STORAGE_BASE_URL`, `COLD_STORAGE_DB_PATH`, `DISCOCLAW_COLD_STORAGE_INJECT_MAX_CHARS`, `DISCOCLAW_COLD_STORAGE_SEARCH_LIMIT`.

## 17. Pipeline Engine (`src/pipeline/`)

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

## 18. Transport Abstraction

Platform-agnostic message normalization layer (Phase 1 of transport portability). Downstream consumers can be migrated off discord.js types incrementally.

| Component | File(s) | Status |
|-----------|---------|--------|
| `PlatformMessage` type (normalized chat message shape) | `src/transport/types.ts` | **done** |
| discord.js `Message` → `PlatformMessage` mapper | `src/discord/platform-message.ts` | **done** |
| Mapper unit tests | `src/discord/platform-message.test.ts` | **done** |
| `TransportClient` interface (platform-agnostic guild/channel/member operations) | `src/discord/transport-client.ts` | **done** |
| `DiscordTransportClient` (discord.js `Guild` + `Client` implementation) | `src/discord/transport-client.ts` | **done** |
| TransportClient unit tests | `src/discord/transport-client.test.ts` | **done** |

## 19. Webhook Server

HTTP server that receives external webhook POSTs, verifies HMAC-SHA256 signatures, and dispatches through the cron executor pipeline. See `docs/webhook-exposure.md` for setup.

| Component | File(s) | Status |
|-----------|---------|--------|
| Webhook HTTP server (HMAC-SHA256 verification, dispatcher) | `src/webhook/server.ts` | **done** |
| Webhook server tests | `src/webhook/server.test.ts` | **done** |

Config: `DISCOCLAW_WEBHOOK_ENABLED`, `DISCOCLAW_WEBHOOK_PORT`, `DISCOCLAW_WEBHOOK_CONFIG`.

## 20. CLI & Configuration

### Operator Tools

| Command | Description | File(s) | Status |
|---------|-------------|---------|--------|
| `discoclaw dashboard` | Launches the operator dashboard for common admin tasks: inspect service/runtime state, review config doctor findings, change model assignments, and trigger service actions through the loopback-by-default web UI/HTTP server, with optional trusted-host Tailscale access | `src/cli/index.ts`, `src/cli/dashboard.ts`, `src/cli/dashboard.test.ts`, `src/dashboard/server.ts`, `src/dashboard/page.ts`, `src/service-control.ts`, `src/health/config-doctor.ts` | **done** |

### Configuration

Centralized env-var parsing into a typed `DiscoclawConfig` object. Handles boolean, number, enum, and string fields with validation, warnings, and info messages emitted at startup.

| Component | File(s) | Status |
|-----------|---------|--------|
| Config parser (`DiscoclawConfig` type, env-var parsing, validation) | `src/config.ts` | **done** |
| Config parser tests | `src/config.test.ts` | **done** |
| Model configuration (`models.json` loader, env-var fallback, slot resolution for `chat`, `fast`, `plan-run`, `voice`, forge roles, and cron roles) | `src/model-config.ts` | **done** |
| Config doctor engine (shared config-health inspection/apply-fixes logic for install drift, deprecated env vars, conflicting overrides, stale runtime/model overrides, and missing secrets; reused by CLI, preflight, and Discord) | `src/health/config-doctor.ts`, `src/cli/index.ts`, `scripts/doctor.ts`, `src/discord/health-command.ts`, `src/discord/message-coordinator.ts` | **done** |

## 21. Bang Commands

`!`-prefixed commands handled directly by the message coordinator without AI invocation.

| Command | Description | File(s) | Status |
|---------|-------------|---------|--------|
| `!help` | Lists available bang commands | `src/discord/help-command.ts` | **done** |
| `!health [verbose\|tools\|doctor [fix]]` | Renders runtime metrics, config snapshot, tool reports, and shared config-doctor findings/fixes | `src/discord/health-command.ts`, `src/discord/health-command.test.ts`, `src/discord/message-coordinator.ts` | **done** |
| `!doctor [fix]` | Runs the shared config doctor to report or apply config-health fixes | `src/discord/health-command.ts`, `src/discord/health-command.test.ts`, `src/discord/message-coordinator.ts` | **done** |
| `!trace [traceId]` | Lists recent run traces or shows a detailed per-run timeline for a specific `traceId` | `src/discord/trace-command.ts`, `src/discord/trace-command.test.ts`, `src/discord/message-coordinator.ts` | **done** |
| `!status` | Shows bot status summary | `src/discord/status-command.ts` | **done** |
| `!restart` | Triggers graceful restart | `src/discord/restart-command.ts` | **done** |
| `!stop` | Shuts down the bot process | `src/discord/message-coordinator.ts` | **done** |
| `!models` | Lists registered runtime adapters | `src/discord/models-command.ts` | **done** |
| `!mcp` | Shows boot-time MCP server configuration status and validation warnings; `list` repeats the default view and `help` shows command usage | `src/discord/mcp-command.ts`, `src/discord/mcp-command.test.ts`, `src/discord/message-coordinator.ts`, `src/discord/message-coordinator.mcp-command.test.ts` | **done** |
| `!update` | Pulls latest code and restarts | `src/discord/update-command.ts` | **done** |
| `!memory` | Memory read/write subcommands (see section 4) | `src/discord/memory-commands.ts` | **done** |
| `!plan` | Plan management subcommands, including targeted phase controls (`run-phase`, `skip-to`) and regeneration resequencing (`phases --regenerate --keep-done`) | `src/discord/plan-commands.ts` | **done** |
| `!forge` | Forge control subcommands | `src/discord/forge-commands.ts` | **done** |
| `!voice` | Voice subsystem commands: `status` (connection + config), `set <name>` (switch Deepgram TTS voice at runtime, ephemeral), `help` | `src/discord/voice-command.ts` (primary), `src/discord/voice-status-command.ts` (status renderer) | **done** |
| `!secret` | DM-only command to securely set/unset `.env` secrets (e.g. API keys); bypasses AI runtime, no echo | `src/discord/secret-commands.ts` | **done** |

## 22. npm Publishing

CI/CD pipeline for publishing DiscoClaw to npm on versioned releases.

| Component | File(s) | Status |
|-----------|---------|--------|
| GitHub Actions publish workflow (triggered on `v*` tags, OIDC Trusted Publishing) | `.github/workflows/publish.yml` | **done** |
| Releasing guide | `docs/releasing.md` | **done** |

## 23. Voice System (`src/voice/`)

Real-time voice chat: STT transcription, AI response generation, TTS synthesis, and Discord voice playback. See `docs/voice.md` for setup.

| Component | File(s) | Status |
|-----------|---------|--------|
| Voice types (`VoiceConfig`, `AudioFrame`, `SttProvider`, `TtsProvider`) | `src/voice/types.ts` | **done** |
| Voice connection manager (per-guild connections, reconnect logic) | `src/voice/connection-manager.ts` | **done** |
| Audio pipeline manager (orchestrates STT/TTS/responder lifecycle per guild) | `src/voice/audio-pipeline.ts` | **done** |
| Audio receiver (Opus decode, 48kHz→16kHz downsample, feed STT) | `src/voice/audio-receiver.ts` | **done** |
| Voice responder (AI invoke → TTS → audio playback, generation-based cancellation) | `src/voice/voice-responder.ts` | **done** |
| Deepgram STT provider (Nova-3 streaming via WebSocket) | `src/voice/stt-deepgram.ts` | **done** |
| Cartesia TTS provider (Sonic-3 via WebSocket, PCM s16le output) | `src/voice/tts-cartesia.ts` | **done** |
| Deepgram TTS provider (Aura REST streaming, PCM s16le output) | `src/voice/tts-deepgram.ts` | **done** |
| Opus decoder factory (`@discordjs/opus` wrapper) | `src/voice/opus.ts` | **done** |
| STT provider factory | `src/voice/stt-factory.ts` | **done** |
| TTS provider factory | `src/voice/tts-factory.ts` | **done** |
| Presence handler (auto-join/leave based on user voice state) | `src/voice/presence-handler.ts` | **done** |
| Transcript mirror (posts voice conversation text to Discord channel) | `src/voice/transcript-mirror.ts` | **done** |
| Voice action flags (restricted action subset for voice invocations) | `src/voice/voice-action-flags.ts` | **done** |
| Voice actions (join/leave/status/mute/deafen) | `src/discord/actions-voice.ts` | **done** |

Config: `DISCOCLAW_VOICE_ENABLED`, `DISCOCLAW_STT_PROVIDER`, `DEEPGRAM_STT_MODEL`, `DISCOCLAW_TTS_PROVIDER`, `DEEPGRAM_TTS_VOICE`, `DEEPGRAM_TTS_SPEED`, `DISCOCLAW_VOICE_HOME_CHANNEL`, `DEEPGRAM_API_KEY` (STT + TTS), `CARTESIA_API_KEY`.

---

## MVP Gaps (what's left)

### Must-have for MVP

- [x] **README rewrite** — user-facing overview, setup, and quickstart are now in `README.md`.
- [x] **`.env.example`** — slimmed to essentials; `.env.example.full` has all ~90 options.
- [x] **First-run experience** — `pnpm setup` provides guided interactive configuration; `pnpm preflight` validates the result.
- [x] **Graceful degradation when external prerequisites missing** — tasks no longer require the `bd` CLI at runtime (the in-process `TaskStore` is the live path); `bd` is only needed for one-time data migration. Cron requires a forum channel. Clean errors / skip when prerequisites aren't configured.

### Nice-to-have before MVP

- [ ] **Observability beyond status channel** — basic metrics (messages handled, errors, latency) to stdout or a simple dashboard.
- [ ] **Content dir without Dropbox** — make Dropbox symlinks fully optional; default to a local `data/content/` tree.

### Post-MVP

- [x] **OpenAI-compatible runtime adapter** — `src/runtime/openai-compat.ts` with registry and forge auditor routing via `FORGE_AUDITOR_RUNTIME`.
- [x] **Codex CLI runtime adapter** — `src/runtime/codex-cli.ts` shells out to `codex exec` for models that aren't available on the public completions API (e.g., `gpt-5.4`). Selectable via `FORGE_AUDITOR_RUNTIME=codex`. Supports session persistence (`sessions` capability) — maps session keys to Codex thread IDs in memory, using `codex exec resume` for multi-turn conversations within a forge run.
- [x] **Additional runtime adapters** — Gemini adapter landed in `src/runtime/gemini-cli.ts` with tests.
- [ ] **Full runtime selection for all roles** — currently only the forge auditor can be routed to a non-Claude runtime. The Codex CLI adapter now supports read-only tools (`tools_fs`), but extending to drafter/reviser would require write tool support. Cron executor and message handler still need evaluation.
- [ ] Discord-native dashboard (status embeds, config commands, health checks in a dedicated channel)
- [x] Shareable PRD packs — `docs/discoclaw-recipe-spec.md`, `templates/recipes/integration.discoclaw-recipe.md`, and `skills/discoclaw-recipe-{generator,consumer}/` define exchangeable `recipes/*.discoclaw-recipe.md` artifacts
