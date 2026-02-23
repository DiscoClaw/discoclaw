# Chunk C8 - Scripts, Docs, Config Release Surface

## Scope
- `scripts/**`
- `docs/**`
- `README.md`
- `MIGRATION.md`
- `.env.example`
- `.env.example.full`
- `package.json`
- `systemd/discoclaw.service`

Approximate file count in this chunk: 43.

## Commands Run
- `pnpm preflight`
- `pnpm guard:legacy`
- `pnpm build`
- `pnpm test`
- `rg -n "Gemini adapter|stub — not started|README rewrite" docs/INVENTORY.md`
- `rg -n "gemini|Gemini" src/runtime README.md .env.example .env.example.full`
- `git diff --name-only b1c7071..1de6a1a`
- `git diff --unified=200 b1c7071..1de6a1a -- .github/workflows/publish.yml package.json docs/releasing.md docs/INVENTORY.md`

## Findings
- None.

## Gate Results
| Gate | Result | Notes |
| --- | --- | --- |
| Contract | PASS | Release scripts and preflight/legacy guards execute successfully. |
| Failure-mode | PASS | Doctor and setup script test coverage is green (`scripts/doctor*.test.ts`, `scripts/setup.test.ts`, `scripts/legacy-token-guard.test.ts`). |
| Security | PASS | Legacy token guard passes; release config checks pass. |
| Observability | PASS | Preflight reports all required vars/status clearly. |
| Test | PASS | Script-related tests pass in full baseline run. |
| Release | PASS | No blocker-level issues found in release-surface checks. |

## Required Fixes
- None.

## Retest Evidence
- Preflight and legacy guards passed.
- Full suite passed.
- Delta from `b1c7071` to `1de6a1a` is limited to release-surface files and remains green.

## Signoff
- Status: PASS
- Timestamp: 2026-02-23
