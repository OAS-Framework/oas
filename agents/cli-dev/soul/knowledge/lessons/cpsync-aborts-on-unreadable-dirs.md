---
type: Lesson
title: fs.cpSync can abort the process on unreadable directories
description: Node 22's cpSync native recursion can abort the process, not throw a catchable JS error, when it meets an unreadable directory; recovery code must hand-walk hostile trees instead.
tags: [node, filesystem, rollback, error-handling, robustness]
timestamp: 2026-07-29
---

Found while pinning a rollback journal's "construction failure must leave no
backup residue" case. The test made a protected directory unreadable to force a
snapshot failure, and instead of a test failure the whole test process died:

```text
libc++abi: terminating due to uncaught exception of type
std::__1::__fs::filesystem::filesystem_error:
filesystem error: in directory_iterator::directory_iterator(...): Permission denied
```

Reproduced standalone on node 22: `cpSync(src, dst, { recursive: true })` where
`src` contains a `chmod 000` subdirectory does **not** throw a JS error. It
aborts the process. `try/catch` around it never runs, and neither does any
`finally`, any cleanup handler, or any typed-error path.

# Why it matters beyond the test

Any code whose *job* is recovery must not use `cpSync` on attacker-, user-, or
accident-shaped trees. A capability store with one bad-permission directory — a
stray root-owned file, an interrupted install — would kill the whole command
with a libc++ message, no diagnostic, no rollback, and no cleanup of whatever
the run had already staged.

This supersedes the earlier safe-looking `cpSync` measurement in the [run-level
rollback journal craft](/lessons/run-level-rollback-journal-craft.md): preserving
mode, timestamps, and symlinks on readable inputs is not enough for recovery
code. The failure the recovery code exists to handle can be exactly the failure
that prevents it from running.

# Replacement shape

A hand-walked recursion using `lstatSync` / `readdirSync` / `copyFileSync` /
`symlinkSync` raises ordinary catchable `EACCES`, and costs about fifteen lines:

```js
function copyExact(from, to) {
  const st = lstatSync(from);
  mkdirSync(dirname(to), { recursive: true });
  if (st.isSymbolicLink()) { symlinkSync(readlinkSync(from), to); return; }
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) copyExact(join(from, name), join(to, name));
    chmodSync(to, st.mode & 0o7777);      // AFTER children
    utimesSync(to, st.atime, st.mtime);   // AFTER children
    return;
  }
  if (!st.isFile()) fail("E_JOURNAL_UNSUPPORTED_ENTRY", …); // fifos/sockets fail closed
  copyFileSync(from, to);
  chmodSync(to, st.mode & 0o7777);
  utimesSync(to, st.atime, st.mtime);
}
```

Two details the walker has to get right that `cpSync` hid: **mode and times go
on after the children**, because a read-only directory applied first rejects its
own contents; and non-regular entries such as fifos and sockets must fail closed
rather than being handed to `copyFileSync`, which would block.

# Generalizable rule

Before using a convenience filesystem API inside error-recovery code, check what
it does on the *hostile* input, not the happy path. "Throws an error you can
catch" is an assumption worth one five-line probe — here the assumption was
wrong in the most damaging possible way.
