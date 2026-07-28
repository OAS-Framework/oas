---
type: Lesson
title: Hoisted-resource fallbacks anchor at the declaring manifest directory
description: Marketplace hoisted-resource fallbacks must re-resolve manifest-relative paths from the declaring capability's canonical marketplace directory and still walk the hoisted tree for containment.
tags: [kernel, capabilities, marketplace, hoisted, containment, spawn]
timestamp: 2026-07-28
---

# The defect

`manifestPath()` once resolved a missing marketplace capability resource with
`join(PKG_ROOT, rel)`. Manifest-relative paths are written against the
**manifest's own directory**. In the marketplace, that declaring directory is
`<PKG_ROOT>/capabilities/<slug>`, not `PKG_ROOT`.

`oas.authoring` declares `../../skills/{integration-authoring,skill-craft,
soul-craft}`. PKG_ROOT-anchored fallback resolved those as
`<PKG_ROOT>/../../skills/...`, outside the kernel, so the authoring skills never
resolved and strict composition raised `E_CAPABILITY_RESOURCE_MISSING` for every
framework-author spawn.

`oas-aweb` masked the bug because its `node_modules/@awebai/pi/skills/...`
declaration happened to resolve under `PKG_ROOT` when the kernel's own
`node_modules` was populated. Its `capabilities/oas-aweb/package.json`
declaration still shows the intended base: per-capability npm materialization,
so the path is capability-dir-relative rather than PKG_ROOT-relative.

# Fix boundaries

The exemption is correct in *what* it allows — framework-shipped marketplace
packages may reach framework-hoisted content — but the fallback must preserve the
meaning of the declaration's path spelling.

- Annotate installed marketplace manifests with the lock entry (`_marketplaceLock`
  source and version), not just a boolean `_marketplace` marker.
- Find the canonical shipped source by **capability identity** through
  `marketplaceCapabilities()`, never by the directory slug inside the lock
  selector. `marketplace:oas-web@0.9.6` for capability `oas.web` is a real
  historical spelling, so the selector is not an addressable path.
- Require shipped version, installed version, and locked version to match before
  using the shipped source. Version drift throws `E_MARKETPLACE_SOURCE_DRIFT`
  naming `oas install <id> --dir <scope>`; a kernel that no longer ships the
  capability returns undefined and lets the missing-resource preflight fail
  closed with rollback.
- Keep package-exported manifests (`m._package`) out of marketplace annotation,
  so a legacy `marketplace:` residue entry for an official id cannot hand a
  third-party package the kernel's content.
- Keep containment explicit: a hoisted tree may sit outside the copied install,
  but it is walked against `PKG_ROOT` rather than exempted from the symlink-escape
  walk. An early return for every outside-copy tree skipped containment entirely.

# Regression shape

A path-arithmetic bug can be invisible from the source checkout when the wrong
anchor lands on an absent directory either way. `test/marketplace-hoisted.test.mjs`
copies the published `files` into a node_modules-shaped root
(`.../node_modules/@oas-framework/oas`) and imports that installed kernel's
`lib/core.mjs`, so `PKG_ROOT` is a real installed root and the pre-fix anchor
lands inside the temp tree where its absence is provable.

Nest the fake kernel deeply. If the kernel is only one level below the temp dir,
the pre-fix `../../skills` anchor can resolve into the shared tmpdir, where an
unrelated `skills/` tree could mask the regression.

The regression has teeth: restoring the PKG_ROOT anchor fails three of four
marketplace-hoisted tests, and restoring the early-return containment exemption
fails exactly the symlink-escape case.

# Related

[Marketplace over bundled](/lessons/marketplace-trust-and-hoisted-paths.md)
records the provenance and trust boundary for marketplace installs. This lesson
corrects the hoisted fallback anchor and containment shape inside that boundary.
