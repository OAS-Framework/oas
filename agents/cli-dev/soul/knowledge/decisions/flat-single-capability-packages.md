---
type: Decision
title: Legacy "." capability roots are compatibility-only
description: A manifest with capabilities ["."] is accepted only as legacy compatibility when configTemplates is absent; newly authored packages must not emit it.
tags: [packages, manifest, layout, compatibility]
timestamp: 2026-07-29
---

# Current rule

A package-root capability declared as `capabilities: ["."]` is compatibility-only.
Newly authored packages must never emit it. The reader accepts it only under the
compatibility discriminator in [A "." capability root is discriminated by configTemplates, never by configs](/decisions/legacy-capability-root-discriminator.md).

This supersedes the older broad rule that flat single-capability packages were
newly supported. The accepted legacy shape still has the package root as the
capability directory, with `oas-package.json` and `oas.json` side by side, but
only when the manifest is on the legacy side of that discriminator.

`"."` must still be the only `capabilities` entry. Mixing it with other
capability paths would make the package root contain nested capabilities, which
the engine rejects.

# Engine consequences retained for accepted legacy packages

Package integrity covers the whole tree. Manifest loading stays unambiguous
because each manifest filename has one loader.

Npm materialization roots are realpath-deduped. Without that, an accepted `"."`
package root would qualify both as the package root and as the capability root
and run `npm ci` twice for the same tree.
