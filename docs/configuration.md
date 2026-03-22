# DiscoClaw Configuration Reference

All configuration is done through environment variables, typically set in a `.env` file. This document lists every variable, its default, and a brief description. For quick setup, see `.env.example` (essentials) or `.env.example.full` (all options).

Boolean values accept `0`/`1` or `true`/`false`.

## Setup Boundary: Source Checkout vs npm-Managed vs Provider/Auth Proof

DiscoClaw has separate setup surfaces for source checkouts and `npm install -g discoclaw` installs. The shipped commands are intentionally split, and the readiness claim depends on which surface you are using:

1. **Config-only source checks** are handled by [`scripts/doctor.ts`](../scripts/doctor.ts), surfaced through `pnpm preflight` and `pnpm preflight:blank-machine`. On the runtime/provider boundary, that script only enforces what it can prove locally through [`checkRuntimeBinaries()`](../scripts/doctor-lib.ts) plus [`inspect()`](../src/health/config-doctor.ts#L727). It can check repo-visible prerequisites such as required env vars, binary presence, binary versions, forum/bootstrap eligibility, and model/runtime config files, but it does not invoke Claude, Codex, or the OpenAI runtime path.
2. **Config-only doctor surfaces shared by both install modes** are handled by [`inspect()`](../src/health/config-doctor.ts#L727) and [`applyFixes()`](../src/health/config-doctor.ts#L808) in [`src/health/config-doctor.ts`](../src/health/config-doctor.ts). For the npm-managed CLI path, [`discoclaw doctor`](../src/cli/index.ts#L357) loads `.env` and then calls those functions from [`src/cli/index.ts`](../src/cli/index.ts). In Discord, [`!doctor` and `!health doctor`](../src/discord/message-coordinator.ts#L1137) route through the same config-doctor module in [`src/discord/message-coordinator.ts`](../src/discord/message-coordinator.ts). That module only inspects config/state files such as `.env`, `models.json`, `runtime-overrides.json`, and workspace/bootstrap markers; it never invokes Codex or OpenAI.
3. **Bootstrap-derived Discord forum state** covers whether DiscoClaw can resolve the cron/task forum channels from checked config or from first-run bootstrap state. That state is considered satisfiable when you already have explicit forum IDs, when persisted scaffold/bootstrap state can supply them, or when `DISCORD_GUILD_ID` is present so the repo can create the missing forums on startup.
4. **Provider/auth validation** remains separate by install mode. Claude source checkouts use [`scripts/claude-auth-smoke.ts`](../scripts/claude-auth-smoke.ts) via `pnpm claude:auth-smoke`, while npm-managed installs use [`discoclaw claude auth-smoke`](../src/cli/index.ts#L315). Codex source checkouts follow the manual session-auth gate documented in [docs/audit/codex-blank-machine-readiness.md](audit/codex-blank-machine-readiness.md), and npm-managed installs follow [docs/audit/codex-npm-managed-path.md](audit/codex-npm-managed-path.md). When any configured source-checkout route uses OpenAI, the separate proof gate is the repo smoke harness documented in [docs/audit/codex-blank-machine-readiness.md](audit/codex-blank-machine-readiness.md); for the npm-managed Codex/OpenAI alternate path, follow the live runtime-visible gate documented in [docs/audit/codex-npm-managed-path.md](audit/codex-npm-managed-path.md). For the shipped OpenRouter env-key path, source checkouts can prove setup/bootstrap with `pnpm preflight*`, prove the running env-key path with `!status` or the startup credential report showing `openrouter-key: ok`, and capture workload evidence only through the repo smoke path. npm-managed installs stay narrower: treat `OPENROUTER_API_KEY`, `discoclaw doctor`, `!doctor`, and `.env` inspection as config/bootstrap evidence only, then stop the shipped claim at post-start evidence such as `openrouter-key: ok`.

That boundary is intentional. The checked-in audit memos at [docs/audit/claude-blank-machine-readiness.md](audit/claude-blank-machine-readiness.md), [docs/audit/claude-npm-managed-path.md](audit/claude-npm-managed-path.md), [docs/audit/codex-blank-machine-readiness.md](audit/codex-blank-machine-readiness.md), [docs/audit/codex-npm-managed-path.md](audit/codex-npm-managed-path.md), and [docs/audit/openrouter-api-key-support-boundary.md](audit/openrouter-api-key-support-boundary.md) are the authoritative readiness verdicts for those install-mode/provider paths. Treat a passing `pnpm preflight:blank-machine`, `pnpm preflight`, `discoclaw doctor`, `!doctor`, or `!health doctor` run as evidence for config/bootstrap prerequisites only. Treat Claude auth smoke, Codex session-auth proof, any required OpenAI runtime proof, and any source-checkout OpenRouter repo smoke-path proof separately as the install-mode-specific auth/readiness gates.

Source-only auth and preflight scripts are unavailable in npm installs because they are not shipped in [`package.json`](../package.json). The published `package.json.files` list includes `dist/`, selected docs, templates, and assets, but not repo-owned source helpers such as `scripts/doctor.ts` or `scripts/claude-auth-smoke.ts`.

For npm-managed daemon installs, readiness is currently constrained by service executable and `PATH` resolution, not just by manual Claude login. [`src/cli/daemon-installer.ts`](../src/cli/daemon-installer.ts) hardcodes `/usr/bin/node` in both service renderers and gives the service a fixed `PATH`, while [`discoclaw init`](../src/cli/init-wizard.ts) does not persist `CLAUDE_BIN`. A passing `discoclaw claude auth-smoke` therefore proves the interactive shell path only; it does not yet prove daemon parity with that shell.

## Discord

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_TOKEN` | — | **Required.** Discord bot token |
| `DISCORD_ALLOW_USER_IDS` | — | Comma-separated user IDs allowed to interact with the bot (fail-closed: empty = respond to nobody) |
| `DISCORD_ALLOW_BOT_IDS` | — | Comma-separated bot IDs trusted for message handling |
| `DISCORD_CHANNEL_IDS` | — | Comma-separated channel IDs the bot responds in (empty = all channels) |
| `DISCORD_GUILD_ID` | — | Server (guild) ID; enables config-only verification of the forum bootstrap path and is required when DiscoClaw must auto-create missing cron/task forum channels |
| `DISCORD_REQUIRE_CHANNEL_CONTEXT` | `true` | Require a channel context file before responding in a channel |
| `DISCORD_AUTO_INDEX_CHANNEL_CONTEXT` | `true` | Auto-create context files for new channels |
| `DISCORD_AUTO_JOIN_THREADS` | `true` | Auto-join public threads the bot encounters |

## Model Configuration

Model assignments are configured in `models.json` under the data dir (`$DISCOCLAW_DATA_DIR/models.json`; default `./data/models.json` in a source checkout). Each role (`chat`, `fast`, `plan-run`, `voice`, forge roles, cron roles, etc.) stores a model string only. Runtime-only overlays such as `voiceRuntime` and `fastRuntime` persist separately in `runtime-overrides.json`. See `src/model-config.ts` and `src/runtime-overrides.ts` for the loading logic.

On first run, `models.json` is scaffolded from the instance startup defaults. `!models set ...` updates it at runtime. `!models reset` writes the startup-default model strings back into `models.json` and clears matching fast/voice runtime overlays from `runtime-overrides.json`. The `plan-run` role is independent from `chat` and starts from `DISCOCLAW_PLAN_RUN_MODEL` (default `capable`) rather than the live chat model.

Legacy env vars `RUNTIME_MODEL`, `DISCOCLAW_PLAN_RUN_MODEL`, and `DISCOCLAW_FAST_MODEL` are still read as startup fallbacks when `models.json` is missing or incomplete, but new deployments should use `models.json` exclusively.

For the operator workflow that explains startup defaults vs. overrides, install-mode detection, `!models reset` semantics, live main-runtime swaps, and safe adapter/model switching, see [docs/runtime-switching.md](runtime-switching.md). If you want OpenRouter to participate in tier-based switching, define the specific `DISCOCLAW_TIER_OPENROUTER_<TIER>` vars you need there as well.

`!models` and `!models help` also expose image generation as a discoverable capability before setup is complete: `!models` shows `imagegen` as `setup-required` when unconfigured, and `!models help` notes that imagegen setup is still required and must be done through environment variables rather than `!models set`.

## Runtime

| Variable | Default | Description |
|----------|---------|-------------|
| `PRIMARY_RUNTIME` | `claude` | Runtime adapter: `claude`, `openai`, `openrouter`, `gemini`, `codex` |
| `RUNTIME_MODEL` | `capable` | **Deprecated** — use `models.json`. Startup-default model tier for chat invocations |
| `DISCOCLAW_PLAN_RUN_MODEL` | `capable` | **Deprecated** — use `models.json`. Startup-default model tier for the dedicated `plan-run` role |
| `DISCOCLAW_FAST_RUNTIME` | — | **Deprecated** — use `!models set fast <model>` instead, which auto-detects and switches the fast-tier runtime. Legacy startup-only runtime override for fast-tier workloads (summary, cron auto-tag/model classify, task auto-tag); ignored by `!models reset` |
| `RUNTIME_TOOLS` | `Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch` | Comma-separated tools available to the runtime |
| `RUNTIME_TIMEOUT_MS` | `1800000` (30 min) | Per-invocation timeout |
| `RUNTIME_FALLBACK_MODEL` | — | Fallback model if primary fails |
| `RUNTIME_MAX_BUDGET_USD` | — | Max budget per invocation (positive number) |
| `CLAUDE_APPEND_SYSTEM_PROMPT` | — | Additional system prompt appended to all invocations (max 4000 chars) |
| `DISCOCLAW_RUNTIME_SESSIONS` | `true` | Enable multi-turn session persistence |

### Global Runtime Supervisor

Runtime-wide wrapper for every invocation (`plan -> execute -> evaluate -> decide`). Disabled by default to preserve legacy behavior.

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_GLOBAL_SUPERVISOR_ENABLED` | `false` | Enable the runtime-wide supervisor wrapper. When `false`, invocations run through the legacy direct path. |
| `DISCOCLAW_GLOBAL_SUPERVISOR_AUDIT_STREAM` | `stderr` | Stream for per-cycle JSON audit events (`stdout` or `stderr`). |
| `DISCOCLAW_GLOBAL_SUPERVISOR_MAX_CYCLES` | `3` | Max supervisor cycles before bail. Must be `>= 1`. |
| `DISCOCLAW_GLOBAL_SUPERVISOR_MAX_RETRIES` | `2` | Max retries across cycles. Must be `>= 0`. Effective retries are capped by `maxCycles - 1`. |
| `DISCOCLAW_GLOBAL_SUPERVISOR_MAX_ESCALATION_LEVEL` | `2` | Max escalation level appended to the system prompt after retries. Must be `>= 0`. |
| `DISCOCLAW_GLOBAL_SUPERVISOR_MAX_TOTAL_EVENTS` | `5000` | Max total streamed runtime events across all cycles before bail. Must be `>= 1`. |
| `DISCOCLAW_GLOBAL_SUPERVISOR_MAX_WALL_TIME_MS` | `0` | Wall-time cap for the full supervisor loop. `0` disables the cap. Must be `>= 0`. |

If the supervisor bails, the normalized `RuntimeFailure` stays attached on `error.failure`, while the runtime error message remains operator-readable. The envelope still preserves the legacy handoff format in `rawMessage` for compatibility:

- Envelope fields: `envelope`, `envelopeVersion`, `source`, `code`, `message`, `rawMessage`, `userMessage`, `retryable`, and `metadata`.
- Legacy compatibility prefix inside `rawMessage`: `GLOBAL_SUPERVISOR_BAIL `
- Supervisor metadata: `reason`, `cycle`, `retriesUsed`, `escalationLevel`, `failureKind`, `signature`, `lastError`, and `limits`.
- Bail reasons: `non_retryable_failure`, `deterministic_retry_blocked`, `max_cycles_exceeded`, `max_retries_exceeded`, `max_wall_time_exceeded`, `max_events_exceeded`.

### Runtime Failure Envelope

`RuntimeFailure` is the single runtime/tool failure contract for DiscoClaw. There are no environment variables to enable it; normalization is always on in `src/runtime/runtime-failure.ts`.

| Field | Values | Notes |
|-------|--------|-------|
| `envelope` | `runtime_failure` | Stable envelope marker |
| `envelopeVersion` | `v1` | Schema version for the envelope |
| `source` | `runtime`, `pipeline_tool`, `global_supervisor` | Identifies where the failure originated |
| `code` | Runtime/tool failure code | Includes pipeline codes such as `E_TOOL_UNAVAILABLE` and runtime codes such as `STREAM_STALL`, `CONTEXT_LIMIT_EXCEEDED`, and `GLOBAL_SUPERVISOR_BAIL` |
| `message` | string | Canonical machine-facing failure text |
| `rawMessage` | string | Original upstream text; preserves legacy prefixes/payloads when applicable |
| `userMessage` | string | User-facing explanation derived from the normalized failure |
| `retryable` | `true`, `false`, `null` | Retry hint after classification |
| `metadata` | object | Source-specific structured data (pipeline operation/details or supervisor bail metadata) |

Normalization accepts all current runtime failure inputs:

- Pipeline tool failures from `src/runtime/openai-tool-exec.ts`, including failed auto-run `pipeline.start` / `pipeline.resume` executions (legacy `{ ok: false, operation, failure_code_version, failure_code, message }` payloads)
- Legacy global supervisor bail strings prefixed with `GLOBAL_SUPERVISOR_BAIL `
- Raw runtime error strings that previously relied on Discord-side pattern matching

Runtime emitters that still use `type: 'error'` now attach `error.failure` while keeping `error.message` in its existing readable form.

This changes failure shape, not runtime configuration: operators do not need new env vars or migration steps to adopt the unified envelope.

### Claude CLI

For the source-checkout flow, [`scripts/doctor.ts`](../scripts/doctor.ts) remains config-only. Through `pnpm preflight` and `pnpm preflight:blank-machine`, it can verify Claude CLI presence, version, and related config, but it does **not** invoke Claude or prove interactive authentication. Use `pnpm preflight:blank-machine` when you need the audit to ignore inherited shell env and validate only the written `.env`.

Claude auth is a separate install-mode-specific step. Source checkouts use [`scripts/claude-auth-smoke.ts`](../scripts/claude-auth-smoke.ts) via `pnpm claude:auth-smoke`, while npm-managed installs use `discoclaw claude auth-smoke`. The blank-machine audit in [docs/audit/claude-blank-machine-readiness.md](audit/claude-blank-machine-readiness.md) remains the authority for how to combine the config-only preflight result with the source-checkout Claude auth smoke result.

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_BIN` | `claude` | Path to Claude CLI binary |
| `CLAUDE_OUTPUT_FORMAT` | `text` | Output format: `text` or `stream-json` |
| `CLAUDE_VERBOSE` | `false` | Enable verbose metadata (requires `stream-json` format) |
| `CLAUDE_ECHO_STDIO` | `false` | Echo runtime stdio to console |
| `CLAUDE_DEBUG_FILE` | — | Write debug output to this file |
| `CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS` | `false` | Skip runtime permission checks |
| `CLAUDE_STRICT_MCP_CONFIG` | `true` | Strict MCP config validation |

### OpenAI-Compatible

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | — | OpenAI API key |
| `OPENAI_BASE_URL` | — | Custom base URL for OpenAI-compatible API |
| `OPENAI_MODEL` | `gpt-4o` | Model ID for OpenAI-compatible adapter |
| `OPENAI_COMPAT_TOOLS_ENABLED` | `false` | Enable function-calling tool use |

Requirement: choose models that reliably support structured JSON output and function calling. API compatibility alone is not sufficient.

### OpenRouter

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | — | OpenRouter API key |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter base URL |
| `OPENROUTER_MODEL` | `openai/gpt-5-mini` | Default model via OpenRouter |
| `OPENROUTER_PROVIDER_PREFERENCES` | — | Optional JSON string forwarded as OpenRouter's request `provider` object |

Treat `OPENROUTER_API_KEY` as config presence only until the running instance proves it can see that key. The shipped live proof surface today is `!status` or the startup credential report showing `openrouter-key: ok` for the active OpenRouter path. For source checkouts, the audited support boundary is broader but still narrow: `pnpm preflight*` can prove setup/bootstrap prerequisites, and repo smoke-path validation is the only shipped workload-proof surface for OpenRouter-backed routes. For npm-managed installs, `discoclaw doctor` remains config-only and must not be described as workload proof. Same requirement applies when routing through OpenRouter: model reliability for JSON/tool-call output is required. DiscoClaw ships OpenRouter tier defaults of `fast → openai/gpt-5-mini`, `capable → anthropic/claude-sonnet-4.6`, and `deep → anthropic/claude-opus-4.6`; override them with `DISCOCLAW_TIER_OPENROUTER_<TIER>` only when you need different routing.

### OpenRouter env-key parity checklist

Use this checklist for the current audited OpenRouter slice. It covers the shipped `OPENROUTER_API_KEY` env-key path, the source-checkout setup/bootstrap boundary, and the source-checkout repo smoke path for workload evidence.

1. **Authoritative `.env`**: set `OPENROUTER_API_KEY` in the instance `.env` that the actual service or dev process reads.
2. **Intended routing**: set `PRIMARY_RUNTIME=openrouter`, use `!models set chat openrouter`, or otherwise configure the role/runtime path that should actually hit OpenRouter. Key presence alone does not change runtime routing.
3. **Source checkout setup proof**: if you are validating a source checkout, run `pnpm preflight` or `pnpm preflight:blank-machine` first and treat those as setup/bootstrap evidence only.
4. **Optional base override**: if you use a proxy or alternate base, set `OPENROUTER_BASE_URL` intentionally and verify it is the base you expect the running instance to probe.
5. **Start or restart DiscoClaw**: load the updated env into the real process you are validating.
6. **Check the shipped live proof surface**: run `!status` or inspect the startup credential report and confirm it shows `openrouter-key: ok`.
7. **Source checkout workload proof**: if you need to claim an OpenRouter-backed workload in a source checkout, use the repo smoke path for that exact workload or model. That is the only shipped workload-proof surface today.
8. **Claim only the current boundary**: treat `openrouter-key: ok` as proof that the shipped runtime can see the configured OpenRouter env-key path, and treat repo smoke-path evidence as source-checkout workload proof only. Do not extend either signal into blanket model, tool, daemon, or install-mode parity claims.

Current proof surface:
- `pnpm preflight` and `pnpm preflight:blank-machine` remain source-checkout setup/bootstrap evidence only for this path.
- `!status` renders the live OpenRouter credential row and reports `openrouter-key: ok` only after the running instance successfully performs the shipped `GET /models` credential probe.
- The startup credential report exposes the same runtime-visible proof without requiring a separate interactive command.
- For source checkouts, repo smoke-path validation is the only shipped workload-proof surface for OpenRouter-backed routes.
- `discoclaw init`, `discoclaw doctor`, `!doctor`, and `.env` inspection remain config/bootstrap evidence only for this path.

Deferred follow-up areas for later OpenRouter parity work:
- Install-mode-specific parity claims beyond the current source-checkout smoke path and env-key visibility checks, including npm-managed workload parity and daemon/service parity language.
- Curated workload-specific model recommendations beyond the shipped OpenRouter tier defaults.
- Broader runtime-readiness claims beyond the current source-checkout smoke path and shipped credential probe, such as end-to-end tool, action, or broader workload validation.

### Model validation smoke test (recommended)

Run this checklist before adopting any new OpenAI-compatible/OpenRouter model:

1. **Basic response check**: send a normal prompt and verify a stable non-empty text response.
2. **Structured JSON check**: request a small fixed JSON object (no prose, no code fences), parse it, and verify required keys are always present.
3. **Repeatability check**: run the same JSON prompt at least 10 times; reject the model if parse/schema failures occur.
4. **Tool-call check** (when `OPENAI_COMPAT_TOOLS_ENABLED=1`): verify the model emits valid `tool_calls`, the server executes them, and the model returns a final answer without looping.
5. **Action/routing format check** (if you use Discord actions or cron JSON routing): verify the model returns strict machine-readable output (`<discord-action>{...}</discord-action>` blocks or bare JSON arrays) without extra wrapper prose.

If any check fails consistently, treat the model as unsupported for DiscoClaw runtime use.

### Gemini CLI

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_BIN` | `gemini` | Path to Gemini CLI binary |
| `GEMINI_MODEL` | `gemini-2.5-pro` | Gemini model ID |

### Codex CLI

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_BIN` | `codex` | Path to Codex CLI binary |
| `CODEX_MODEL` | `gpt-5.4` | Codex model ID |
| `CODEX_DANGEROUSLY_BYPASS_APPROVALS_AND_SANDBOX` | `false` | Skip Codex safety checks |
| `CODEX_DISABLE_SESSIONS` | `false` | Disable Codex session persistence |
| `DISCOCLAW_CODEX_VERBOSE_PREVIEW` | `false` | Emit richer reasoning/command preview lines (also forces `model_reasoning_summary="auto"` for Codex runs) |
| `DISCOCLAW_CODEX_ITEM_TYPE_DEBUG` | `false` | Emit structured `item.started`/`item.completed` item-type debug events in preview (also forces `model_reasoning_summary="auto"` for Codex runs) |

### Tier Overrides

Use `DISCOCLAW_TIER_<RUNTIME>_<TIER>` env vars to replace the built-in tier-to-model map for a runtime.

| Topic | Value | Notes |
|-------|-------|-------|
| Pattern | `DISCOCLAW_TIER_<RUNTIME>_<TIER>` | `<RUNTIME>` is the runtime ID in uppercase (for example `OPENAI`, `OPENROUTER`, `GEMINI`, `CODEX`, `CLAUDE_CODE`); `<TIER>` is `FAST`, `CAPABLE`, or `DEEP` |
| Example | `DISCOCLAW_TIER_OPENAI_CAPABLE=gpt-5.4` | Maps the `capable` tier for that runtime to a concrete model string |
| OpenRouter note | `DISCOCLAW_TIER_OPENROUTER_FAST/CAPABLE/DEEP` | Optional overrides for the shipped OpenRouter defaults; even one unique entry is enough for exact-string reverse-mapping for fast/voice runtime auto-switching |
| Default behavior | Built-in tier map from `src/runtime/model-tiers.ts` | If no override is set, DiscoClaw uses the repo's shipped defaults for every built-in runtime, including OpenRouter |
| Full workflow | [docs/runtime-switching.md](runtime-switching.md) | See the canonical operator guide for install-mode detection, switch verification, platform-appropriate log checks, OpenRouter tier defaults and overrides, restart behavior, rollback, and safe switching steps |

## Memory

See [docs/memory.md](memory.md) for detailed descriptions of each layer.
Current durable-memory behavior is size-triggered hot-tier compaction: active items are kept near 25 items or ~2000 chars, and low-value items are demoted using `hitCount` + `lastHitAt` signals.

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_DURABLE_MEMORY_ENABLED` | `true` | Enable durable (long-term) memory |
| `DISCOCLAW_DURABLE_INJECT_MAX_CHARS` | `2000` | Max chars of durable memory per prompt |
| `DISCOCLAW_DURABLE_MAX_ITEMS` | `200` | Max durable items per user |
| `DISCOCLAW_DURABLE_DATA_DIR` | — | Override durable memory storage directory |
| `DISCOCLAW_DURABLE_SUPERSESSION_SHADOW` | `false` | Shadow mode: log supersession without acting |
| `DISCOCLAW_MEMORY_CONSOLIDATION_THRESHOLD` | `50` | Legacy consolidation threshold knob (parsed for compatibility; not wired to active hot-tier compaction) |
| `DISCOCLAW_MEMORY_CONSOLIDATION_MODEL` | `fast` | Legacy consolidation model knob (parsed for compatibility; no runtime effect in current hot-tier path) |
| `DISCOCLAW_MEMORY_COMMANDS_ENABLED` | `true` | Enable `!memory` bang commands |
| `DISCOCLAW_SUMMARY_ENABLED` | `true` | Enable rolling summaries |
| `DISCOCLAW_SUMMARY_MODEL` | `fast` | Model tier for summary generation |
| `DISCOCLAW_SUMMARY_MAX_CHARS` | `2000` | Max chars for rolling summary |
| `DISCOCLAW_SUMMARY_EVERY_N_TURNS` | `5` | Turns between summary refreshes |
| `DISCOCLAW_SUMMARY_MAX_TOKENS` | `1500` | Estimated-token threshold for rolling summary recompression (roughly `ceil(chars / 4)`) |
| `DISCOCLAW_SUMMARY_TARGET_RATIO` | `0.65` | Recompression target ratio; target tokens are `floor(DISCOCLAW_SUMMARY_MAX_TOKENS * ratio)` |
| `DISCOCLAW_SUMMARY_DATA_DIR` | — | Override summary storage directory |
| `DISCOCLAW_SUMMARY_TO_DURABLE_ENABLED` | `true` | Enable auto-extraction (user turn → durable memory) |
| `DISCOCLAW_MESSAGE_HISTORY_BUDGET` | `3000` | Character budget for message history |
| `DISCOCLAW_SHORTTERM_MEMORY_ENABLED` | `true` | Enable cross-channel short-term memory |
| `DISCOCLAW_SHORTTERM_MAX_ENTRIES` | `20` | Max short-term entries |
| `DISCOCLAW_SHORTTERM_MAX_AGE_HOURS` | `6` | Expiry in hours for short-term entries |
| `DISCOCLAW_SHORTTERM_INJECT_MAX_CHARS` | `1000` | Max chars for short-term injection |
| `DISCOCLAW_SHORTTERM_DATA_DIR` | — | Override short-term memory storage directory |

## Plan & Forge

See [docs/plan-and-forge.md](plan-and-forge.md) for usage details.

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_PLAN_COMMANDS_ENABLED` | `true` | Enable `!plan` bang commands |
| `PLAN_PHASES_ENABLED` | `true` | Enable plan phase execution |
| `PLAN_PHASE_MAX_CONTEXT_FILES` | `5` | Max context files per phase |
| `PLAN_PHASE_TIMEOUT_MS` | `1800000` (30 min) | Timeout per phase execution |
| `PLAN_PHASE_AUDIT_FIX_MAX` | `3` | Max audit-fix attempts per phase |
| `PLAN_FORGE_HEARTBEAT_INTERVAL_MS` | `45000` | Default heartbeat interval (ms) for command-path phase progress updates in `!plan run*` and `!forge`; `0` disables periodic heartbeats |
| `DISCOCLAW_FORGE_COMMANDS_ENABLED` | `true` | Enable `!forge` bang commands |
| `FORGE_MAX_AUDIT_ROUNDS` | `5` | Max audit rounds in forge |
| `FORGE_DRAFTER_MODEL` | — | Model override for forge drafter |
| `FORGE_AUDITOR_MODEL` | — | Model override for forge auditor |
| `FORGE_DRAFTER_RUNTIME` | — | Runtime override for forge drafter |
| `FORGE_AUDITOR_RUNTIME` | — | Runtime override for forge auditor |
| `FORGE_TIMEOUT_MS` | `1800000` (30 min) | Timeout for forge operations |
| `FORGE_PROGRESS_THROTTLE_MS` | `3000` | Throttle interval for forge progress messages |
| `FORGE_AUTO_IMPLEMENT` | `true` | Auto-run plan phases after forge approval |

## Cron & Automations

See [docs/cron.md](cron.md) for the operator guide.

When `DISCOCLAW_CRON_FORUM` is unset, forum state may still be bootstrap-satisfiable if persisted scaffold state already recorded the forum ID or if `DISCORD_GUILD_ID` is present so startup can create the forum. That is a configuration/bootstrap check only; it is separate from Claude login validation.

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_CRON_ENABLED` | `true` | Enable the cron subsystem |
| `DISCOCLAW_CRON_FORUM` | — | Explicit forum channel ID for cron job definitions; when unset, DiscoClaw relies on persisted bootstrap state or `DISCORD_GUILD_ID` to create/resolve the forum |
| `DISCOCLAW_CRON_MODEL` | `fast` | Model tier for cron definition parsing |
| `DISCOCLAW_CRON_EXEC_MODEL` | `capable` | Model tier for cron execution |
| `DISCOCLAW_CRON_AUTO_TAG` | `true` | Auto-tag cron forum threads |
| `DISCOCLAW_CRON_AUTO_TAG_MODEL` | `fast` | Model tier for cron auto-tagging |
| `DISCOCLAW_CRON_STATS_DIR` | — | Override cron stats storage directory |
| `DISCOCLAW_CRON_TAG_MAP` | — | Override cron tag map file path |

## Tasks

See [docs/tasks.md](tasks.md) for the operator guide.

The same forum-boundary rule applies to tasks: `DISCOCLAW_TASKS_FORUM` is the direct config path, while persisted scaffold state or `DISCORD_GUILD_ID` covers the bootstrap-derived path that automated setup can check today.

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_TASKS_ENABLED` | `true` | Enable the task subsystem |
| `DISCOCLAW_TASKS_FORUM` | — | Explicit forum channel ID for task threads; when unset, DiscoClaw relies on persisted bootstrap state or `DISCORD_GUILD_ID` to create/resolve the forum |
| `DISCOCLAW_TASKS_CWD` | — | Override task working directory |
| `DISCOCLAW_TASKS_TAG_MAP` | — | Override task tag map file path |
| `DISCOCLAW_TASKS_MENTION_USER` | — | User ID to @mention on task creation; fresh `discoclaw init` / `pnpm run setup` configs default this to the first `DISCORD_ALLOW_USER_IDS` entry |
| `DISCOCLAW_TASKS_SIDEBAR` | `true` | Show tasks in forum sidebar |
| `DISCOCLAW_TASKS_AUTO_TAG` | `true` | Auto-tag task threads via AI |
| `DISCOCLAW_TASKS_AUTO_TAG_MODEL` | `fast` | Model tier for auto-tagging |
| `DISCOCLAW_TASKS_SYNC_SKIP_PHASE5` | `false` | Skip the reconcile phase in task sync |
| `DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_ENABLED` | `true` | Retry failed sync operations |
| `DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_DELAY_MS` | `30000` | Delay before retrying failed sync |
| `DISCOCLAW_TASKS_SYNC_DEFERRED_RETRY_DELAY_MS` | `30000` | Delay before retrying deferred sync |
| `DISCOCLAW_TASKS_PREFIX` | `ws` | Prefix for task IDs |

## Voice

See [docs/voice.md](voice.md) for the full setup guide and provider details.

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_VOICE_ENABLED` | `false` | Master switch for voice subsystem |
| `DISCOCLAW_VOICE_AUTO_JOIN` | `false` | Auto-join voice channels when users enter |
| `ANTHROPIC_API_KEY` | — | Anthropic API key (required for direct Messages API voice responses) |
| `DISCOCLAW_VOICE_MODEL` | follows startup chat model | Model override for voice responses |
| `DISCOCLAW_VOICE_SYSTEM_PROMPT` | — | System prompt override for voice (max 4000 chars) |
| `DISCOCLAW_STT_PROVIDER` | `deepgram` | Speech-to-text provider: `deepgram`, `whisper`, `openai` |
| `DISCOCLAW_TTS_PROVIDER` | `cartesia` | Text-to-speech provider: `cartesia`, `deepgram`, `kokoro`, `openai` |
| `DISCOCLAW_VOICE_HOME_CHANNEL` | — | Voice channel name or ID for prompt context |
| `DISCOCLAW_VOICE_LOG_CHANNEL` | `voice-log` | Text channel for transcript mirror |
| `DEEPGRAM_API_KEY` | — | Deepgram API key (required for Deepgram STT/TTS) |
| `DEEPGRAM_STT_MODEL` | `nova-3-general` | Deepgram STT model |
| `DEEPGRAM_TTS_VOICE` | `aura-2-asteria-en` | Deepgram TTS voice |
| `DEEPGRAM_TTS_SPEED` | `1.3` | Deepgram TTS playback speed multiplier (0.5–1.5) |
| `CARTESIA_API_KEY` | — | Cartesia API key (required for Cartesia TTS) |

## Webhook

See [docs/webhook-exposure.md](webhook-exposure.md) for setup and security details.

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_WEBHOOK_ENABLED` | `false` | Enable the webhook HTTP server |
| `DISCOCLAW_WEBHOOK_PORT` | `9400` | Port for the webhook server |
| `DISCOCLAW_WEBHOOK_CONFIG` | — | Path to webhook config file |

## Dashboard

See [docs/dashboard-tailscale.md](dashboard-tailscale.md) for access and trusted-host details.

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_DASHBOARD_ENABLED` | `true` | Enable the local operator dashboard (`0` disables it) |
| `DISCOCLAW_DASHBOARD_PORT` | `9401` | Port for the dashboard HTTP server. Each DiscoClaw instance on the same machine needs its own dashboard port. |
| `DISCOCLAW_DASHBOARD_TRUSTED_HOSTS` | — | Comma-separated exact hosts accepted in the dashboard `Host` header. When non-empty, DiscoClaw binds the dashboard to `0.0.0.0` so trusted Tailscale hosts can reach it. |

If you run multiple DiscoClaw instances on one machine and want dashboards on both, assign distinct `DISCOCLAW_DASHBOARD_PORT` values such as `9401` and `9402`.

## Canvas

Interactive HTML artifacts served as Discord Activities. See [docs/discord-bot-setup.md](discord-bot-setup.md) § Canvas Activities for the Discord Developer Portal setup steps.

Canvas is experimental and default-off. Existing installs that want to keep canvas available after this change must set `DISCOCLAW_CANVAS_ENABLED=1` explicitly before restarting on the new version.

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_CANVAS_ENABLED` | `false` | Opt-in master switch for the experimental canvas subsystem. Fresh installs and upgraded installs must set it to `1` explicitly to keep canvas available. |
| `DISCOCLAW_CANVAS_PORT` | `9402` | Canvas server port |
| `DISCOCLAW_CANVAS_ARTIFACT_DIR` | — | Override artifact storage directory |
| `DISCOCLAW_CANVAS_MAX_ARTIFACTS` | `1000` | Max stored artifacts (LRU eviction) |
| `DISCOCLAW_CANVAS_PENDING_LAUNCH_TTL_SECONDS` | `120` | Pending launch expiry |
| `DISCOCLAW_CANVAS_WRITE_BRIDGE_ENABLED` | `true` | Allow artifacts to export files to disk |
| `DISCOCLAW_CANVAS_EXPORT_DIR` | — | Override export directory |
| `DISCOCLAW_CANVAS_EXPORT_MAX_BYTES` | `5242880` (5 MB) | Max export file size |
| `DISCORD_ACTIVITY_CLIENT_SECRET` | — | OAuth client secret (optional; pre-auth is used when absent) |

## Actions

Master switch and per-category flags for Discord actions. See [docs/discord-actions.md](discord-actions.md).

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_DISCORD_ACTIONS` | `true` | Master switch for all Discord actions |
| `DISCOCLAW_DISCORD_ACTIONS_CHANNELS` | `true` | Channel management actions |
| `DISCOCLAW_DISCORD_ACTIONS_MESSAGING` | `true` | Messaging actions (send, edit, delete, react) |
| `DISCOCLAW_DISCORD_ACTIONS_GUILD` | `true` | Guild/server actions (roles, members) |
| `DISCOCLAW_DISCORD_ACTIONS_MODERATION` | `false` | Moderation actions (kick, ban, timeout) |
| `DISCOCLAW_DISCORD_ACTIONS_POLLS` | `true` | Poll actions |
| `DISCOCLAW_DISCORD_ACTIONS_TASKS` | `true` | Task actions |
| `DISCOCLAW_DISCORD_ACTIONS_CRONS` | `true` | Cron actions |
| `DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE` | `true` | Bot profile actions (status, activity, nickname) |
| `DISCOCLAW_DISCORD_ACTIONS_FORGE` | `true` | Forge actions |
| `DISCOCLAW_DISCORD_ACTIONS_PLAN` | `true` | Plan actions |
| `DISCOCLAW_DISCORD_ACTIONS_MEMORY` | `true` | Memory actions |
| `DISCOCLAW_DISCORD_ACTIONS_DEFER` | `true` | Deferred (scheduled) actions |
| `DISCOCLAW_DISCORD_ACTIONS_LOOP` | `true` | Loop actions (repeating scheduled self-invocations) |
| `DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN` | `false` | Enables actual image generation execution; normal manual/help surfaces can still advertise `imagegen` before setup |
| `DISCOCLAW_DISCORD_ACTIONS_VOICE` | `false` | Voice actions |
| `DISCOCLAW_DISCORD_ACTIONS_SPAWN` | `true` | Spawn parallel sub-agent invocations |
| `DISCOCLAW_SENDFILE_ALLOWED_DIRS` | `/tmp` | Comma-separated absolute directory paths allowed for the `sendFile` action. `DISCOCLAW_DATA_DIR` and `WORKSPACE_CWD` are auto-included when set. Symlinks are resolved via `fs.realpath()` before checking. |
| `DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_DELAY_SECONDS` | `1800` | Max delay for deferred actions |
| `DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_CONCURRENT` | `5` | Max concurrent deferred actions |
| `DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_DEPTH` | `4` | Max nesting depth for nested defers |
| `DISCOCLAW_DISCORD_ACTIONS_LOOP_MIN_INTERVAL_SECONDS` | `60` | Minimum interval accepted for `loopCreate` |
| `DISCOCLAW_DISCORD_ACTIONS_LOOP_MAX_INTERVAL_SECONDS` | `86400` | Maximum interval accepted for `loopCreate` |
| `DISCOCLAW_DISCORD_ACTIONS_LOOP_MAX_CONCURRENT` | `5` | Max concurrent active loops |
| `DISCOCLAW_DISCORD_ACTIONS_SPAWN_MAX_CONCURRENT` | `8` | Max concurrent spawned agents |
| `DISCOCLAW_ACTION_FOLLOWUP_DEPTH` | `3` | Max follow-up depth for action chains |

## Image Generation

Users can discover `imagegen` before setup on the normal manual/help surfaces (`!models`, `!models help`, and the normal manual message/follow-up action path). That is discoverability only. Actual generation still requires the existing enablement/config path: set `DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN=1` and configure a provider key. Until then, normal manual/follow-up invocations return a setup walkthrough instead of generating an image. Reaction/deferred flows remain on their own current flag-driven contracts.

| Variable | Default | Description |
|----------|---------|-------------|
| `IMAGEGEN_GEMINI_API_KEY` | — | Gemini API key for image generation |
| `IMAGEGEN_DEFAULT_MODEL` | — | Default imagegen model (auto-detected from available keys) |

## Bot Appearance

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_BOT_NAME` | — | Override the bot's display name |
| `DISCOCLAW_BOT_STATUS` | — | Bot status: `online`, `idle`, `dnd`, `invisible` |
| `DISCOCLAW_BOT_ACTIVITY` | — | Bot activity text (e.g., "Listening to music") |
| `DISCOCLAW_BOT_ACTIVITY_TYPE` | `Playing` | Activity type: `Playing`, `Listening`, `Watching`, `Competing`, `Custom` |
| `DISCOCLAW_BOT_AVATAR` | — | Bot avatar URL or absolute file path |

## Operations

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_DATA_DIR` | — | Root data directory (workspace, content, memory under this) |
| `DISCOCLAW_CONTENT_DIR` | — | Override content directory |
| `WORKSPACE_CWD` | — | Override workspace working directory |
| `GROUPS_DIR` | — | Override groups directory |
| `USE_GROUP_DIR_CWD` | `false` | Use group directory as runtime CWD |
| `DISCOCLAW_STATUS_CHANNEL` | — | Channel ID for boot/status messages |
| `DISCOCLAW_SERVICE_NAME` | `discoclaw` | systemd service name (for multi-instance setups) |
| `DISCOCLAW_HEALTH_COMMANDS_ENABLED` | `true` | Enable `!health` and `!doctor` bang commands |
| `DISCOCLAW_HEALTH_VERBOSE_ALLOWLIST` | — | User IDs allowed verbose health output |
| `DISCOCLAW_SESSION_SCANNING` | `true` | Enable session scanning |
| `DISCOCLAW_TOOL_AWARE_STREAMING` | `true` | Enable tool-aware streaming and presentation-layer runtime signal adaptation for Discord previews (concise human-readable lines derived from runtime events, while internal event payloads stay unchanged). |
| `DISCOCLAW_STREAM_PREVIEW_RAW` | `false` | Render a denser `Thinking...` preview when `true` (14-line tail, 120-char width, richer runtime signals). `false` keeps compact mode (8-line tail, 72-char width). Preview text remains sanitized in both modes (`<discord-action>` tags, including partial trailing tags, are stripped), and structured payload fragments are redacted from user-facing preview lines. |
| `DISCOCLAW_MULTI_TURN` | `true` | Enable multi-turn sessions |
| `DISCOCLAW_MULTI_TURN_HANG_TIMEOUT_MS` | `60000` | Timeout for hung multi-turn sessions |
| `DISCOCLAW_MULTI_TURN_IDLE_TIMEOUT_MS` | `300000` | Idle timeout for multi-turn sessions |
| `DISCOCLAW_MULTI_TURN_MAX_PROCESSES` | `5` | Max concurrent multi-turn processes |
| `DISCOCLAW_STREAM_STALL_TIMEOUT_MS` | `1800000` | Timeout for stalled streams |
| `DISCOCLAW_PROGRESS_STALL_TIMEOUT_MS` | `1800000` | Timeout for stalled progress |
| `DISCOCLAW_STREAM_STALL_WARNING_MS` | `300000` | Warning threshold for stalled streams |
| `DISCOCLAW_MAX_CONCURRENT_INVOCATIONS` | `0` (unlimited) | Max concurrent AI invocations |
| `DISCOCLAW_DEBUG_RUNTIME` | `false` | Enable runtime debug logging |
| `DISCOCLAW_COMPLETION_NOTIFY` | `true` | Enable long-run follow-up status updates. Uses in-process deferred timers during normal execution and persisted lifecycle recovery on startup after interruption. |
| `DISCOCLAW_COMPLETION_NOTIFY_THRESHOLD_MS` | `30000` | Delay before the in-process "still running" follow-up timer fires. Applies only while the process stays alive; interrupted runs are recovered from persisted state on startup. |
| `DISCOCLAW_BOT_MESSAGE_MEMORY_WRITE` | `false` | Write bot messages to memory |

Runtime preview text adapter (DRAFT):

- `EngineEvent`/`PlanRunEvent` schemas are internal contracts and are not changed by preview formatting.
- Discord preview text is generated in a presentation layer; this can summarize or redact details (especially structured JSON fragments) without changing underlying runtime events or logs.
- `DISCOCLAW_STREAM_PREVIEW_RAW` changes preview density/formatting only; it does not broaden exposed internal payload detail.

Completion notify behavior:

- Normal path: schedules an in-process deferred "still running" follow-up when runtime duration passes `DISCOCLAW_COMPLETION_NOTIFY_THRESHOLD_MS`.
- Persistence-first invariant: before any final Discord edit/send that could strand the run, the coordinator stages a bounded, normalized recovery payload through the watchdog and persists completion state to disk.
- Staging failure behavior: if that recovery staging fails, the coordinator treats the run as a visible failure path and posts an explicit failure notice instead of continuing as a recoverable success path.
- Recovery path: startup sweep replays interrupted long-running runs from persisted watchdog state and reposts meaningful summary text from the recovery payload when one was saved.
- Generic fallback: startup recovery falls back to a generic completion notice only when no persisted recovery payload exists.
- Duplicate handling: after a successful coordinator-side final Discord delivery, the coordinator explicitly acknowledges visibility back into the watchdog so startup sweep skips that run instead of reposting it.

This guarantee adds no new environment variables; `.env.example` remains unchanged.

## Browser Launcher

Discoclaw's browser path is a thin local launcher around a single managed Chrome/Chromium profile. It does not run a long-lived helper daemon or localhost control service. For the full operator workflow and failure modes, see [docs/browser-launcher.md](browser-launcher.md).

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_BROWSER_EXECUTABLE_PATH` | — | Optional path to the Chrome/Chromium executable used for managed-profile launches. When unset, Discoclaw falls back to PATH/common-install discovery. |

- Managed browser storage lives under `$DISCOCLAW_DATA_DIR/browser/` as `profile/` and `state.json`. If `DISCOCLAW_DATA_DIR` is unset in a source checkout, the default becomes `./data/browser/`.
- Source-install restriction: repo-local source installs may only use the default `./data/browser/` path for managed browser storage. A custom in-repo `DISCOCLAW_DATA_DIR` is rejected; move it outside the repo or leave it unset.
- Supported CLI commands: `discoclaw browser setup`, `discoclaw browser doctor`, `discoclaw browser launch`, and `discoclaw browser launch --headless`.
- Supported Discord commands: `!browser setup`, `!browser doctor`, `!browser launch`, `!browser launch --headless`, and `!browser help`.

## Cold Storage

Semantic search over conversation history using SQLite + sqlite-vec for vector storage, FTS5 for keyword search, and Reciprocal Rank Fusion for hybrid retrieval. Requires an embedding API (OpenAI or any OpenAI-compatible endpoint).

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_COLD_STORAGE_ENABLED` | `false` | Enable cold-storage subsystem |
| `COLD_STORAGE_PROVIDER` | `openai` | Embedding provider: `openai` or `openai-compat` |
| `COLD_STORAGE_API_KEY` | — | API key for the embedding provider (falls back to `OPENAI_API_KEY`) |
| `COLD_STORAGE_MODEL` | `text-embedding-3-small` | Embedding model name (required for `openai-compat`) |
| `COLD_STORAGE_DIMENSIONS` | `1536` | Embedding dimensions (required for `openai-compat`) |
| `COLD_STORAGE_BASE_URL` | `https://api.openai.com/v1` | Base URL for the embedding API (required for `openai-compat`) |
| `COLD_STORAGE_DB_PATH` | — | Override SQLite database file path |
| `DISCOCLAW_COLD_STORAGE_INJECT_MAX_CHARS` | `1500` | Max chars for cold-storage prompt section |
| `DISCOCLAW_COLD_STORAGE_SEARCH_LIMIT` | `10` | Max results per search query |
| `COLD_STORAGE_CHANNEL_FILTER` | — | Comma-separated channel IDs to restrict cold-storage ingestion/retrieval (empty = all) |

When using `openai-compat`, the provider does not send a `dimensions` parameter in the request body (many third-party endpoints reject it). The `COLD_STORAGE_DIMENSIONS` value is used only to configure the sqlite-vec column width — the provider determines its own output dimensionality. Model namespace prefixes (e.g., `openai/text-embedding-3-small`) are automatically stripped.

## Reactions

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_REACTION_HANDLER` | `true` | Enable reaction handler |
| `DISCOCLAW_REACTION_REMOVE_HANDLER` | `false` | Enable reaction-remove handler |
| `DISCOCLAW_REACTION_MAX_AGE_HOURS` | `24` | Max age for reactable messages |
