# Releasing discoclaw to npm

## How releases work

1. **Bump the version** in `package.json` via a PR — this is the only manual step.
2. **Merge the PR** — `release.yml` fires on push to `main`.
3. `release.yml` reads the version from `package.json`, checks if the tag already exists, and creates + pushes the tag if it doesn't.
4. The tag push triggers `publish.yml` directly, which builds, tests, and publishes to npm.

The tag push from `release.yml` uses `GITHUB_TOKEN`. Normally, tags pushed by Actions
don't retrigger other workflows — but `publish.yml` fires here because it's triggered by
`push: tags: v*`, and GitHub *does* fire that event when a workflow pushes a tag (only
workflow_dispatch and push-to-branch events are suppressed). The OIDC token's ref is
`refs/tags/vX.Y.Z`, which npmjs.com's Trusted Publisher accepts.

> **Why not `workflow_call`?** When `release.yml` called `publish.yml` via `workflow_call`,
> the OIDC token's ref was `refs/heads/main` (the caller's ref), not the tag. npmjs.com
> rejected it. Direct tag trigger fixes this permanently.

## Workflow files

- **`release.yml`** — triggers on `main` push. Tags HEAD if the version is new.
- **`publish.yml`** — does the actual build/test/publish. Triggered by a tag push matching `v*`.

## Manual release (if needed)

Push a tag manually and `publish.yml` will fire directly:

```bash
git tag v1.2.3
git push origin v1.2.3
```

Or trigger `release.yml` manually from the Actions tab (workflow_dispatch) to re-run the tag check and publish.

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
3. Is the Trusted Publisher config on npmjs.com still pointing at `publish.yml`? (If the workflow was renamed, update it there.)
4. Is `NODE_AUTH_TOKEN` being passed somewhere? Remove it.

### `registry-url` is required — do not remove it

The `actions/setup-node` step in `publish.yml` **must** include `registry-url: "https://registry.npmjs.org/"`.

This is what triggers `setup-node` to write an `.npmrc` file that configures the npm registry. Without it, npm has no registry configuration at all and throws `ENEEDAUTH` — even though the OIDC token is valid.

With `registry-url` present and no `NODE_AUTH_TOKEN`, npm correctly performs the OIDC exchange to obtain a temporary publish token. This is the working configuration.

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
2. Once merged, `release.yml` handles tagging and publishing automatically

### Version guidance

- **patch** (0.x.**y**) — bug fixes, small tweaks, no new features
- **minor** (0.**x**.0) — new features, backwards-compatible
- **major** (**x**.0.0) — breaking changes
