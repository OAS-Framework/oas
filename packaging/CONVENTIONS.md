# Official OAS package repository conventions

Each directory under `packaging/` is staged as the exact root of one future public repository. These conventions apply identically after the directory is transferred to that repository.

## Repository shape

Every repository contains:

- `oas-package.json`, enumerating package resources explicitly;
- one self-contained capability directory explicitly enumerated by `oas-package.json` (normally `capabilities/<name>`; a marked flat `.` layout is used only where root skills/dependency locks must remain escape-free and remains gated on engine confirmation);
- `schemas/oas-package.schema.json` and `schemas/capability-manifest.schema.json`;
- `scripts/validate-manifests.mjs`, including package-path and symlink-containment checks;
- standalone tests under `test/`, runnable with `npm test`;
- `.github/workflows/ci.yml`, `README.md`, `SCHEMA-STATUS.md`, and the identical MIT `LICENSE`;
- package-owned dependency locks where runtime dependencies apply; and
- no deployment targets, secrets, personal paths, generated dependencies, or kernel-hoisted resources.

The package ID equals the single exported capability ID. Package version starts at the extracted capability version. Until the engine freeze, each `SCHEMA-STATUS.md` records `TODO(engine-freeze)` for the outer schema and the real OAS compatibility floor.

## Continuous integration

Each repository's `ci` workflow runs for pull requests and pushes to `main` on Node.js 22 with read-only contents permission. The required job:

1. validates `oas-package.json` against the repository's package schema;
2. validates every enumerated `oas.json` against the capability schema;
3. verifies that all declared resources exist, contain no parent-directory references, and remain inside the package after symlink resolution;
4. runs package-specific unit/smoke tests; and
5. reports the consumer-probe gate as blocked until engine fixtures are frozen.

`oas-aweb` additionally runs `npm ci --ignore-scripts` at its package root, which owns the checked dependency lock, and proves that all three declared skill paths resolve from that materialized `node_modules`. No acquisition or CI step runs npm lifecycle scripts.

## Consumer probe gate

Publication requires a clean fixture that performs the complete consumer flow against the package's declared minimum OAS version:

1. acquire the pinned Git tag;
2. verify package graph and lockfile-v2 integrity;
3. trust only the exported capability when commands or hooks exist;
4. activate the capability for an explicit test soul;
5. spawn scaffold-only probes for both pi and Claude;
6. inspect `instance.json`, exact instance-local skills, generated instructions, layer selection, trust, and hook results; and
7. run `oas doctor` and retire the probes.

This is `BLOCKED(engine-fixtures)` during staging. A workflow echo is a visible placeholder, not a passing consumer probe.

## Release and provenance

No tags are created during staging. After all schema, compatibility, runtime-boundary, and consumer-probe gates pass:

1. update package and capability versions together and commit a clean release tree;
2. create an annotated tag `vX.Y.Z` pointing at that reviewed commit;
3. generate `SHA256SUMS` from tracked release files, excluding `.git`, `node_modules`, and `SHA256SUMS` itself, in bytewise sorted path order:

   ```bash
   LC_ALL=C git ls-files -z | grep -zv '^SHA256SUMS$' \
     | xargs -0 shasum -a 256 > SHA256SUMS
   ```

4. verify the manifest from a clean checkout with `shasum -a 256 -c SHA256SUMS`;
5. publish provenance notes naming the package ID/version, tag, commit SHA, OAS compatibility floor, Node version, workflow run, consumer-probe evidence, dependency-lock/materialization command where applicable, and the `SHA256SUMS` digest; and
6. create a catalog entry only after the immutable tag and clean consumer probe pass.

If the checksum manifest is committed, create the release commit containing it first and tag that exact commit. Never regenerate a checksum manifest against a tree different from the tagged release tree.
