---
type: Lesson
title: Resource tree symlink containment must recurse and fail closed
description: Resource containment must recurse through contained directory symlinks with a visited realpath set, validate every descendant link under both skill and capability-agent trees, and let deeper path-escape errors propagate.
tags: [security, symlinks, containment, testing]
timestamp: 2026-07-27
---

# Swallowed security throws in recursive walkers

A package dependency fixture exposed a two-link shape: `node_modules/dep` was a
relative symlink to `../vendor/dep` (inside the package), and that target
directory contained another symlink that escaped the containment boundary. The
lexical walk visited `vendor/dep` with dependency context lost and skipped it.

The first fix was to recurse through contained directory-link targets while
preserving dependency context, with a realpath visited set for loops. Apply that
same traversal to every package resource tree before trusting or exposing it:
skill trees and capability-agent soul directories both need descendant target
validation before the runtime reads `soul.yaml` or exposes `_soulDir`. The test
still failed because the recursion sat inside a broad probe guard:

```js
try {
  if (lstat(target).isDirectory()) walk(target, true);
} catch {}
```

That `catch` handled the `lstat` convenience probe and also swallowed genuine
path-escape errors thrown by the recursive walk. Narrow guards to exactly the
probing call; recursive containment failures must propagate and fail closed.

# Regression shape

Validate walker fixes against a real `npm ci` `file:` dependency layout, not only
hand-built trees: npm creates `node_modules/dep` as a relative symlink, which is
part of the bug shape. The regression should include the inside-link to a target
directory that itself contains the escaping link. See the testing playbook's
[symlink-containment fixture note](/playbooks/test-conventions.md).

Fail-closed strengthening can also invalidate older tests that asserted
degrade-to-untrusted semantics; update those tests deliberately when the security
posture is supposed to throw.
