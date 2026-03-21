# Claude Blank-Machine Readiness Audit

Date: 2026-03-20
Scope: what `pnpm preflight:blank-machine` / `discoclaw doctor` can actually prove for a first-time Claude operator on this repo today.

## 1.0 Verdict

Verdict: `FAIL` for fully automated Claude readiness.

Reason:

- the automated doctor can verify local prerequisites such as Node, pnpm, Claude CLI presence/version, Discord env formatting, and the forum bootstrap path
- it cannot verify Claude login/auth state today
- Claude login remains a manual operator gate until the codebase has an auth-aware smoke check

## Automated Contract

`pnpm preflight:blank-machine` and `discoclaw doctor` should only claim the prerequisites they can verify directly:

- local binaries and versions
- required env presence and basic formatting
- Discord forum bootstrap eligibility through explicit forum IDs, persisted scaffold state, or `DISCORD_GUILD_ID`
- shared config-doctor findings

They should not claim that Claude is ready end-to-end just because the CLI binary exists.

## Manual Validation Path

### Pre-login

1. Run:
   ```bash
   pnpm preflight:blank-machine
   ```
2. Confirm the automated checks pass.
3. Confirm the output explicitly says Claude auth is manual and points back to this audit memo.

### Login gate

1. Complete Claude CLI authentication interactively on the machine.
2. If the CLI reports expired or missing auth, re-authenticate before continuing.

### Post-login

1. Run a trivial Claude CLI prompt from the repo:
   ```bash
   claude -p -- "Reply with OK"
   ```
2. Confirm the CLI returns a normal text response instead of an auth/login error.
3. Treat that manual prompt result, together with a passing `pnpm preflight:blank-machine`, as the current 1.0 readiness check.

## Follow-up Gap

To move this audit to `PASS`, the repo needs a non-misleading automated auth smoke path that can distinguish:

- Claude CLI missing
- Claude CLI installed but not authenticated
- Claude CLI authenticated and able to answer a minimal prompt
