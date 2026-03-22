# Provider/Auth 1.0 Support Matrix

Date: 2026-03-22
Scope: authoritative 1.0 consolidation for `ws-1276`, covering the provider/auth/runtime paths currently implied by DiscoClaw docs, setup surfaces, and runtime config.

## 1.0 Policy

For DiscoClaw 1.0, the operator policy is:

- `Claude CLI` auth on a source checkout is the blessed default path.
- `Codex CLI` on a source checkout is the explicitly supported secondary path.
- Every other currently shipped provider/auth path is narrower: either `PARTIAL` or `OUT OF SCOPE` until the exact proof surface and support boundary below are satisfied.

This matrix is about the main startup/chat runtime story. The voice-only direct Anthropic runtime is called out separately where relevant and is not treated as a supported `PRIMARY_RUNTIME` path.

## Consolidated Matrix

| Path | Install mode | 1.0 status | Current support-safe claim | Exact blocker or boundary | Primary evidence |
| --- | --- | --- | --- | --- | --- |
| Claude CLI / OAuth | Source checkout | `SUPPORTED FOR 1.0` | Repo-owned Claude path is support-claimable when `pnpm preflight*` stays config-only and `pnpm claude:auth-smoke` passes after interactive Claude login. | Current contract is narrow rather than one-command automated, but no blocker prevents the current source-checkout 1.0 claim. | `docs/audit/claude-blank-machine-readiness.md` |
| Claude CLI / OAuth | npm / global install | `PARTIAL` | Installed shell path is support-safe only up to the current login check (`discoclaw claude auth-smoke` or equivalent raw Claude prompt). | `discoclaw init` does not persist `CLAUDE_BIN`, and daemon installers pin `/usr/bin/node` plus a fixed `PATH`, so shell success does not prove daemon parity, first useful reply, or restart recovery. | `docs/audit/claude-npm-managed-path.md` |
| Codex CLI | Source checkout | `SUPPORTED FOR 1.0` | Repo-owned Codex path is support-claimable when `pnpm preflight*` stays config-only, the same-shell `codex exec ...` auth check passes after login, and any active OpenAI route separately passes the repo smoke harness. | Current contract is narrow rather than one-command automated, but no blocker prevents the current source-checkout 1.0 claim. | `docs/audit/codex-blank-machine-readiness.md` |
| Codex CLI | npm / global install | `PARTIAL` | Installed shell path is support-safe only up to the documented same-shell `codex exec ...` login check, plus runtime-visible OpenAI proof if the optional fast/alternate path is enabled. | No shipped `discoclaw codex auth-smoke`; `CODEX_BIN` is not persisted; daemon installers pin `/usr/bin/node` plus a fixed `PATH`; optional OpenAI proof is still post-start only. | `docs/audit/codex-npm-managed-path.md` |
| OpenAI-compatible HTTP | Source checkout | `PARTIAL` | Exact source-checkout OpenAI-backed routes can be validated with the repo smoke harness when they are actually active. | No blanket adapter-level 1.0 claim is support-safe. Model reliability for JSON output and tool calls varies by provider/model and must be separately smoke-tested for the exact route under test. | `docs/runtime-switching.md`, `docs/configuration.md`, `docs/audit/codex-blank-machine-readiness.md` |
| OpenAI-compatible HTTP | npm / global install | `PARTIAL` | The running instance can prove it sees the configured key only after startup via runtime-visible evidence such as `openai-key: ok`. | Post-start proof only; no dedicated npm-managed OpenAI workload/readiness audit; model capability still varies by provider/model and is not guaranteed by API shape alone. | `docs/runtime-switching.md`, `src/cli/init-wizard.ts`, `src/health/config-doctor.ts` |
| OpenRouter | Source checkout | `PARTIAL` | Source checkouts can prove the running env-key path via `openrouter-key: ok`, and can separately prove the exact workload under test through the repo smoke harness. | The current 1.0 claim stops at env-key visibility plus exact smoke-tested workloads. Blanket tool, model-quality, daemon, and install-mode parity claims are not support-safe. | `docs/audit/openrouter-api-key-support-boundary.md`, `docs/audit/openrouter-parity-audit.md` |
| OpenRouter | npm / global install | `PARTIAL` | The running instance can support-claim that it sees and probes its configured `OPENROUTER_API_KEY` path when `openrouter-key: ok` is visible. | No shipped npm-managed workload smoke path; no blanket workload or daemon parity claim is support-safe. | `docs/audit/openrouter-api-key-support-boundary.md`, `docs/audit/openrouter-parity-audit.md` |
| Gemini API (`gemini-api`) | Source checkout or npm / global install | `PARTIAL` | The canonical runtime name and config boundary are explicit: `gemini-api` is the API-backed Gemini path, and `gemini` is only a compatibility alias to it. | No dedicated install-mode/provider-auth readiness audit is locked yet, so broader 1.0 workload/readiness claims are not support-claimable from the current shipped evidence. | `docs/audit/gemini-support-boundary.md`, `docs/runtime-switching.md` |
| Gemini CLI (`gemini-cli`) | Source checkout or npm / global install | `PARTIAL` | The runtime path is explicit and intentionally narrow: DiscoClaw enforces the current `streaming_text` capability boundary in code before invocation. | The path is capability-limited and also lacks a dedicated install-mode/provider-auth readiness audit, so broader 1.0 workload/readiness claims are not support-claimable yet. | `docs/audit/gemini-support-boundary.md`, `docs/runtime-switching.md` |
| Claude API / direct Anthropic main-runtime path | Source checkout or npm / global install | `OUT OF SCOPE` | There is no supported `PRIMARY_RUNTIME` or `!models set chat <runtime>` path for direct Anthropic chat/main-runtime operation in 1.0. | `anthropic` is voice-only today. It is not a valid startup/chat runtime, so there is no shipped chat/startup provider/auth path to claim for 1.0. | `docs/runtime-switching.md` |

## Classification Notes

### Why OpenAI-compatible HTTP is `PARTIAL`

DiscoClaw does ship the `openai` runtime and real proof gates for it, but the current proof surfaces are still narrower than a blanket 1.0 claim:

- source checkouts rely on the repo smoke harness for the exact active route
- npm-managed installs rely on post-start runtime-visible key proof
- provider/model capability still varies, especially for JSON output and tool calls

That means the support-safe claim is route-specific and model-specific, not "all OpenAI-compatible endpoints are 1.0-ready."

### Why Gemini paths are `PARTIAL`

The Gemini work completed the naming and capability contract:

- `gemini-api` is canonical
- `gemini` is only a compatibility alias
- `gemini-cli` is the limited CLI path and that limit is enforced in code

What is still missing is the install-mode/provider-auth/readiness audit layer that Claude and Codex now have.

### Why direct Anthropic is `OUT OF SCOPE`

DiscoClaw does have a direct Anthropic runtime name, but only for voice placement. The operator-facing runtime contract explicitly says:

- `anthropic` is voice-only
- it is not a valid `PRIMARY_RUNTIME`
- it is not a valid chat runtime selection

So for the main startup/chat provider-auth matrix, direct Anthropic is not merely "not yet proven." It is intentionally outside the 1.0 scope.

## Setup And Docs Guardrails

When docs, setup copy, or health surfaces talk about provider readiness, keep the following rules aligned with this matrix:

- Do not compress config presence into runtime proof.
- Do not describe OpenAI-compatible HTTP or OpenRouter as blanket capability guarantees.
- Do not describe Gemini API and Gemini CLI as one interchangeable "Gemini" path.
- Do not imply a direct Anthropic chat/main-runtime path exists in 1.0.
- Keep `Claude CLI` as the blessed 1.0 default path and `Codex CLI` as the explicitly supported secondary path.

This file is the authoritative 1.0 consolidation layer. The narrower audit memos remain the primary evidence for each row above.
