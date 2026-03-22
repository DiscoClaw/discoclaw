# Claude Blank-Machine Path Audit

Date: 2026-03-22
Checkout under test: `c7ad973562d9c38bc9b6d95d140bf01fd5d1e91f`
Scope: the actual blessed Claude source-checkout path run from a throwaway clone at `/tmp/discoclaw-test`

## Outcome

Fresh-clone post-login path: `PASS`

First-login stranger path release gate: `OPEN`

Why:

- the throwaway clone plus isolated repo/data state worked after one clone-local config cleanup
- `pnpm claude:auth-smoke` produced the expected unauthenticated result from an isolated Claude home with no active session
- the same fresh clone produced the expected authenticated result from the host's normal already-logged-in Claude shell
- the isolated no-session shell was **not** advanced through an interactive `claude` login, so this run does not close the full first-login stranger path gate

## Isolation Preconditions

The run used these exact preconditions:

- cloned `/home/davidmarsh/code/discoclaw` into `/tmp/discoclaw-test`
- ran `pnpm install --frozen-lockfile` inside the throwaway clone
- copied the working `.env` into the clone because secrets are not tracked in git
- overrode the clone-local `.env` with `PRIMARY_RUNTIME=claude`
- overrode the clone-local `.env` with `DISCOCLAW_DATA_DIR=/tmp/discoclaw-test-data`
- overrode the clone-local `.env` with `WORKSPACE_CWD=/tmp/discoclaw-test-data/workspace`
- overrode the clone-local `.env` with `GROUPS_DIR=/tmp/discoclaw-test-data/workspace/groups`
- overrode the clone-local `.env` with `BEADS_DIR=/tmp/discoclaw-test-data/workspace/.beads`
- started with empty isolated data/workspace directories under `/tmp/discoclaw-test-data`
- ran the pre-login Claude auth step with `HOME=/tmp/discoclaw-test-home`
- ran the pre-login Claude auth step with `XDG_CONFIG_HOME=/tmp/discoclaw-test-home/.config`
- ran the pre-login Claude auth step with `XDG_STATE_HOME=/tmp/discoclaw-test-home/.state`
- ran the pre-login Claude auth step with `XDG_DATA_HOME=/tmp/discoclaw-test-home/.local/share`

This proves a fresh clone plus isolated repo/data state on this host. It is not a claim that the machine had no provider secrets available anywhere outside that clone-local setup.

## Observed Run

| Step | Exact command | Result | Observed output | What it means |
| --- | --- | --- | --- | --- |
| Clone and install | `git clone /home/davidmarsh/code/discoclaw /tmp/discoclaw-test` then `pnpm install --frozen-lockfile` | `PASS` | `Done in 741ms using pnpm v10.28.2` | The repo can be materialized and its source-checkout scripts can run from a throwaway location. |
| First preflight attempt | `pnpm preflight:blank-machine` | `FAIL` | `Config doctor [warn] RUNTIME_MODEL is deprecated and still configured.` | A copied legacy maintainer `.env` can fail the blessed path before Claude auth is even tested. |
| Clone-local cleanup | removed `RUNTIME_MODEL` from `/tmp/discoclaw-test/.env` | `PASS` | n/a | This was a throwaway env cleanup only; no tracked repo files changed. |
| Second preflight attempt | `pnpm preflight:blank-machine` | `PASS` | `All automated checks passed.` | The config/bootstrap surface remained honest once the clone-local config drift was removed. |
| Pre-login auth smoke | `HOME=/tmp/discoclaw-test-home ... pnpm claude:auth-smoke` | `EXPECTED FAIL` | `Claude CLI appears installed but not authenticated.` and `Not logged in · Please run /login` | The repo-owned smoke correctly classified the isolated no-session Claude shell as unauthenticated. |
| Logged-in-shell auth smoke | `pnpm claude:auth-smoke` | `PASS` | `Claude CLI answered the minimal prompt.` and `Output preview: OK` | The same fresh clone can reach the authenticated post-login result when the shell already has an active Claude session. |

## Hidden Prerequisites The Run Exposed

- A source checkout still needs a real `.env`; a fresh clone alone is not runnable because provider secrets and Discord IDs are not in git.
- If you reuse an existing maintainer `.env`, force `PRIMARY_RUNTIME=claude` or you may accidentally test another provider path instead of the blessed Claude path.
- To get a meaningful first-login pre-auth result on a machine that already uses Claude, you need an isolated Claude home/session location; otherwise a reused logged-in shell can skip the stranger-path failure entirely.
- `pnpm install --frozen-lockfile` is a real prerequisite for the repo-owned source helpers.

## Confusing Failures And Sharp Edges

### 1. `pnpm preflight:blank-machine` failed on legacy config drift before Claude auth

Observed output:

```text
Config doctor [warn] RUNTIME_MODEL is deprecated and still configured.
```

This did not come from the throwaway clone itself. It came from reusing a working maintainer `.env` that still carried a deprecated key. That means the current docs are only honest if they keep saying preflight is config/bootstrap proof, not a guaranteed pass on every inherited env file.

### 2. A passing auth smoke from the default shell is not enough to close the stranger gate

Observed output:

```text
Claude CLI answered the minimal prompt.
If this shell/account was already logged in, record that limitation and leave the first-login stranger gate open.
```

That warning is correct. This run proved the fresh-clone post-login path, but not the full first-login stranger path, because the isolated no-session shell was not logged in interactively and rerun afterward.

## Must Fix Before 1.0 Closeout

- Do not mark the first-login stranger path closed until the same no-session shell or account records the expected pre-login `Claude CLI appears installed but not authenticated.` result.
- Do not mark the first-login stranger path closed until that same no-session shell or account also records the post-login `Claude CLI answered the minimal prompt.` rerun after interactive `claude` login.
- Keep release signoff language narrowed to `fresh-clone post-login path proven` until that same-shell login/rerun evidence exists.

## Defer To 1.0.x

- Improve migration or operator guidance for inherited legacy `.env` files that still carry `RUNTIME_MODEL`. This throwaway run needed a manual env cleanup, but that came from copied maintainer state rather than the current setup-generated Claude path.

## Final Audit Call

This `/tmp/discoclaw-test` run proved that DiscoClaw's blessed Claude source-checkout path can be recreated in a throwaway clone, can pass the config/bootstrap doctor once clone-local config drift is removed, can show the expected pre-login unauthenticated Claude result from an isolated session, and can answer the minimal prompt from the fresh clone once Claude is already logged in.

It did **not** close the first-login stranger release gate. No interactive `claude` login was executed inside the isolated no-session shell, so the honest claim from this run is: fresh-clone post-login path proven; first-login stranger path still open.
