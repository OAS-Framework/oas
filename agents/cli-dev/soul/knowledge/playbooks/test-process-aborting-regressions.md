---
type: Playbook
title: Test a process-aborting regression in a child process
description: Node's recursive cpSync can terminate the process on an unreadable directory, so the regression test for it must run out-of-process or a failure kills the whole runner.
tags: [testing, node, kernel, packages]
timestamp: 2026-07-29
---

# The hazard

Node 22's `cpSync(src, dest, { recursive: true })` recurses in native code. On
macOS an unreadable directory inside the tree surfaces as an **uncaught libc++
`filesystem_error` that terminates the process** — no JS `catch`, no `finally`.
A transaction using it can never clean up staging or roll back the store, the
lock and the ignore file.

The kernel therefore routes every package-, capability- and user-shaped tree
copy through a hand-written `copyTreeSafe` walk, where `EACCES` is an ordinary
throwable error.

# Why the test must be out-of-process

An in-process test for that regression cannot fail — it *aborts*. `node --test`
reports the whole file as crashed, the remaining tests never run, and the
diagnostic points at whichever test happened to be executing. The signal you
most want is the one the harness cannot deliver.

So the fixture writes a probe script to a temp dir, `chmod 0o000`s a directory
inside a package source, and runs it with `spawnSync(process.execPath, [probe, tmp])`:

```js
const r = spawnSync(process.execPath, [probe, t], { encoding: "utf8" });
assert.equal(r.status, 0, `the probe must exit cleanly, not abort — stderr: ${r.stderr}`);
const out = JSON.parse(r.stdout.trim().split("\n").pop());
assert.notEqual(out.code, "NO-THROW");
assert.equal(out.lock, false);
assert.deepEqual(out.installed, []);
```

`r.status === 0` is the actual regression assertion: a reintroduced `cpSync`
makes the child die by signal, and the parent test fails cleanly with the
child's stderr attached.

# Details that matter

- The probe **restores the mode** (`chmod 0o700`) before reporting, so the temp
  tree stays removable.
- It reports a JSON object on the last stdout line, so the parent can assert on
  *behavior* (typed code, no lock, no staging residue) and not just survival.
- `{ skip: process.getuid?.() === 0 }` — root ignores the permission bits, so the
  fixture is meaningless there. Skip explicitly rather than let it pass vacuously.
- Absolute-path the module under test into the probe with `JSON.stringify(resolve(...))`;
  the child has no import map from the test file.

# When to reach for this

Any regression whose failure mode is *process death* rather than an exception:
native recursion, `process.exit` in library code, stack overflow, OOM. If a
failing assertion would take the runner with it, put the fixture in a child.

See also [test conventions](/playbooks/test-conventions.md).
