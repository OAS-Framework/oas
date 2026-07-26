# Schema status

- **Prepare-only schema snapshot**: the vendored schema currently matches returned package-engine head `dfa2ae7`; re-vendor and revalidate only after WS1 broadcasts the corrected freeze.
- **Runtime closure confirmed**: `capabilities/oas-aweb` is an independent npm-ci unit beside the manifest that resolves `node_modules/...`. Materialization and audit both omit dev/peer dependencies and lifecycle scripts. Kernel lock v2 records and verifies the resulting platform-specific `depsIntegrity`; that digest is kernel-generated trust metadata, not a package source file.
- **Conditional advisory gate**: the full npm peer closure contains high-severity GHSA-mh99-v99m-4gvg under pi-coding-agent. Under the frozen peer-omission contract, `@awebai/pi` stays in the 0.2.x line, all three skills resolve, pi-coding-agent is absent, executable scripts import no omitted peer, and the scoped audit reports zero vulnerabilities. The blocker reactivates if peer materialization is ever required.
- `TODO(engine-consumer-fixtures)`: run the released OAS 0.19.0 acquire → lock → trust → activate → spawn probe when WS1 fixtures are available.

No publication tag or catalog entry may be created while this item remains open.
