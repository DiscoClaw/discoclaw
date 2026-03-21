# Codex Npm-Managed Path Audit

Date: 2026-03-21
Scope: the stranger-run Codex path for `npm install -g discoclaw` as the shipped npm-managed code supports it today, including the optional OpenAI fast/alternate runtime path.

## Method

This audit follows the real npm-managed operator path rather than the source-checkout path:

- global install
- `discoclaw init` and its current Codex/OpenAI validation guidance
- `discoclaw doctor` / `!doctor`
- `discoclaw install-daemon` and service startup behavior
- first useful Codex-backed reply
- restart / recovery on the installed daemon path
- npm-managed update detection and upgrade mechanics

This is a code-backed product-surface audit. It does not treat repo-only source helpers as evidence for the npm-managed path.

## 1.0 Verdict

Verdict: `NOT YET SUPPORT-CLAIMABLE`

Reason:

- global install and npm-managed update mechanics exist
- `discoclaw doctor` / `!doctor` remain config-only and no shipped `discoclaw codex auth-smoke` exists yet
- `discoclaw init` documents the same-shell `codex exec --skip-git-repo-check -- "Reply with OK"` login gate, but it does not persist `CODEX_BIN`
- the npm daemon installers still pin `/usr/bin/node` and a fixed service `PATH`, so the installed service can diverge from the interactive shell that passed the Codex prompt or exposed the OpenAI key

## Step Audit

| Step | Current state | Evidence | Blocker classification |
| --- | --- | --- | --- |
| Global install | The npm package exposes the `discoclaw` binary and includes the compiled runtime, docs, templates, and assets needed for a real `npm install -g discoclaw` surface. npm-managed detection is explicit. | `package.json`, `src/npm-managed.ts`, `src/cli/index.ts` | `no-blocker` |
| Init / Codex login validation | `discoclaw init` detects `codex` in the current shell and prints the manual before/after `codex exec --skip-git-repo-check -- "Reply with OK"` sequence. The npm-managed product still ships no `discoclaw codex auth-smoke`, and init does not persist `CODEX_BIN`, so the validated shell path is not recorded for the daemon. | `src/cli/init-wizard.ts`, `src/health/config-doctor.ts`, `src/cli/index.ts` | `accepted-manual-gate`, `blocker-missing-codex-bin-persistence` |
| Optional OpenAI fast/alternate auth gate | When npm-managed config uses the optional OpenAI fast/alternate runtime path, init and config-doctor tell operators to treat `OPENAI_API_KEY` as config-only and to confirm `openai-key: ok` from a live DiscoClaw startup or `!status`. That is a real proof gate, but only after the installed runtime starts. | `src/cli/init-wizard.ts`, `src/health/config-doctor.ts` | `accepted-manual-gate` |
| Daemon install / startup | The service renderers pin `/usr/bin/node` and a fixed `PATH`. The runtime later resolves `CODEX_BIN` from env or falls back to plain `codex`, but init does not persist `CODEX_BIN`, so the daemon can start in a different Node / Codex environment than the shell the operator validated. | `src/cli/daemon-installer.ts`, `src/config.ts`, `src/cli/init-wizard.ts` | `blocker-daemon-runtime-path` |
| First useful reply | Shared Discord reply machinery exists, but the npm-managed daemon path still cannot claim this step because service startup can diverge from the shell that passed the manual Codex prompt before the bot reaches Discord. | `src/index.ts`, `src/cli/daemon-installer.ts`, `src/cli/init-wizard.ts` | `blocked-by-auth-and-daemon-gaps` |
| Restart recovery | Shared restart and long-run recovery code exists, but the npm-managed Codex daemon path inherits the same unresolved runtime-path mismatch. If the installed service cannot reliably come back with the same Node / Codex resolution, restart recovery is not support-claimable for this path. | `src/cli/daemon-installer.ts`, `src/config.ts`, `src/index.ts`, `src/discord/update-command.ts` | `blocked-by-daemon-runtime-path` |
| Update | The real npm-managed update surface is still `discoclaw update` / `discoclaw update apply` on top of the npm helpers in `src/npm-managed.ts`. The Discord `!update` path is a wrapper over the same npm-managed mode plus restart behavior. | `src/npm-managed.ts`, `src/cli/index.ts`, `src/discord/update-command.ts` | `no-blocker` |

## Findings

### Finding 1: Install and update mechanics exist, but that is narrower than a Codex-ready verdict

Classification: `no-blocker`

The shipped npm package does expose a real install and update surface:

- `package.json` publishes the `discoclaw` bin from `./dist/cli/index.js`
- `src/npm-managed.ts` explicitly distinguishes npm-managed installs from source checkouts
- `src/cli/index.ts` exposes `discoclaw update` and `discoclaw update apply`

That is enough to claim install and upgrade mechanics. It is not enough to claim that the npm-managed Codex runtime path is production-ready for strangers.

### Finding 2: The npm-managed shell path has a manual Codex session gate, but no shipped auth-smoke helper

Classification: `accepted-manual-gate`

The installed CLI does document a real Codex login check:

- `discoclaw init` tells operators to run `codex exec --skip-git-repo-check -- "Reply with OK"` before and after `codex` login
- `src/health/config-doctor.ts` repeats the same-shell recommendation
- `discoclaw doctor`, `!doctor`, and `!health doctor` remain config-only and do not invoke Codex

That is enough to claim a documented shell-level Codex validation path. It is not enough to claim daemon readiness, because the validated shell path is not persisted into the installed service.

### Finding 3: The optional OpenAI fast/alternate path has its own proof gate and cannot be inferred from key presence

Classification: `accepted-manual-gate`

For npm-managed Codex installs that also enable the OpenAI fast/alternate runtime path:

- init explicitly says `OPENAI_API_KEY` presence is not proof
- init and config-doctor require runtime-visible evidence such as `openai-key: ok` in `!status` or the startup credential report

That is the correct boundary for the shipped code today. It still depends on the installed runtime actually starting under the expected environment.

### Finding 4: The daemon path can diverge from the shell path that init validated

Classification: `blocker-daemon-runtime-path`

The current daemon installers lock in assumptions that are unsafe for the npm-managed Codex path:

- systemd uses `ExecStart=/usr/bin/node ...` and a fixed `Environment=PATH=...`
- launchd likewise uses `/usr/bin/node`
- the runtime later resolves `CODEX_BIN` from env and otherwise falls back to plain `codex`
- `discoclaw init` never writes `CODEX_BIN` into `.env`, even when `codex` was detected interactively

That means the successful interactive path can depend on a Node install, npm prefix, shell shim, or Codex binary location that the service unit never records.

### Finding 5: First reply and restart recovery are blocked by the missing npm-managed runtime proof

Classification: `blocked-by-auth-and-daemon-gaps`

This is the key scoping point for the 1.0 claim:

- the repo does have shared Discord reply, update, and recovery code
- the installed shell has a documented manual Codex session check
- the optional OpenAI fast/alternate path has a documented runtime-visible proof gate
- but the npm-managed Codex daemon path still lacks the product work needed to prove that the installed service will start under the same Node / Codex environment and reach a useful reply state

## Final 1.0 Decision

`NOT YET SUPPORT-CLAIMABLE` for the npm-managed Codex path.

What currently passes:

- `npm install -g discoclaw`
- npm-managed detection
- shell-level manual Codex validation via `discoclaw init` guidance
- config-only doctor surfaces
- version check / upgrade mechanics via `discoclaw update` and `discoclaw update apply`
- runtime-visible OpenAI key confirmation after startup when the optional OpenAI path is enabled

What still blocks a 1.0 support claim:

- no shipped `discoclaw codex auth-smoke`
- init detects Codex but does not persist `CODEX_BIN`
- daemon install assumes `/usr/bin/node` and a fixed service `PATH`
- first useful reply and restart recovery inherit those unresolved runtime-path gaps
