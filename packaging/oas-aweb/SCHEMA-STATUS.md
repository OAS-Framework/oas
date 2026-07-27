# Schema status

- **Corrected schemas verified**: all three vendored schemas are byte-identical to package-engine PR head `b3ac4c6`; CI validates package and capability manifests against them.
- **Vendored-skills decision**: the original `@awebai/pi` npm closure was superseded because its direct `@awebai/aw` dependency carries an install script and platform-specific optional binaries, invalid under v1 platform-invariance. The three required MIT skill trees are now reviewed package-owned resources synchronized from `https://github.com/awebai/aweb.git`, tag `pi-v0.2.3`, commit `812bdeb1be8ed99dbd339a910a153e7b802501d4`; `skills/VENDORED.md`, the upstream `LICENSE`, and the deterministic sync script preserve provenance.
- **No npm runtime closure**: no runtime dependency manifest, npm lock, or `node_modules` exists in the package. GHSA-mh99-v99m-4gvg is outside this package's source/runtime closure; source integrity covers the vendored skill bytes and no `depsIntegrity` is expected.
- `TODO(engine-consumer-fixtures)`: run the released OAS 0.19.0 acquire → lock → trust → activate → spawn probe when WS1 fixtures are available.

No publication tag or catalog entry may be created while this item remains open.
