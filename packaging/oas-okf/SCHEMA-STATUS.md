# Schema status

- **Frozen schema aligned**: `oas-package.json` validates against the verbatim `docs/oas-package.schema.json` from `feature/package-engine` at `1db919b`; CI runs that validation for every change.
- `TODO(compatibility-floor)`: replace the inherited `compatibility.oas` value (`>=0.6.2`) in both manifests with the OAS release that ships lockfile v2 and the supported package-runtime boundary.
- `TODO(package-runtime-boundary)`: replace the private `lib/core.mjs` import described in `KERNEL-API-NEEDS.md` before release; the frozen M1 export list does not yet provide the required harvest service.
- `TODO(engine-consumer-fixtures)`: run the acquire → lock → trust → activate → spawn probe when package-engine M2 and its fixtures are available.

No publication tag or catalog entry may be created while these items remain open.
