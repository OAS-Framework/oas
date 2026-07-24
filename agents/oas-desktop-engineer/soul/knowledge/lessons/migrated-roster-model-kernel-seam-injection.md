---
type: Lesson
title: Migrated roster model gets deployment seams injected, not kernel-relative imports
description: Code migrated out of the kernel tree must not keep kernel-relative imports; the desktop server first used injected core seams and later removed the direct core bridge in favor of an app-owned deployment reader plus CLI mutation boundary.
tags: [desktop, server, model, kernel-seam, migration]
timestamp: 2026-07-24
---

The roster collector (`collectControlPane`) used a kernel-relative static import
from `../core.mjs`. In its new home (`packages/desktop/server/model.mjs`) that
path is wrong and would silently couple the app to a layout.

The first migration step injected the core dependency (`model.initModel(core)`) rather than letting the moved module import the kernel by relative path. That avoided the bad static import, but it was still a transitional direct-core bridge.

The durable pattern after the bridge removal is stronger: code migrated out of
the kernel tree takes explicit deployment seams from the app-owned reader for
read-only discovery, and OAS mutations stay behind the CLI boundary. Do not
revive `FRAMEWORK_ROOT`/`lib/core.mjs` imports just to make a migrated desktop
module work.
