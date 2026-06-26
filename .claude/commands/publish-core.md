# /publish-core - Publish Run402 Core packages to npm via OIDC

Trigger the canonical publish pipelines in this repo:

| Package | Workflow | Tag |
|---|---|---|
| `@run402/functions` | `.github/workflows/publish-functions.yml` | `v<version>-functions` |
| `@run402/release` | `.github/workflows/publish-release.yml` | `v<version>-release` |
| `@run402/runtime-kernel` | `.github/workflows/publish-runtime-kernel.yml` | `v<version>-runtime-kernel` |

These workflows own the full release lifecycle: version bump, lockfile update, build/test/smoke, OIDC-authenticated `npm publish --provenance`, version-bump commit-back to `main`, tag, GitHub release, and workflow summary.

Do not publish locally with `npm publish`. The trust model is npm Trusted Publisher: `kychee-com/run402-core` + `main` + the exact workflow filename.

## When to publish

- `@run402/functions`: in-function helper API/types/runtime changed.
- `@run402/release`: ReleaseSpec canonicalization, materialization, diffing, schemas, or compatibility fixtures changed.
- `@run402/runtime-kernel`: public Core runtime contracts, capabilities, gateway-facing services, storage, functions, archive import/export, or adapter-facing behavior changed.

If `@run402/functions` or `@run402/release` changed and runtime-kernel should consume it, publish the dependency first, then commit a runtime-kernel dependency bump to the exact published version, then publish runtime-kernel.

## Pre-flight

Run from the repo root.

1. Verify local `main` is exactly synced with `origin/main`:
   ```bash
   git branch --show-current
   git fetch origin main
   git rev-list --count HEAD..origin/main
   git rev-list --count origin/main..HEAD
   git status --short
   ```
   Stop if not on `main`, behind/ahead, or dirty. The workflow builds from `origin/main`; unpushed or uncommitted work would be invisible.

2. Run local checks:
   ```bash
   npm run lint
   npm run build
   npm test
   ```

3. Run relevant package smoke checks:
   ```bash
   npm run test:functions:smoke
   npm run test:release:smoke
   npm run core:boundary
   ```

4. If a workflow previously failed with `ENEEDAUTH`, `E401`, or `E403`, confirm npm Trusted Publisher on the package access page:
   - Owner/repo: `kychee-com/run402-core`
   - Branch: `main`
   - Workflow filename: package workflow above
   - Environment: empty

## Choose bump

Ask the user for `patch`, `minor`, or `major` unless they already specified it.

- Patch: bug fix or internal packaging change.
- Minor: new backwards-compatible public surface/capability.
- Major: breaking public contract change.

## Trigger

Use `tag=latest` unless the user asks for another dist-tag.

```bash
gh workflow run publish-functions.yml --repo kychee-com/run402-core --ref main -f bump=patch -f tag=latest -f dry_run=false
gh workflow run publish-release.yml --repo kychee-com/run402-core --ref main -f bump=patch -f tag=latest -f dry_run=false
gh workflow run publish-runtime-kernel.yml --repo kychee-com/run402-core --ref main -f bump=patch -f tag=latest -f dry_run=false
```

Dry-run example:

```bash
gh workflow run publish-runtime-kernel.yml --repo kychee-com/run402-core --ref main -f bump=patch -f tag=latest -f dry_run=true
```

## Watch

```bash
RUN_ID=$(gh run list --repo kychee-com/run402-core --workflow publish-runtime-kernel.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --repo kychee-com/run402-core --exit-status
```

Use the workflow name matching the package being published.

## Verify

After the workflow succeeds:

1. Get the new version from the workflow summary or package `package.json` after pulling.
2. Verify registry state with direct `curl`:
   ```bash
   curl -sS "https://registry.npmjs.org/@run402/runtime-kernel/<new_version>" | jq -r .version
   curl -sS "https://registry.npmjs.org/@run402/runtime-kernel/<new_version>" | jq '.dist.attestations'
   ```
   Expected: exact version and non-null attestations.
3. Pull the bump commit and tags:
   ```bash
   git pull --rebase origin main
   git fetch --tags
   ```
4. If Run402 Cloud consumes the package, update `/Users/talweiss/Developer/run402-private/packages/gateway/package.json`, run the private boundary tests, commit, and push.

## Troubleshooting

- Auth failure at publish: fix npm Trusted Publisher metadata or workflow metadata. Do not fall back to local publish.
- Published version but commit/tag failed: npm is immutable. Commit the exact published version to `main`, add the matching tag, and create the GitHub release.
- Already-published version: cut the next patch. Never overwrite npm.
- `npm view` looks stale: use direct `curl`; local npm may be date-pinned.
