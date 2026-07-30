---
type: Decision
title: A "." capability root is discriminated by configTemplates, never by configs
description: Keying legacy-package acceptance on the deprecated `configs` spelling would strand oas.authoring@1.0.0, because it declares "." without either template map.
tags: [kernel, packages, manifest, compatibility]
timestamp: 2026-07-29
---

# The rule

`oas-package.json` may declare `capabilities: ["."]` — the package root is
itself the capability root. Newly authored packages must never emit it. The
reader accepts it **iff the manifest does not carry `configTemplates`**, and
rejects it as soon as it does, because a `configTemplates` manifest is
unambiguously new-format.

This is the compatibility boundary for the older [flat single-capability package decision](/decisions/flat-single-capability-packages.md).

# Why not key on `configs`

The intuitive reading is "legacy manifests use `configs`, new ones use
`configTemplates`, so `.` is legacy iff `configs` is present." That is wrong for
the exact case the compatibility exists to serve:

**`oas.authoring@1.0.0` is `capabilities: ["."]` and ships no template map at
all** — neither `configs` nor `configTemplates`. A `configs`-keyed discriminator
rejects it, i.e. breaks the one immutable published tag the rule was written
for.

The asymmetry is the point:

| manifest                              | `"."` accepted? |
|---------------------------------------|-----------------|
| no template map (oas.authoring@1.0.0) | yes             |
| `configs: {...}` (deprecated 0.19)    | yes             |
| `configTemplates: {...}`              | **no**          |
| both spellings                        | invalid manifest, whatever the roots |

`configs` still matters — it normalizes to the same descriptor shape and sets a
diagnostic `legacySpelling` flag — but it is a *deprecation* signal, not a
*format-era* signal. Absence of `configTemplates` is the format-era signal.

# General shape of the lesson

When adding a discriminator for "old format", enumerate the actual published
artifacts it must accept before choosing the field. A field that is *optional*
in the old format cannot discriminate it; only a field that is *impossible* in
the old format can.
