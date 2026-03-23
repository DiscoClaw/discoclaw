# Changelog

All notable changes to DiscoClaw are documented here.

## [Unreleased]

### Changed
- Added the stable `pnpm release:rehearsal` source-checkout entrypoint for the blessed Claude 1.0 rehearsal path; current 1.0 release-readiness is still blocked because the authoritative repo-local `.env` run now reaches `pnpm dev` but the harness does not surface the ready boundary / live checkpoint phase or return to a clean rehearsal baseline after interruption, as tracked in [CLAUDE SOURCE-CHECKOUT STATUS.md](CLAUDE%20SOURCE-CHECKOUT%20STATUS.md).

### Removed
- Codex app-server native transport path (`CODEX_APP_SERVER_URL` / `CODEX_APP_SERVER_NATIVE` env vars) — Codex now uses `codex exec` exclusively
- Mid-turn steering / interrupt mechanism and two-stage Codex draft flow

## [0.8.1] — 2026-03-15

4 commits. Vision support for chat history images, imagegen model switching, reasoning effort tuning.

### Added
- Vision support for images in chat history — bot can now see images from thread/channel context, not just the triggering message (#696)
- Image attachment awareness in readMessages/fetchMessage — metadata (filename, content type, dimensions) included in text summaries (#693)
- Imagegen model runtime-switchable via `!models set` (#695)

### Changed
- Bumped `claude_code` capable tier reasoning effort to `high`, deep tier to `max` (#694)

## [0.8.0] — 2026-03-15

38 commits. Forge and Codex reliability hardening, cron persistence, dashboard improvements, documentation overhaul.

### Added
- Force action inventory check before capability refusals
- Runtime preset switcher in dashboard
- Cron patterns cookbook (docs)
- Codex mid-turn steering
- CHANGELOG.md (backfilled to v0.1.0)

### Changed
- Local cron persistence is now canonical source of truth
- Forge routing forced onto CLI for reliability
- Codex grounded tool capabilities split from advertised contract
- Require explicit action starts and live workspace warning checks
- Refactored forge shaping for bounded research turns
- Audited adapters against shared tool contract

### Fixed
- Discord action follow-up lifecycle improvements
- Slow task-sync CLI completion
- Forge failure reasons now persisted in watchdog notices
- Native Codex forge hardening: salvage retries, plan tail preservation, stall detection, websocket reconnect
- DISCLAIMER.md updated to list all five runtime adapters
- INVENTORY.md cold storage wiring note corrected

## [0.7.0] — 2026-03-10

45 commits. Major additions: operator dashboard, cold storage, loop actions, plan verification, MCP command surface.

### Added
- **Operator dashboard** — local web UI for service state, config doctor, model overrides, and quick actions; enabled by default on `127.0.0.1:9401`; optional Tailscale access via `DISCOCLAW_DASHBOARD_TRUSTED_HOSTS`
- **Cold storage** — semantic search over conversation history using SQLite + sqlite-vec + FTS5 with hybrid retrieval; integrated into live prompt assembly
- **Loop actions** — first-class repeating scheduled self-invocations (`loopCreate`, `loopList`, `loopCancel`)
- **`!mcp` command** — surface MCP server configuration status and validation warnings from Discord
- **`!trace` command** — per-run execution trace observability scoped to requester context
- **Plan verification evidence** — capture and surface verification state in plan status views
- **Dedicated `plan-run` model role** — independent from `chat`, defaults to `capable`
- **Config doctor surfaces** — exposed in dashboard, CLI, and Discord
- **Official docs index** (`docs/official-docs.md`) — comprehensive provider and dependency reference
- **Runtime/model switching guide** (`docs/runtime-switching.md`)
- **Reaction context** — add nearby chat history to reaction-triggered runs

### Changed
- Default stall timeouts raised to 30 minutes
- Continuation capsule persisted across compression
- Requester permissions enforced for Discord actions
- Suppressed requester-gated actions without requester context

### Fixed
- Unified structured runtime failures (`RuntimeFailure` envelope)
- Persisted resumable HITL waits across restarts
- Fixed orphaned preview on thread archive
- Fixed Codex image handling on resumed sessions
- Strip ANSI escape codes from tool output

## [0.6.0] — 2026-03-06

85 commits. Major additions: streaming preview, cold storage foundation, global supervisor, model tier consolidation, Codex enhancements.

### Added
- **Streaming preview** — tool-aware Discord streaming with runtime signal adaptation; configurable density via `DISCOCLAW_STREAM_PREVIEW_RAW`
- **Cold storage subsystem** — SQLite + sqlite-vec vector store, FTS5 keyword search, RRF hybrid retrieval, OpenAI and OpenAI-compatible embedding providers; wired into prompt assembly
- **Global runtime supervisor** — plan/execute/evaluate/decide loop with retries, escalation, and structured bail (env-toggle: `DISCOCLAW_GLOBAL_SUPERVISOR_ENABLED`)
- **Consolidated model config** — single `models.json` system with tier-based presets (`fast`/`capable`/`deep`) per runtime
- **Spawn actions** — parallel sub-agent invocations (`spawnAgent`) with concurrency limits
- **Claude effort-level** injection per tier
- **Prompt ordering optimization** — primacy/recency zone layout for prompt sections
- **Durable memory compaction** — size-triggered hot-tier compaction with hit-count signals
- **Rolling summary recompression** — one-pass token-cap recompression when summary exceeds threshold
- **Codex enhancements** — image support (`--image`), workspace instructions, MCP, `appendSystemPrompt`, per-tier reasoning effort, mid-turn steering

### Changed
- Claude `capable` tier changed from Sonnet to Opus
- Fast-runtime collapsed into tier system (no separate `DISCOCLAW_FAST_RUNTIME` needed)
- Forge auditor defaults to `deep` tier
- Updated Codex and OpenAI tier defaults to current models

### Fixed
- Stale rolling-summary recency drift
- Plan parser reading metadata past `---` separator
- Stop-reaction abort for follow-up messages
- Heartbeat line accumulation in stream preview

## [0.5.0] — 2026-02-27

9 commits. Voice system launch and spawn actions.

### Added
- **Voice system** — real-time STT/TTS voice chat with Deepgram Nova-3 and Cartesia Sonic-3; barge-in, auto-join, transcript mirror
- **Spawn actions** — `spawnAgent` for parallel sub-agent invocations (enabled by default)
- `DEEPGRAM_TTS_SPEED` env var for TTS playback speed control

### Fixed
- GCC 14 opus build failure workaround for Fedora 43+

## [0.5.1] — 2026-02-28

16 commits. Voice refinements, transport abstraction, open-task prompt injection.

### Added
- Live open-task summary injected into every prompt
- `TransportClient` interface (platform-agnostic guild/channel/member ops)
- `deep` model tier for Opus-class tasks
- Pinned prompt messages for cron threads
- Voice task-ID stripping before TTS

### Fixed
- Stop reaction preventing archived-thread orphan
- Discord-action JSON leaking into streaming previews
- Unclosed code fences before action results

## [0.5.2–0.5.8] — 2026-02-28 to 2026-03-01

Rapid patch series for cron, memory, and voice improvements.

- **0.5.2** — Durable memory decay/reinforcement signals
- **0.5.3** — Cron state persistence and job chaining
- **0.5.4** — GCC 15 / Fedora 43 CFLAGS compatibility fix
- **0.5.5** — Nested defers up to configurable depth limit
- **0.5.6** — Per-role voice runtime, Gemini REST adapter, cron patterns cookbook
- **0.5.7** — Version bump (voice pipeline stabilization)
- **0.5.8** — Query-aware durable memory injection, embed content in fetch/read/listPins, `@discordjs/opus` security bump to 0.10.0

## [0.4.0] — 2026-02-27

35 commits. Documentation overhaul, YouTube transcripts, image generation, secret management.

### Added
- **`!secret` command** — DM-only secure `.env` management (set/unset/list)
- **YouTube transcript injection** — auto-fetch and inject video transcripts into prompt context
- **Gemini native image generation** — `generateContent` for Gemini image-output models
- **Durable memory consolidation** and supersession engines
- Full documentation gap remediation (12 work packages)
- Model-tier-aware tool scoping
- Loop detection for forge runs and plan phases

### Changed
- External content truncation limit raised to 50k chars
- Replaced YouTube timedtext fetcher with `youtube-transcript-plus`

## [0.3.0] — 2026-02-25

9 commits. OpenAI tool use, runtime hot-swap.

### Added
- **OpenAI function-calling tool use** — schemas, execution handlers, wired into OpenAI-compat adapter
- **Runtime hot-swap** via `!models set chat <runtime>`
- MCP guide and webhook documentation

### Changed
- Split system/user messages in OpenAI-compat adapter

## [0.2.0] — 2026-02-24

Task sync overhaul and init wizard improvements.

### Changed
- Eliminated store-event-triggered full `taskSync` passes (performance)
- Overhauled init wizard to minimal required questions
- Surfaced forge role fallback behavior in `!models` output

## [0.1.0–0.1.8] — 2026-02-22 to 2026-02-24

Initial release series. Core orchestrator, Discord integration, task/cron subsystems, Claude Code and OpenAI-compatible runtime adapters, image generation, CI/CD pipeline for npm publishing via OIDC Trusted Publisher.

[Unreleased]: https://github.com/DiscoClaw/discoclaw/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/DiscoClaw/discoclaw/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/DiscoClaw/discoclaw/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/DiscoClaw/discoclaw/compare/v0.5.8...v0.6.0
[0.5.0]: https://github.com/DiscoClaw/discoclaw/compare/v0.4.0...v0.5.0
[0.5.1]: https://github.com/DiscoClaw/discoclaw/compare/v0.5.0...v0.5.1
[0.5.2–0.5.8]: https://github.com/DiscoClaw/discoclaw/compare/v0.5.1...v0.5.8
[0.4.0]: https://github.com/DiscoClaw/discoclaw/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/DiscoClaw/discoclaw/compare/v0.2.5...v0.3.0
[0.2.0]: https://github.com/DiscoClaw/discoclaw/compare/v0.1.8...v0.2.0
[0.1.0–0.1.8]: https://github.com/DiscoClaw/discoclaw/releases/tag/v0.1.0
