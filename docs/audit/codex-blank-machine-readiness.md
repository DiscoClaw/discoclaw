# Codex Blank-Machine Readiness Audit

Date: 2026-03-21
Scope: what the repo-owned source-checkout preflight surface can actually prove for a first-time Codex operator today, and how that differs from the npm/global install path.

## 1.0 Verdict

Verdict: `PASS` for the repo-owned source-checkout Codex readiness path.

Reason:

- `pnpm preflight` and `pnpm preflight:blank-machine` now state the real boundary: they only prove local prerequisites, not Codex or OpenAI auth
- the source-checkout path has two explicit auth-aware proof gates when configured: Codex CLI session auth, and `OPENAI_API_KEY` runtime auth for any OpenAI fast/alternate routing
- the npm/global install path remains a separate audit surface with weaker local proof and a blocked daemon/runtime path, so it is not folded into this source-checkout `PASS`

## 1.0 Support Matrix

| Install mode | Local preflight / config proof | Auth / usefulness proof |
| --- | --- | --- |
| Source checkout | `PASS` — `pnpm preflight:blank-machine` and `pnpm preflight` can prove local binaries, env formatting, bootstrap/forum eligibility, Codex binary presence/version, and `OPENAI_API_KEY` presence when current routing requires it. | `PASS` — the operator can prove Codex session auth with `codex exec -m gpt-5.4 --skip-git-repo-check --ephemeral -s read-only -- "Reply with OK"` and, when any configured route uses OpenAI, prove `OPENAI_API_KEY` separately with `OPENAI_SMOKE_TEST_TIERS=fast pnpm test`. |
| npm / global install | `PARTIAL` — `discoclaw init`, `discoclaw doctor`, `!doctor`, and `!health doctor` document the boundary and can prove config only, but there is still no shipped `discoclaw codex auth-smoke`. | `FAIL` — Codex usefulness on the daemon path is still blocked by the missing npm-managed Codex auth helper, the post-start-only OpenAI proof boundary, and the daemon/runtime-path mismatch documented in `docs/audit/codex-npm-managed-path.md`. |

## Automated Contract

`pnpm preflight:blank-machine`, `pnpm preflight`, and the underlying `scripts/doctor.ts` source-checkout flow should only claim the prerequisites they can verify directly:

- local binaries and versions
- required env presence and basic formatting
- Codex binary presence/version when current routing needs Codex
- `OPENAI_API_KEY` presence when current routing needs OpenAI
- Discord forum bootstrap eligibility through explicit forum IDs, persisted scaffold state, or `DISCORD_GUILD_ID`
- shared config-doctor findings

They should not claim that Codex is ready end-to-end just because `codex` exists on `PATH`, and they should not claim that the OpenAI fast/alternate runtime path is ready end-to-end just because `OPENAI_API_KEY` is present.

For the source-checkout path, the separate proof gates are:

- `Codex CLI session auth`: run one minimal `codex exec ...` prompt in the same host shell that will operate the source checkout
- `OPENAI_API_KEY` runtime auth: when any configured source route uses OpenAI (`PRIMARY_RUNTIME=openai`, `DISCOCLAW_FAST_RUNTIME=openai`, `FORGE_DRAFTER_RUNTIME=openai`, or `FORGE_AUDITOR_RUNTIME=openai`), run the repo OpenAI smoke harness separately

## Manual Validation Path

### Local preflight proof

1. Run:
   ```bash
   pnpm preflight:blank-machine
   ```
2. Confirm the automated checks pass.
3. Confirm the output says Codex CLI session auth and OpenAI runtime auth are separate proof gates rather than implied success.
4. If you need the merged shell-plus-`.env` view instead of blank-machine mode, also run:
   ```bash
   pnpm preflight
   ```

### Codex CLI session auth gate

1. Before logging in, run:
   ```bash
   codex exec -m gpt-5.4 --skip-git-repo-check --ephemeral -s read-only -- "Reply with OK"
   ```
2. Confirm the expected pre-login result is a Codex auth/session failure rather than a normal reply.
3. Log in interactively with:
   ```bash
   codex
   ```
4. Re-run the same `codex exec ...` command.
5. Confirm it returns normal text.

### Optional `OPENAI_API_KEY` runtime gate

1. If no configured source-checkout route uses OpenAI, mark this gate `not-applicable`.
2. If any configured source-checkout route uses OpenAI, run:
   ```bash
   OPENAI_SMOKE_TEST_TIERS=fast pnpm test
   ```
3. Confirm the `openai / fast` smoke passes.
4. If you need exact model evidence instead of the fast-tier check, replace `fast` with the intended tier or literal model ID and re-run the same smoke harness.

Treat the source-checkout path as a 1.0 `PASS` only when:

- local preflight is green
- the Codex session-auth prompt succeeds after interactive login
- the OpenAI smoke passes whenever current routing makes `OPENAI_API_KEY` part of the active source-checkout path

## Follow-up Gap

This is `PASS` for the narrowed source-checkout contract, but it is still not a single-command automated Codex login proof. The remaining gaps are:

- no dedicated `pnpm codex:auth-smoke` helper yet
- npm/global install still lacks a support-claimable Codex daemon/runtime path
