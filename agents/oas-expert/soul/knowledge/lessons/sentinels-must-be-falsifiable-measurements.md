---
type: Lesson
title: A sentinel that cannot fail is worse than no sentinel
description: Self-testing verification harnesses must audit each sentinel expression for structural constants — a sentinel whose firing is guaranteed by construction certifies nothing while inflating the harness's credibility.
tags: [verification, harness, sentinel, falsifiability]
timestamp: 2026-08-25
---

Observed in the OAS Phase-5 clean-room gate (2026-08-25). The harness design
required sentinel-first self-testing: perturb an expectation, show the
assertion fails, then run the real assertion. Two of 44 sentinels were
tautological, and both were only caught by an adversarial auditor reading the
sentinel EXPRESSIONS:

- One ANDed in a conjunct false by construction (`[ "$HOME" = "$REALHOME" ]`
  inside a clean room whose whole premise is HOME != REALHOME), so it fired
  unconditionally and never read the real home it claimed to check — while
  the real home actually contained the artifact whose absence the sentinel
  supposedly proved.
- One grepped for a literal invented by the harness itself
  (`p5-nonexistent-type`), which no real end-state could ever produce.

Both sat next to genuine assertions, so the substance survived — but the
harness's own record described the tautological sentinels as evidence, which
made the record false even where the release was fine.

# The lesson

Rules that would have caught them at authoring time:

1. A sentinel must read THE SAME value its paired assertion reads, and its
   perturbation must be of the expectation (or a copy of the artifact), never
   a fabricated third value.
2. Audit each sentinel expression for structural constants: any conjunct or
   search term whose truth value is fixed by the harness's own construction
   makes the sentinel unfalsifiable.
3. Demonstrate each sentinel BOTH firing (perturbed → fails) and breaking
   (perturbation neutralized → the harness flags SENTINEL_BROKEN); a sentinel
   that cannot be made to break is decoration.
4. The record must describe what was measured, not what the probe was named —
   a sentinel labeled "package not in real home" that never reads the real
   home is a false record line even when the underlying claim happens to be
   true.

# Related

- [Final verification must hunt the fix's class, not re-test its instance](/lessons/incomplete-fix-class-final-verification.md)
  — both are cases of a correct-looking artifact (fix, sentinel) whose own
  description overclaims; the auditor's job is to falsify the description,
  not admire the artifact.
