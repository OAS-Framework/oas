---
name: capability-source-reinstall
description: >-
  Use when editing a local OAS capability package and reinstalling or testing it
  in a deployment, when `oas install <capability-id>` did not pick up source
  changes, when a path-installed capability needs trust, or when manifest paths
  to bundled/hoisted skills disappear after acquisition.
---

# Reinstalling edited capability sources

When you edit `capabilities/<name>/` in this repo, do **not** reinstall by
capability ID and assume the checkout was used. `oas install <capability-id>`
resolves against the globally installed kernel's marketplace, not the working
tree, so it can silently re-lock the old published version.

## Procedure

1. Bump the capability `version` in `oas.json` for the edited capability; the
   lock records this value, and stale-version confusion is easy.
2. At the owning config level, remove the old lock entry and installed artifact:
   `oas-lock.json` plus `.agents/capabilities/installed/<name>`.
3. If the manifest references files outside the capability directory through a
   hoisted path (for example `node_modules/...` skills), copy that tree into
   the capability directory before acquisition. Path installs do not get the
   marketplace's hoisted-path resolution.
4. Install from the local path, not by ID:
   ```bash
   oas install /path/to/repo/capabilities/<name> [--dir <level>]
   ```
5. Trust the path-installed package at that scope:
   ```bash
   oas trust <id> --dir <level>
   ```
6. Remove any temporary copied-in hoisted tree after acquisition, then verify
   the lock/source/version and spawn or doctor the affected instance.

## Gotchas

- Path installs are not marketplace-trusted; forgetting `oas trust` leaves
  executable hooks/commands disabled.
- A manifest path that exists only in the globally installed package can make
  the capability appear installed while instances silently lose those skills.
- Reinstalling by ID after local edits usually proves only that the published
  marketplace copy still works.
