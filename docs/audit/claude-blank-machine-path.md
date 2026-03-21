# Claude Blank-Machine Path Audit

Date: 2026-03-20
Scope: the stranger-run Claude path on this repo as it exists today, from setup/preflight through first useful Discord flows.

## Method

This audit checks the shipped path a new operator would actually encounter:

- setup and init copy
- `pnpm preflight` / doctor copy
- the required unauthenticated Claude smoke step
- the post-login rerun
- first reply, follow-up reply, task flow, cron flow, and restart/recovery behavior

This is a code-and-test-backed audit, not a destructive host-auth experiment. The repo intentionally records Claude login as a manual validation gate rather than something automated surfaces claim to verify.

## 1.0 Verdict

Verdict: `PASS`

Reason:

- the stranger-facing setup, init, preflight, and configuration surfaces now describe the real contract instead of implying full end-to-end Claude readiness
- the required unauthenticated failure and post-login rerun are explicitly recorded as a manual Claude CLI validation gate
- the first reply, follow-up, task, cron, and restart/recovery paths all have direct code or test coverage in the repo

Non-goal of this `PASS`:

- it is **not** a claim that the repo can automatically prove Claude login/auth health on a blank machine

## Step Audit

| Step | Current state | Evidence | Blocker classification |
| --- | --- | --- | --- |
| Setup / init surfaces | `pnpm run setup` and `discoclaw init` tell the operator that forum channels can auto-create on first connect and that Claude login is manual. | `scripts/setup.ts`, `scripts/setup.test.ts`, `src/cli/init-wizard.ts`, `src/cli/init-wizard.test.ts` | `no-blocker` |
| Preflight / doctor surfaces | `pnpm preflight:blank-machine` explicitly says it only verifies local prerequisites, allows bootstrap-derived forum IDs, and points Claude operators to a manual auth validation path. | `scripts/doctor.ts`, `scripts/doctor.test.ts`, `scripts/doctor-lib.test.ts`, `docs/configuration.md` | `no-blocker` |
| Unauthenticated first run | The shipped stranger path now explicitly requires running `claude -p -- "Reply with OK"` before login and confirming an auth/login failure. That is the correct expected first-run failure. | `scripts/setup.ts`, `scripts/setup.test.ts`, `src/cli/init-wizard.ts`, `src/cli/init-wizard.test.ts` | `accepted-manual-gate` |
| Post-login rerun | The shipped path then requires logging in with `claude`, rerunning the same prompt, and confirming normal text output. The repo documents this, but does not auto-prove it. | `scripts/setup.ts`, `src/cli/init-wizard.ts`, `docs/audit/claude-blank-machine-readiness.md` | `accepted-manual-gate` |
| First reply | Normal message runs start a real watchdog-backed reply lifecycle instead of relying on a generic completion notice, and reply rendering/edit behavior is covered. | `src/discord-followup.test.ts`, `src/discord/output-common.test.ts` | `no-blocker` |
| Follow-up reply | Query-action follow-ups post an explicit placeholder, keep lifecycle state on that placeholder, and complete with the follow-up result. | `src/discord-followup.test.ts`, `src/discord/message-coordinator.followup-lifecycle.test.ts` | `no-blocker` |
| Task flow | Tasks resolve from an explicit forum ID or bootstrap-provided system forum ID, and `taskCreate` is covered as a direct action path. | `src/tasks/initialize.ts`, `src/tasks/initialize.test.ts`, `src/tasks/task-action-executor.test.ts`, `docs/tasks.md` | `no-blocker` |
| Cron flow | Cron prerequisites accept first-connect forum bootstrap, and cron execution is covered from scheduler invoke to posting in the target channel. | `scripts/doctor-lib.test.ts`, `src/cron/executor.test.ts`, `docs/cron.md` | `no-blocker` |
| Restart / recovery | Long-run recovery persists staged summary text, retries final posting after restart, and marks orphaned running work as interrupted with a final status. | `src/discord/long-run-watchdog.test.ts`, `docs/configuration.md` | `no-blocker` |

## Findings

### Finding 1: Automated surfaces are no longer misleading about Claude auth

Classification: `no-blocker`

The repo now consistently says the same thing in the three stranger-facing entry points:

- `pnpm run setup`
- `discoclaw init`
- `pnpm preflight:blank-machine` / doctor

Those surfaces no longer claim that Claude is fully ready just because the binary exists. They explicitly stop at what the repo can verify locally and push Claude auth into a manual smoke step.

### Finding 2: Claude login/auth remains a required human gate

Classification: `accepted-manual-gate`

This is still a real dependency, but under the narrowed 1.0 contract it is recorded, not hidden. The required sequence is:

1. Run `claude -p -- "Reply with OK"` before login and confirm an auth/login failure.
2. Log in with `claude`.
3. Repeat the same prompt and confirm normal text output.

That is acceptable for this 1.0 audit because the automated surfaces no longer overclaim beyond that boundary.

### Finding 3: Post-auth operational paths are repo-proven

Classification: `no-blocker`

After the manual Claude gate, the repo has direct coverage for:

- the first reply path
- auto-follow-up reply lifecycle
- task creation / task forum resolution
- cron execution and posting
- restart-time long-run recovery

The remaining risk is not that these paths are undocumented or obviously misleading; it is that the Claude login step itself still depends on a human operator and an external CLI session.

## Final 1.0 Decision

`PASS` for the narrowed blank-machine 1.0 contract.

Why it passes:

- strangers are told the truth about what setup and preflight can verify
- Claude auth is explicitly treated as a manual gate instead of an implied automated success
- the first useful post-login behaviors are covered in-repo

What would change this from "manual-gate PASS" to "fully automated PASS":

- a checked auth-aware Claude smoke path that can distinguish missing CLI, unauthenticated CLI, and authenticated minimal prompt success without relying on ambiguous operator interpretation
