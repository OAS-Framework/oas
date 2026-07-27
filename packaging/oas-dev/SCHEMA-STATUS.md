# Schema status

- **Corrected schemas verified**: all three vendored schemas are byte-identical to package-engine PR head `b3ac4c6`; CI validates package and capability manifests against them.
- `TODO(dependency-pins)` **explicit publication blocker**: replace all three `TODO(pin-at-publication)` dependency selectors with immutable official release selectors. No consumer probe or publication may run while any placeholder remains. `oas.dev` publishes last, after OKF, aweb, and authoring releases are probe-clean.
- `TODO(engine-consumer-fixtures)`: run the released OAS 0.19.0 profile adoption and capability probe after dependency pins exist. Lock/probe metadata must report distribution `oas.dev@1.0.0` and exported capability `oas.review@1.1.7` separately.
- **Package-local profile method**: until the released resolver fixture is available, tests assert the complete profile shape, required family-to-capability matrix, forbidden deployment-specific fields, and a closer child-repository fixture that disables each inherited layer/capability binding.

No publication tag or catalog entry may be created while either TODO remains open.
