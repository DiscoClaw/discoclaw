# OpenRouter Parity Audit

Date: 2026-03-21
Scope: first `ws-1285` slice for auditable OpenRouter-backed workloads. This audit is broader than the env-key memo, but it still stops at what the current runtime, doctor surfaces, and repo-owned smoke path can prove today.

## 1.0 Verdict

Verdict: `PARTIAL`.

Reason:

- DiscoClaw ships a real OpenRouter runtime registration path through the shared OpenAI-compatible adapter and a live credential probe that reports `openrouter-key: ok` only after a successful `GET /models` request.
- Source checkouts can prove more than npm-managed installs because the repo contains the workload smoke harness in `src/runtime/model-smoke.test.ts`, while the published npm package does not ship that harness in `package.json.files`.
- The doctor/init surfaces now align with that narrower boundary: they stop at config/bootstrap or post-start env-key visibility and do not claim broader OpenRouter workload, tool, or install-mode parity.
- Built-in OpenRouter tier defaults and model recommendations are still intentionally deferred. The runtime can route to explicit OpenRouter models today, but this slice does not audit or recommend a default `fast` / `capable` / `deep` map.

## Exact Support Boundary By Install Mode

| Install mode | Config/bootstrap proof | Live credential proof | Workload proof | Current support-safe claim |
| --- | --- | --- | --- | --- |
| Source checkout | `pnpm preflight` / `pnpm preflight:blank-machine` can prove local setup prerequisites only. They do not start DiscoClaw or hit OpenRouter. | `!status` or the startup credential report showing `openrouter-key: ok` proves the running process can see the configured env-key path and complete the shipped `GET /models` probe. | Repo-owned smoke path only. The current workload-proof surface lives in `src/runtime/model-smoke.test.ts` and `src/runtime/model-smoke-helpers.ts`, not in preflight. | `PASS`, but only for the exact source-checkout route or model that was separately smoke-validated plus the running instance that showed `openrouter-key: ok`. |
| npm / global install | `discoclaw init`, `discoclaw doctor`, `!doctor`, and `.env` inspection are config/bootstrap evidence only. | `!status` or the startup credential report showing `openrouter-key: ok` is still valid post-start proof for the running instance. | No shipped npm-managed workload smoke path yet. The published package omits repo tests/helpers, so workload parity is not support-claimable from the installed CLI alone. | `PARTIAL`: support-safe claim stops at "this running instance can see and probe its configured env-key path." |

## What Enforces The Boundary

### Credential-proof boundary

The live env-key claim is enforced in code, not just by wording:

- `src/index.ts` registers the `openrouter` runtime only when `OPENROUTER_API_KEY` is configured.
- `src/health/credential-check.ts` performs the OpenRouter probe as `GET /models` against the configured base URL and emits stable `openrouter-key` results.
- `src/discord/status-command.ts` renders `OpenRouter: openrouter-key: ok` only when that probe actually succeeded for the running instance.
- `scripts/doctor.ts` and `src/health/config-doctor.ts` explicitly describe OpenRouter doctor output as config/bootstrap evidence only and point operators to the post-start `openrouter-key: ok` proof gate instead.

### Read-only tool claim

If a source-checkout OpenRouter workload is described as "read-only", that claim is only support-safe when the current enforcement layers are present:

- `src/workspace-permissions.ts` maps workspace `readonly` permission tier to `Read`, `Glob`, `Grep`, `WebSearch`, and `WebFetch`.
- `src/discord/prompt-common.ts` applies that workspace tier, intersects it with runtime capabilities through `filterToolsByCapabilities`, and then applies model-tier reductions through `filterToolsByTier`.
- `src/runtime/tool-capabilities.ts` makes file and exec tools capability-gated instead of prompt-only.
- `src/runtime/openai-compat.ts` only advertises file/exec tool capabilities for OpenAI-compatible runtimes when `OPENAI_COMPAT_TOOLS_ENABLED=1`.
- `src/runtime/openai-tool-exec.ts` fail-closes actual execution by rejecting non-advertised tool names and by enforcing root containment, relative-pattern scope, and bounded bash timeouts.

The support-safe claim is therefore narrow:

- a specific OpenRouter-backed invocation can be constrained to a read-only tool surface by workspace permissions, capability filtering, model-tier filtering, and executor allowlists/root guards

It is **not** support-safe to say "OpenRouter is read-only" as a blanket runtime property.

## Smoke Evidence Path

The current shipped workload-proof path for source checkouts is the repo smoke harness:

- `src/runtime/model-smoke.test.ts`
- `src/runtime/model-smoke-helpers.ts`

Important boundary details:

- This harness is repo-only. It is available from a source checkout via `pnpm test`, not from the published npm package.
- The current entry point is still the shared OpenAI-compatible smoke harness (`OPENAI_SMOKE_TEST_TIERS=... pnpm test`). There is no dedicated `OPENROUTER_SMOKE_TEST_TIERS` wrapper in this slice.
- Because the OpenRouter runtime is implemented through the shared OpenAI-compatible adapter in `src/runtime/openai-compat.ts`, the source-checkout smoke path is the only shipped place today where workload evidence can be captured for an exact OpenRouter-backed route or model.

That means the evidence split for this slice is:

1. `openrouter-key: ok` proves the running instance can see and probe its configured env-key path.
2. Repo smoke-path evidence proves only the exact source-checkout workload under test.
3. Neither proof should be stretched into blanket install-mode, daemon, tool, or model-quality parity claims.

## Doctor And Init Boundary

The shared doctor boundary now lines up with the auditable evidence:

- `scripts/doctor.ts` says preflight only checks whether `OPENROUTER_API_KEY` is present when routing requires it and explicitly says it does not prove the running process can complete the shipped `GET /models` probe.
- `src/health/config-doctor.ts` says npm-managed doctor output is config-only and points operators to post-start `openrouter-key: ok` evidence plus the audit docs for the exact support boundary.
- `src/cli/init-wizard.ts` says `discoclaw init` only writes the existing env-key path and tells operators to start DiscoClaw and confirm `openrouter-key: ok`.

That wording is intentional and should remain aligned with this audit. If a future change makes doctor or init claim more than config/bootstrap or post-start env-key visibility, it must land the new proof surface first.

## Explicit Deferrals For Follow-up Plans

This first `ws-1285` slice does **not** claim the following:

- built-in OpenRouter tier defaults for `DISCOCLAW_TIER_OPENROUTER_FAST`, `DISCOCLAW_TIER_OPENROUTER_CAPABLE`, or `DISCOCLAW_TIER_OPENROUTER_DEEP`
- curated OpenRouter model recommendations for chat, fast-tier, forge, or action workloads
- npm-managed OpenRouter workload parity
- a dedicated `OPENROUTER_SMOKE_TEST_TIERS` or other one-command OpenRouter workload helper
- blanket tool, daemon, or install-mode equivalence from the current env-key proof

The code backs that deferral today:

- `src/runtime/model-tiers.ts` ships built-in tier maps for `claude_code`, `gemini`, `openai`, and `codex`, but not for `openrouter`.
- `src/config.ts` and `src/cli/init-wizard.ts` still provide a default `OPENROUTER_MODEL`, but that is a routing default, not an audited recommendation.

Treat later plans as the place to decide default OpenRouter tier maps, preferred models, and stronger npm-managed parity claims. This audit only records the narrower proof boundary that the current runtime can actually support.
