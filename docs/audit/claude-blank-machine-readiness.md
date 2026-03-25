# Claude Blank-Machine Readiness Audit

Date: 2026-03-22
Scope: what `pnpm preflight:blank-machine` plus `pnpm claude:auth-smoke` can honestly claim today for the blessed Claude source-checkout path

## Current Verdict

Verdict: `PASS` for first-login stranger source-checkout readiness

First-login stranger path release gate: `CLOSED`

Reason:

- the real `/tmp/discoclaw-test` run showed that the repo-owned source-checkout path can pass preflight from a throwaway clone once clone-local config drift is removed
- the repo-owned auth smoke correctly classified an isolated no-session Claude shell as unauthenticated
- that same isolated no-session Claude home was then taken through interactive Claude CLI login and rerun successfully
- the fresh-clone post-login operator loop was already proven separately, so the remaining release-gate condition was the same-shell first-login auth proof

## What The Automated Surface Can Honestly Prove

`pnpm preflight:blank-machine` remains a config/bootstrap proof gate only. It can verify:

- local binaries and versions
- required env presence and formatting
- forum/bootstrap eligibility
- config-doctor findings that are visible from the repo and clone-local `.env`

The real `/tmp/discoclaw-test` run also showed the practical limit of that claim:

- preflight failed first on `RUNTIME_MODEL is deprecated and still configured`
- after removing that clone-local legacy key, preflight passed cleanly

That is honest behavior for a config/bootstrap checker. It is not Claude auth proof.

## What The Claude Smoke Can Honestly Prove

`pnpm claude:auth-smoke` is the separate repo-owned Claude proof gate for this install mode. It can prove only the session context it actually runs in:

- from an isolated no-session Claude home, it proved `unauthenticated`
- from that same isolated Claude home, after interactive Claude CLI login, it proved `authenticated`

That means the combined claim is now support-safe:

- passing `pnpm preflight:blank-machine`
- plus the expected pre-login `pnpm claude:auth-smoke` failure
- plus interactive Claude CLI login in that same isolated shell or account
- plus the post-login `pnpm claude:auth-smoke` success rerun

is enough to close the first-login stranger gate for the source-checkout Claude path

## Tightened 1.0 Closeout Checklist

Use this checklist for the Claude source-checkout 1.0 signoff:

1. Create a throwaway clone in `/tmp` and run `pnpm install --frozen-lockfile`.
2. Supply a real clone-local `.env` and isolate repo-owned state with throwaway `DISCOCLAW_DATA_DIR` and `WORKSPACE_CWD` paths.
3. Force `PRIMARY_RUNTIME=claude-cli` if the source env came from a different provider path.
4. Run `pnpm preflight:blank-machine`.
5. If preflight fails, record the exact config drift or missing prerequisite. Do not silently treat that failure as Claude-auth evidence.
6. Run `pnpm claude:auth-smoke` from a shell or account with no active Claude session.
7. Confirm the expected pre-login result contains `Claude CLI appears installed but not authenticated.`
8. Complete interactive `claude` login in that same shell or account.
9. Rerun `pnpm claude:auth-smoke` in that same shell or account.
10. Confirm the expected post-login result contains `Claude CLI answered the minimal prompt.`
11. Only after steps 6 through 10 happen in the same no-session shell or account may the release closeout mark the first-login stranger gate closed.
12. If step 10 is captured only from an already-logged-in shell, downgrade the claim to `fresh-clone post-login path only` and leave the first-login stranger gate open.

## Observed 2026-03-22 Evidence

The real throwaway run produced these anchor points:

- `pnpm preflight:blank-machine` initially failed with `RUNTIME_MODEL is deprecated and still configured.`
- after removing `RUNTIME_MODEL` from the clone-local `.env`, `pnpm preflight:blank-machine` returned `All automated checks passed.`
- `HOME=/tmp/discoclaw-test-home ... pnpm claude:auth-smoke` returned `Claude CLI appears installed but not authenticated.` with `Not logged in · Please run /login`
- one stale browser-window retry surfaced an unsupported localhost callback rejection instead of completing login
- rerunning interactive Claude login from the isolated shell with `claude auth login --console` completed successfully in that same isolated home
- rerunning `HOME=/tmp/discoclaw-test-home ... pnpm claude:auth-smoke` in that same isolated home returned `Claude CLI answered the minimal prompt.` with `Output preview: OK`

That is enough to support the first-login stranger claim for the repo-owned Claude source-checkout path.
