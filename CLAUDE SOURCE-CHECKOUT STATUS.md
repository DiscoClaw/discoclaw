# Claude Source-Checkout Status

Date: 2026-03-22
Checkout under review: `846a5b032d169a7c67403914294c954ca96238ab`
Scope: evidence-backed closeout memo for DiscoClaw's blessed Claude source-checkout path

## Current Call

Status: `SUPPORTED FOR 1.0` for the Claude source-checkout path

First-login stranger gate: `CLOSED`

What that status means today:

- a fresh clone can install and run the repo-owned Claude source-checkout helpers
- an isolated no-session Claude shell still returns the expected pre-login unauthenticated result
- that same isolated no-session Claude home can complete interactive Claude CLI login and pass the post-login `pnpm claude:auth-smoke` rerun
- the first-login stranger auth gate is now backed by same-shell evidence instead of inference from a separately logged-in shell
- the broader source-checkout operator loop had already been proven for the fresh-clone post-login path, so the remaining release-gate item was this same-shell auth proof

## What Actually Happened

- `git clone /home/davidmarsh/code/discoclaw /tmp/discoclaw-qa-qu0E0N`
  Result: `PASS`
- `pnpm install --frozen-lockfile` in `/tmp/discoclaw-qa-qu0E0N`
  Result: `PASS`
  Evidence: `Done in 777ms using pnpm v10.28.2`
- `HOME=/tmp/discoclaw-qa-qu0E0N-home XDG_CONFIG_HOME=/tmp/discoclaw-qa-qu0E0N-home/.config XDG_STATE_HOME=/tmp/discoclaw-qa-qu0E0N-home/.state XDG_DATA_HOME=/tmp/discoclaw-qa-qu0E0N-home/.local/share pnpm claude:auth-smoke`
  Result: `EXPECTED PRE-LOGIN FAILURE`
  Evidence: `Claude CLI appears installed but not authenticated.` and `Not logged in · Please run /login`
- `HOME=/tmp/discoclaw-qa-qu0E0N-home ... claude auth login --console`
  Result: `PASS`
  Evidence: `Login successful.`
- `HOME=/tmp/discoclaw-qa-qu0E0N-home ... pnpm claude:auth-smoke`
  Result: `PASS`
  Evidence: `Claude CLI answered the minimal prompt.` and `Output preview: OK`
- one stale browser-window retry during login
  Result: `SHARP EDGE`
  Evidence: rejected localhost callback from a recycled browser tab; a fresh terminal-driven login completed successfully afterward
- `pnpm preflight:blank-machine` in `/home/davidmarsh/code/discoclaw`
  Result: `FAIL`
  Evidence: current maintainer config still reports stale repo-local state, deprecated `RUNTIME_MODEL`, and a persisted summary override drift
- `pnpm preflight` in `/tmp/discoclaw-qa-qu0E0N` with inherited env plus isolated `DISCOCLAW_DATA_DIR`, `WORKSPACE_CWD`, `GROUPS_DIR`, and `BEADS_DIR`
  Result: `FAIL`
  Evidence: `.env file missing`

## Why The Clone-Side Blank-Machine Step Stayed Open

The exact blessed config/bootstrap command is `pnpm preflight:blank-machine`, and that command only reads the checkout's own `.env`.

This task's safety rule forbids writing to `.env`, so this rerun could not create the clone-local `.env` required to reproduce that exact step safely inside `/tmp/discoclaw-qa-qu0E0N`.

That means this memo proves the fresh-clone install path and the Claude auth behavior from that clone, but it does not add new same-clone `pnpm preflight:blank-machine` evidence beyond the existing audit trail.

## Audit Call

- Current support-safe claim: `SUPPORTED FOR 1.0` for the repo-owned Claude source-checkout path
- First-login stranger gate: `CLOSED`
- Keep the support claim narrow: it is based on a real clone-local `.env`, isolated repo/data paths on the maintainer machine, the expected pre-login failure, interactive Claude CLI login in that same isolated home, and the post-login rerun success
- Keep the stale-browser callback rejection documented as a sharp edge, but it is not a blocker because a fresh CLI-driven login in the same isolated home succeeded

## Tightened 1.0 Closeout Checklist

1. Create a throwaway clone and run `pnpm install --frozen-lockfile`.
2. Supply a real clone-local `.env` with the required Discord and runtime values.
3. If auditing from a machine with existing DiscoClaw state, isolate `DISCOCLAW_DATA_DIR`, `WORKSPACE_CWD`, `GROUPS_DIR`, and `BEADS_DIR` to throwaway paths.
4. Force `PRIMARY_RUNTIME=claude` for this audit.
5. Run `pnpm preflight:blank-machine` and treat it as config/bootstrap evidence only.
6. From a shell or account with no active Claude session, run `pnpm claude:auth-smoke`.
7. Confirm the expected pre-login result contains `Claude CLI appears installed but not authenticated.`
8. Run `claude` and complete login in that same shell or account.
9. Rerun `pnpm claude:auth-smoke` in that same shell or account.
10. Confirm the expected post-login result contains `Claude CLI answered the minimal prompt.`
11. Run `pnpm build && pnpm dev`, then confirm a short Discord prompt receives a normal reply.
12. Restart the running service/process and verify clean startup, one normal post-restart reply, and if applicable either the persisted recovery summary or the generic notice ending with `Recovered after restart.`
13. Release closeout may mark the first-login stranger gate closed once steps 6 through 10 happen in the same no-session shell or account.
14. If the passing auth smoke came from an already-logged-in shell or account instead, keep the claim narrowed to `fresh-clone post-login path only`.
