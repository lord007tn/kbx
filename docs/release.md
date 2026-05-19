# Release Process

This project publishes the `kbx` CLI as the npm package `@kbx/cli` and creates GitHub Releases from Conventional Commits with [antfu/changelogithub](https://github.com/antfu/changelogithub).

## Prerequisites

- Node.js `>=20.19.0` for local development.
- An npm automation or granular publish token saved in the GitHub repository as `NPM_TOKEN`.
- The GitHub repository must be public for npm provenance to be attached during `npm publish --provenance`.
- A clean release branch based on `main`.

## Prepare A Release

1. Update the version in `package.json` and `src/version.ts`.
2. Update `CHANGELOG.md` if there are compatibility notes or release highlights that should remain visible in the repository.
3. Run the full preflight:

```bash
npm run release:preflight
```

4. Commit with Conventional Commit style, for example:

```bash
git commit -m "chore(release): prepare v0.1.0"
```

5. Tag and push the release:

```bash
git tag v0.1.0
git push origin main --tags
```

## Automated Publish

Pushing a `v*` tag triggers `.github/workflows/release.yml`.

The workflow verifies that:

- the tag commit is on `main`;
- the tag version matches `package.json`;
- typecheck, tests, build, package verification, and install smoke tests pass.

If verification passes, the workflow publishes the package to npm using `secrets.NPM_TOKEN` and runs:

```bash
npm run release:github -- --to v0.1.0
```

That command uses the pinned `antfu/changelogithub` npm package from `package-lock.json` to create or update the GitHub Release.

## npm Token Setup

1. Create an npm token that can publish `@kbx/cli`.
2. In GitHub, open the repository settings.
3. Go to **Secrets and variables** -> **Actions**.
4. Add a repository secret named `NPM_TOKEN`.
5. Paste the npm token as the secret value.

Do not commit an `.npmrc` containing the token. The release workflow passes the token only to the publish step through `NODE_AUTH_TOKEN`.

## Failure Handling

- If verification fails, fix the issue on `main`, delete the failed local/remote tag if needed, and create a new tag on the fixed commit.
- Do not publish from an unverified local checkout unless GitHub Actions is unavailable and the release has been approved manually.
- If npm publish succeeds but GitHub release creation fails, rerun only the failed workflow job or run `npm run release:github` with a GitHub token that can create releases.
