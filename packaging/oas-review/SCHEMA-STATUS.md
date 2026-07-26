# Schema status

- **Frozen schema aligned**: `oas-package.json` validates against the verbatim `docs/oas-package.schema.json` from `feature/package-engine` at `1db919b`; CI runs that validation for every change.
- `TODO(compatibility-floor)`: replace the inherited `compatibility.oas` value (`>=0.16.0`) in both manifests with the OAS release that ships lockfile v2.
- `TODO(engine-consumer-fixtures)`: run the acquire → lock → activate → spawn probe when package-engine M2 and its fixtures are available. This package has no commands or hooks, so executable trust is not expected.

No publication tag or catalog entry may be created while these items remain open.
