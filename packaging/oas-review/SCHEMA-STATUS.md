# Schema status

- `TODO(engine-freeze)`: align `oas-package.json` and `schemas/oas-package.schema.json` with the package-engine workstream's frozen manifest schema. The current shape follows the accepted distribution decision.
- `TODO(engine-freeze)`: replace the inherited `compatibility.oas` value (`>=0.16.0`) in both manifests with the OAS release that ships lockfile v2.
- The acquire → lock → activate → spawn consumer probe remains blocked on the package engine's consumer fixtures. This package has no commands or hooks, so executable trust is not expected.

No publication tag or catalog entry may be created while these items remain open.
