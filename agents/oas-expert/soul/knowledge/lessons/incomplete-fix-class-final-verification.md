---
type: Lesson
title: Final verification must hunt the fix's class, not re-test its instance
description: The dominant late-round defect in adversarially reviewed branches is a correct fix applied at one call site while sibling sites keep the defect — and the fix's own docstring then overclaims; verifiers must sweep for the class.
tags: [review, verification, adversarial, fix-completeness]
timestamp: 2026-08-25
---

Observed on the OAS kernel v0.20.1 branch (2026-08-25), where the final
verification round found no broken fixes but a cluster of INCOMPLETE ones:

- A regex replacement-string hazard was fixed at one `.replace` call site with
  a replacer function, while three sibling sites in the same files kept
  interpolating untrusted text as a replacement string — one of them on a
  path that WRITES the corrupted result to a config file.
- Underscore-annotation stripping was added to three manifest/soul readers;
  a fourth reader with the identical spread-over-JSON.parse shape was missed,
  and its map was merged OVER a stripped map.
- A YAML-injection refusal covered four flag-value write paths but not the
  scaffolded `name: <basename>` line — the same injection, same file, written
  by the same commands.
- A desktop digest helper was refactored and given a docstring claiming
  kernel compatibility, while the predicate it selected still diverged from
  the kernel in the over-trusting direction.

The pattern: each fix is CORRECT where applied, its tests pass red→green, and
the docstring or docs then state the guarantee as if it covered the class.
Re-running the fix's own repro proves nothing about the siblings.

# The lesson

1. When a fix closes a hazard shaped like "call site does X with untrusted
   input", the verifier's first move is a sweep for every occurrence of the
   SHAPE (`grep` for the call pattern, trace every producer/consumer), not a
   re-run of the reported repro.
2. Treat every docstring or doc sentence AUTHORED BY THE FIX as a claim to
   falsify: overclaiming prose on top of a partial fix is how partial fixes
   survive review.
3. In fixer briefs, name the class explicitly ("convert ALL sites whose
   replacement argument is interpolated; audit the three files") and require
   the fixer to report the audit, so the verifier can check the audit rather
   than redo it blind.

Incomplete-fix defects are the late-round residue that keeps a branch from
converging when briefs name instances instead of classes: round 1 tends to
surface product truth, round 2 the new guards' own defects, round 3 the
pre-existing edges — and this class hides in round 3.

# Related

- [A sentinel that cannot fail is worse than no sentinel](/lessons/sentinels-must-be-falsifiable-measurements.md)
