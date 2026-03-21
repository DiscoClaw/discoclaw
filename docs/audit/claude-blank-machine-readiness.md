# Claude Blank-Machine Readiness Audit

Date: 2026-03-20
Scope: what `pnpm preflight:blank-machine` / `discoclaw doctor` can actually prove for a first-time Claude operator on this repo today.

## 1.0 Verdict

Verdict: `PASS` for the repo-owned source-checkout Claude readiness path.

Reason:

- the automated doctor can verify local prerequisites such as Node, pnpm, Claude CLI presence/version, Discord env formatting, and the forum bootstrap path
- the repo now ships `pnpm claude:auth-smoke` as the Claude auth-aware smoke check for this source path
- Claude login still happens interactively, but the pre-login and post-login validation step is now a checked-in repo command instead of a handwritten raw prompt

## Automated Contract

`pnpm preflight:blank-machine` and `discoclaw doctor` should only claim the prerequisites they can verify directly:

- local binaries and versions
- required env presence and basic formatting
- Discord forum bootstrap eligibility through explicit forum IDs, persisted scaffold state, or `DISCORD_GUILD_ID`
- shared config-doctor findings

They should not claim that Claude is ready end-to-end just because the CLI binary exists.

`pnpm claude:auth-smoke` is the separate Claude auth validator for this path. It runs one minimal Claude prompt from the repo and classifies the result as:

- authenticated
- unauthenticated
- missing CLI
- other Claude smoke failure

## Manual Validation Path

### Pre-login

1. Run:
   ```bash
   pnpm preflight:blank-machine
   ```
2. Confirm the automated checks pass.
3. Confirm the output explicitly says Claude auth validation is separate and points you to `pnpm claude:auth-smoke`.
4. Run:
   ```bash
   pnpm claude:auth-smoke
   ```
5. Confirm the expected pre-login result includes:
   ```text
   Claude CLI appears installed but not authenticated.
   ```

### Login gate

1. Complete Claude CLI authentication interactively on the machine.
2. If the CLI reports expired or missing auth, re-authenticate before continuing.

### Post-login

1. Re-run:
   ```bash
   pnpm claude:auth-smoke
   ```
2. Confirm the expected post-login result includes:
   ```text
   Claude CLI answered the minimal prompt.
   ```
3. Treat that authenticated smoke result, together with a passing `pnpm preflight:blank-machine`, as the current 1.0 readiness check for this source path.

## Follow-up Gap

This is now `PASS` for the current source-checkout contract, but it is still not a single-command fully automated Claude login proof. The remaining gap to that higher bar is an integrated flow that can distinguish:

- Claude CLI missing
- Claude CLI installed but not authenticated
- Claude CLI authenticated and able to answer a minimal prompt
