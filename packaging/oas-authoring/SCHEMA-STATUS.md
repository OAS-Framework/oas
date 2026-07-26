# Schema status

- **Frozen schema aligned**: `oas-package.json` validates against the verbatim `docs/oas-package.schema.json` from `feature/package-engine` at `1db919b`; CI runs that validation for every change. The schema syntactically permits the flat package-relative capability directory `.` used to keep root `skills/` canonical without parent references.
- `TODO(package-root-capability)`: `capabilities: ["."]` remains pending explicit engine confirmation in the contract addendum. If rejected, mechanically move `oas.json` and all three canonical skills under one nested capability directory; parent-relative skill paths are not an acceptable fallback.
- `TODO(compatibility-floor)`: replace the inherited `compatibility.oas` value (`>=0.6.2`) in both manifests with the OAS release that ships lockfile v2.
- `TODO(engine-consumer-fixtures)`: run the acquire → lock → activate → spawn probe when package-engine M2 and its fixtures are available. This package has no executable surface and should not require `oas trust`.

No publication tag or catalog entry may be created while these items remain open.
