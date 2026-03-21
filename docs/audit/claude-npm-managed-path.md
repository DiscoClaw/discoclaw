# Claude Npm-Managed Path Audit

Date: 2026-03-21
Scope: the stranger-run Claude path for `npm install -g discoclaw` as the shipped npm-managed code supports it today.

## Method

This audit follows the real npm-managed operator path rather than the source-checkout path:

- global install
- `discoclaw init` and the current login-validation guidance
- `discoclaw install-daemon` and service startup behavior
- first useful Claude-backed reply
- restart / recovery on the installed daemon path
- npm-managed update detection and upgrade mechanics

This is a code-backed product-surface audit. It does not treat source-only helpers as evidence for the npm-managed path.

## 1.0 Verdict

Verdict: `NOT YET SUPPORT-CLAIMABLE`

Reason:

- global install and npm-managed update mechanics exist
- the npm-managed Claude path still lacks a shipped auth-smoke surface: `src/cli/index.ts` exposes no Claude auth-smoke subcommand, the published package omits `scripts/claude-auth-smoke.ts`, and `discoclaw doctor` / `!doctor` remain config-only
- `discoclaw init` detects Claude interactively but does not persist `CLAUDE_BIN`, so the daemon path cannot rely on the same Claude binary resolution that succeeded in the user shell
- `src/cli/daemon-installer.ts` hardcodes `/usr/bin/node` and a fixed service `PATH`, so daemon startup can diverge from the operator's interactive npm / Claude environment before the bot reaches a first useful reply

## Step Audit

| Step | Current state | Evidence | Blocker classification |
| --- | --- | --- | --- |
| Global install | The npm package exposes the `discoclaw` binary and includes compiled runtime files, so `npm install -g discoclaw` is a real install surface. npm-managed detection is explicit and not inferred from Discord command usage. | `package.json`, `src/npm-managed.ts`, `src/cli/index.ts` | `no-blocker` |
| Init / login validation | `discoclaw init` detects `claude` in the current shell and prints a manual raw `claude -p -- "Reply with OK"` sequence, but it explicitly says it does not auto-check login state. The generated `.env` does not persist `CLAUDE_BIN`. There is no npm-side `discoclaw claude-auth-smoke` command, and the published package does not ship `scripts/claude-auth-smoke.ts`. | `src/cli/init-wizard.ts`, `package.json`, `scripts/claude-auth-smoke.ts`, `src/cli/index.ts` | `blocker-missing-shipped-auth-smoke`, `blocker-missing-claude-bin-persistence` |
| Daemon install / startup | The service renderers pin `/usr/bin/node` and a fixed `PATH`. The runtime later resolves `CLAUDE_BIN` from env or falls back to bare `claude`, then exits early if `claude --version` fails. Because init does not persist `CLAUDE_BIN`, the daemon can start in a different Node / Claude environment than the one the operator validated interactively. | `src/cli/daemon-installer.ts`, `src/config.ts`, `src/index.ts`, `src/cli/init-wizard.ts` | `blocker-daemon-runtime-path` |
| First useful reply | Shared reply machinery exists, but the npm-managed Claude path cannot currently claim this step as a supported stranger path because there is no shipped npm auth-smoke proof and the daemon/runtime path can fail before Discord ever reaches Claude. | `src/index.ts`, `src/cli/index.ts`, `src/cli/daemon-installer.ts`, `src/cli/init-wizard.ts` | `blocked-by-auth-and-daemon-gaps` |
| Restart recovery | Shared restart and long-run recovery code exists, but the npm-managed daemon path inherits the same unresolved service-runtime mismatch. If the installed service cannot reliably come back with the same Node / Claude resolution, restart recovery is not support-claimable for this path. | `src/cli/daemon-installer.ts`, `src/config.ts`, `src/index.ts`, `src/discord/update-command.ts` | `blocked-by-daemon-runtime-path` |
| Update | The real npm-managed update surface is the CLI path in `src/cli/index.ts` plus the npm detection / registry helpers in `src/npm-managed.ts`: check via `npm show discoclaw version`, apply via `npm install -g discoclaw --loglevel=error`. The Discord `!update` command is a wrapper over the same npm-managed mode plus restart behavior; it is not the primary evidence for whether npm-managed update exists. | `src/npm-managed.ts`, `src/cli/index.ts`, `src/discord/update-command.ts` | `no-blocker` |

## Findings

### Finding 1: The package is installable and updateable, but that is narrower than a Claude-ready verdict

Classification: `no-blocker`

The shipped npm package does expose a real global-install and update path:

- `package.json` publishes the `discoclaw` bin from `./dist/cli/index.js`
- `src/npm-managed.ts` explicitly distinguishes npm-managed installs from source checkouts by checking for the package-root `.git` directory
- `src/cli/index.ts` exposes `discoclaw update` and `discoclaw update apply` on top of those npm-managed helpers

That is enough to claim install and upgrade mechanics. It is not enough to claim that the npm-managed Claude runtime path is production-ready for strangers.

### Finding 2: The npm-managed Claude path has no shipped auth-smoke proof

Classification: `blocker-missing-shipped-auth-smoke`

The repo does contain `scripts/claude-auth-smoke.ts`, but that is source-path evidence, not npm-managed evidence:

- the published `files` list in `package.json` does not include `scripts/`
- `src/cli/index.ts` has no `claude-auth-smoke` subcommand
- `discoclaw init` falls back to a handwritten raw Claude prompt and explicitly says it does not auto-check login state
- `discoclaw doctor` only runs `inspect()` / `applyFixes()` from `src/health/config-doctor.ts`
- Discord `!doctor` and `!health doctor` route through the same config-doctor path in `src/discord/message-coordinator.ts`

So the shipped npm-managed product still has no code-owned Claude auth validation surface that a stranger can run after `npm install -g discoclaw`.

### Finding 3: The daemon path can diverge from the shell path that init validated

Classification: `blocker-daemon-runtime-path`

The current daemon installers lock in assumptions that are unsafe for the npm-managed Claude path:

- systemd uses `ExecStart=/usr/bin/node ...` and `Environment=PATH=%h/.local/bin:%h/.npm-global/bin:/usr/local/bin:/usr/bin:/bin`
- launchd likewise uses `/usr/bin/node`
- the runtime later resolves `CLAUDE_BIN` from env and otherwise falls back to plain `claude`
- `discoclaw init` never writes `CLAUDE_BIN` into `.env`, even when it found `claude` interactively

That means the successful interactive path can depend on a Node install, npm prefix, shell shim, or Claude binary location that the service unit never records.

### Finding 4: First reply and restart recovery are blocked by the missing npm-managed runtime proof, not by missing shared Discord features

Classification: `blocked-by-auth-and-daemon-gaps`

This is the key scoping point for the 1.0 claim:

- the repo does have shared Discord reply, update, and recovery code
- but the npm-managed Claude path still lacks the product work needed to prove that the installed service can authenticate Claude, start under the right runtime path, survive restart, and return to a useful reply state

Until the auth-smoke surface is shipped and the daemon/runtime path records the real Node and Claude executables it validated, those later steps stay blocked for the npm-managed stranger path.

## Final 1.0 Decision

`NOT YET SUPPORT-CLAIMABLE` for the npm-managed Claude path.

What currently passes:

- `npm install -g discoclaw`
- npm-managed detection
- version check / upgrade mechanics via `discoclaw update` and `discoclaw update apply`

What still blocks a 1.0 support claim:

- no shipped npm-managed Claude auth-smoke command
- config-only doctor surfaces that do not prove Claude auth
- init detects Claude but does not persist `CLAUDE_BIN`
- daemon install assumes `/usr/bin/node` and a fixed service `PATH`
- first useful reply and restart recovery inherit those unresolved runtime-path gaps
