---
type: Lesson
title: A required-hook guarantee shipped inert because its only user swallowed its own failures
description: The kernel enforced required spawn hooks correctly, but oas-aweb converted every fatal path into a warning on exit 0, so the mechanism never fired for the capability it was built for.
tags: [capabilities, hooks, fail-closed, testing, contracts]
timestamp: 2026-07-27
---

# Lesson

`required: true` on a spawn hook was implemented, tested, and green: a nonzero exit fails
the spawn and rolls it back. It protected nothing.

`capabilities/oas-aweb/bin/oas-aweb.mjs` caught missing `aw`, a missing `.aw` root, and
every minting exception, printed `{"warning": …}` and exited **0**. The kernel saw success.
An instance still started with no messaging — precisely the outcome the flag existed to
prevent.

**A fail-closed mechanism is only as strong as the exit code of its first user.** When
adding an enforcement, the same change must convert its intended user, and the test must
execute the SHIPPED implementation. Fixture hooks that exit 1 on demand prove the kernel
half and nothing about whether any real capability will ever trigger it.

# The compensation half

`runLifecycleHooks` discarded `e.stdout` on failure, so `results.meta` had nothing for the
failing capability, and rollback called retire with `{}`. aweb's retire refuses without
`meta.alias`, so a failure *after* `aw team join` stranded a remote identity.

Rule: **a failing hook's stdout is its only channel for reporting external state it already
created.** Parse it on the failure path exactly as on the success path, and have the hook
record such state the instant it exists, not when it finishes successfully — the failure
may arrive in between.

# Fixing the obvious paths is not fixing the class

The first correction made the visible failures fatal — missing `aw`, missing `.aw`,
minting exceptions — and left three more terminal pre-mint paths on `warn()`/exit 0: no
resolvable team, an ambiguous bare team name, no matching membership. Each reaches the end
of setup having minted nothing, i.e. the exact condition being guarded, and each survived a
review round.

When converting a component to fail closed, enumerate **every** exit from the function and
ask "did the thing this guarantees actually happen?" — do not patch the paths the reviewer
happened to name.

# Converting a path to fatal is a claim that the path is CORRECT

Making "no matching membership" fatal turned a latent field-name drift into a hard block on
every spawn: `aw team list --json` returns `memberships`, the spawn path read `teams.teams`,
and the hook's own `setup` path already read `memberships || teams`. While the mismatch only
warned, nobody noticed. Fail-closed surfaced it — which is the point — but the lesson is
that **the moment before you make a path fatal is the moment to verify the path is right**,
against the real tool's output, not against the fixture that was written alongside the bug.

That fixture asserted the stale `{"teams": []}` shape, so it agreed with the defect. Two
call sites now share one reader, because drift between them was the root cause.

# Compensation must not overclaim either

The rollback announced "spawn rolled back" while the retire hook had turned a failed remote
delete into an exit-0 warning — and the rollback then removed the local key that was the
only means of deleting it. Two rules fell out:
- a compensation hook that could not finish must exit nonzero;
- "nothing to undo" and "tried and failed" must be distinguishable at the source, or the
  caller cannot tell completion from silent loss.

# Keep the distinction the decision rests on

Making everything fatal would have been easier and wrong. The founder's decision separates
"the capability cannot function" (no identity → fail) from advisory trouble (the Claude
channel plugin, a team-name mismatch → warn). Flattening that would turn every transient
annoyance into a spawn blocker and discredit the mechanism.

# Schema must not out-permit the runtime

The published schema accepted `required` on `retire`/`soul-scaffold` while the runtime
rejected it, so authoring tools could approve a manifest OAS refuses to load. Any
constraint enforced at load time needs the same constraint in the public schema, with a
test compiling the real schema and asserting BOTH directions.

See also [generous stub gate](/lessons/generous-stub-fail-closed-open-gate.md) and
[rollback probe empty-stderr lesson](/lessons/rollback-probes-argv-and-fail-closed.md) — three variants of one theme this
branch kept hitting: the test agreed with the code instead of with the requirement.
