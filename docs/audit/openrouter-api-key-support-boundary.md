# OpenRouter API Key Support Boundary

Date: 2026-03-21
Scope: the first auditable DiscoClaw slice for the shipped `OPENROUTER_API_KEY` path, limited to what the product can prove today through its existing readiness surfaces.

This memo intentionally stays narrow. Use it for the credential-only question:

- can the running DiscoClaw instance see the configured `OPENROUTER_API_KEY` path and complete the shipped `GET /models` probe?

For the broader first-slice parity boundary, including install-mode differences, the repo smoke evidence path for source checkouts, the enforcement behind read-only-tool claims, and the deferred tier-default / model-recommendation work, use [OpenRouter Parity Audit](openrouter-parity-audit.md).

## 1.0 Verdict

Verdict: `PASS` for the narrowed `OPENROUTER_API_KEY` support slice only.

Reason:

- DiscoClaw already ships an OpenRouter runtime registration path backed by `OPENROUTER_API_KEY`.
- The shipped credential probe for that path is explicit: `GET /models` against the configured OpenRouter base URL.
- The proof is operator-visible in shipped readiness surfaces: `!status` and the startup credential report expose `openrouter-key: ok`.
- Current setup and doctor guidance can now stay support-boundary-safe by treating key presence as config only until that live proof appears.

This verdict does **not** mean "OpenRouter is fully parity-complete everywhere." It means the current product can support-claim one narrower fact:

- the running DiscoClaw instance can see the configured `OPENROUTER_API_KEY` path and successfully complete the shipped OpenRouter credential probe

## What Is Support-Claimable Now

| Surface | Current claim | Status |
| --- | --- | --- |
| Authoritative `.env`, `PRIMARY_RUNTIME=openrouter`, `!models set chat openrouter`, or similar routing config | Config/routing intent only. These can show that OpenRouter is selected or selectable, but they do not prove the running process can see the key. | `PARTIAL` |
| `discoclaw init`, `pnpm preflight*`, `discoclaw doctor`, `!doctor` | Setup/bootstrap evidence only for this path. These surfaces may confirm the key is configured or expected, but they are not runtime proof. | `PARTIAL` |
| `!status` or startup credential report showing `openrouter-key: ok` | Live proof for the shipped env-key slice. This is the current auditable readiness signal for both source-checkout and npm-managed installs because it comes from the running instance under test. | `PASS` |
| Broader OpenRouter parity claims (tool reliability, workload suitability, tier defaults, model recommendations, one-command install readiness, or all-path equivalence) | Not support-claimable from the current shipped proof. | `DEFERRED` |

## Evidence That Counts

Use this checklist when you need a support-safe claim for the current OpenRouter path:

1. Set `OPENROUTER_API_KEY` in the authoritative `.env` for the exact process you are validating.
2. Configure a route that actually uses OpenRouter, such as `PRIMARY_RUNTIME=openrouter` or a live/runtime role switch that targets `openrouter`.
3. Start or restart the actual DiscoClaw process that should carry the claim.
4. Confirm one of the shipped readiness surfaces reports live success:
   - `!status` includes `OpenRouter: openrouter-key: ok`
   - the startup credential report includes `openrouter-key: ok`
5. If `OPENROUTER_BASE_URL` is overridden, confirm the proof surface reflects the intended base URL for that same process.

When those conditions are met, the support-safe claim is:

- "This running DiscoClaw instance can see and successfully probe its configured `OPENROUTER_API_KEY` path."

## Evidence That Does Not Count

The following are useful troubleshooting inputs, but they are **not** enough to claim shipped OpenRouter readiness on their own:

- `OPENROUTER_API_KEY` being present in `.env`
- `discoclaw init` completing successfully
- `pnpm preflight`, `pnpm preflight:blank-machine`, `discoclaw doctor`, or `!doctor` reporting clean config
- `PRIMARY_RUNTIME=openrouter` or `!models set chat openrouter` showing intended routing
- `!models` showing the OpenRouter adapter is registered
- an external `curl` or manual API call made outside DiscoClaw with the same key
- generic claims that OpenRouter is "ready" without the runtime-visible `openrouter-key: ok` signal

## Deferred To Follow-up Plans

The following remain out of scope for this first auditable slice:

- end-to-end workload proof beyond the credential probe, including JSON/tool-call reliability and action-specific validation
- tier/default parity work for `DISCOCLAW_TIER_OPENROUTER_FAST`, `DISCOCLAW_TIER_OPENROUTER_CAPABLE`, and `DISCOCLAW_TIER_OPENROUTER_DEEP`
- curated model recommendations for OpenRouter-backed roles
- any stronger install-mode story than the current runtime-visible env-key proof
- a dedicated OpenRouter smoke helper beyond the existing `!status` and startup credential report surfaces

Until follow-up work lands, do not collapse the current env-key proof into broader claims about model quality, tool parity, or universal daemon/runtime readiness.

## Previously Overclaiming Documentation Surfaces

This audit exists because summary/setup docs had previously compressed too many things into "OpenRouter readiness." The current docs that needed this narrower boundary are:

- `README.md` summary and prerequisite language for the OpenRouter path
- `docs/discord-bot-setup.md` validation guidance
- `docs/runtime-switching.md` adapter requirement and switching guidance
- `docs/configuration.md` OpenRouter configuration summary

Those docs should now be read as summary surfaces only. This file is the durable reference for what the shipped `OPENROUTER_API_KEY` path can actually support-claim today, what evidence counts, and where the boundary stops.

For anything broader than that env-key proof, do not extend this memo by implication. Hand off to [OpenRouter Parity Audit](openrouter-parity-audit.md), which is the authoritative audit for the wider `ws-1285` install-mode and workload boundary in this first slice.
