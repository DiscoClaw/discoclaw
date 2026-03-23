# Releasing discoclaw to npm

## How releases work

1. **Bump the version** in `package.json` via a PR — this is the only manual step.
2. **Merge the PR** — `release.yml` fires on push to `main`.
3. `release.yml` reads the version from `package.json`, checks if the tag already exists, and creates + pushes the tag if it doesn't.
4. The tag push triggers `publish.yml` directly, which builds, tests, and publishes to npm.

> **Important:** `release.yml` pushes the tag using `GITHUB_TOKEN`. GitHub intentionally
> prevents workflows triggered by `GITHUB_TOKEN` from firing other workflows. This means
> the tag push from `release.yml` does **not** automatically trigger `publish.yml`.
>
> After merging a version bump PR, you must retag manually from your local machine to
> trigger `publish.yml`. See [Manual release](#manual-release-if-needed) below.
>
> **Do not add a PAT or any token to work around this.** Adding any token to the publish
> path breaks the OIDC Trusted Publisher flow and causes ENEEDAUTH.

> **Why not `workflow_call`?** When `release.yml` called `publish.yml` via `workflow_call`,
> the OIDC token's ref was `refs/heads/main` (the caller's ref), not the tag. npmjs.com
> rejected it. Direct tag trigger is the only working path.

## Workflow files

- **`release.yml`** — triggers on `main` push. Tags HEAD if the version is new.
- **`publish.yml`** — does the actual build/test/publish. Triggered by a tag push matching `v*`.

## Claude 1.0 Release Rehearsal (Blessed Source Checkout)

The repo-owned harness is the authoritative operational rehearsal for the blessed Claude source-checkout path:

```bash
pnpm release:rehearsal
```

That harness lives in `scripts/release-rehearsal.ts` and owns one exact contract:

1. Refuse to run unless the current tree is a real source checkout, `<repoRoot>/.env` exists, and that repo-local `.env` resolves both `PRIMARY_RUNTIME=claude` and a concrete `DISCORD_GUILD_ID`.
2. Run this command sequence in order against that same checkout:
   - `pnpm preflight:blank-machine`
   - `pnpm claude:auth-smoke`
   - `pnpm discord:smoke-test -- --guild-id <repo-local DISCORD_GUILD_ID>`
   - `pnpm build`
   - `pnpm dev`
3. Hold the live Discord verification points as manual checkpoints for the first reply, same-conversation follow-up reply, task sync, cron execution, and restart/recovery.
4. Tear the rehearsal-owned task, cron, and local-temp artifacts back down to a reusable baseline and treat any unresolved owned artifact as a blocked verdict, not a soft warning.
5. Write a durable closeout in `docs/release-audit/claude-release-rehearsal-<slug>.json` and `.md`, including checkout provenance when the operator supplied it for context.

Fresh-clone / stranger-path proof stays outside this harness as a separate evidence track. Inside the rehearsal itself, checkout provenance may be recorded as operator context and repo-local secret hygiene stays an operator concern, but they do not become extra runtime gates beyond the real git-checkout boundary, repo-owned source markers, repo-local `.env`, `PRIMARY_RUNTIME=claude`, the command sequence above, the required manual checkpoints, and the blocked-on-leftovers teardown verdict.

### Why each restriction is true

- **Repo-local config source is enforced, not implied.** `scripts/release-rehearsal.ts` refuses to run without `<repoRoot>/.env`, parses that file directly, blocks unless that file explicitly sets `PRIMARY_RUNTIME=claude` and `DISCORD_GUILD_ID`, and builds each child-process env from a small execution/auth shell baseline plus that repo-local file after stripping repo-local persistence/config path overrides that would escape the rehearsal temp root, then applies the rehearsal-only isolation overrides. The first command in the contract is `pnpm preflight:blank-machine`, which routes through `scripts/doctor.ts` and the shared config-doctor path specifically to validate the checkout's own `.env` instead of inheriting your normal shell environment.
- **The source-checkout boundary is a real git checkout, not just copied files.** `scripts/release-rehearsal.ts` requires both the repo-owned marker files and checkout-local `.git` metadata, so an extracted archive or copied folder without git checkout state does not satisfy the gate.
- **Repo-local `.env` means the operator-managed config file in the checkout being rehearsed.** The harness validates that file as the source of truth for the run and requires it to set `PRIMARY_RUNTIME=claude` and `DISCORD_GUILD_ID`. Secret hygiene for that file is a normal local-operator concern, not a separate rehearsal gate, and the file itself should not be copied into durable release evidence.
- **Checkout provenance is context, not a new runtime gate.** `scripts/release-rehearsal.ts` accepts optional operator-recorded `throwaway-clone` or `reused-checkout` provenance and writes that value into the durable closeout when supplied, but it does not change the runtime restrictions or child-process env from that answer. Fresh-clone evidence remains a separate proof track rather than a second readiness gate inside this harness.
- **Claude auth is a separate gate.** `pnpm claude:auth-smoke` runs `scripts/claude-auth-smoke.ts`, so the rehearsal does not collapse config/bootstrap success into Claude-session success.
- **Discord bootstrap is a separate gate.** `pnpm discord:smoke-test -- --guild-id <repo-local DISCORD_GUILD_ID>` runs `scripts/discord-smoke-test.mjs` before the live runtime comes up, so Discord login and basic guild/forum reachability fail fast against the same pinned guild the rehearsal will later clean up. After that, the harness waits for the runtime to log `Discord runtime ready`, which is emitted immediately after the Discord login/bootstrap path resolves and before post-connect startup checks or dashboard startup, so late non-essential startup work does not block the live checkpoints.
- **Manual chat checkpoints stay manual.** The live message path in `src/discord/message-coordinator.ts` only serves allowlisted requesters, and Discord does not give the harness a way to impersonate that allowlisted sender for a real end-to-end message turn. The rehearsal therefore pauses for operator-confirmed TTY checkpoints for the first reply, the same-conversation follow-up reply, and the post-restart reply instead of faking the chat leg, and any skipped required live checkpoint blocks the verdict.
- **Task sync verification is tied to the real task owners.** The rehearsal task check exercises the canonical sync path in `src/tasks/task-sync-engine.ts`, while `src/tasks/sync-coordinator.ts` remains the concurrency/coalescing owner for repeated sync triggers.
- **Cron mutation remains unavailable during the rehearsal.** In `src/index.ts`, the cron executor context is created with `cronActionFlags.crons = false` and `cronActionFlags.archive = false` before `executeCronJob()` in `src/cron/executor.ts` is invoked, so the rehearsal can verify cron execution without allowing cron-emitted action blocks to mutate cron state or archive channels.
- **Restart/recovery verification is tied to the real recovery owners.** `src/discord/long-run-watchdog.ts` owns persisted long-run recovery/final-post behavior, and `src/health/startup-healing.ts` owns startup healing of stale runtime state. The rehearsal restart step is checking those real boundaries, not a separate fake harness path.

### Isolation, namespace, and teardown

- **Local persistence is isolated by rehearsal-only child-process overrides.** `scripts/release-rehearsal.ts` launches child commands with temporary `DISCOCLAW_DATA_DIR`, `WORKSPACE_CWD`, `GROUPS_DIR`, `BEADS_DIR`, and a rehearsal-only `DISCOCLAW_TASKS_PREFIX`, and it strips repo-local persistence/config path overrides such as task tag-map or webhook config paths before launch, so the local task/cron/workspace stores do not share state with the operator's normal environment.
- **Live Discord artifacts are namespaced.** The harness generates a unique rehearsal slug and uses it in the rehearsal task title and cron name, so live Discord-visible artifacts can be identified and swept deterministically.
- **Teardown is part of the verdict.** Cleanup closes rehearsal tasks, runs the task-sync path to archive related task threads, archives rehearsal cron threads, persists `disabled: true` into the canonical cron records for those archived rehearsal threads, checks that canonical state, and removes the per-run local temp root. Those rehearsal-owned artifacts are the hard blocked-on-leftovers boundary. Manual message-handling and restart/recovery chat artifacts remain an operator checklist item: when those checkpoints were exercised, record whether they were cleaned up or confined to a disposable location, but do not treat checkout provenance or general local-secret hygiene as extra machine-enforced teardown gates.

### Manual fallback

If you need to diagnose a failing step outside the harness, use the same blessed order manually:

```bash
pnpm preflight:blank-machine
pnpm claude:auth-smoke
pnpm discord:smoke-test -- --guild-id <repo-local DISCORD_GUILD_ID>
pnpm build
pnpm dev
```

Treat that as debugging only. The authoritative release-rehearsal artifact is still the closeout written by `pnpm release:rehearsal`, because that path is the only one that also enforces the repo-local config source, child-process isolation, required live-checkpoint gating, teardown of rehearsal-owned artifacts, optional checkout-provenance capture for context, and durable closeout contract in one run.

## Manual release (if needed)

Push a tag manually and `publish.yml` will fire directly:

```bash
git tag v1.2.3
git push origin v1.2.3
```

Do **not** rely on `release.yml` `workflow_dispatch` to publish. It still creates/pushes tags via `GITHUB_TOKEN`, so `publish.yml` will not auto-fire from that path either.

## Authentication

Publishing uses **OIDC Trusted Publishing** — no token or secret required. GitHub Actions
exchanges an OIDC token directly with npm. The `id-token: write` permission in `publish.yml`
enables this.

npm is configured to trust `publish.yml` in the `DiscoClaw/discoclaw` repo. If the workflow
filename ever changes, the Trusted Publisher config at `https://www.npmjs.com/package/discoclaw`
→ Settings → Trusted Publishers must be updated to match.

### Do not use NPM_TOKEN or any npm access token

**Never** add `NODE_AUTH_TOKEN`, `NPM_TOKEN`, or any npm access token as a GitHub secret
or pass it into the publish workflow. Reasons:

- Tokens expire and cause silent failures months later (`401 Access token expired`)
- Tokens require manual rotation — OIDC tokens are ephemeral and auto-renewed per-run
- OIDC is strictly more secure: only this specific workflow in this specific repo can publish

If you ever see an npm auth failure in CI, the fix is **not** to create a new token. Check:
1. Is `id-token: write` set on the publish job? (It is — don't remove it.)
2. Is `registry-url: "https://registry.npmjs.org/"` present in the `actions/setup-node` step? (It must be — see below.)
3. Is `npm install -g npm@11` still running before `npm publish`? (It must be — see below.)
4. Is the Trusted Publisher config on npmjs.com still pointing at `publish.yml`? (If the workflow was renamed, update it there.)
5. Is `NODE_AUTH_TOKEN` being passed somewhere? Remove it.

### `registry-url` is required — do not remove it

The `actions/setup-node` step in `publish.yml` **must** include `registry-url: "https://registry.npmjs.org/"`.

This is what triggers `setup-node` to write an `.npmrc` file that configures the npm registry. Without it, npm has no registry configuration at all and throws `ENEEDAUTH` — even though the OIDC token is valid.

With `registry-url` present and no `NODE_AUTH_TOKEN`, npm correctly performs the OIDC exchange to obtain a temporary publish token. This is the working configuration.

### `npm@11` is required — do not remove it

The `publish.yml` workflow must run `npm install -g npm@11` before `npm publish`.

Node 22 currently ships with npm 10.x, and that version does not reliably complete the OIDC exchange when `setup-node` prepares the publish environment. npm 11 does. Keep the explicit npm 11 upgrade in the workflow.

**Root cause of v0.1.3 failure (for future reference):**
`v0.1.3` added `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` to the publish step. `NPM_TOKEN` was not set as a GitHub secret, so it expanded to an empty string. `setup-node` wrote `.npmrc` with an empty token, which npm sent to the registry, getting a 404/expired-token error. Fix: remove `NODE_AUTH_TOKEN` entirely. Do not remove `registry-url`.

## Recovery: retagging a release

Use this when a tag was pushed pointing to the wrong commit (e.g., a bad PR was tagged before the fix was merged).

`release.yml` checks whether the remote tag exists before creating one. If the tag is already on the remote, `release.yml` will skip tagging and not trigger `publish.yml`. You must retag manually.

### Check current state

```bash
cd ~/code/discoclaw
git fetch --tags
git log --oneline -5               # confirm HEAD is the correct commit
git rev-parse v1.2.3               # see what the existing tag points to
git ls-remote --tags origin | grep v1.2.3  # check if tag exists on remote
```

### Retag (local tag wrong, remote tag missing)

If the local tag exists but points to the wrong commit, and the remote tag doesn't exist yet:

```bash
git tag -d v1.2.3                  # delete local tag
git tag v1.2.3                     # re-create pointing to HEAD
git push origin v1.2.3             # push — triggers publish.yml
```

### Retag (remote tag exists and is wrong)

If the remote tag exists and points to the wrong commit:

```bash
git tag -d v1.2.3                  # delete local tag
git push origin :refs/tags/v1.2.3  # delete remote tag
git tag v1.2.3                     # re-create pointing to HEAD
git push origin v1.2.3             # push — triggers publish.yml
```

### Why this works

`publish.yml` triggers on `push: tags: v*` regardless of how the tag was pushed. A manually pushed tag fires it directly, bypassing `release.yml` entirely.

After pushing, verify:
1. The `publish` Actions run completed successfully (green in the Actions tab)
2. `npm view discoclaw version` returns the expected version

## Setting up Trusted Publishing (one-time)

1. Go to `https://www.npmjs.com/package/discoclaw` → **Settings** tab.
2. Under **Trusted Publishers → GitHub Actions**, add a publisher:
   - **GitHub owner:** `DiscoClaw`
   - **Repository:** `discoclaw`
   - **Workflow filename:** `publish.yml`
   - **Environment name:** leave blank
3. Save. No secrets or tokens to create or rotate.

## Verifying a publish succeeded

- **GitHub Actions tab** — two separate workflow runs will appear: `release` (tags HEAD) and `publish` (builds and publishes). Both should be green. Expand the `publish` run → `npm publish` step to see confirmation.
- **npm registry:**
  ```bash
  npm view discoclaw version
  ```
- **Provenance** — the package page on npmjs.com will show a "Published via GitHub Actions" badge.

## Releasing via Weston (Discord)

When you're ready to ship, say something like:

> "tag a release" or "tag a patch release" or "bump to 0.3.0 and tag it"

Weston will:

1. Bump the version in `package.json` and open a PR (or commit directly if on a branch)
2. Once merged, `release.yml` creates the tag automatically
3. Retag manually from local to trigger `publish.yml` (see [Manual release](#manual-release-if-needed))

### Version guidance

- **patch** (0.x.**y**) — bug fixes, small tweaks, no new features
- **minor** (0.**x**.0) — new features, backwards-compatible
- **major** (**x**.0.0) — breaking changes
