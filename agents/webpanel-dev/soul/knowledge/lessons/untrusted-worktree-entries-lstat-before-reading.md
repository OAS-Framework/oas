---
type: Lesson
title: Lstat untrusted worktree entries before reading
description: "Desktop viewers must lstat untracked worktree entries before reading them: render symlinks as readlink text and skip FIFOs/devices so untrusted worktrees cannot leak files or hang the server."
tags: [oas-web, desktop-viewers, security, filesystem]
timestamp: 2026-07-22
---

# The trap

Desktop viewers inspect files from worktrees that may be untrusted. Reading an untracked entry before checking its filesystem type can follow a symlink out of the workspace or block forever on a FIFO/device.

# Rule

`lstat` untracked worktree entries before reading their contents:

- if the entry is a symlink, render the link target text via `readlink` instead of following it;
- if the entry is a FIFO, device, or other non-regular file, skip it.

# Related concepts

- [oas-web architecture](/architecture/oas-web-architecture.md)
- [Guard file-serving paths by realpathing requests and roots](/lessons/file-endpoint-realpath-guard.md)
