# Schema status

- `TODO(engine-freeze)`: align `oas-package.json` and `schemas/oas-package.schema.json` with the package-engine workstream's frozen manifest schema. The current shape follows the accepted distribution decision.
- `TODO(engine-freeze)`: replace the inherited `compatibility.oas` value (`>=0.6.2`) in both manifests with the OAS release that ships lockfile v2.
- The acquire → lock → trust → activate → spawn consumer probe remains blocked on the package engine's consumer fixtures.

No publication tag or catalog entry may be created while these items remain open.
