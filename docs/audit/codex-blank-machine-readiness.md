# Codex Blank-Machine Readiness Audit

Date: 2026-03-21
Scope: what the repo-owned source-checkout setup and preflight surfaces can actually prove for a first-time Codex operator today, including the optional OpenAI fast/alternate runtime path when it is configured from source.

## 1.0 Verdict

Verdict: `PASS` for the narrowed source-checkout Codex readiness contract.

Reason:

- `pnpm preflight:blank-machine` and `pnpm preflight` only claim the Codex/OpenAI prerequisites they can verify directly
- the shipped source setup flow now documents the two separate proof gates this path really has: Codex CLI session auth and, when configured, `OPENAI_API_KEY` auth for the OpenAI fast/alternate runtime path
- the repo already ships OpenAI runtime smoke coverage through `OPENAI_SMOKE_TEST_TIERS=... pnpm test`, so `OPENAI_API_KEY` can be proven separately instead of being inferred from key presence alone

## Automated Contract

`pnpm preflight:blank-machine`, `pnpm preflight`, and the underlying `scripts/doctor.ts` flow should only claim the prerequisites they can verify directly:

- local binaries and versions
- required env presence and basic formatting
- Codex binary presence/version and `OPENAI_API_KEY` presence when the current routing requires it
- Discord forum bootstrap eligibility through explicit forum IDs, persisted scaffold state, or `DISCORD_GUILD_ID`
- shared config-doctor findings

They should not claim that Codex is ready end-to-end just because `codex` exists on `PATH`, and they should not claim that the OpenAI fast/alternate runtime path is ready end-to-end just because `OPENAI_API_KEY` is present in `.env`.

For this source path, the remaining auth-aware proof gates are:

- Codex CLI session auth via a minimal `codex exec ...` prompt in the same host shell
- OpenAI runtime auth via the opt-in model smoke tests when any source-checkout routing uses OpenAI (`PRIMARY_RUNTIME=openai`, `DISCOCLAW_FAST_RUNTIME=openai`, or `FORGE_*_RUNTIME=openai`)

## Manual Validation Path

### Preflight

1. Run:
   ```bash
   pnpm preflight:blank-machine
   ```
2. Confirm the automated checks pass.
3. Confirm the output explicitly says Codex CLI session auth and OpenAI runtime auth are separate proof gates.

### Codex CLI session auth gate

1. Before logging in, run:
   ```bash
   codex exec -m gpt-5.4 --skip-git-repo-check --ephemeral -s read-only -- "Reply with OK"
   ```
2. Confirm the expected pre-login result is a Codex auth/session failure rather than a successful reply.
3. Log in interactively with:
   ```bash
   codex
   ```
4. Re-run the same `codex exec ...` command.
5. Confirm it returns normal text.

### Optional OpenAI fast/alternate runtime gate

1. If no source-checkout runtime path uses OpenAI, skip this gate.
2. If your source-checkout config routes fast or alternate work through OpenAI, run:
   ```bash
   OPENAI_SMOKE_TEST_TIERS=fast pnpm test
   ```
3. Confirm the `openai / fast` smoke passes.
4. If you need exact model evidence instead of the default fast-tier check, replace `fast` with the intended tier or model ID and re-run the same smoke harness.

Treat the combination of a passing `pnpm preflight:blank-machine`, a successful Codex session-auth prompt, and a passing OpenAI smoke test when OpenAI routing is configured as the current 1.0 readiness proof for this source path.

## Follow-up Gap

This is `PASS` for the current source-checkout contract, but the repo still does not ship a dedicated `pnpm codex:auth-smoke` helper. Codex session auth remains a documented manual gate, and npm-managed daemon parity remains a separate non-claimable path.
