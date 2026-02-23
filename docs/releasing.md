# Releasing discoclaw to npm

## How releases work

1. **Bump the version** in `package.json` via a PR — this is the only manual step.
2. **Merge the PR** — `release.yml` fires on push to `main`.
3. `release.yml` reads the version from `package.json`, checks if the tag already exists, and creates + pushes the tag if it doesn't.
4. `release.yml` then calls `publish.yml` directly (via `workflow_call`) to build, test, and publish to npm.

The two-job structure avoids the GitHub Actions limitation where `GITHUB_TOKEN`-pushed tags
don't trigger other workflows. `publish.yml` is never triggered by the tag push from CI —
only by an explicit `workflow_call` from `release.yml` (or a manually pushed tag).

## Workflow files

- **`release.yml`** — triggers on `main` push. Tags HEAD if the version is new, then calls `publish.yml`.
- **`publish.yml`** — does the actual build/test/publish. Triggered by `release.yml` (workflow_call) or a manually pushed tag.

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
2. Is the Trusted Publisher config on npmjs.com still pointing at `publish.yml`? (If the workflow was renamed, update it there.)
3. Is `NODE_AUTH_TOKEN` being passed somewhere? Remove it.

## Setting up Trusted Publishing (one-time)

1. Go to `https://www.npmjs.com/package/discoclaw` → **Settings** tab.
2. Under **Trusted Publishers → GitHub Actions**, add a publisher:
   - **GitHub owner:** `DiscoClaw`
   - **Repository:** `discoclaw`
   - **Workflow filename:** `publish.yml`
   - **Environment name:** leave blank
3. Save. No secrets or tokens to create or rotate.

## Verifying a publish succeeded

- **GitHub Actions tab** — the `release` workflow run should show both jobs green.
  Expand the `publish` job → `npm publish` step to see confirmation.
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
