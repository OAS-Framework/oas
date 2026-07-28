---
type: Lesson
title: One lstat of a full path cannot tell absent from broken link at depth
description: existsSync plus a single lstat detects a dangling symlink only when it is the final component; an intermediate broken link makes both fail and reads as absent, downgrading path-escape to a plain not-found.
tags: [containment, security, kernel, review]
timestamp: 2026-07-28
---

Classifying a configured path inside a fetched checkout has three outcomes that
must stay distinct: **absent**, **present but dangling**, and **escaping**. The
obvious implementation —

```js
if (!existsSync(target)) {
  let dangling = false;
  try { dangling = !!lstatSync(target); } catch {}
  if (dangling) throw pathEscape(...);
  return undefined;          // absent
}
```

— only works when the dangling link IS the final component. Given `dangling ->
missing` and the path `dangling/sub`, both `existsSync` and `lstatSync` fail on
the full path, so a broken link at depth is reported as "no package here"
(`invalid-source`) instead of `path-escape`.

Both still fail closed, so this is a taxonomy defect rather than an exploit —
but the contract promised "a broken link at any depth is path-escape", and a
guarantee that holds only for the last path component is not the guarantee that
was documented.

# The fix shape

Walk the components. For each prefix: `lstat` (a throw here is genuinely absent
→ return undefined); if it is a symlink, `realpath` it (a throw is a broken link
at THIS depth → `path-escape`, naming the depth) and check containment of the
result. Then resolve and check the final target.

The general lesson: **when a check has more outcomes than a single syscall can
distinguish, the loop is not an optimization detail — it is the check.** Any
"does this path exist / is it safe" helper that collapses a multi-component path
into one probe is worth re-reading for exactly this.

Naming the failing depth in the message (`traverses a broken symlink at
"mid/broken"`) costs one `slice().join()` and is the difference between a
diagnosable source-layout defect and a shrug.

See [payload root subtree extraction](/lessons/payload-root-subtree-extraction.md).
