# Package engine contract (capability materialization, lock v3)

Status: **FROZEN** for the capability-materialization delivery. This document is
the resolver / projection / lock API that the config-and-CLI lane builds
against. It implements the accepted Decision "Packages materialize capabilities
while config templates remain explicitly adopted local policy" (2026-07-29); the
Decision is authoritative where this document is silent. It supersedes the
package-store portions of the previous freeze (lock v2, `.agents/packages/installed/`)
while keeping the source grammar, contained-package-root contract, integrity
discipline and error taxonomy of that freeze intact. Contract changes go through
the coordinator to the maintainer.

Companion machine-readable schemas:

- [`docs/oas-package.schema.json`](../oas-package.schema.json) — `oas-package.json`
- [`docs/oas-lock.schema.json`](../oas-lock.schema.json) — `oas-lock.json` v3 (+ readable v2, v1)

Addendum: [`package-runtime-api.md`](./package-runtime-api.md) — the public
package-runtime CLI boundary, npm runtime closure semantics, incremental
transaction guarantees, and runtime-validated schema invariants.

## 0. The model in one paragraph

A **package** is transport: the source, dependency, integrity, review and atomic
update unit. A **capability** is the installed entity: the versioned, targetable,
activatable, trustable thing a user actually runs. Acquisition stages a package
closure in a temporary transaction directory, validates the whole selected
payload, **materializes** each declared capability into a flat, self-contained
artifact under `.agents/capabilities/installed/<capability-id>/`, writes the
exact v3 lock, and discards staging. There is **no persistent package root** in
final v3 operation. Acquisition activates nothing and trusts nothing. Config
templates are package source material that installation never applies.

## 1. Package source grammar and normalized identity

*(Unchanged from the previous freeze. Restated because the lock's `source` and
`path` fields are parsed against exactly this grammar.)*

A **package source spec** (CLI argument, or an entry in a manifest's
`dependencies[]`) takes one of four forms:

| Form | Examples | Notes |
|---|---|---|
| Shorthand git | `git:github.com/org/repo@v1.2.0#<path>`, `git:host/org/repo@<ref>` | `@ref` and `#<path>` both optional at the CLI; resolved once and exact-locked, never advanced on restore |
| Raw git URL | `https://host/org/repo.git@v1.2.0#dist/oas`, `git@host:org/repo.git@ref#.` | HTTPS or SSH; same `@ref` and `#<path>` rules |
| Local path | `./pkgs/mypkg`, `/abs/path`, `path:./pkgs/mypkg` | development escape hatch; locked with `commit: "local"` and tree integrity; **exact directory** — no `#<path>` and no default-path heuristic |
| Official catalog short ID | `oas.okf`, `oas.okf@v1.4.0` | pattern `^[a-z0-9][a-z0-9._-]*$` with optional `@selector`; resolved through the catalog to a git repo **and its `path`**; takes no `#<path>` |

Manifest `dependencies[]` entries must be pinnable: an official selector, a
pinned git tag/commit (`@ref` required), or a local path. There is **no
general semver solver**.

### 1.1 Contained package root (`path`)

A Git repository is not a package: it *contains* one. The **package root** is
the directory inside the fetched source that carries `oas-package.json`, and it
is selected by the source contract — never hardcoded at a use site:

- **Git specs** select it with a single `#<path>` fragment, split off *before*
  `@ref` parsing so a path can never be mistaken for part of a ref. One
  fragment maximum; a second `#` is `invalid-source`.
- **Catalog entries** carry it as data: `{ url, ref?, path? }`. The catalog
  owns its packages' roots, so an entry may move one (see §4 `updatePackage`).
- **Omitted** on either: the default is **`oas-package`**.
- **Local paths** never take one. `oas install /repo/custom-root` treats that
  exact directory as the package root whatever it is named, and locks `.`.

**Canonical form.** A path is POSIX-relative with no redundant or trailing
separators. Every spelling of the source root (`.`, `./`, `./.`, empty)
normalizes to the single canonical `"."`, so a root selection round-trips
identically through spec → lock → JSON → doctor/list/update. Absolute paths,
Windows drive paths, `~` spellings, backslash separators and NUL are
`invalid-source`; `..` traversal is `path-escape`.

**Resolution and containment.** One exact commit is cloned once; the configured
path is resolved *inside that checkout by realpath*; `oas-package.json` must be
there; and **only that subtree** is staged, hashed and projected. A path that
resolves outside the checkout — through a symlink at any depth — and a broken
link are `path-escape`, decided before any store or lock mutation. Staged
payload bytes therefore equal the selected subtree: repository docs, CI
configuration, owner souls and sibling packages never reach `integrity` and can
never reach an installed artifact. Root source-control metadata (`.git`) is
always stripped on staging, including direct local roots.

One repository may contain several packages selected by different paths. Because
the closure dedupe key is *source **and** selected path*, two contained roots
claiming the same OAS package identity still fail `duplicate-package-identity`.

**Normalized identity** (what dedupe and lock keys use):

- The **package identity** is the `package` field of the staged
  `oas-package.json` — never derived from the source string.
- The **normalized source** recorded in the lock is one of
  `git:<canonical-url>@<ref>`, `path:<dir>`, `catalog:<id>` for an originally
  bare catalog request, or `catalog:<id>@<selector>` for an originally explicit
  selector. The resolved catalog commit is recorded separately in `commit`.
- The **selected package root** is recorded in the lock as its own strict
  `path` field — never folded into the source string, stored in canonical form
  only, never normalized or repaired on read (`invalid-lock` otherwise).
- A lock's `source` is parsed against **exactly** that writer grammar, and
  never carries a `#<path>` fragment. Strictness is load-bearing: `updatePackage`
  and `readLockedConfigTemplates` re-derive a source spec from this string, so a
  payload that merely starts with a known scheme but is invalid for its kind
  (`catalog:../evil`, `path:relative/dir`) would be RECLASSIFIED. Such entries
  are `invalid-lock` at parse, before anything can act on them.

**Catalog resolver boundary**: the catalog is a pure mapping *official short ID
→ git repository (+ optional selector → ref translation, + optional package
root path)*. It authenticates identity and discovery only. It performs **no lock
advancement** and grants **no executable trust**; after catalog resolution the
source behaves exactly like a pinned git source. The engine ships a fixture
catalog for tests.

## 2. Package manifest: what a package must declare

```json
{
  "package": "example.engineering",
  "version": "3.0.0",
  "description": "Shared agent capabilities and workspace defaults.",
  "compatibility": { "oas": ">=0.20.0" },
  "capabilities": ["capabilities/example-review", "capabilities/example-delivery"],
  "configTemplates": {
    "default": { "path": "config-templates/default/oas-config.yaml", "default": true }
  },
  "dependencies": ["oas.okf@v1.4.0"]
}
```

Binding rules (schema + runtime; JSON Schema alone is not complete — see the
addendum §4):

1. **`capabilities` is REQUIRED and non-empty.** Config-only and empty packages
   are rejected: `invalid-package-manifest`. A package's reason to exist is the
   capabilities it materializes.
2. **Dedicated capability roots.** Each entry names a directory carrying one
   `oas.json`. Newly authored packages must not use `"."`; conventional roots
   are `capabilities/<slug>/`.
3. **`configTemplates` is the canonical spelling.** `configs` is accepted as a
   deprecated read-only alias so immutable published 0.19 tags stay consumable
   and migratable. Carrying **both** is `invalid-package-manifest`.
4. **Legacy-format detection is by spelling.** A manifest carrying `configs` is
   a *legacy-format* manifest, and that is the **only** context in which a `"."`
   capability root is accepted. A manifest without `configs` is new-format: a
   `"."` root is `invalid-package-manifest`.
   *(Consequence: `oas install` of an immutable 0.19 `.`-layout package still
   works — that is the compatibility this window exists for — but the projection
   rules of §3 still apply, and a `.` layout that cannot be projected
   self-contained fails rather than degrading.)*
5. **Self-containment.** Everything a capability declares (`skills`, `inject`,
   `commands`, `hooks`, `agents`, and any resource path) must resolve **inside
   that capability's own root** after symlink resolution. A capability reaching
   package-only paths, sibling capabilities, or outside the package is
   `capability-not-self-contained` — it cannot be materialized, and the engine
   fails rather than silently installing a broken artifact.
6. At most one `configTemplates.*.default === true`; `compatibility.oas` is
   required with exactly the grammar `>=x.y.z` / `^x.y.z` / `x.y.z`.
7. Two capability paths in one package exporting the same capability ID is
   `duplicate-capability-id`; two packages at one scope exporting the same
   capability ID is `duplicate-capability-id` with both packages as provenance.

## 3. Store layout and the materialized artifact

```text
<scope>/oas-config.yaml                              zero or one active config
<scope>/oas-lock.json                                lock (v3)
<scope>/.agents/capabilities/.gitignore              contains exactly `installed/`
<scope>/.agents/capabilities/owned/<id>/             authored; normally committed
<scope>/.agents/capabilities/installed/<id>/         MATERIALIZED artifact; ignored
<scope>/.agents/config-templates/adopted/<pkg>/<template>/
                                                     adopted base + adoption.json
                                                     (written by the config lane;
                                                      NEVER ignored)
```

- There is **no `<scope>/.agents/packages/installed/`** in final v3 operation. A
  package checkout exists only inside a transaction staging directory, which is
  created under `.agents/capabilities/installed/.staging-<pid>-<rand>/` (same
  filesystem as the destination, so the commit phase is a rename; already
  gitignored; skipped by discovery because it is dot-prefixed) and removed
  unconditionally when the transaction ends.
- The **materialized artifact** at `installed/<id>/` is the complete validated
  capability root: its `oas.json`, skills, injections, commands, hooks,
  capability-defined agents, and its materialized runtime closure
  (`node_modules`, §6). It additionally carries a generated
  **`.oas-installation.json`** provenance file:

  ```json
  {
    "capability": "example.review", "version": "2.1.0",
    "package": "example.engineering", "packageVersion": "3.0.0",
    "source": "catalog:example.engineering", "commit": "0123…", 
    "packagePath": "oas-package", "capabilityPath": "capabilities/example-review",
    "installedBy": "0.20.0"
  }
  ```

  It is **inside** the hashed tree: tampering with provenance is integrity drift.
  The lock remains authoritative; this file is for inspection and diagnosis.
- **Capability artifact integrity** (`capabilityArtifactIntegrity`) hashes
  **every byte** under the artifact root — no exclusions, including
  `node_modules` and `.oas-installation.json`. It is the only thing executable
  trust binds to, which is why the previous freeze's separate `depsIntegrity`
  binding no longer exists at capability level: the runtime closure is *inside*
  the artifact.
- **Package payload integrity** (`packageIntegrity`) hashes the staged package
  subtree excluding any `node_modules` and a root `oas-lock.json`. It proves the
  distribution bytes and is what bare restore re-verifies before reprojecting.
- `.agents/capabilities/owned/<id>/` and `from: path:<dir>` keep their exact
  current semantics, precedence, and structural trust. `from: installed` means
  the flat installed-capability store regardless of which package supplied it.
- **Git ignore maintenance** (`ensureInstalledGitignore`): at a Git-backed scope
  the engine ensures `.agents/capabilities/.gitignore` contains `installed/`
  **and nothing else it added** — it never writes `owned/` and never touches
  `.agents/config-templates/`. Outside version control it is a no-op returning
  `false`: non-Git scopes use the same layout without fake Git state. It runs
  after the artifact+lock transaction has committed and is **best-effort**: an
  unwritable ignore file never turns a committed transaction into an error.

## 4. Lock v3

```json
{
  "lockfileVersion": 3,
  "packages": {
    "example.engineering": {
      "source": "git:https://example.invalid/engineering.git@v3.0.0",
      "path": "oas-package",
      "version": "3.0.0",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "integrity": "sha256-…",
      "dependencies": ["oas.okf"]
    }
  },
  "capabilities": {
    "example.review": {
      "version": "2.1.0",
      "package": "example.engineering",
      "path": "capabilities/example-review",
      "integrity": "sha256-…",
      "trusted": false
    }
  }
}
```

- Package rows exact-lock the transport unit: `source`, selected package `path`,
  `version`, `commit`, package payload `integrity`, and **package-identity**
  `dependencies`. A package row no longer lists capabilities and no longer
  carries trust: the `capabilities` map's `package` back-reference is the single
  provider truth, so the two levels cannot disagree.
- Capability rows exact-lock the installed entity: `version` (from the
  capability's own `oas.json`), provider `package`, dedicated manifest `path`
  inside that package, materialized artifact `integrity`, and boolean `trusted`
  bound **only** to that capability integrity.
- Semantic invariants validated before any consumption (`invalid-lock`):
  every `capabilities.*.package` is a key of `packages`; every
  `packages.*.dependencies[]` id is a key of `packages`, with no self-dependency
  and no cycle; canonical `path` spellings; `path:` sources require
  `commit: "local"` and `path: "."`; `git:`/`catalog:` require an exact 40-hex
  commit; sha256 digest shapes; array uniqueness; package-identity charset on
  every map key, read into null-prototype maps so raw-JSON
  `__proto__`/`constructor` keys cannot forge entries.
- **v3 has no residue container.** `capabilities` *is* the capability map. A v1
  lock therefore converts to v3 only when every one of its entries converts
  (§7); a scope that cannot fully convert stays v1 and keeps working.

## 5. Exported kernel functions (`lib/core.mjs`)

All functions are runtime-neutral and dependency-free like the rest of the
kernel. Errors are thrown `Error`s carrying `code` (§8) and, where relevant,
`provenance`.

### 5.1 Source, manifest, integrity (unchanged shapes unless noted)

```js
export function parsePackageSource(spec, { baseDir } = {})
export const DEFAULT_PACKAGE_PATH               // "oas-package"
export function normalizePackagePath(raw, opts)
export function inspectGitSourceRoot(spec)
export function resolvePackageRoot(checkout, packagePath, spec)
export function gitCheckoutExactRef(dir, ref, spec)
export function packageIntegrity(dir)           // payload hash; excludes node_modules
export function capabilityArtifactIntegrity(dir) // NEW: materialized artifact hash, no exclusions
export function capabilityIntegrity(dir)         // legacy v1 artifact hash (kept for v1 reads)

/** Load + validate an oas-package.json against §2. Returns the manifest plus
 * _dir, _legacyFormat (true when the deprecated `configs` spelling was used),
 * _configTemplates (normalized {name: {path, description?, default?}} from
 * either spelling), and
 * _capabilities: [{ id, rel, dir, manifest }].
 * @throws "invalid-package-manifest", "path-escape", "duplicate-capability-id",
 *         "retired-capability"
 */
export function loadPackageManifestAt(pdir)

/** Assert a capability root can be materialized self-contained: every declared
 * resource exists and resolves (after symlink resolution, recursively through
 * contained directory links) inside `capDir`.
 * @throws "capability-not-self-contained", "path-escape"
 */
export function assertCapabilitySelfContained(capDir, manifest)
```

### 5.2 Locks

```js
/** THE strict lock reader/validator for v1, v2 AND v3. Returns
 * { version, packages, capabilities, legacy } or null when the file is absent.
 * Every violation is a typed invalid-lock with file/package provenance. Old
 * locks are read as they are — never normalized, repaired or rewritten.
 */
export function parseLockFileStrict(file)

/** Read every lock visible from a directory (config-chain levels PLUS any
 * ancestor owning an oas-lock.json), closest scope wins per identity.
 * SOLE strict reader; consumers never see an invalid lock as absent or usable.
 * @returns {{
 *   packages: Record<pkgId, PackageRow & { _file, _level, _lockfileVersion }>,
 *   capabilities: Record<capId, CapabilityRow & { _file, _level }>, // v3 only
 *   legacy: Array<{ file, level, lockfileVersion, capabilities }>,  // v1 files + v2 residue
 *   migration: Array<{ file, level, lockfileVersion, kind: "v1"|"v1-empty"|"v2"|"v2-residue",
 *                      packages: string[], capabilities: string[] }>
 * }}
 *   // `migration` is provenance ONLY: it says which scopes still need an
 *   // explicit conversion and what they hold. Reading never converts anything.
 *   // v2 package rows appear in `packages` tagged _lockfileVersion: 2 so doctor
 *   // can diagnose them; they carry v2 fields (capabilities[],
 *   // trustedCapabilities[], depsIntegrity) and MUST NOT be treated as v3.
 */
export function readPackageLocks(startDir)

/** Write/replace (entry) or delete (entry === null) one v3 package row.
 * Validates the COMPLETE prospective document before writing. Refuses a v1/v2
 * file: code "legacy-lock" (migrate first). An absent file, or an empty v1
 * file ({} / {capabilities:{}}), is treated as a fresh v3 document.
 * @returns {string} lock file path
 */
export function writePackageLock(levelDir, packageId, entry)

/** Same, for one v3 capability row. */
export function writeCapabilityLockEntry(levelDir, capabilityId, entry)

/** Semantic validation of one v3 row against the whole document (§4). */
export function validateLockEntry(packageId, entry, allPackages, opts)
export function validateCapabilityLockEntry(capabilityId, entry, allPackages, opts)
```

### 5.3 Acquisition and projection

```js
/** Stage → validate → materialize → lock → discard staging, at one scope.
 *
 * Fetches the root source and the whole dependency closure into a temporary
 * staging directory; validates every manifest (§2), detects cycles, identity
 * collisions and capability-ID collisions (within the closure, and against
 * capabilities already locked at this scope by packages outside it); asserts
 * every capability is self-contained; materializes each capability's runtime
 * closure IN STAGING; then atomically swaps every projected artifact into
 * `.agents/capabilities/installed/<id>/` and writes the v3 lock. On any failure
 * before the swap, the store and lock are byte-identical to the pre-operation
 * state. Staging is always removed.
 *
 * ACTIVATES NOTHING and TRUSTS NOTHING: `trusted` is false for every capability
 * whose artifact integrity is not byte-identical to the one already locked.
 *
 * @param {string} levelDir  scope directory owning the store + lock
 * @param {string} spec      package source spec
 * @param {{ catalog?, replace?: boolean, expectPackage?: string, rootSnapshot? }} [opts]
 * @returns {{
 *   root: string,                       // root package identity
 *   lockFile: string,
 *   installed: Array<{ package, version, source, path, commit, integrity,
 *                      dependencies: string[], capabilities: string[], kept: boolean }>,
 *   capabilities: Array<{ capability, version, package, path, integrity, dir,
 *                         trusted: boolean, status: "installed"|"replaced"|"kept",
 *                         executableSurface: { commands: string[], hooks: string[] } }>,
 *   configTemplates: Array<{ package, template, path, description?, default: boolean,
 *                            content: string, contentIntegrity: string,
 *                            legacySpelling: boolean }>
 * }}
 *   // `configTemplates` carries VALIDATED descriptors AND payload bytes read
 *   // from staging before it is discarded, so the config lane can offer/adopt a
 *   // template inside the same transaction without a second fetch. Acquisition
 *   // itself applies none of them.
 * @throws "invalid-source", "invalid-package-manifest", "path-escape",
 *         "capability-not-self-contained", "dependency-cycle",
 *         "duplicate-package-identity", "duplicate-capability-id",
 *         "incompatible-oas", "integrity-drift", "legacy-lock", "invalid-lock"
 */
export function acquirePackage(levelDir, spec, opts)

/** Bare restore from a v3 lock, for every visible lock-owning scope.
 *
 * Preflight parses and caches the COMPLETE visible chain before any fetch,
 * staging or swap. Per capability: a present artifact whose integrity equals the
 * locked integrity is `ok`. Otherwise the provider package's EXACT locked
 * provenance (source + commit + path) is fetched once per package into staging,
 * its payload integrity is verified against the package row, the capability is
 * reprojected, its artifact integrity is verified against the capability row,
 * and only then swapped in. NEVER advances source/version/commit/path, never
 * changes `trusted`, never converts a lock. v1/v2 scopes are reported as
 * `legacy` with their migration action.
 *
 * @returns {Array<{ package?, capability?, level, status:
 *   "ok"|"restored"|"failed"|"legacy", dir?, reason?, code? }>}
 * @throws "invalid-lock" (preflight, before any mutation)
 */
export function restorePackages(startDir, opts)

/** Derive the package/provider view from the v3 lock + the flat capability
 * store — NOT from a package root (there is none). Closest scope wins per
 * package identity; two same-scope packages claiming one capability ID is
 * duplicate-capability-id.
 * @returns {Array<{ package, version, level, source, path, commit, integrity,
 *   dependencies: string[], lockfileVersion: 3,
 *   capabilities: Array<{ id, version, path, dir, integrity, trusted,
 *                         installed: boolean, manifest? }> }>}
 *   // `installed:false` + absent `manifest` = locked but not materialized —
 *   // exactly what a bare `oas install` repairs. It is reported, never hidden.
 */
export function listInstalledPackages(startDir)

/** Path of a materialized capability artifact at a scope. */
export function installedCapabilityDir(levelDir, capabilityId)
export const CAPABILITY_INSTALLATION_FILE   // ".oas-installation.json"
```

### 5.4 Trust

```js
/** Is this capability's executable surface approved at its CURRENT materialized
 * artifact integrity? Two call shapes (unchanged):
 *   capabilityTrust(startDir, capabilityId)   // contract shape
 *   capabilityTrust(manifest, startDir)       // internal resolver/dispatch shape
 * @returns {{ trusted, package, integrity, executableSurface: { commands, hooks },
 *             reason? }}
 */
export function capabilityTrust(a, b)

/** Approve executable surfaces at exactly the current artifact integrity.
 * Per-capability by default; `allCapabilities` treats `id` as a PACKAGE identity
 * and approves every capability that package currently supplies (the caller must
 * have displayed the full executable-surface summary first). Writes
 * `trusted: true` on the capability rows. Non-executable capabilities need no
 * approval (no-op, reported in `skipped`). Official identity grants nothing.
 * @throws "unknown-capability", "integrity-drift", "invalid-lock"
 */
export function approveCapability(levelDir, id, { allCapabilities } = {})
```

### 5.5 Update and remove

```js
/** Transactional update of one package: re-resolve the closure from the row's
 * ORIGINAL spec (or opts.spec), validate everything in staging, then replace
 * ALL of that package's exported capability artifacts and lock rows together.
 *
 * - Every export is validated and replaced atomically — never a partial set.
 * - Trust is preserved ONLY for capabilities whose new artifact integrity is
 *   byte-identical to the locked one; any change sets `trusted: false`.
 * - Exports that no longer exist are removed ONLY when safe: no config in the
 *   chain references them and no other locked package depends on the provider.
 *   Otherwise the whole update fails `remove-blocked` with the blockers.
 * @returns {{ package, level, changed, pathChanged, before, after, installed,
 *   capabilities, configTemplates, addedCapabilities, removedCapabilities,
 *   retiredArtifacts, invalidatedApprovals }}
 */
export function updatePackage(startDir, packageId, opts)

/** Remove one locked package and every capability artifact it supplied.
 * Refuses (`remove-blocked`, with provenance) while another locked package in
 * the TARGET ENTRY'S OWN scope map depends on it, or any config in the chain
 * references one of its capabilities. Transactional: artifacts move to a
 * backup, lock rows are removed, and both sides roll back on failure.
 */
export function removePackage(startDir, packageId)
```

### 5.6 Config templates (read-only, exact-locked)

```js
/** Read config templates from the EXACT currently locked source of one package
 * — the config lane's `oas config diff` / `oas config sync` / `oas config adopt`
 * input.
 *
 * Stages the locked source (source + commit + path) in a temp directory,
 * validates the manifest, verifies the payload integrity against the package
 * row, reads the requested template bytes, and removes staging. It NEVER
 * persists a package root, never exposes a path into one, never mutates the
 * lock or the capability store, and never advances anything.
 *
 * @param {string} startDir
 * @param {string} packageId
 * @param {{ template?: string, catalog? }} [opts]  template omitted = all of them
 * @returns {{ package, source, version, commit, path, integrity,
 *   templates: Array<{ template, path, description?, default: boolean,
 *                      content: string, contentIntegrity: string }> }}
 *   // `integrity` is the package PAYLOAD integrity, verified equal to the lock;
 *   // `contentIntegrity` is the sha256 of the template bytes themselves.
 * @throws "unknown-capability" (no such locked package), "invalid-lock",
 *         "integrity-drift", "invalid-package-manifest", "invalid-source",
 *         "unknown-config-template"
 */
export function readLockedConfigTemplates(startDir, packageId, opts)
```

### 5.7 Migration

```js
/** Plan the conversion of one scope's lock to v3. PURE — applies nothing.
 *
 * v1 sources: `marketplace:` entries map through the catalog (aliases first,
 * then identity); `git:`/`path:` entries map to package specs when the source
 * really is a package. Anything unmappable makes the SCOPE unconvertible —
 * v3 has no residue container — so it is reported as `hold`/`manual` and the
 * scope stays v1.
 * v2 sources: every locked package row is projected. When the installed package
 * root is present and its integrity matches the row, projection uses those
 * EXACT bytes and performs NO network access; otherwise the exact locked source
 * is re-fetched.
 *
 * @returns {{ from: 1|2|3, convertible: boolean,
 *   plan: Array<{ capabilityId?, package?, v1?, v2?, source?, spec?,
 *                 action: "acquire"|"project-local"|"refetch"|"convert-format"
 *                       |"hold"|"manual"|"keep-owned" , reason? }>,
 *   warnings: string[] }}
 */
export function migrateLegacyLock(levelDir, opts)

/** Apply that plan, transactionally.
 *
 * - Conversion is explicit and all-or-nothing per scope.
 * - v2: capabilities are projected from already-locked bytes without network
 *   when available; `trustedCapabilities` carries over to `trusted` ONLY for
 *   capabilities projected from LOCAL bytes whose package integrity matched the
 *   v2 lock (same bytes the user approved — never a broadening); a capability
 *   that had to be re-fetched lands untrusted.
 * - `.agents/packages/installed/` is removed only AFTER the v3 artifacts and
 *   lock are durable.
 * - Any failure restores the prior lock BYTE-IDENTICALLY, removes everything the
 *   conversion created, and leaves the old store untouched.
 * - Owned/path capabilities are not touched.
 * @returns {{ from, migrated, residue, skipped?, removedStore?, warnings, file, trust }}
 * @throws "official-mapping-unavailable", "legacy-lock", "invalid-lock", …
 */
export function applyLegacyLockMigration(levelDir, opts)
```

## 6. Runtime closure in the materialized model

The npm rules of the addendum §2 are unchanged in kind and change in *placement*:

- **Materialization roots are the declared CAPABILITY roots**, each carrying
  both `package.json` and `package-lock.json`. A package-root-only closure has
  no durable home in v3 and is **not** materialized — it is package tooling. If a
  capability actually needs it, self-containment (§2.5) fails and the package is
  rejected: that is the "fail rather than silently retain package-only paths"
  rule. (For a legacy `.` capability root, capability root == package root, so
  the package-root closure *is* the capability closure.)
- `npm ci --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund` only;
  no npm lifecycle scripts ever run, at any phase.
- Transaction-wide platform-invariance preflight over EVERY materialization
  root's lockfile **before** any `npm ci`; post-materialization `.node` native
  binary scan and symlink containment (every link under every materialized
  `node_modules` must realpath-resolve inside the **capability artifact root**)
  **before** any digest or swap.
- Materialization happens **in staging**; a failure fails the whole transaction
  with the store and lock unchanged.
- The closure is inside the artifact, so it is covered by the capability's
  `integrity` — there is no separate `depsIntegrity` at capability level.
  Tampering with a materialized dependency invalidates `trusted` exactly like
  source drift, and bare restore reprojects it.

## 7. Compatibility and migration

The kernel continues to **read**:

- valid v1 capability locks and their `.agents/capabilities/installed/` artifacts
  (legacy standalone-capability restore and trust keep working unchanged);
- valid v2 package locks and their `.agents/packages/installed/` roots; and
- immutable package manifests using `configs` or a `"."` capability root.

The kernel **writes** only v3. Conversion is explicit (`oas migrate`),
transactional and all-or-nothing per scope; a failed conversion leaves the prior
lock and store byte-identical; unmappable v1 scopes stay v1 and keep working;
owned/path capabilities are unchanged; and executable trust is never broadened.

## 8. Error taxonomy

Stable `error.code` values (also the `--json` envelope codes):

| code | Meaning |
|---|---|
| `invalid-source` | source spec parses to none of the four grammar forms |
| `invalid-package-manifest` | `oas-package.json` missing/invalid against §2, or a declared path does not identify the expected resource kind |
| `path-escape` | a declared path resolves outside its containment root after symlink resolution (package root when staging, capability root when projecting, artifact root at runtime) |
| `capability-not-self-contained` | **new** — a declared capability cannot be materialized as a self-contained artifact (a declared resource resolves outside its capability root, or is missing) |
| `dependency-cycle` | package dependency graph contains a cycle (provenance: the cycle path) |
| `duplicate-package-identity` | two sources claim the same package identity at one scope (provenance: both sources) |
| `duplicate-capability-id` | two packages export the same capability ID at one scope, or one package exports it twice (provenance: both) |
| `integrity-drift` | staged/installed bytes ≠ locked integrity (package payload or capability artifact), or a trust operation against a drifted artifact |
| `capability-list-mismatch` | a locked capability's provider package no longer exports it at the locked path |
| `incompatible-oas` | `compatibility.oas` floor not met by the running kernel |
| `retired-capability` | a package exports / config references a capability the kernel has retired |
| `legacy-lock` | operation requires lockfileVersion 3 but the scope has v1 or v2 — run the migration command |
| `invalid-lock` | lock violates the semantic invariants of §4 — fail closed, no normalization, no auto-repair |
| `unknown-capability` | trust/update/remove/template target is not present in the visible locks |
| `unknown-config-template` | the package has no config template by that name |
| `remove-blocked` | removal target is still referenced by config or by a dependent locked package (provenance: the blockers) |
| `official-mapping-unavailable` | guided official migration cannot map a legacy official capability yet; the scope was left unchanged |

Fail-closed enforcement points: `readPackageLocks`, `listInstalledPackages` and
`parseLockFileStrict` RAISE — consumers never see an invalid lock as absent or
usable data; the writers validate the complete prospective document before
writing; restore, trust queries, approval, update/remove/migration planning and
the template reader all validate before acting. Doctor is the only consumer that
continues past an invalid lock, and it never uses the invalid data.

## 9. Invariants (restated from the Decision — binding)

- Acquisition activates nothing, targets nothing and trusts nothing.
- Every exported capability stays independently addressable, targetable,
  activatable, configurable, excludable and trustable by capability ID;
  capability manifests still cannot carry deployment targets; packages cannot
  make capabilities, family assignments or settings mandatory.
- Package installation applies **no** config template and creates **no** active
  config. Templates are reported as optional follow-ups.
- A materialized capability is self-contained: its complete validated local
  production closure and every declared artifact, with all paths and symlinks
  inside the capability root after resolution.
- Trust binds to capability artifact integrity, never to package identity;
  official catalog identity is not executable approval; any artifact change
  resets `trusted` to false.
- No silent lock advancement anywhere: bare restore never changes
  source/version/commit/path; only an explicit `oas update <package-id>` may.
- No npm lifecycle scripts, ever; production closure only; platform-invariant
  closures required in v1.
- Existing config targeting / layer / injection / override / scope-precedence
  semantics are unchanged, including `from: installed`, `from: owned`,
  `from: path:<dir>`, `none` for inherited layers, and injection ejection.
- `.agents/capabilities/owned/<id>` and `from: path:<dir>` capability development
  are untouched by package paths and keep their existing structural/executable
  trust, targeting, override and composition semantics.
- Git-backed scopes ignore `installed/` only; `owned/` and adopted config-template
  data are never ignored. Non-Git scopes work without fake Git state.
