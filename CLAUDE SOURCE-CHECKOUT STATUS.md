# Claude Source-Checkout Status

Date: 2026-03-23
Checkout under review: `846a5b032d169a7c67403914294c954ca96238ab`
Scope: evidence-backed closeout memo for DiscoClaw's blessed Claude source-checkout path

## Current Call

Status: `SUPPORTED FOR 1.0` for the Claude source-checkout path
Release rehearsal verdict: `BLOCKED`

First-login stranger gate: `CLOSED`

What that status means today:

- a fresh clone can install and run the repo-owned Claude source-checkout helpers
- an isolated no-session Claude shell still returns the expected pre-login unauthenticated result
- that same isolated no-session Claude home can complete interactive Claude CLI login and pass the post-login `pnpm claude:auth-smoke` rerun
- the first-login stranger auth gate is now backed by same-shell evidence instead of inference from a separately logged-in shell
- the broader source-checkout operator loop had already been proven for the fresh-clone post-login path, so the remaining release-gate item was this same-shell auth proof

## Release Rehearsal Result

- Command: `pnpm release:rehearsal`
- Repo root used: `/home/davidmarsh/code/discoclaw`
- Checkout provenance for the attempted run: `reused-checkout`
- Run slug: `rr-20260323-051920-vsa0`
- Task prefix: `rr051920vsa0`
- Created Discord artifact names: none confirmed or recorded; the harness reserved `Release rehearsal rr-20260323-051920-vsa0 task` and `Release rehearsal rr-20260323-051920-vsa0 cron`, but it never reached the manual live-checkpoint phase
- Teardown result: `BLOCKED` because the interrupted run did not write a durable closeout or complete cleanup; the rehearsal-owned local temp root `/tmp/discoclaw-release-rehearsal/rr-20260323-051920-vsa0` remained after `SIGINT`
- Final P1 verdict: `BLOCKED`
- Exact symptom: with checkout provenance supplied, the harness passed `pnpm preflight:blank-machine`, `pnpm claude:auth-smoke`, `pnpm discord:smoke-test`, and `pnpm build`, then printed `Starting Run pnpm dev...` and never surfaced the old late `Discord bot started` ready boundary or any manual checkpoint prompt in the interactive session. The child `src/index.ts` process was still alive and listening on port `9404`, so the run had to be interrupted and did not produce its own closeout.
- Draft remediation now in the repo: the harness waits for the earlier `Discord runtime ready` log emitted immediately after Discord login/bootstrap, requires repo-local `DISCORD_GUILD_ID` for both the smoke step and cleanup targeting, and blocks if task/cron checkpoints pass without any machine-observed rehearsal artifact evidence. A fresh live rerun is still required before changing the release verdict.
- Exact repro: from `/home/davidmarsh/code/discoclaw`, with the current repo-local `.env` unchanged, run `RELEASE_REHEARSAL_CHECKOUT_PROVENANCE=reused-checkout pnpm release:rehearsal`; observe successful command steps through `pnpm build`, then `Starting Run pnpm dev...` with no later harness output, and after `SIGINT` observe exit code `130` plus the leftover rehearsal root `/tmp/discoclaw-release-rehearsal/rr-20260323-051920-vsa0`
- Durable closeout: none written for `rr-20260323-051920-vsa0`; the latest durable harness artifacts still on disk are the earlier provenance-blocked runs under `docs/release-audit/claude-release-rehearsal-rr-20260323-043611-gau1.{json,md}`

This path is not `release-ready`. That label remains unavailable until `pnpm release:rehearsal` completes the live Discord checkpoints from a source checkout whose repo-local `.env` already sets `PRIMARY_RUNTIME=claude-cli` and `DISCORD_GUILD_ID`, and returns from cleanup with a clean baseline for rehearsal-owned artifacts. The recorded checkout provenance is useful operator context, but it is not a separate harness pass/fail gate.

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
  Result: `PASS`
  Evidence: `All automated checks passed.`
- `pnpm claude:auth-smoke` in `/home/davidmarsh/code/discoclaw`
  Result: `PASS`
  Evidence: `Claude CLI answered the minimal prompt.` and `Output preview: OK`
- `pnpm discord:smoke-test -- --guild-id 1465054970687783015` in `/home/davidmarsh/code/discoclaw`
  Result: `PASS`
  Evidence: `Discord bot ready (guilds: 1; guild ok: 1465054970687783015)`
- `pnpm build` in `/home/davidmarsh/code/discoclaw`
  Result: `PASS`
  Evidence: `Bundled embedded-app-sdk` and `Bundled canvas-runtime`
- `RELEASE_REHEARSAL_CHECKOUT_PROVENANCE=reused-checkout pnpm release:rehearsal` in `/home/davidmarsh/code/discoclaw`
  Result: `BLOCKED`
  Evidence: command steps completed through `pnpm build`, then the harness printed `Starting Run pnpm dev...` and did not emit the old ready-boundary line `Discord bot started` or any checkpoint prompt before the run was interrupted
- side observation during the blocked rehearsal
  Result: `SHARP EDGE`
  Evidence: the child `src/index.ts` process stayed alive and listened on `*:9404`, which suggests the runtime likely started far enough to bind the dashboard port even though the harness never surfaced its ready boundary

## Why The Clone-Side Blank-Machine Step Stayed Open

The exact blessed config/bootstrap command is `pnpm preflight:blank-machine`, and that command only reads the checkout's own `.env`.

This task's safety rule forbids writing to `.env`, so this rerun could not create the clone-local `.env` required to reproduce that exact step safely inside `/tmp/discoclaw-qa-qu0E0N`.

That means this memo proves the fresh-clone install path and the Claude auth behavior from that clone, but it does not add new same-clone `pnpm preflight:blank-machine` evidence beyond the existing audit trail.

## Audit Call

- Current support-safe claim: `SUPPORTED FOR 1.0` for the repo-owned Claude source-checkout path
- Current release-rehearsal claim: `BLOCKED` on the authoritative harness run itself; with repo-local `.env` and checkout provenance supplied, the run hung after `Starting Run pnpm dev...`, produced no durable closeout, and left rehearsal-owned local state behind after interruption
- First-login stranger gate: `CLOSED`
- Keep the support claim narrow: it is based on a real clone-local `.env`, isolated repo/data paths on the maintainer machine, the expected pre-login failure, interactive Claude CLI login in that same isolated home, and the post-login rerun success
- Keep the stale-browser callback rejection documented as a sharp edge, but it is not a blocker because a fresh CLI-driven login in the same isolated home succeeded

## Tightened 1.0 Closeout Checklist

1. Create a throwaway clone and run `pnpm install --frozen-lockfile`.
2. Supply a real clone-local `.env` with the required Discord and runtime values.
3. If auditing from a machine with existing DiscoClaw state, isolate `DISCOCLAW_DATA_DIR`, `WORKSPACE_CWD`, `GROUPS_DIR`, and `BEADS_DIR` to throwaway paths.
4. Force `PRIMARY_RUNTIME=claude-cli` for this audit.
5. Run `pnpm preflight:blank-machine` and treat it as config/bootstrap evidence only.
6. From a shell or account with no active Claude session, run `pnpm claude:auth-smoke`.
7. Confirm the expected pre-login result contains `Claude CLI appears installed but not authenticated.`
8. Run `claude` and complete login in that same shell or account.
9. Rerun `pnpm claude:auth-smoke` in that same shell or account.
10. Confirm the expected post-login result contains `Claude CLI answered the minimal prompt.`
11. Run `pnpm release:rehearsal` from that same checkout once the repo-local `.env` is ready with `PRIMARY_RUNTIME=claude-cli`.
12. Record in the closeout whether the checkout was a throwaway clone or a reused maintainer checkout; treat that as provenance/context, not as a separate harness gate.
13. Treat any non-empty rehearsal-owned cleanup leftovers as a `BLOCKED` verdict even if all earlier live steps passed.
14. Only call the path `release-ready` when the rehearsal completed the live Discord checkpoints and cleanup returned to a clean baseline for rehearsal-owned artifacts.
15. Release closeout may mark the first-login stranger gate closed once steps 6 through 10 happen in the same no-session shell or account.
16. If the passing auth smoke came from an already-logged-in shell or account instead, keep the claim narrowed to `fresh-clone post-login path only`.
17. If `pnpm release:rehearsal` reaches `Starting Run pnpm dev...` but never surfaces `Discord runtime ready` or a checkpoint prompt, treat that as a harness/runtime blocker and do not call the path `release-ready` even if the child runtime appears partially alive.
