---
type: Lesson
title: Desktop spawn-modal race — roster appearance ≠ terminal readiness
description: The desktop panel roster lists a freshly spawned instance before its tmux session registers, so post-spawn auto-open must gate on running plus tmux readiness, not mere presence.
tags: [desktop, spawn, tmux, race]
---

# Desktop spawn-modal race — roster appearance ≠ terminal readiness

In `packages/desktop`, `doSpawn` (`renderer/views/spawn.mjs`) polled `waitForInstanceInPanel`, which only checked that the instance appeared in `/api/panel`, then called `openTerminal`. But `openTerminalTabInner` (`renderer/shell.mjs`) required `inst.running && inst.tmux?.session` and otherwise fired a blocking `alert("no live tmux session")`.

The panel snapshot can list the instance a beat before tmux registration, so the auto-open path can alert spuriously and leave the spawn modal appearing stuck if the modal is not closed on success.

Lesson: any post-spawn auto-navigation must wait for the same readiness predicate the open path enforces (`running` plus tmux session). Automated paths should avoid blocking `alert()` failures; degrade to status text when readiness is still pending. This was routed as a single-developer fix to the `oas-desktop-engineer` soul.
