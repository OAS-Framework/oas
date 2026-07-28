---
type: Lesson
title: Tightening a reader means testing it against everything the writer can emit
description: Making parseLockSource strict rejected catalog:oas.okf@release@candidate — a source acquisition really writes — because the reader split at the last @ while the public parser splits at the first.
tags: [packages, kernel, lock-v2, review, testing]
timestamp: 2026-07-28
---

Tightening lock-source parsing (to stop `catalog:../evil` being reclassified as
a local path) introduced the opposite bug in one round: the reader began
rejecting a source the writer legitimately produces.

`parsePackageSource` splits a catalog spec with
`/^([a-z0-9][a-z0-9._-]*)(?:@(.+))?$/` — the id charset excludes `@`, so the
split is at the **first** `@` and the selector keeps the rest.
`parseLockSource` split at the **last** `@`. For a one-`@` selector the two
agree, which is why every existing test passed. For `oas.okf@release@candidate`
— a perfectly ordinary git ref spelling — the reader saw the id
`oas.okf@release` and failed the whole lock as `invalid-lock`.

# Two rules that would have caught it

1. **A strict reader must be derived from the writer's grammar, not written
   next to it.** Where the writer uses a regex, mirror that regex's *splitting
   behavior*, not just its accepted charset. "Last separator" vs "first
   separator" is invisible until a value contains two.
2. **Round-trip tests beat validity tests.** Asserting "these malformed strings
   are rejected" proves nothing about the writer's output. The test that
   matters constructs the value the way production does (acquire), then feeds
   it to every reader (validate, restore, update) and asserts the value comes
   back unchanged. That one test would have failed immediately.

The schema had the same defect independently (`(@[^@#]+)?` excluded `@` from
selectors) — a second copy of the grammar drifting the same way, which argues
for deriving the pattern from the same reasoning in the same commit rather than
hand-writing it.

# The asymmetry worth remembering

Git sources KEEP the last-`@` split, and that is correct: `git@host:org/repo.git`
means the URL half legitimately contains `@`, so the last one is the only
unambiguous separator. Catalog ids cannot contain `@`, so the first one is. The
two source kinds genuinely need opposite rules — writing one helper for "split
on @" would have been the wrong abstraction.

See [lock source strictness](/lessons/lock-source-strictness-prevents-reclassification.md).
