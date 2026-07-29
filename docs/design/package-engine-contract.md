# Package engine contract (capability materialization, lock v2)

Status: **FROZEN** for the capability-materialization delivery. This document is
the resolver / projection / lock API that the config-and-CLI lane builds
against. It implements the accepted Decision "Packages materialize capabilities
while config templates remain explicitly adopted local policy" (2026-07-29) as
amended by the founder's simplification ruling: the capability-materialization
`{ packages, capabilities }` lock **replaces** the earlier package-root
`lockfileVersion: 2` in place and **remains `lockfileVersion: 2`**. There is no
lock v3, and there is no compatibility path or migration for the earlier
transitional v2 shape — it is unsupported input, rejected rather than converted.
Contract changes go through the coordinator to the maintainer.

Companion machine-readable schemas:

- [`docs/oas-package.schema.json`](../oas-package.schema.json) — `oas-package.json`
- [`docs/oas-lock.schema.json`](../oas-lock.schema.json) — `oas-lock.json` v2 (+ readable, usable v1)

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
exact lock, and discards staging. There is **no persistent package root**.
Acquisition activates nothing and trusts nothing. Config templates are package
source material that installation never applies.

## 1. Package source grammar and normalized identity

*(Unchanged. Restated because the lock's `source` and `path` fields are parsed
against exactly this grammar.)*

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
  owns its packages' roots, so an entry may move one (see §5.5 `updatePackage`).
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
   `oas.json`. Authoring never emits `"."`; conventional roots are
   `capabilities/<slug>/`.
3. **`configTemplates` is the canonical spelling and is OPTIONAL.** A package
   that ships no template is perfectly valid — installation is about
   capabilities. `configs` is accepted as a deprecated read-only alias so
   immutable published tags stay consumable; both spellings normalize to one
   descriptor shape carrying a diagnostic `legacySpelling`. Carrying **both** is
   `invalid-package-manifest`.
4. **Legacy `"."` capability roots are read compatibility, and the discriminator
   is `configTemplates` — never `configs`.** Published packages exist with a
   `"."` root and *no* template map at all (`oas.authoring@1.0.0` is
   `capabilities: ["."]` with neither spelling), so keying acceptance on
   `configs` would strand them. The rule is therefore:
   - a manifest **without** `configTemplates` may declare `"."` — the
     compatibility reader accepts it and projects it;
   - a manifest **with** `configTemplates` is unambiguously new, and `"."` is
     `invalid-package-manifest`;
   - authoring tooling rejects and never emits `"."` regardless.
   `"."` remains exclusive with any other capability path (it would nest one
   capability inside another).
5. **Self-containment.** Everything a capability declares (`skills`, `inject`,
   `commands`, `hooks`, `agents`) must exist and resolve **inside that
   capability's own root** after symlink resolution. A capability reaching
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
<scope>/oas-lock.json                                lock (v2)
<scope>/.agents/capabilities/.gitignore              contains exactly `installed/`
<scope>/.agents/capabilities/owned/<id>/             authored; normally committed
<scope>/.agents/capabilities/installed/<id>/         MATERIALIZED artifact; ignored
<scope>/.agents/config-templates/adopted/<pkg>/<template>/
                                                     adopted base + adoption.json
                                                     (written by the config lane;
                                                      NEVER ignored)
```

- There is **no `<scope>/.agents/packages/`** in this model at all. A package
  checkout exists only inside a transaction staging directory, which is created
  under `.agents/capabilities/installed/.staging-<random>/` (same filesystem as
  the destination, so the commit phase is a rename; already gitignored; skipped
  by discovery because it is dot-prefixed) and removed unconditionally when the
  transaction ends.
- The **materialized artifact** at `installed/<id>/` is the complete validated
  capability root: its `oas.json`, skills, injections, commands, hooks,
  capability-defined agents, and its materialized runtime closure
  (`node_modules`, §6). It additionally carries a generated
  **`.oas-installation.json`** provenance file.

### 3.1 `.oas-installation.json` — deterministic, replayable provenance

The file is **inside** the hashed tree, so tampering with it is integrity drift.
That is only sound if a future kernel reprojecting the same locked bytes
produces the same file, so it contains **nothing about the writing kernel** —
only lock-, source- and manifest-derived values:

```json
{
  "schemaVersion": 1,
  "capability": "example.review",
  "version": "2.1.0",
  "package": "example.engineering",
  "packageVersion": "3.0.0",
  "source": "catalog:example.engineering",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "packagePath": "oas-package",
  "capabilityPath": "capabilities/example-review"
}
```

Binding serialization: exactly these keys, in exactly this order,
`JSON.stringify(obj, null, 2)` plus a single trailing `"\n"`, written with mode
`0o644`. `schemaVersion` is a constant of the format, bumped only by an explicit
contract change (which is itself an integrity change, so it is visible). Every
field must agree with the lock rows it was projected from; a disagreement is
`invalid-lock` at read time, and a modified file is `integrity-drift`. Bare
restore under a newer kernel therefore reproduces the identical artifact hash.

### 3.2 Integrity boundaries

- **Capability artifact integrity** (`capabilityArtifactIntegrity`) hashes
  **every byte** under the artifact root — no exclusions, including
  `node_modules` and `.oas-installation.json`. It is the only thing executable
  trust binds to; the runtime closure is *inside* the artifact, so there is no
  separate dependency digest anywhere in this model.
- **Package payload integrity** (`packageIntegrity`) hashes the staged package
  subtree excluding any `node_modules` and a root `oas-lock.json`. It proves the
  distribution bytes and is what bare restore re-verifies before reprojecting.
- `.agents/capabilities/owned/<id>/` and `from: path:<dir>` keep their exact
  current semantics, precedence, and structural trust. `from: installed` means
  the flat installed-capability store regardless of which package supplied it.

### 3.3 Git ignore maintenance is part of the transaction

`ensureInstalledGitignore` is **not** post-commit convenience. At a Git-backed
scope the engine **preflights** `.agents/capabilities/.gitignore` before any
authoritative mutation: it snapshots the prior bytes (or the file's absence),
ensures the file contains `installed/`, and if it cannot do so **fails before
any artifact or lock mutation**. If the transaction later fails, the ignore
bytes are rolled back with everything else. It writes `installed/` and nothing
else: `owned/` holds authored capabilities and
`.agents/config-templates/adopted/` holds portable adopted bases, and neither is
ever ignored or touched. Outside version control it is a no-op: a non-Git scope
uses the same layout without pretending Git owns its durability.

The engine owns this for acquire, restore, update and v1 migration. The CLI lane
keeps its own outer rollback journal and snapshots the prior ignore state
alongside its other state; no engine transaction handle or callback is exchanged.

## 4. Lock v2 (capability materialization)

```json
{
  "lockfileVersion": 2,
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

- Both top-level maps are **required**. `packages` rows exact-lock the transport
  unit: `source`, selected package `path`, `version`, `commit`, package payload
  `integrity`, and **package-identity** `dependencies` — always present, an
  empty array when there are none. `capabilities` rows exact-lock the installed
  entity: `version` (from the capability's own `oas.json`), provider `package`,
  dedicated manifest `path` inside that package, materialized artifact
  `integrity`, and boolean `trusted` bound **only** to that artifact integrity.
- A package row carries **no** capability list and **no** trust: the capability
  rows' `package` back-reference is the single provider truth, so the two levels
  cannot disagree.
- Semantic invariants validated before any consumption (`invalid-lock`):
  every `capabilities.*.package` is a key of `packages`; every
  `packages.*.dependencies[]` id is a key of `packages`, with no self-dependency
  and no cycle; canonical `path` spellings; `path:` sources require
  `commit: "local"` and `path: "."`; `git:`/`catalog:` require an exact 40-hex
  commit; sha256 digest shapes; array uniqueness.
- **Prototype safety is global.** Every map is read into a null-prototype
  object with identity-charset-validated keys, and *every* lookup or membership
  check keyed by a package or capability ID uses `Object.hasOwn` or such a map —
  central read, dependency graph, provider resolution, trust, update and remove
  alike. Raw parsed JSON returns inherited `constructor`, `toString` or
  `valueOf` for `map[id]` when no own entry exists, so a prototype-named or
  hostile ID must never be able to impersonate a provider, a dependency or a
  trust entry, or to bypass a membership check.

### 4.1 The unsupported transitional v2 shape

The earlier package-root spelling of `lockfileVersion: 2` is **unsupported
input**. It is detected centrally, **before any discovery or mutation**, and
rejected with typed `invalid-lock` and an actionable message naming the
unsupported transitional v2 shape and scope recreation. It is never converted
and never partially interpreted.

Detection uses **direct raw lock-scope reads** — walking ancestor directories
that own an `oas-lock.json`, *not* `configChain`, so lock-only scopes with no
config are visible — and this exact OR predicate:

1. a **nonempty** `lockfileVersion: 2` document with no top-level `capabilities`
   map is unsupported transitional v2 **by itself**; **independently**
2. any package row for which
   `Object.hasOwn(row, "capabilities") || Object.hasOwn(row, "trustedCapabilities") || Object.hasOwn(row, "depsIntegrity")`
   is forbidden transitional evidence.

The row test is **own-property presence, never truthiness or array length**: an
empty `capabilities: []`, an empty `trustedCapabilities: []`, and a dependency-free
old row that carries `capabilities`/`trustedCapabilities` but no `depsIntegrity`
are all still transitional. Package-row `path` and `dependencies` are **never**
tells — the current shape retains both.

An **empty** transitional `{ "lockfileVersion": 2, "packages": {} }` carries no
state and is semantically identical to an empty current lock, so it normalizes
to `{ lockfileVersion: 2, packages: {}, capabilities: {} }`. An empty
`lockfileVersion: 1` file does **not** normalize: it remains pending explicit
format migration.

## 5. Exported kernel functions (`lib/core.mjs`)

All functions are runtime-neutral and dependency-free like the rest of the
kernel. Errors are thrown `Error`s carrying `code` (§8) and, where relevant,
`provenance`. Typed engine codes and messages pass through the CLI verbatim.

### 5.1 Source, manifest, integrity

```js
export function parsePackageSource(spec, { baseDir } = {})
export const DEFAULT_PACKAGE_PATH               // "oas-package"
export function normalizePackagePath(raw, opts)
export function inspectGitSourceRoot(spec)
export function resolvePackageRoot(checkout, packagePath, spec)
export function gitCheckoutExactRef(dir, ref, spec)
export function packageIntegrity(dir)            // payload hash; excludes node_modules
export function capabilityArtifactIntegrity(dir) // materialized artifact hash, no exclusions
export function capabilityIntegrity(dir)         // v1 artifact hash (legacy capability store)

/** Load + validate an oas-package.json against §2. Returns the manifest plus
 * _dir, _legacySpelling (true when the deprecated `configs` key was used),
 * _configTemplates (normalized { name: { path, description?, default } } from
 * either spelling), and _capabilities: [{ id, rel, dir, manifest }].
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
/** THE strict lock reader/validator for v1 and v2. Returns
 * { version, packages, capabilities, legacyCapabilities } — all null-prototype
 * and validated — or null when the file is absent. Rejects the unsupported
 * transitional v2 shape (§4.1) centrally, with NO side effects. Old locks are
 * read as they are: never normalized, repaired or rewritten (the one exception
 * is the state-free empty transitional document of §4.1).
 */
export function parseLockFileStrict(file)

/** Read every lock visible from a directory — every ancestor owning an
 * oas-lock.json, plus config-chain levels — closest scope wins per identity.
 * SOLE strict reader; consumers never see an invalid lock as absent or usable.
 * @returns {{
 *   packages: Record<pkgId, PackageRow & { _file, _level }>,
 *   capabilities: Record<capId, CapabilityRow & { _file, _level }>,
 *   legacy: Array<{ file, level, lockfileVersion, capabilities }>,   // v1 files
 *   migration: Array<{ file, level, lockfileVersion, kind: "v1"|"v1-empty",
 *                      capabilities: string[] }>
 * }}
 *   // `migration` is provenance ONLY: which scopes still need an explicit
 *   // conversion and what they hold. Reading never converts anything.
 */
export function readPackageLocks(startDir)

/** Write/replace (entry) or delete (entry === null) one package row / one
 * capability row. Each validates the COMPLETE prospective document before
 * writing. An existing v1 lock — INCLUDING an empty one — is `legacy-lock`:
 * conversion happens only through explicit migration, so only an ABSENT lock is
 * a fresh document.
 */
export function writePackageLock(levelDir, packageId, entry)
export function writeCapabilityLockEntry(levelDir, capabilityId, entry)

/** Semantic validation of one row against the whole document (§4). */
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
 * closure IN STAGING; calls `opts.assertCommittable` (below); preflights the
 * scope's `.gitignore` (§3.3); then atomically swaps every projected artifact
 * into `.agents/capabilities/installed/<id>/` and writes the lock. On ANY
 * failure — before OR during the commit phase — every already-renamed artifact,
 * the lock bytes and the ignore bytes are rolled back to the pre-operation
 * state. Staging is always removed.
 *
 * ANCHOR DIRECTORIES: staging must live inside the store, so on a scope with no
 * store this necessarily creates `.agents/`, `.agents/capabilities/` and
 * `.agents/capabilities/installed/`. Every refusal and failure path removes
 * exactly the anchors THIS operation created — deepest-first, only while empty,
 * never a pre-existing one and never one holding owned/, adopted/ or any
 * unrelated state. A refused or failed acquisition therefore leaves the scope's
 * tree byte-for-byte and entry-for-entry as it found it, including on a
 * completely clean scope.
 *
 * A v1 lock at the scope is refused BEFORE any source fetch, staging, ignore or
 * artifact work — every v1, INCLUDING AN EMPTY ONE. An empty v1 is still an
 * unconverted scope: converting it as a side effect of `oas install` is the
 * implicit migration §7 forbids, and failing later would make the caller pay for
 * a fetch to learn it.
 *
 * ACTIVATES NOTHING and TRUSTS NOTHING: `trusted` is false for every capability
 * whose artifact integrity is not byte-identical to the one already locked.
 *
 * @param {string} levelDir  scope directory owning the store + lock
 * @param {string} spec      package source spec
 * @param {{ catalog?, replace?: boolean, expectPackage?: string, rootSnapshot?,
 *           assertCommittable?: (preview) => void }} [opts]
 *   // `assertCommittable` is the PRE-COMMIT GATE. It is called exactly once,
 *   // after the whole closure is projected in staging and BEFORE the ignore
 *   // preflight, the artifact swap and the lock write — so the scope is still
 *   // completely untouched. It receives the full staged outcome:
 *   //
 *   //   { root, packages: [{ package, version, source, path, commit, integrity,
 *   //                        dependencies, capabilities }],
 *   //     capabilities: [{ capability, version, package, path, integrity,
 *   //                      trusted, status, layer, executableSurface }],
 *   //     configTemplates }   // identical descriptors to the return value's,
 *   //                         // including `content` and `contentIntegrity`
 *   //
 *   // It is a PURE GATE: inspect and (optionally) throw, nothing else. A throw
 *   // propagates unchanged, staging is discarded, and NOTHING is mutated — no
 *   // ignore file, no artifact, no lock byte — so a refusal needs no rollback.
 *   // This is what lets guided `oas init --package` present and validate the
 *   // complete selected template plan before any engine mutation, and what lets
 *   // `oas update` refuse a config-referenced export drop byte-exactly (§5.5).
 *   // Staging paths are deliberately NOT exposed: the gate decides, it does not
 *   // reach into the transaction.
 *   //
 *   // `layer` is the capability's DECLARED fundamental layer, normalized to
 *   // null when it declares none. It is in the preview because a config
 *   // template may bind a fundamental slot to a capability the ROOT PACKAGE
 *   // ITSELF supplies: before the commit that capability is not materialized,
 *   // is not in the lock, and is not discoverable, so the preview is the only
 *   // place the binding can be validated. Validating it after the commit and
 *   // unwinding is strictly worse — the gate exists so that case never needs an
 *   // outer rollback. The field is the minimum needed for that check; it is not
 *   // a staging path and not the manifest.
 * @returns {{
 *   root: string,
 *   lockFile: string,
 *   installed: Array<{ package, version, source, path, commit, integrity,
 *                      dependencies: string[], capabilities: string[], kept: boolean }>,
 *   capabilities: Array<{ capability, version, package, path, integrity, dir,
 *                         trusted: boolean, status: "installed"|"replaced"|"kept",
 *                         layer: string|null,
 *                         executableSurface: { commands: string[], hooks: string[] } }>,
 *   configTemplates: Array<{ package, template, path, description?, default: boolean,
 *                            content: string, contentIntegrity: string,
 *                            legacySpelling?: boolean }>
 * }}
 *   // `configTemplates` carries VALIDATED descriptors AND payload bytes read
 *   // from staging before it is discarded, with digests identical to what
 *   // `readLockedConfigTemplates` would return, so the config lane can adopt a
 *   // template inside the same transaction without a second fetch. Acquisition
 *   // itself applies none of them.
 * @throws "invalid-source", "invalid-package-manifest", "path-escape",
 *         "capability-not-self-contained", "dependency-cycle",
 *         "duplicate-package-identity", "duplicate-capability-id",
 *         "incompatible-oas", "integrity-drift", "legacy-lock", "invalid-lock"
 */
export function acquirePackage(levelDir, spec, opts)

/** Bare restore, for every visible lock-owning scope.
 *
 * Preflight parses and caches the COMPLETE visible chain before any fetch,
 * staging or swap. Per capability: a present artifact whose integrity equals the
 * locked integrity is `ok`. Otherwise the provider package's EXACT locked
 * provenance (source + commit + path) is fetched once per package into staging,
 * its payload integrity is verified against the package row, the capability is
 * reprojected, its artifact integrity is verified against the capability row,
 * and only then swapped in. NEVER advances source/version/commit/path, never
 * changes `trusted`, never converts a lock. v1 scopes restore through the
 * existing legacy capability path and are reported with their migration action.
 *
 * @returns {Array<{ package?, capability?, level, status:
 *   "ok"|"restored"|"failed"|"legacy", dir?, reason?, code? }>}
 * @throws "invalid-lock" (preflight, before any mutation)
 */
export function restorePackages(startDir, opts)

/** Derive the package/provider view from the lock + the flat capability store —
 * NOT from a package root (there is none). Closest scope wins per package
 * identity; two same-scope packages claiming one capability ID is
 * duplicate-capability-id.
 * @returns {Array<{ package, version, level, source, path, commit, integrity,
 *   dependencies: string[],
 *   capabilities: Array<{ id, version, path, dir, integrity, trusted,
 *                         installed: boolean, manifest? }> }>}
 *   // `installed:false` + absent `manifest` = locked but not materialized —
 *   // exactly what a bare `oas install` repairs. It is reported, never hidden.
 */
export function listInstalledPackages(startDir)

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
 *
 * Two preconditions per target, BOTH required before any flag is set:
 *   1. the materialized artifact hashes to the capability row's `integrity`;
 *   2. its `.oas-installation.json` agrees with that capability row and its
 *      provider package row.
 * Integrity alone is not sufficient — a provenance file edited and then
 * re-hashed into its row leaves every byte matching its recorded digest with
 * only the ORIGIN disagreeing, and approval is what unlocks execution. Both are
 * checked for every target before the single lock write, so a bulk approval
 * commits nothing when one capability's origin is disputed.
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
 *   chain references them. Otherwise the whole update fails `remove-blocked`
 *   and the pre-operation state is restored.
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
 * Stages the locked source (source + commit + path), validates the manifest and
 * its resource containment, verifies the payload integrity against the package
 * row, reads the requested template bytes, and removes staging. It NEVER
 * persists a package root, never exposes a path into one, never mutates the lock
 * or the capability store, and never advances anything. A plain list of what is
 * installed must NOT call this — it is a network operation.
 *
 * @param {{ template?: string, catalog? }} [opts]  template omitted = all of them
 * @returns {{ package, source, version, commit, path, integrity, legacySpelling,
 *   templates: Array<{ template, path, description?, default, content,
 *                      contentIntegrity, legacySpelling }> }}
 *   // `integrity` is the package PAYLOAD integrity, verified equal to the lock.
 *   // The CLI lane owns oas-config schema/policy validation.
 * @throws "unknown-capability" (no such locked package), "invalid-lock",
 *         "integrity-drift", "invalid-package-manifest", "invalid-source",
 *         "unknown-config-template"
 */
export function readLockedConfigTemplates(startDir, packageId, opts)
```

**One template descriptor shape, two readers.** Acquisition (§5.3
`configTemplates`) and this locked reader produce the SAME descriptor, field for
field, and both carry `legacySpelling` on **every template item** — the root
`legacySpelling` here is a package-level convenience duplicate, not the only
place it appears. A consumer must never have to know which reader produced a
descriptor in order to read it.

**`contentIntegrity` digests the exact FILE BYTES**, not the decoded string:
`sha256-<64 lowercase hex>` over the bytes on disk. Digesting the decoded string
would hash U+FFFD replacement characters for any byte sequence that failed to
decode, yielding a digest nothing can reproduce from the file — and adoption
compares template bytes. Config templates are UTF-8 text by contract, so the
decode is **fail-closed**: undecodable bytes are `invalid-package-manifest`, a
malformed package, never silently repaired. Acquisition and the locked reader
therefore agree byte-for-byte and digest-for-digest on the same locked source.

### 5.7 Migration (v1 only)

```js
/** Plan the conversion of one scope's v1 lock. PURE — applies nothing.
 *
 * `marketplace:` entries map through the catalog (aliases first, then identity);
 * `git:`/`path:` entries map to package specs when the source really is a
 * package. Anything the scope cannot convert makes the WHOLE SCOPE
 * unconvertible — the lock has no residue container, so an entry left behind
 * would have nowhere to live and would simply be dropped. `hold`, `manual` AND
 * `retain` therefore all clear `convertible`, and the scope stays v1 in full
 * and keeps working. (`retain` is the guided mode's "keep this custom entry
 * unchanged"; keeping it is only possible by keeping the entire scope.)
 *
 * @returns {{ from: 1|2, convertible: boolean,
 *   plan: Array<{ capabilityId?, v1?, package?, spec?,
 *                 action: "acquire"|"convert-format"|"hold"|"manual"|"retain" ,
 *                 reason? }>,
 *   warnings: string[] }}
 */
export function migrateLegacyLock(levelDir, opts)

/** Apply that plan, transactionally and all-or-nothing per scope. Executable
 * approvals are never carried over — a v1 capability artifact and a materialized
 * artifact are different bytes — and the returned `trust[]` names every surface
 * to re-approve. Any failure restores the original v1 lock BYTE-IDENTICALLY,
 * removes everything the conversion created, and leaves superseded v1 artifacts
 * in place.
 *
 * A MIXED scope — official work beside `retain` entries — is refused
 * `legacy-lock` BEFORE any lock, artifact or ignore mutation: not one official
 * artifact is partially acquired, and the config, store and trust of that scope
 * are byte-identical afterwards.
 *
 * There is NO residue result and no residue container. `retained` appears only
 * on a `skipped` scope — one with no official work at all, left entirely on v1 —
 * and lists the v1 capability ids that were left untouched.
 * @returns {{ migrated, skipped?, retained?, formatConverted?, warnings, file, trust }}
 * @throws "official-mapping-unavailable", "legacy-lock", "invalid-lock", …
 */
export function applyLegacyLockMigration(levelDir, opts)
```

## 6. Runtime closure in the materialized model

- **Materialization roots are the declared CAPABILITY roots**, each carrying
  both `package.json` and `package-lock.json`. A package-root-only closure has
  no durable home and is **not** materialized — it is package tooling. If a
  capability actually needs it, self-containment (§2.5) fails and the package is
  rejected. (For a legacy `"."` capability root, capability root == package root,
  so the package-root closure *is* the capability closure.)
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
  `integrity`. Tampering with a materialized dependency invalidates `trusted`
  exactly like source drift, and bare restore reprojects it.

## 7. Compatibility

**v1 stays usable without any implicit conversion.** Runtime discovery, exact
restore, trust checks and approval updates, and `doctor`/`list` diagnosis all
continue to work against v1 locks and the existing
`.agents/capabilities/installed/` v1 artifacts. Ordinary use of an unconverted
deployment must not require migration; only lifecycle *mutation* through the new
package surface does (`legacy-lock`, naming the explicit command). Guided
official migration converts a v1 scope **directly** into this flat capability
materialization.

**Immutable published package manifests** using `configs`, or a `"."` capability
root, remain readable and projectable under §2.3–2.4.

**The earlier transitional package-root v2** is unsupported input (§4.1): it
fails clearly rather than being guessed at or converted. Existing local
pre-adoption state is recreated by reinstalling; there is no product migration
path, and there is no compatibility subsystem to maintain.

## 8. Error taxonomy

Stable `error.code` values (also the `--json` envelope codes):

| code | Meaning |
|---|---|
| `invalid-source` | source spec parses to none of the four grammar forms |
| `invalid-package-manifest` | `oas-package.json` missing/invalid against §2, or a declared path does not identify the expected resource kind |
| `path-escape` | a declared path resolves outside its containment root after symlink resolution (package root when staging, capability root when projecting, artifact root at runtime) |
| `capability-not-self-contained` | a declared capability cannot be materialized as a self-contained artifact (a declared resource is missing, or resolves outside its capability root) |
| `dependency-cycle` | package dependency graph contains a cycle (provenance: the cycle path) |
| `duplicate-package-identity` | two sources claim the same package identity at one scope (provenance: both sources) |
| `duplicate-capability-id` | two packages export the same capability ID at one scope, or one package exports it twice (provenance: both) |
| `integrity-drift` | staged/installed bytes ≠ locked integrity (package payload or capability artifact), or a trust operation against a drifted artifact |
| `capability-list-mismatch` | a locked capability's provider package no longer exports it at the locked path |
| `incompatible-oas` | `compatibility.oas` floor not met by the running kernel |
| `retired-capability` | a package exports / config references a capability the kernel has retired |
| `legacy-lock` | operation requires the current lock shape but the scope has v1 — run the explicit migration command |
| `invalid-lock` | lock violates the semantic invariants of §4, **or** is the unsupported transitional v2 shape of §4.1 — fail closed, no normalization, no auto-repair, no side effects |
| `unknown-capability` | trust/update/remove/template target is not present in the visible locks |
| `unknown-config-template` | the package has no config template by that name |
| `remove-blocked` | removal target is still referenced by config or by a dependent locked package (provenance: the blockers) |
| `official-mapping-unavailable` | guided official migration cannot map a legacy official capability yet; the scope was left unchanged |

Fail-closed enforcement points: `parseLockFileStrict`, `readPackageLocks` and
`listInstalledPackages` RAISE — consumers never see an invalid lock as absent or
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
  closures required.
- Existing config targeting / layer / injection / override / scope-precedence
  semantics are unchanged, including `from: installed`, `from: owned`,
  `from: path:<dir>`, `none` for inherited layers, and injection ejection.
- `.agents/capabilities/owned/<id>` and `from: path:<dir>` capability development
  are untouched by package paths and keep their existing structural/executable
  trust, targeting, override and composition semantics.
- Git-backed scopes ignore `installed/` only, ensured transactionally; `owned/`
  and adopted config-template data are never ignored. Non-Git scopes work
  without fake Git state.
