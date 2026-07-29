---
type: Decision
title: A mixed migration scope is refused whole — no residue container, ever
description: Founder ruling on the retained-locks data loss — `retain` clears convertible like hold/manual, apply refuses before any mutation, and `residue` is gone from every result shape.
tags: [migration, capability-materialization, decision, fail-closed]
timestamp: 2026-07-29
---

Resolution of the data loss recorded in
[guided mixed retain](/lessons/guided-mixed-retain-needs-residue-or-hold.md).

**Ruling (founder, via the coordinator): refuse mixed scopes; keep the entire
scope byte-identical v1. Do not add a residue container.**

What that means concretely, and why each part is load-bearing:

- **`retain` clears `convertible`, exactly as `hold` and `manual` do.** Nothing
  else could stop the conversion, because `retain` is otherwise a *successful*
  plan row — the plan looked healthy right up to the point where the write
  dropped the rows.
- **`applyLegacyLockMigration` refuses a mixed scope before any lock, artifact
  or ignore mutation.** Not one official artifact is partially acquired. The
  message names every retained entry with its source, states that the whole v1
  scope stays usable, and — when every retained source is package-mappable —
  names plain `oas migrate` as the command that *can* convert the scope
  completely. A refusal that does not tell you the way forward is a dead end.
- **No official work at all stays a truthful no-op**: `skipped`, with the
  untouched ids under `retained`.
- **`residue` is removed from every result shape**, the CLI's human and JSON
  output, the engine contract's return shape, and the public docs that promised
  it. Doctor's `migrationResidue` stays and is *not* the same thing: it
  diagnoses pre-existing on-disk state written by an older release that
  converted around entries — precisely the damage this refusal now prevents.
- **The CLI plan gained a `blocked` status** so dry-run and apply agree, and a
  dry run containing one is nonzero. Automation must never read a blocked scope
  as ready.

The accepted cost is real and was chosen deliberately: a 0.18 deployment holding
a capability with no published package cannot migrate until that package exists.
That is strictly better than converting around it, because the alternative is
silent data loss with the artifacts still on disk and nothing looking wrong.

The general principle, worth carrying past this fix: **when a format has no
place to put something, the operation that would leave it behind must refuse,
not improvise.** The engine already said so in a comment on its `manual` branch
and simply had not applied it to every action that can leave something behind.
