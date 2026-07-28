# Package engine contract (workstream 1 frozen interface)

Status: **FROZEN** once merged to `feature/package-engine`. This document is
the resolver/lock API that the config-bootstrap (workstream 2) and
official-package-extraction (workstream 3) workstreams build against. It
implements the accepted Decision "Distribution packages, config profiles, and
consented host requirements"; the Decision is authoritative where this
document is silent. Contract changes go through the coordinator to the
maintainer.

Companion machine-readable schemas:

- [`docs/oas-package.schema.json`](../oas-package.schema.json) — `oas-package.json`
- [`docs/oas-lock.schema.json`](../oas-lock.schema.json) — `oas-lock.json` v2 (+ legacy v1)

Addendum (maintainer clarifications on the M1 freeze):
[`package-runtime-api.md`](./package-runtime-api.md) — the public
package-runtime CLI boundary, npm runtime closure semantics, incremental
transaction guarantees, and runtime-validated schema invariants.

## 1. Package source grammar and normalized identity

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
  owns its packages' roots, so an entry may move one (see §3 `updatePackage`).
- **Omitted** on either: the default is **`oas-package`**. Official examples,
  scaffolds and conventions use `oas-package/` — never a generic `package/`.
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
there; and **only that subtree** is copied, hashed and materialized. A path
that resolves outside the checkout — through a symlink at any depth — and a
broken link are `path-escape`, decided before any store or lock mutation.
Installed bytes therefore equal the selected subtree: repository docs, CI
configuration, owner souls and sibling packages are never installed and never
reach `integrity`. Our own clone metadata (`.git`) is dropped, so a root
selection and a subtree selection behave identically.

One repository may contain several packages selected by different IDs. Because
the closure dedupe key is *source **and** selected path*, two contained roots
claiming the same OAS package identity still fail `duplicate-package-identity`.

**Normalized identity** (what dedupe and lock keys use):

- The **package identity** is the `package` field of the acquired
  `oas-package.json` — never derived from the source string.
- The **normalized source** recorded in the lock is one of
  `git:<canonical-url>@<ref>`, `path:<dir>`, `catalog:<id>` for an originally
  bare catalog request, or `catalog:<id>@<selector>` for an originally explicit
  selector. The resolved catalog commit is recorded separately in `commit`.
  Two source strings that normalize to the same canonical git URL are the
  same source.
- The **selected package root** is recorded in the lock as its own strict
  `path` field — never folded into the source string. It is stored in canonical
  form only and is never normalized or repaired on read: a non-canonical
  spelling is `invalid-lock`. `path:` sources always record `"."`.

**Catalog resolver boundary** (all workstream 3 gets to plug into): the
catalog is a pure mapping *official short ID → git repository (+ optional
selector → ref translation)*. It authenticates identity and discovery only.
It performs **no lock advancement** and grants **no executable trust**;
after catalog resolution the source behaves exactly like a pinned git source.
The engine ships a fixture catalog for tests; publishing real catalog content
is workstream 3.

## 2. Store layout

```text
<scope>/.agents/packages/installed/<package-slug>/   installed package roots
<scope>/oas-lock.json                                 lock (v2)
```

- `<scope>` is any config-chain level (laptop / workspace / repository), same
  chain semantics as today.
- `<package-slug>` is the package identity with `/` and `@` made
  filesystem-safe (identity charset already forbids both, so slug == identity
  in practice).
- `.agents/packages/installed/` is gitignored the same way the capability
  store is (`ensureInstalledGitignore` analogue).
- Installed **capability** directories (`.agents/capabilities/installed/`)
  are superseded by installed package roots.
  `.agents/capabilities/owned/<id>/` and `from: path:<dir>` keep their exact
  current semantics and precedence.

## 3. Exported kernel functions (lib/core.mjs)

All functions are runtime-neutral and dependency-free like the rest of the
kernel. Errors are thrown `Error`s carrying `code` (see §4) and, where
relevant, `provenance` (array of `{ package, source, file }`).

```js
/** Parse + normalize a package source spec.
 * @param {string} spec  CLI/dependency source string
 * @returns {{ kind: "git"|"path"|"catalog", url?: string, ref?: string,
 *             path?: string, packagePath?: string, id?: string,
 *             selector?: string, normalized: string }}
 *   // normalized = lock "source" form (ref may be unresolved for bare git
 *   //   specs) and NEVER carries the `#<path>` fragment
 *   // path        = the local directory of a path: source
 *   // packagePath = the CONTAINED package root selected by `#<path>`,
 *   //   canonical; undefined when the spec selects none (resolution then
 *   //   applies the catalog entry's path or DEFAULT_PACKAGE_PATH). Always
 *   //   "." for path: sources.
 * @throws  code: "invalid-source", "path-escape"
 */
export function parsePackageSource(spec)

/** The default contained package root — "oas-package" — applied whenever a
 * Git/catalog source contract selects none. Read it; never hardcode it. */
export const DEFAULT_PACKAGE_PATH

/** Normalize a configured package path to canonical form (§1.1), or throw.
 * Returns undefined ONLY for an absent value, so the caller applies the
 * source-appropriate default.
 * @param {string|undefined} raw
 * @param {{ where?: string, code?: string }} [opts]  message context / code
 *        for non-traversal violations (default "invalid-source")
 * @returns {string|undefined}
 * @throws  code: opts.code, or "path-escape" for ".." traversal
 */
export function normalizePackagePath(raw, opts)

/** Read the merged package locks visible from a directory's config chain
 * (closest scope wins per package identity). Legacy v1 files are surfaced
 * separately, untouched.
 * @returns {{ packages: Record<id, LockEntry & { _file, _level }>,
 *             legacy: Array<{ file, level, capabilities: Record<id, V1Lock> }> }}
 */
export function readPackageLocks(startDir)

/** Write/replace one package's lock entry (creates lockfileVersion 2 file).
 * Refuses to write into a v1 file: code "legacy-lock" (migrate first).
 * @returns {string} lock file path
 */
export function writePackageLock(levelDir, packageId, entry)

/** Resolve + acquire a package closure at a scope: fetch the root source,
 * read oas-package.json, validate it (schema + path containment + resource
 * kinds), recursively resolve dependencies (official selector / pinned
 * git / local path), detect cycles and identity collisions, materialize
 * every package into <scope>/.agents/packages/installed/, and exact-lock
 * the whole closure. Activates nothing. Transactional: staged in a temp
 * dir; the store and lock are replaced together or not at all.
 * @param {string} levelDir  scope directory owning the store + lock
 * @param {string} spec      package source spec
 * @param {{ catalog?: (id, selector) => { url, ref, path? } }} [opts]  catalog resolver injection (fixture in tests)
 * @returns {{ root: id, installed: Array<{ package, version, commit,
 *             integrity, source, path, capabilities: string[] }>, lockFile }}
 * @throws codes: "invalid-source", "invalid-package-manifest", "path-escape",
 *         "dependency-cycle", "duplicate-package-identity",
 *         "duplicate-capability-id", "incompatible-oas"
 */
export function acquirePackage(levelDir, spec, opts)

/** Restore a scope's store exactly from its v2 lock: for each locked
 * package, fetch the exact commit, verify tree integrity, verify the lock's
 * capabilities[] list against the restored oas-package.json, and install.
 * Transactional per scope. Never advances a ref. NO team-boundary recursion
 * (that is workstream 2, layered on top of this).
 * @returns {Array<{ package, level, status: "restored"|"ok"|"failed",
 *                   path?, reason? }>}
 * @throws codes: "integrity-drift", "capability-list-mismatch", "legacy-lock"
 */
export function restorePackages(startDir, opts)

/** Enumerate installed packages visible from a directory and the
 * capabilities each exports, with provenance. Closer scope wins for the
 * same package identity; two same-scope packages exporting one capability
 * ID throw code "duplicate-capability-id".
 * @returns {Array<{ package, version, level, source, path, commit, integrity,
 *             dir, capabilities: Array<{ id, dir, manifest }> }>}
 */
export function listInstalledPackages(startDir)

/** Trust queries and approval, bound to package integrity.
 * capabilityTrust: is this capability's executable surface approved at the
 * provider package's CURRENT locked integrity?
 * @returns {{ trusted: boolean, package, integrity,
 *             executableSurface: { commands: string[], hooks: string[] } }}
 */
export function capabilityTrust(startDir, capabilityId)

/** Approve executable surfaces. Per-capability by default; allCapabilities
 * requires the caller to have displayed the full executable-surface summary.
 * Writes trustedCapabilities[] into the provider's lock entry at its exact
 * integrity. Any integrity change (update/acquire) resets the list to [].
 * Skill/instruction/config-only capabilities need no approval (no-op, noted
 * in the return). Official-catalog identity grants NO executable trust.
 * @throws codes: "unknown-capability", "integrity-drift"
 */
export function approveCapability(levelDir, capabilityId, { allCapabilities } = {})

/** Map a legacy v1 lock (per-capability marketplace/git/path entries) to a
 * v2 package-lock plan, preserving config activation (from: installed keeps
 * meaning). Pure mapping — the migration COMMAND applies it.
 * @returns {{ plan: Array<{ capabilityId, v1: V1Lock,
 *             package: { id, source, spec } | null,   // null = no mapping (owned/path/unknown)
 *             action: "acquire"|"keep-owned"|"manual" }>,
 *             warnings: string[] }}
 */
export function migrateLegacyLock(levelDir, opts)
```

Notes for consumers:

- **Workstream 2** consumes `restorePackages` (wrapping it in team-boundary
  recursion), `listInstalledPackages` (profile validation: every referenced
  installed capability is provided by the closure), `acquirePackage` (from
  `oas init --package`), and `readPackageLocks` (provenance recording).
- **Workstream 3** consumes `parsePackageSource` + the `opts.catalog`
  injection point, and the acquire → lock → trust → activate → spawn probe
  fixture as its per-repo CI probe.
- `readPackageLocks` returns `{ packages, legacy }`; a lockfileVersion 2 file
  may retain unmappable v1 capability entries as **migration residue** under
  `capabilities` (surfaced through `legacy`). `oas migrate` flips the version,
  converts what the catalog can map, and keeps the rest as residue so legacy
  restore/trust continue working; doctor flags residue as pending migration.
  `writePackageLock` still refuses pure-v1 files (`legacy-lock`).
- Capability discovery (`discoverManifests` today) gains an
  `installed-package` origin: it indexes only the `oas.json` files enumerated
  by visible packages' manifests and annotates each with
  `{ _package, _packageSource }` provenance. `from: installed` in config keeps
  its spelling and resolves to package-exported capabilities.

## 4. Error taxonomy

Stable `error.code` values (also the `--json` envelope codes for the
lifecycle commands):

| code | Meaning |
|---|---|
| `invalid-source` | source spec parses to none of the four grammar forms |
| `invalid-package-manifest` | `oas-package.json` missing/invalid against the schema, or a declared path does not identify the expected resource kind |
| `path-escape` | a declared package-relative path resolves outside the package root after symlink resolution (or a hook/code path escapes the locked package + materialized deps at runtime) |
| `dependency-cycle` | package dependency graph contains a cycle (provenance: the cycle path) |
| `duplicate-package-identity` | two sources claim the same package identity at one scope (provenance: both sources) |
| `duplicate-capability-id` | two same-scope packages export the same capability ID (provenance: both packages) |
| `integrity-drift` | installed tree hash ≠ locked integrity (restore verification, or trust operations against a drifted artifact) |
| `capability-list-mismatch` | lock's `capabilities[]` disagrees with the restored package manifest |
| `incompatible-oas` | `compatibility.oas` floor not met by the running kernel |
| `retired-capability` | a package exports / config references a capability the kernel has retired (existing retirement registry) |
| `legacy-lock` | operation requires lockfileVersion 2 but the scope has a v1 lock — run the migration command |
| `invalid-lock` | v2 lock entry violates semantic invariants (trust subset, dependency references, source/commit pairing) — see the runtime API addendum §4 |
| `unknown-capability` | trust/approval target is not exported by any visible installed package |
| `remove-blocked` | `oas remove` target is still referenced by config or by a dependent locked package (provenance: the blockers) |

## 5. Invariants (restated from the Decision — binding)

- Acquisition activates and targets nothing.
- Every exported capability stays independently addressable by capability ID;
  capability manifests still cannot carry deployment targets; packages cannot
  make capabilities or family assignments mandatory.
- No silent lock advancement; no npm lifecycle scripts (`npm ci --omit=dev
  --omit=peer --ignore-scripts` only, for a checked-in `package-lock.json` —
  see the runtime API addendum §2); no
  executable-trust broadening; official identity ≠ executable trust.
- Any package integrity change invalidates all of its capability approvals.
- Existing config targeting/layer/injection/override semantics unchanged.
- The selected package root is part of what a lock pins. A bare `oas install`
  restores the exact locked source + commit + **path** + integrity even if the
  catalog, the ref or the upstream directory layout moved; a plain acquire that
  resolves a different path is refused (`integrity-drift`). Only an explicit
  `oas update <package-id>` may adopt a newer commit or path, and it reports a
  path move in both human and `--json` output.
- `.agents/capabilities/owned/<id>` and `from: path:<dir>` capability
  development are untouched by package paths: they are not package sources, are
  never routed through the default contained root, and keep their existing
  structural/executable trust, targeting, override and composition semantics.
