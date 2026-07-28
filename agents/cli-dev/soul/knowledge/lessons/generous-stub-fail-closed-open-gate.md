---
type: Lesson
title: A stub more generous than the real thing turns a fail-closed test green while the gate is open
description: The pi list stub always printed an install path, but real pi prints it only when the package is installed — so the stale-row regression passed for the wrong reason and the gate it guarded was still open.
tags: [testing, fail-closed, pi, fakes, review]
timestamp: 2026-07-27
---

# Lesson

The gate: a required runtime package must actually be installed, not merely configured.
The regression: a settings row whose files were never installed must fail the spawn. It
passed. The gate was open anyway.

Real pi, from its own list command:

```js
console.log(`  ${display}`);
if (pkg.installedPath) { console.log(chalk.dim(`    ${pkg.installedPath}`)); }
```

The path line appears **only when the package is really installed**. My stub printed a
path unconditionally, so the "stale row" fixture emitted a directory that merely did not
exist — which the check `!!row.dir && !existsSync(row.dir)` happened to catch. The real
shape is *no path line at all*, giving `dir: undefined`, which that check evaluated to
false and waved through.

So the test exercised a condition that cannot occur, and asserted nothing about the one
that does.

# The rule

**A fake must be no more generous than the real thing.** Every field a stub always
populates is a branch the real system can leave empty and your tests will never reach.
When writing a stub for an external tool, read how that tool actually renders the output —
conditionals in its formatter are exactly the branches your gate has to handle.

Corollary for fail-closed logic: `!!x && !valid(x)` silently passes when `x` is absent.
Absence and invalidity usually deserve the same verdict, so prefer `!x || !valid(x)` and
give each its own message.

# Also

When a runtime cannot be consulted at all, its config file is not a substitute. Settings
record what was **configured**, never what is **installed**. Mark such rows unverified and
fail closed rather than trusting them.

See also [runtime contract lesson](/lessons/runtime-contract-not-resolution-internals.md).
