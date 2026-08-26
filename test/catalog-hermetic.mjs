/**
 * Offline determinism for the CLI test suite.
 *
 * From v0.21 the official package catalog is resolved from the OAS repo on
 * GitHub at resolution time, so any spawned CLI that reaches a catalog-consuming
 * command would go to the network. `OAS_PACKAGE_CATALOG` is the documented
 * hermetic escape hatch: it names a local FILE and suppresses the remote fetch
 * entirely. Every CLI-spawning test therefore binds a catalog file explicitly —
 * a fixture where the test has one, and otherwise this repository's own bundled
 * `package-catalog.json`, which is byte-for-byte what those runs already read.
 */
import { fileURLToPath } from "node:url";

/** This repository's bundled catalog — what a CLI spawned from this checkout
 * read before the remote contract existed, and what it must keep reading in
 * tests that do not bind a fixture of their own. */
export const BUNDLED_CATALOG = fileURLToPath(new URL("../package-catalog.json", import.meta.url));

/** Bind the bundled catalog for tests that spawn the CLI with the ambient
 * environment. Never overrides a catalog the runner already chose. */
export function pinAmbientCatalog() {
  if (!process.env.OAS_PACKAGE_CATALOG) process.env.OAS_PACKAGE_CATALOG = BUNDLED_CATALOG;
  return process.env.OAS_PACKAGE_CATALOG;
}
