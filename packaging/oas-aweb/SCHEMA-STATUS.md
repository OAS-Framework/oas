# Schema status

- **Frozen schema aligned**: `oas-package.json` validates against the verbatim `docs/oas-package.schema.json` from `feature/package-engine` at `1db919b`; CI runs that validation for every change. It enumerates the nested package-relative capability directory `capabilities/oas-aweb`.
- `TODO(compatibility-floor)`: replace the inherited `compatibility.oas` value (`>=0.6.2`) in both manifests with the OAS release that ships lockfile v2 and package runtime dependency materialization.
- `TODO(package-runtime-closure)`: staging places `package.json` and `package-lock.json` under `capabilities/oas-aweb` and runs `npm ci --ignore-scripts --prefix capabilities/oas-aweb`. This keeps materialized `node_modules` beside the inner manifest, preserves its escape-free resource paths, and leaves the outer test package dependency-free. WS1 is still amending integrity, platform, path-containment, lock-placement, and transactional rollback semantics; revalidate this draft against that contract before consumer probes or publication.
- `TODO(dependency-audit)`: the inherited `@awebai/pi` range currently locks `0.2.3`; npm auto-materializes its pi-coding-agent peer, whose transitive `brace-expansion` triggers GHSA-mh99-v99m-4gvg at high severity. Resolve or explicitly disposition this before publication; do not apply an unreviewed override.
- `TODO(engine-consumer-fixtures)`: run the acquire → lock → trust → activate → spawn probe when package-engine M2 and its fixtures are available.

No publication tag or catalog entry may be created while these items remain open.
