---
type: Lesson
title: A byte-preserving config merge must splice line ranges of the local file, never reserialize it
description: Three-way config template sync cannot round-trip YAML through a parser; the merge is a diff3 over exactly-terminated lines whose output is built from the local line array, and two invariants make byte preservation testable.
tags: [config, templates, sync, merge, yaml, byte-preservation, testing]
timestamp: 2026-07-29
---

`oas config sync` compares a recorded adopted base, the current local
`oas-config.yaml`, and the template from the currently locked package. The
binding rule is that untouched local bytes stay byte-identical — comments,
key ordering, blank lines, indentation style, and the presence or absence of a
trailing newline.

# The forbidden implementation

Parsing all three with the kernel's YAML subset, merging the objects, and
reserializing is the obvious route and it is wrong: a round trip rewrites the
whole file even when one key changed. Comments do not survive a parser that
does not model them, and key order and indentation become the serializer's
choice rather than the adopter's. The Decision makes the local config
"fully locally owned", which a whole-file rewrite silently contradicts.

# The shape that works

1. **Split lines keeping their terminators.** `splitConfigLines(t).join("") === t`
   for every `t`, including CRLF files and a final line with no newline. Line
   identity is then byte identity, so a line differing only in its terminator is
   a real difference rather than a silent rewrite.
2. **Diff each side against the base** (LCS) into half-open change regions;
   a pure insertion is a zero-width base range.
3. **Group regions by overlapping-or-TOUCHING base range.** Touching must count:
   an insertion at line `p` and a replacement starting at `p` are the same
   disputed spot, and treating them as independent interleaves two sides' edits
   at one point without either side agreeing to it.
4. **Classify**: only the template moved → upstream; only local moved → local;
   both moved to the same text → agreed; both moved differently → conflict.
5. **Build the output from the LOCAL line array**, splicing only the selected
   regions. Byte preservation is then structural, not a property to be checked:
   with nothing selected the output is the input array rejoined.

# Adjacency entanglement is correct, and surprising

If the template changes lines `a` and `b` while the local file changes only `b`,
LCS yields one contiguous template hunk covering both, so the whole span becomes
a single conflict. `a` is *not* applied independently. This looks like
over-conservatism but it is the right call: applying `a` behind the user's back
while `b` is still being decided writes an unreviewed upstream edit. Write the
test that documents it, because the first instinct on seeing it is to "fix" it.

# Two invariants make it testable

Randomized three-way inputs (deterministic PRNG, mutations = delete/change/insert
per line) verified over hundreds of rounds:

* **Choosing local everywhere is a byte-identical no-op.** Directly the
  byte-preservation rule.
* **Choosing the package side everywhere reconstructs the template exactly.**
  This is the strong one: it only holds if the regions plus the untouched spans
  between them account for every byte of both files, so it catches off-by-one
  errors in the base→side offset mapping that hand-written cases miss.

Plus: regions are disjoint and ordered in the local file, and every region's
recorded slice text really is the file's bytes at its own indices.

# Fail-closed details worth keeping

* A conflict has `recommended: null`, so applying with no decision throws
  rather than picking — that is the noninteractive fail-closed rule, expressed
  in the data instead of in the CLI.
* The plan carries a digest of the local text it was computed from; line indices
  are meaningless against any other text, so applying a plan the user reviewed
  before the file changed under them must fail, not splice at stale offsets.
* An edit decision that does not end in a newline while local content follows
  would glue two YAML lines together; terminate it, and let only a
  genuinely-final region end the file without a newline.
* The LCS tables are O(n*m); guard on the line-count product so a pathological
  input fails closed instead of allocating gigabytes.

The whole core is engine-independent — three texts in, one text out, no lock,
no filesystem, no package identity — which is what let it be built during a
contract freeze on the engine seam.
