# Schema status

- **Amended schema aligned**: `oas-package.json` validates against the verbatim `docs/oas-package.schema.json` from `feature/package-engine` at `dfa2ae7`; CI runs that validation for every change.
- **Runtime boundary aligned**: harvest uses the frozen structured `oas spawn --json` boundary, dispatch-provided `OAS_SETTINGS`, a capability-defined `memory-harvest` agent, and cleaned-up mode-0600 task files. No private kernel import or `oas root` lookup remains.
- `TODO(engine-consumer-fixtures)`: run the released OAS 0.19.0 three-mode harvest fixture, Pi/Claude scaffold parity, and sub-floor rejection when WS1 fixtures are available.

No publication tag or catalog entry may be created while this item remains open.
