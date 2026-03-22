# Gemini Support Boundary

Date: 2026-03-21
Scope: the current Gemini runtime-selection and capability contract for `ws-1288`, limited to what the shipped code can prove today about runtime naming, compatibility aliasing, and the Gemini CLI support boundary.

This memo is intentionally narrow. It answers three contract questions only:

- which Gemini runtime name is canonical for the API-backed path
- what the legacy bare `gemini` name means today
- why `gemini-cli` is currently a limited runtime, and what code enforces that limit

## 1.0 Verdict

Verdict: `PASS` for the current narrowed Gemini contract.

The shipped code already makes the runtime boundary explicit:

- `gemini-api` is the canonical Gemini runtime name for the REST/API-backed path.
- bare `gemini` is a compatibility alias that normalizes to `gemini-api`; it is not a parallel runtime contract.
- `gemini-cli` is a distinct CLI-backed runtime path and is currently limited because its strategy advertises only `streaming_text`.
- that `gemini-cli` limitation is enforced in code, not just described in docs: DiscoClaw filters tools against runtime capabilities before invocation and drops anything the runtime does not advertise.

This means the support-safe operator claim today is:

- "`gemini-api` is the canonical Gemini runtime name, `gemini` remains only a compatibility alias to that path, and `gemini-cli` is the limited Gemini runtime because the runtime capability gate only advertises `streaming_text` and strips unsupported tools before the turn starts."

## Contract In Code

| Contract point | Current code evidence | Status |
| --- | --- | --- |
| `gemini-api` is the canonical Gemini API runtime name | `src/config.ts` normalizes `gemini` to `gemini-api`; `src/index.ts` registers the REST runtime under `gemini-api` and logs `legacyAlias: 'gemini'` | `PASS` |
| bare `gemini` is only a compatibility alias | `parseRuntimeName()` in `src/config.ts` rewrites `gemini` to `gemini-api`; runtime registration keeps `gemini` pointed at the same REST adapter in `src/index.ts` | `PASS` |
| `gemini-cli` is a separate explicit runtime path | `src/index.ts` registers `gemini-cli` independently via `createGeminiCliRuntime()` | `PASS` |
| `gemini-cli` is limited because of runtime capabilities, not docs wording | `src/runtime/strategies/gemini-strategy.ts` exports `GEMINI_CLI_CAPABILITIES = ['streaming_text']`; `resolveEffectiveTools()` in `src/discord/prompt-common.ts` calls `filterToolsByCapabilities()` in `src/runtime/tool-capabilities.ts` and drops tools that require unadvertised capabilities | `PASS` |

## What Docs And Help May Claim

The following are support-claimable from the shipped code today:

- operators should prefer `gemini-api` and `gemini-cli` as the explicit runtime names
- `gemini` still works, but only as a compatibility alias for `gemini-api`
- `gemini-cli` is limited because its advertised capability set is intentionally narrow
- the limiting behavior is enforced by the existing capability-filter path before invocation, not by operator discipline alone

## What Docs And Help Must Not Claim

The following would overstate the shipped contract:

- treating `gemini`, `gemini-api`, and `gemini-cli` as interchangeable runtime names
- implying that `gemini` can resolve to either Gemini path depending on environment or credentials
- describing `gemini-cli` as limited or experimental without tying that label to the actual capability gate
- implying that the Gemini CLI path supports tools beyond what the runtime advertises

## Evidence That Counts

Use these code-backed facts when operator docs or command help need to describe Gemini support:

1. `src/config.ts` canonicalizes `gemini` to `gemini-api`.
2. `src/index.ts` registers `gemini-api` and keeps `gemini` pointed at the same REST adapter as a legacy alias.
3. `src/index.ts` registers `gemini-cli` as a separate runtime.
4. `src/runtime/strategies/gemini-strategy.ts` advertises only `streaming_text` for the Gemini CLI strategy.
5. `src/discord/prompt-common.ts` and `src/runtime/tool-capabilities.ts` enforce that contract by removing unsupported tools before a Gemini CLI turn is invoked.

## Durable Boundary

Until broader Gemini readiness or transport work lands, this is the durable support boundary:

- `gemini-api` is the canonical Gemini runtime name.
- `gemini` is a backward-compatibility alias to `gemini-api`.
- `gemini-cli` is the limited Gemini runtime because the shipped strategy-level capability set only advertises `streaming_text`, and DiscoClaw enforces that boundary by filtering unsupported tools before invocation.
