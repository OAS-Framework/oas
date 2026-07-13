---
type: Decision
title: Scoped capability store, restorable installs, and config templates
description: All capabilities live in the owning config scope's .agents/capabilities/ split into installed/ (acquired, gitignored, restorable) and owned/ (authored, committed); bare `oas install` restores; `oas init --template` seeds a config from a local file or a git repo's main-branch config.
tags: [architecture, capabilities, packages, config, install, templates, trust]
timestamp: 2026-07-12
---

**Status: decided 2026-07-12 by the founder.** Amends the storage and
acquisition mechanics of [capability packages](/decisions/capability-packages.md);
the contract itself (manifest, targeting, composition, trust semantics) is
unchanged.

# Context

v0.7.0 had two artifact stores: a machine-global `~/.oas/capabilities/`
(default `oas install`) and config-scoped `.agents/capabilities/`
(`--here` or hand-authored). The lockfile lived at config scopes, so one
global artifact could be governed by several scope lockfiles — the recorded
"lock cache sharing" watch item — and a cloned repo with config + lock could
not fetch its own dependencies (locks pin but do not restore).

# Decision

1. **One store, config-scoped, two named subtrees.** Every capability lives
   under `<level>/.agents/capabilities/` beside the `oas-config.yaml` and
   `oas-lock.json` that govern it:

   ```text
   <level>/.agents/capabilities/installed/<name>/  # acquired, locked, gitignored, restorable
   <level>/.agents/capabilities/owned/<name>/      # authored at this scope, config-owned trusted
   ```

   `~/.oas/capabilities/` is removed from discovery, and `--here` disappears
   (scope-local is the only behavior). "Global" installs are simply installs
   at the laptop config scope (`~`), an ordinary config level. The trust
   boundary is structural: `owned/` is trusted with the scope and never
   locked; `installed/` must have a matching lock entry, so an installed
   artifact cannot masquerade as owned by dropping its lock. Within one scope
   `owned/` overrides `installed/` on ID collision. Bare manifests directly
   under `.agents/capabilities/` are rejected with a move-to-subdir error.
   `oas install` maintains a one-line `.agents/capabilities/.gitignore`
   (`installed/`) so acquired artifacts stay uncommitted like node_modules
   while owned ones commit; the write is skipped outside version control.
   "Committed" is incidental to `owned/`: at non-git scopes (laptop `~`, a
   plain workspace root) owned capabilities are ordinary files — trusted with
   the scope, not lockable, not restorable, durable only as the scope is.
   The npm framing is deliberate: config + lock declare dependencies
   (capabilities); `agents/*/soul/` is first-party source and already the
   roster declaration — no config-level agent list duplicates it.
2. **Bare `oas install` restores.** With no argument, `oas install` walks the
   current config chain and reacquires every capability that is locked or
   declared with an external `source:` but whose artifact is missing, into the
   scope that owns its declaration. Restored artifacts must hash to the locked
   integrity; a mismatch aborts and removes the fetched copy. Restore acts on
   the current chain (current + outer scopes); nested repos run their own
   restore.
3. **Committed trust is honored on integrity match.** A committed lock's
   `trustedExecutables: true` survives restore when the restored artifact
   hashes to the locked integrity. Rationale: config-owned capabilities in
   `.agents/capabilities/` are already trusted as part of trusting the repo,
   so honoring an integrity-bound committed approval adds no new attack
   surface — the config scope is the trust boundary.
4. **Config templates.** `oas init --template <name|path|git-url>` seeds the
   new `oas-config.yaml` from a template config: a local file path, or a git
   repo's main-branch `oas-config.yaml`. Named templates resolve through a
   `templates: {name: <path|url>}` map in an outer config scope (typically the
   laptop level). Templates are **snapshots**: init copies the content and
   records provenance (`# template: <source>[@<commit>]`); later template edits
   never propagate silently. After seeding, init runs restore so declared
   external capabilities are present.
5. **Per-capability injection override.** A capability declaration in config
   may carry `agents-md-injection: <path>|none|default` to replace, suppress,
   or restore that package's packaged instruction injection; the closest scope
   declaring the key wins. This keeps instruction policy config-owned without
   forking the package.

# Consequences

- The lock cache sharing watch item is resolved: artifact and lock are
  co-located and share a lifecycle; upgrade/remove is scope-local.
- Repos become clone-and-go: config + lock (and optionally committed
  artifacts) fully describe the capability surface; `oas install` restores it.
- Duplication is accepted: two scopes using one capability hold two copies.
  Integrity hashing makes copies equivalent; this mirrors node_modules.
- No migration shim: the young v0.7.0 store is removed outright per the
  clean-contract precedent. `oas doctor` warns if a legacy
  `~/.oas/capabilities/` still exists.
- Doctor invariants become crisp: an `installed/` artifact without a lock
  entry is an error; a lock entry with a missing artifact means "run
  `oas install`".
- Restore does not scan downward for nested configs; each scope restores its
  own chain. A workspace-wide "restore all nested repos" is possible later.

# Options considered

1. **Keep the global store and add transactional multi-lock upgrades.**
   Rejected: more machinery to preserve a cache whose only benefit is disk
   dedup.
2. **Live template inheritance (config `extends:`).** Rejected for v1:
   action-at-a-distance config changes contradict the no-silent-update
   principle; snapshots with provenance are auditable.
3. **Reset trust on restore.** Rejected: config-owned capabilities are already
   auto-trusted, so re-prompting for integrity-matched locked artifacts would
   be security theater inconsistent with the actual trust boundary.
