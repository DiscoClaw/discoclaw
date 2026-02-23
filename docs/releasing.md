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

The publish step authenticates using the `NPM_TOKEN` secret and requests an OIDC
provenance attestation (`id-token: write`) so consumers can verify the package
was built by this workflow.

## Setting up the npm token secret

1. Log in to [npmjs.com](https://www.npmjs.com) and go to **Access Tokens** in
   your account settings.
2. Generate a **Granular Access Token** (or a classic Automation token). Scope it
   to the `discoclaw` package with **Read and Publish** permission.
3. In the GitHub repository, go to **Settings → Secrets and variables → Actions**.
4. Create a secret named **`NPM_TOKEN`** and paste the token value.

The workflow reads it as `${{ secrets.NPM_TOKEN }}`.

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
