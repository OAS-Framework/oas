# Schema status

- `TODO(engine-freeze)`: align `oas-package.json` and `schemas/oas-package.schema.json` with the package-engine workstream's frozen manifest schema. The current shape follows the accepted distribution decision.
- `TODO(engine-freeze)`: confirm the flat single-capability declaration (`capabilities: ["."]`) remains supported so the checked root dependency lock materializes the existing escape-free `node_modules/...` skill paths.
- `TODO(engine-freeze)`: replace the inherited `compatibility.oas` value (`>=0.6.2`) in both manifests with the OAS release that ships lockfile v2 and package runtime dependency materialization.
- `TODO(dependency-audit)`: the inherited `@awebai/pi` range currently locks `0.2.3`; npm auto-materializes its pi-coding-agent peer, whose transitive `brace-expansion` triggers GHSA-mh99-v99m-4gvg at high severity. Resolve or explicitly disposition this before publication; do not apply an unreviewed override.
- The acquire → lock → trust → activate → spawn consumer probe remains blocked on the package engine's consumer fixtures.

No publication tag or catalog entry may be created while these items remain open.
