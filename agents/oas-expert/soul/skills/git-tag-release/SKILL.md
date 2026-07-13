---
name: git-tag-release
description: How to ship a release of the oas-framework packages via the tag-driven CI. Use when publishing a new version of @oas-framework/oas / @oas-framework/pi, cutting a release, "ship an update", bumping the version, or debugging a failed Release workflow run.
---

# Releasing via git tags (oas-framework)

Releases are **tag-driven**: pushing a tag `vX.Y.Z` (on a commit reachable
from `main`) triggers `.github/workflows/release.yml`, which bumps both
packages to X.Y.Z, syntax-checks all shipped `.mjs`, sanity-checks the
tarballs, publishes `@oas-framework/oas` and `@oas-framework/pi` to npm, and
pushes a `release: vX.Y.Z [skip ci]` version-bump commit back to main.

## Procedure

1. **Do NOT bump versions locally.** CI derives the version from the tag and
   runs `npm version X.Y.Z`; if package.json already carries that version,
   CI fails with "Version not changed". Local package.json should still show
   the *previous* released version when you tag.
2. Land the change: commit (signed-off) and `git push origin main`. Bring
   instance memory up to date first (STATE.md, log.md, notes/) per the OKF
   protocol.
3. Pre-flight locally (cheap, catches most CI failures):
   ```bash
   find . -name "*.mjs" -not -path "./node_modules/*" -exec node --check {} \;
   ```
   For changes touching package contents, bin entry points, adapter/kernel
   resolution, or release smoke logic, the smoke must cross the checkout
   boundary: pack both `@oas-framework/oas` and `@oas-framework/pi`, install
   the tarballs in a clean external directory, point the adapter at the
   installed kernel, and run installed CLI/core behavior. Do not substitute a
   repo-local scaffold probe; see
   `knowledge/lessons/package-smoke-tests-cross-checkout-boundary.md`. For
   Pi adapter/resource changes, the real probe must verify an instruction
   marker, a selected skill name, and the absence of an unrelated ambient
   workspace skill; enable at least the read tool so Pi can load skill bodies.
4. Tag and push (v* tags are admin-restricted; pushes show a "Bypassed rule
   violations" notice — that's expected for the admin):
   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
5. Watch CI: `gh run list --limit 2`; on failure
   `gh run view <id> --log-failed`.
6. Confirm publish: `npm view @oas-framework/oas version` (and `/pi`).

## Verify the deployment (mandatory)

Per the lesson `knowledge/lessons/release-verification.md`: probe the
artifact, not the diff.

```bash
TMP=$(mktemp -d)
npm i -g @oas-framework/oas@X.Y.Z --prefix "$TMP/g"
OAS="$TMP/g/bin/oas"
mkdir -p "$TMP/ws/agents" && cd "$TMP/ws"
$OAS init --knowledge oas.okf --messaging none --tasks none
$OAS create probe --description "release probe"
git init -q repo && (cd repo && git commit -q --allow-empty -m init)
$OAS spawn probe --task noop --repo "$TMP/ws/repo" --work checkout --no-launch
$OAS retire probe-1
rm -rf "$TMP"
```

Check the specific change in the generated instance `AGENTS.md` and exact
`.agents/skills/` set while confirming the canonical soul stayed unchanged,
plus `node --check` on every `.mjs` in the installed tree. Adapter/resource
changes also require a real pi session with the matching packed/published
`@oas-framework/pi` loaded explicitly. Do not accept instance `.agents/skills/`
entries that are directory symlinks as sufficient: Pi 0.80.6 did not descend
through those entries during recursive skill discovery, so the runtime probe is
what proves the materialized resource shape works.

## If the run failed

- **"Version not changed"**: you bumped package.json locally. Revert the
  bump on main (commit + push), then re-cut the tag on the fixed commit:
  ```bash
  git push --delete origin vX.Y.Z && git tag -d vX.Y.Z
  git tag vX.Y.Z && git push origin vX.Y.Z
  ```
  Retagging is safe *only while nothing published* — never move a tag whose
  run reached npm publish; cut a new patch version instead.
- **Tag not on main**: CI refuses tags whose commit isn't reachable from
  main. Merge first, then tag.
- **`npm publish` fails with `EOTP`**: the `NPM_TOKEN` is subject to npm
  2FA-on-publish. Create a granular npm access token with read/write access
  for the `@oas-framework` packages/org, update the GitHub Actions secret
  (`gh secret set NPM_TOKEN`), then rerun failed jobs with
  `gh run rerun <id> --failed`. Nothing publishes on EOTP, so the existing
  tag is still safe; repo renames do not matter because npm authority is
  token/account/package-scoped. See
  `knowledge/lessons/npm-eotp-in-tag-release.md`.
- **Publish succeeded for one package only**: cut a new patch release;
  npm versions are immutable.
