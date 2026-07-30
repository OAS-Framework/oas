---
type: Lesson
title: Node recursive cpSync can bypass JavaScript cleanup on unreadable trees
description: On Node 22/macOS, recursive fs.cpSync over an unreadable directory can terminate through a native filesystem exception instead of throwing a catchable JavaScript error.
tags: [node, filesystem, transactions, packages]
timestamp: 2026-07-29
---

# Node recursive cpSync can bypass JavaScript cleanup on unreadable trees

A CLI developer measured that `fs.cpSync(..., { recursive: true })` on Node 22/macOS can abort the process with an uncaught libc++ `filesystem_error` when native recursion encounters an unreadable directory. JavaScript `try`, `catch`, `finally`, typed error conversion, staging cleanup, and rollback do not run.

Do not use recursive `cpSync` on user-, package-, or capability-shaped trees when transaction cleanup is required. A catchable copy walker should:

- inspect with `lstat`;
- recurse with `readdir`;
- copy regular files and preserve symlink targets without dereferencing;
- apply directory modes and timestamps after children;
- reject FIFO, socket, device, and other unsupported entries; and
- preserve containment and deterministic failure reporting.

Pin regressions in a child process so a native abort cannot kill the main test runner, and assert the failed operation leaves no staging, lock, artifact, or ignore mutation.

Related: [Compose atomic engine operations with an outer command rollback journal](/lessons/compose-atomic-engine-operations-with-an-outer-command-journal.md).
