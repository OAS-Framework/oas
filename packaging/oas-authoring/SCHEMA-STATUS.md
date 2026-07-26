# Schema status

- **Corrected schemas verified**: all three vendored schemas are byte-identical to package-engine head `19fbc86`; CI validates package and capability manifests against them.
- **Flat root supported**: the frozen runtime addendum explicitly supports `capabilities: ["."]`; root `oas.json` and the three canonical root skills are final.
- `TODO(engine-consumer-fixtures)`: run the released OAS 0.19.0 acquire → lock → activate → spawn probe when WS1 fixtures are available. This package has no executable surface and should not require `oas trust`.

No publication tag or catalog entry may be created while this item remains open.
