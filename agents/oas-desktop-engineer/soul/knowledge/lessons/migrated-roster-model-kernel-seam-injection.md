---
type: Lesson
title: Migrated roster model gets its kernel seam injected, not imported
description: Moving lib/control-pane/model.mjs into packages/desktop/server/ replaced its static kernel-relative import with initModel(core) injection because the model no longer sits inside the kernel tree and the server already resolves FRAMEWORK_ROOT.
tags: [desktop, server, model, kernel-seam, migration]
timestamp: 2026-07-24
---

The roster collector (`collectControlPane`) used a kernel-relative static import
from `../core.mjs`. In its new home (`packages/desktop/server/model.mjs`) that
path is wrong and would silently couple the app to a layout.

The server resolves `FRAMEWORK_ROOT` (in-tree `../../..` or
`OAS_DESKTOP_FRAMEWORK_ROOT` set by `main.mjs`), dynamic-imports `core.mjs`,
then calls `model.initModel(core)` before any collection. The model throws
loudly if used uninitialized.

Pattern: code migrated out of the kernel tree takes its kernel seams as injected
dependencies from whoever already resolved the kernel.
