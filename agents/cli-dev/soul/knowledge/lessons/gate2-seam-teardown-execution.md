---
type: Lesson
title: Gate-2 package seam teardown execution lessons
description: Executing the package-engine seam teardown showed that prewritten disposition inventories can make merge conflicts mechanical, add/add test conflicts should split by ownership, engine report enums need explicit mapping, and fixture/schema gaps surface during consumption.
tags: [packages, seam, teardown, merge, gate-2]
timestamp: 2026-07-26
---

# Gate-2 seam teardown execution

Executing the gate-2 teardown as a coordinator-authorized direct merge of the
package engine head confirmed and extended the
[package-engine seam teardown decision](/decisions/package-engine-seam-teardown.md):

- **Conflict hunks can be the teardown map.** Each `bin/oas.mjs` conflict hunk
  matched one prewritten inventory disposition: doctor merged engine diagnostics
  with the WS2 payload, restore kept engine `restorePackages` plus the
  reconcile envelope, trust kept the engine block wholesale, and help took the
  union. Writing the teardown plan before the merge made conflict resolution
  mechanical.
- **Both-sides-added tests should split by ownership.** When both sides added
  `test/packages.test.mjs`, the engine suite moved to
  `test/package-engine.test.mjs` after extracting both sides with
  `git show :2:`/`:3:`. Engine-superseded WS2 API tests were dropped because
  the engine suite covered them, while the merged CLI surface required updating
  two engine assertions: bare `install --json` now emits WS2's reconcile
  envelope, and `config` became a kernel command so its unknown-subcommand code
  changed.
- **Map foreign report enums explicitly.** `restorePackages` can emit
  `status: "legacy"` rows with `package: null` for v1 locks. Those rows are
  informational and restored through the capability path; treating every
  non-`ok` status as a reconciliation failure made real deployments fail.
- **Fixture strictness ratchets during seam consumption.** The engine schema
  requires `compatibility` and rejects unknown keys, so fixtures needed
  `compatibility.oas`. Same-scope duplicate capability exports now throw during
  acquisition, so package fixtures needed distinct capability ids.
- **Consumption surfaced upstream engine gaps.** JSON `null` manifests crashed
  `loadPackageManifestAt` uncoded, relative dependency paths resolved against
  CWD instead of the depending package root, and empty v1 locks were not
  surfaced in `readPackageLocks`' legacy list; these were flagged upstream
  rather than fixed locally.

See also the earlier frozen-contract alignment notes on
[legacy lock presence and invalid manifest handling](/lessons/frozen-package-engine-contract-alignment.md).
