# Releasing discoclaw to npm

## How to cut a release

1. **Bump the version** in `package.json`:

   ```bash
   npm version patch   # or minor / major
   ```

   This updates `package.json` and creates a local git commit automatically.

2. **Tag the commit:**

   ```bash
   git tag v1.2.3   # match the version you set above
   ```

   Or use `npm version` to do both steps at once:

   ```bash
   npm version patch --no-git-tag-version   # bump only
   git add package.json && git commit -m "chore: release v1.2.3"
   git tag v1.2.3
   ```

3. **Push the commit and the tag:**

   ```bash
   git push origin main
   git push origin v1.2.3
   ```

   Pushing the tag is what triggers the publish workflow. Pushing main alone does nothing.

## How CI picks it up

`.github/workflows/publish.yml` fires on any tag matching `v*`. It:

1. Checks out the repo.
2. Installs dependencies with `pnpm install --frozen-lockfile`.
3. Builds with `pnpm build`.
4. Runs the test suite with `pnpm test`.
5. Publishes with `npm publish --provenance --access public`.

The publish step authenticates via **OIDC Trusted Publishing** — no token or
secret is required. GitHub Actions exchanges an OIDC token directly with npm,
and provenance attestation (`id-token: write`) is included automatically.

## Setting up Trusted Publishing (one-time)

1. Go to `https://www.npmjs.com/package/discoclaw` → **Settings** tab.
2. Under **Trusted Publishers → GitHub Actions**, add a publisher:
   - **GitHub owner:** `DiscoClaw`
   - **Repository:** `discoclaw`
   - **Workflow filename:** `publish.yml`
   - **Environment name:** leave blank
3. Save. No secrets or tokens to create or rotate.

## Verifying the publish succeeded

- **GitHub Actions tab** — the `publish` workflow run should show a green
  checkmark. Expand the `npm publish` step to see the confirmation output.
- **npm registry** — check `https://www.npmjs.com/package/discoclaw` for the new
  version, or run:

  ```bash
  npm view discoclaw version
  ```

- **Provenance** — the package page on npmjs.com will show a "Published via
  GitHub Actions" provenance badge once the attestation is attached.

- **End-to-end test:**

  ```bash
  npx discoclaw@latest init
  ```
