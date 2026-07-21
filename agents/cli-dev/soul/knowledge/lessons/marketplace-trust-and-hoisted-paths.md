---
type: Lesson
title: Marketplace over bundled — trust at acquisition, hoisted paths via lock source
description: Official capabilities are acquired from the kernel-shipped marketplace folder into a scope's installed/ store with trust written into the lock at acquisition, and the hoisted-resource exemption is keyed on the lock's marketplace source (the _marketplace manifest flag), not on capability id heuristics.
tags: [capabilities, marketplace, trust, integrity, oas-lock, hoisted]
timestamp: 2026-07-21
---

# The migration (v0.13.x)

"From bundled" is gone. `MARKETPLACE_DIR = <PKG_ROOT>/capabilities` is the
official marketplace; packages there are **not ambient** — `oas install <id>`
(or init) copies them into the scope's `.agents/capabilities/installed/`,
writes `oas-lock.json` with `source: marketplace:<id>@<version>` and computes
`integrity`. `from: bundled` in configs is rejected with a migration error.

# Trust at acquisition

Marketplace installs are **auto-trusted at acquisition** — the lock records
`trustedExecutables: true`. Rationale: they ship with the kernel you already
installed; a second `oas trust` would be ceremony without a security boundary.
Third-party git/path installs keep explicit `oas trust`. `capabilityTrust`
reads the lock; committed trust survives `oas install` restore **only when
integrity matches** (the repo is the trust boundary).

# The hoisted-path gotcha

Bundled packages (e.g. oas-aweb) reference framework-hoisted resources like
`node_modules/@awebai/pi/skills/...` that exist only in the kernel tree. A
copied install loses those paths. The fix chosen: `capabilityManifests`
annotates each installed manifest with `_marketplace: true` when the level's
lock source starts with `marketplace:`; `manifestPath` then falls back to
resolving the relative path against the **kernel** PKG_ROOT for flagged
manifests only, and `assertCapabilityTreeContained` skips the symlink-escape
check for them. Do NOT widen this to id heuristics (`oas.*` prefix) — the
exemption must stay tied to the lock's provenance, or third-party packages
could escape their integrity boundary.

# Related trap

A marketplace package copied into a scope also loses **JavaScript relative
imports** into the kernel (v0.13.1 bug: oas-okf's hook imported
`../../lib/core.mjs`). Package scripts must not rely on their position inside
the kernel tree — resolve the kernel explicitly or keep such logic in the
kernel itself.

Reference decision: `agents/oas-expert/soul/knowledge/decisions/marketplace-workmodes-runtime.md`.
