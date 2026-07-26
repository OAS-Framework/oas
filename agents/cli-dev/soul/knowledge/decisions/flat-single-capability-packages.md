---
type: Decision
title: Flat single-capability packages are supported
description: A capability directory may be the package root with oas-package.json and oas.json side by side when capabilities is exactly ["."]; package integrity covers the whole tree, and npm materialization roots are realpath-deduped.
tags: [packages, manifest, layout]
timestamp: 2026-07-26
---

# Decision

A package may be a flat, single-capability tree: the package root is also the
capability directory, with `oas-package.json` and `oas.json` side by side, when
the package manifest declares `capabilities: ["."]`.

`"."` must be the only `capabilities` entry. Mixing it with other capability
paths would make the package root contain nested capabilities, which the engine
rejects.

# Engine consequences

Package integrity covers the whole tree. Manifest loading stays unambiguous
because each manifest filename has one loader.

Npm materialization roots are realpath-deduped. Without that, a flat package root
would qualify both as the package root and as the `"."` capability root and run
`npm ci` twice for the same tree.
