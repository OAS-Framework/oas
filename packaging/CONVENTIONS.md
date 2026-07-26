# Official OAS package repository conventions

Each directory under `packaging/` is staged as the exact root of one future public repository. These conventions apply identically after transfer.

## Repository shape

Every repository contains:

- `oas-package.json`, enumerating package resources explicitly;
- exactly one self-contained capability directory (normally `capabilities/<name>`; the frozen addendum supports `.` for a flat single-capability package);
- byte-identical amended `schemas/oas-package.schema.json`, `schemas/oas-lock.schema.json`, and `schemas/capability-manifest.schema.json`;
- `scripts/validate-manifests.mjs`, including package-path, config-profile, schema, cardinality, and symlink-containment checks;
- standalone tests under `test/`, runnable with `npm test`;
- `.github/workflows/ci.yml`, `README.md`, `SCHEMA-STATUS.md`, and the identical MIT `LICENSE`;
- package-owned dependency locks where runtime dependencies apply; and
- no secrets, personal paths, generated dependencies, deployment accounts, or kernel-hoisted resources.

Every package and capability declares `compatibility.oas: ">=0.19.0"`. The accepted grammar is exactly `>=x.y.z`, `^x.y.z`, or `x.y.z`; missing/free-form compatibility is invalid. Package and capability identity/version are separate: five packages currently share their inner capability identity/version, while `oas.dev@1.0.0` intentionally exports `oas.review@1.1.7` plus a reference config profile.

## Continuous integration

Each repository's `ci` workflow runs for pull requests and pushes to `main` on Node.js 22 with read-only contents permission. The required job:

1. validates `oas-package.json` against the amended package schema;
2. requires exactly one enumerated capability, with negative coverage for missing and extra entries;
3. validates the enumerated `oas.json` and every config profile path;
4. resolves declared resources canonically and proves they remain inside the package after symlink resolution—mere `node_modules` existence is not sufficient;
5. runs package-specific unit/smoke tests; and
6. exposes the released-0.19.0 consumer-fixture gate without pretending a placeholder is a passing probe.

Package/capability directories carrying both `package.json` and `package-lock.json` are independent runtime closure roots. Materialize each with `npm ci --omit=dev --omit=peer --ignore-scripts` (`--no-audit --no-fund` may suppress engine noise); never run lifecycle scripts. Source integrity excludes generated `node_modules`; kernel lock v2 separately records `depsIntegrity` for the materialized closure and trust verifies both digests.

`oas-aweb` owns its closure at `capabilities/oas-aweb`. CI resolves all three skills inside that closure, proves the unused pi-coding-agent peer is absent, rejects executable imports of omitted peers, and requires `npm audit --omit=dev --omit=peer --ignore-scripts` to report zero vulnerabilities.

## Per-repository consumer probe

The binding probe shape is `docs/design/package-runtime-api.md` §1 **Consumer fixture**, combined with the acquire/lock/trust/activate/spawn fixture in the package-engine tests. Against the released OAS 0.19.0 floor, each repository must:

1. acquire a pinned source and verify package graph, source integrity, and any `depsIntegrity`;
2. reject the same package on a kernel below 0.19.0;
3. trust only capabilities with commands/hooks, then activate an explicit test target;
4. scaffold pi and Claude probes and compare exact OAS-managed skills/instructions;
5. inspect `instance.json`, layer selection, provenance, settings, hooks, and trust;
6. run `oas doctor`, then retire every probe; and
7. assert zero lock-v2 `migrationResidue` before catalog/default cutover.

OKF additionally runs its capability-defined harvester in all three source modes: attached local-soul, workspace-mode soul-repository worktree, and attached repo-resident. It verifies parent relation, purpose-derived naming/debounce, dispatch settings, mode-0600 task-file cleanup, schema-v1 success/failure envelopes, and Pi/Claude parity.

These probes remain pending released OAS 0.19.0 consumer fixtures. `oas.dev` additionally waits for immutable dependency selectors and publishes last.

## Release and provenance

No tags are created during staging. After schema, runtime, dependency-pin, and consumer-probe gates pass:

1. update the distribution version and any inner capability version deliberately (they need not be equal), then commit a clean release tree;
2. create an annotated tag `vX.Y.Z` pointing at that reviewed commit;
3. generate `SHA256SUMS` from tracked release files, excluding `.git`, every `node_modules`, and `SHA256SUMS` itself, in bytewise sorted path order:

   ```bash
   LC_ALL=C git ls-files -z | grep -zv '^SHA256SUMS$' \
     | xargs -0 shasum -a 256 > SHA256SUMS
   ```

4. verify from a clean checkout with `shasum -a 256 -c SHA256SUMS`;
5. publish provenance naming package/capability IDs and versions, tag, commit, OAS floor, Node version, workflow run, consumer-probe evidence, dependency materialization/audit command, integrity/`depsIntegrity` evidence, and `SHA256SUMS` digest; and
6. create a catalog entry only after the immutable tag and clean consumer probe pass.

If the checksum manifest is committed, create the release commit containing it first and tag that exact commit. Never regenerate checksums against a tree different from the tagged release tree.
