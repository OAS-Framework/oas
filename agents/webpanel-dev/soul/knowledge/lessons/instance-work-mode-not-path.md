---
type: Lesson
title: Instance work is a mode, not a filesystem path
description: In panelData/control-pane instances, work carries the mode string (worktree/checkout/attached); derive the actual work tree as <home>/work before using it as a cwd or allowed file root.
tags: [oas-web, control-pane, worktree, gotcha]
timestamp: 2026-07-22
---

# The trap

Instance objects served by `/api/panel` from `model.collectControlPane` expose
`work` as the work **mode**: `"worktree"`, `"checkout"`, or `"attached"`. It is
not a filesystem path.

The actual work tree path is conventionally `join(inst.home, "work")`;
`model.mjs`'s own `gitState` uses that shape. Endpoints that need the tree, such
as `/api/diff`, must derive `<home>/work` and check `existsSync` before using it.

# Symptom

Using `inst.work` as a cwd fails with a confusing "no such directory" or a
misleading 404. The same mistake breaks file-serving allowed roots if `inst.work`
is added as though it were a path.

# Rule

Treat `inst.work` as presentation metadata about the work mode. Build paths from
`inst.home` when the web panel needs the actual instance work tree.

# Related concepts

- [oas-web architecture](/architecture/oas-web-architecture.md)
