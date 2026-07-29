---
type: Decision
title: Adopted-base and backup writes validate their parents and never follow a link
description: Every existing component from scope to adopted template dir is checked immediately before each write, fixed .bak paths are replaced instead of written through, and backups are journalled run state.
tags: [security, config-templates, oas-cli, symlink]
timestamp: 2026-07-29
---

# Three separate holes on one path

1. `writeAdoptedTemplate` wrote under
   `.agents/config-templates/adopted/<package>/<template>/` without checking any
   existing component, so a symlink anywhere on that path redirected the run's
   bytes.
2. `oas config sync` and `--reset` used `copyFileSync(file, `${file}.bak`)`.
   `copyFileSync` opens the destination for write, so a planted, predictable
   `.bak` symlink was followed.
3. `oas-config.yaml.bak` was absent from `RUN_JOURNAL_PATHS`, so a failed sync
   could leave behind a backup the operator never had while rollback reported a
   clean failure.

# The rules

- `assertNoSymlinkedParents(scope, leafDir, what)` walks every existing
  component below the scope and refuses any symlink, including links that
  currently stay inside the scope. This code did not sanction redirection, and
  distinguishing contained from escaping links adds a way to be wrong. Absent
  components are fine because this run creates them.
- The parent check runs immediately before each write, not once at command
  entry. The gap between checking and writing is where a swap would land.
- Backup copying is `copyFileAtomic`: read bytes from `from`, write them to a
  sibling temp file for `to`, then rename into place. That replaces the `.bak`
  directory entry instead of writing through it.
- Package and template names are path segments and use the same directory-name
  grammar as materialized capability ids, raising `E_ADOPTED_PATH_UNSAFE` on
  unsafe names. See [the capability-id grammar decision](/decisions/capability-id-grammar-and-containment-proof.md).

# Diagnostic asymmetry

Which guard fires depends on where the link sits, and both outcomes are
fail-closed:

- At the adopted root, `readdirSync` follows the link and finds the base, so the
  read succeeds and the write-time parent check refuses with
  `E_ADOPTED_PATH_UNSAFE`.
- At the package or template level, the scan sees a symlink dirent and skips it,
  so the run stops earlier with `E_NO_ADOPTED_BASE`.

The diagnostic differs; the invariant does not. Revisit only if operators ever
legitimately need a shared adopted tree. Today the second case reads as
"nothing adopted", which is true but incomplete.

# Testing lesson

A rollback test must inject its failure after the writes it claims to undo. A
non-directory adopted root fails during the read, before any write, so it passes
without proving backup journaling. A read-only template directory lands in the
right window for the write order — backup, config, adopted base — and the mutant
that removes the backup journal entry dies there.

See also [the first-adopt merge-base decision](/decisions/no-adopted-base-means-empty-base-not-local.md) and [the run-level rollback journal lesson](/lessons/run-level-rollback-journal-craft.md).
