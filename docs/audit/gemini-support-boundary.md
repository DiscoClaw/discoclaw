# Gemini Support Boundary

Date: 2026-03-21 (updated 2026-03-24: `gemini-cli` removed, `gemini` alias removed)
Scope: the current Gemini runtime-selection and capability contract, limited to what the shipped code can prove today about runtime naming.

This memo is intentionally narrow. It answers two contract questions only:

- which Gemini runtime name is canonical for the API-backed path
- what happened to the legacy bare `gemini` name and `gemini-cli`

## 1.0 Verdict

Verdict: `PASS` for the current narrowed Gemini contract.

The shipped code makes the runtime boundary explicit:

- `gemini-api` is the only Gemini runtime. It is backed by the Gemini REST API.
- `gemini-cli` has been removed (TOS risk). The code files `src/runtime/gemini-cli.ts` and `src/runtime/strategies/gemini-strategy.ts` no longer exist.
- The bare `gemini` alias has been removed as redundant. Use `gemini-api` explicitly.

This means the support-safe operator claim today is:

- "`gemini-api` is the canonical and only Gemini runtime name."

## Contract In Code

| Contract point | Current code evidence | Status |
| --- | --- | --- |
| `gemini-api` is the canonical Gemini API runtime name | `src/index.ts` registers the REST runtime under `gemini-api` | `PASS` |
| `gemini-cli` is removed | No `gemini-cli` registration in `src/index.ts`; source files deleted | `PASS` |
| bare `gemini` alias is removed | `canonicalizeRuntimePathName('gemini')` returns `undefined` | `PASS` |

## What Docs And Help May Claim

The following are support-claimable from the shipped code today:

- `gemini-api` is the only Gemini runtime
- the Gemini runtime requires `GEMINI_API_KEY`

## What Docs And Help Must Not Claim

The following would overstate the shipped contract:

- referring to `gemini-cli` as a valid runtime option
- referring to bare `gemini` as a compatibility alias (it has been removed)
- implying that the Gemini CLI binary can be used as a runtime

## Evidence That Counts

1. `src/index.ts` registers `gemini-api` via `createGeminiRestRuntime()`.
2. `src/runtime/runtime-path-contract.ts` defines `gemini-api` with no `gemini` or `gemini-cli` aliases.

## Durable Boundary

- `gemini-api` is the canonical and only Gemini runtime name.
