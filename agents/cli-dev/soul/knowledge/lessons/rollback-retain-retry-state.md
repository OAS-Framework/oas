---
type: Lesson
title: Rollback must never delete the state needed to finish the rollback
description: A failed required-hook spawn removed the instance home after admitting compensation was incomplete, destroying the only credential able to retry the remote self-delete and turning a transient failure into permanent residue.
tags: [kernel, rollback, capabilities, recovery, fail-closed]
timestamp: 2026-07-27
---

# Lesson

Compensation failed, the error correctly said `rollback INCOMPLETE — external state may
remain`, and the very next statement was `rmSync(home)`. For aweb that home contains
`.aw` — the only signing key that can self-delete the remote identity. So the code
diagnosed a recoverable situation and then made it unrecoverable.

**If cleanup did not finish, the state cleanup needs must survive.** Quarantine rather than
delete: keep the home, mark it (`.oas-rollback-incomplete.json`) with what failed and what
is outstanding, remove the parts that are independently safe (worktree, branch), launch
nothing, and name the retained path plus the retry command in the error. Delete only once
compensation reports complete — or reports there was nothing to undo.

Corollaries:

- The marker must record **capability/hook names and cleanup diagnostics only**. Hook output
  can contain anything; a quarantine file is not a place to spill it.
- Status and doctor must read a quarantine as **retained state, not a live instance**, or
  the operator sees a phantom agent.
- "Nothing to undo" and "tried and failed" must be distinguishable at the source, or this
  logic cannot tell completion from silent loss — see
  [required-hook guarantee lesson](/lessons/required-hook-guarantee-first-user.md).

# The test agreed with the bug

The existing regression contained the comment "the local key that could still delete it is
about to be removed" and asserted the behaviour anyway. Writing down that a destructive step
happens is not the same as deciding it should. When a test comment explains why something
lossy is fine, that is the moment to check whether it is.

The replacement drives the full cycle instead: a hook writes credential material and fails,
compensation fails, the credential SURVIVES, the operator fixes the cause, the retry
succeeds *because* the state was still there, and only then is the home gone.

# A recovery path must be executable, not just advertised

The first version of the quarantine told the operator to run `oas retire <instance>` — a
retry that could not possibly work. The required-hook failure happens BEFORE
`instance.json` is written, so retire found no metadata, skipped every hook, and deleted
the home. Preserving the credential bought nothing because nothing could use it.

**Whenever you retain state for a retry, persist everything that retry needs, and verify
the retry path actually runs.** Here that meant a cleanup descriptor in the shape the
retire path already reads (repo, work/branch, capability runtime, the failed hook's
metadata), plus re-verification so a retry that still fails retains the home again instead
of becoming the deletion.

# Verify the WHOLE transaction on retry, not just the part that failed loudest

A quarantine can exist because Git cleanup failed, not because a hook did. Re-running only
the hooks and clearing the home on their success left a registered worktree or a live branch
behind while reporting removal. Whatever the original rollback owned — hooks, worktree,
branch — the retry must redo and re-verify all of it, and any failure must keep the home.

Related: a rollback-owned branch is not the user's branch. Deleting it must not depend on a
normal-retire flag like `--delete-branch`; spawn created it, so cleanup owns it.

# An unsuccessful retry must not exit zero

`retireInstance` returned `rollbackIncomplete` and the CLI ignored it, printing "Retired …"
and exiting 0 while the home and the external state remained. A structured result nobody
surfaces is the same as no result: scripts and humans both read the exit code.

# Prove a regression can fail

The test for the original quarantine asserted only that the directory was gone — true
whether or not a single hook ran. Before keeping the replacement I reverted the fix and
confirmed the test went red. Three defects on this branch survived because a test agreed
with the code instead of the requirement; a two-minute revert-and-rerun would have caught
each one.

It caught a fourth immediately. My first Git-verification regression passed with the fix
REMOVED: it returned early whenever the initial rollback happened to succeed, so it never
reached the path it claimed to cover. **A test that cannot fail is not evidence.** Run the
revert check on every regression that guards a fail-closed path.

# The escape hatch must escape the state that needs escaping

Retaining state fails closed by design, so the manual override is the only way out — and it
has to work in exactly the states that trigger the retention. A truncated marker made
`--force` useless: the unusable JSON still parsed as "a quarantine", so force got past the
identity guard and then fell into the retry branch, which could not retry, reported the
home incomplete, and retained it. Forever. **Every fail-closed path needs one state where
its override is tested, and that state is the degenerate one** — the marker that is empty,
truncated, or half-written, not the well-formed one.

The general rule: treat *invalid* as *absent* wherever absence already has a defined
answer. `{}` is not a cleanup descriptor; a descriptor missing its fields is not one either.
Anything else gives you two failure modes to reason about where one would do — the same
shape as `!!x && !valid(x)`, which passes silently when x is absent.

And "invalid" has to be judged against USE, not against syntax. My first fix asked only
"does it parse, and is `cleanup` an object?" — so `{"cleanup": {}}` and `{"cleanup": []}`
sailed through into exactly the unremovable state the fix existed to remove. The retry
consumes `repo` (to resolve capabilities and rerun hooks) and `work`/`branch` (to redo the
Git steps); those are the fields that decide usability. **Validate a recovery record against
the code that will consume it, field by field, or you have only moved the failure from
"unparseable" to "parseable and useless".**

Field by field was still not deep enough, and the second miss was worse than the first.
`capabilityRuntime` is handed to `runLifecycleHooks` **as the capability set**, so
`[{}]` — an array, therefore "valid" — resolved zero hooks, reported no failures, and the
retry CLEARED the quarantine: the credential deleted, the external state left behind. The
shallow check turned a stuck home into a destroyed one. `[null]` threw inside the hook loop
instead, which `--force` cannot get past; an unrecognised `work` string skipped the Git
cleanup and called it complete.

The rule that would have caught all three: **validate to the depth the value is consumed,
not to the depth it is stored.** A field passed on as a domain object must be checked as one
(every entry a capability with an id), an enum must be checked against its enum, and an
empty collection must be judged against the situation — a quarantine exists because a
capability's hook failed, so "no capabilities" cannot be true. Where the record names what
went wrong, cross-check the two halves against each other: the descriptor must be able to
rerun the capabilities the marker says failed.

# Validation was the wrong instrument; verification was

Three review rounds went into the same predicate, each one accepting a shape that could not
work, and the fourth finding was the same shape again: a descriptor naming the right
capability but carrying no retire hook for it — or naming it correctly while the config had
drifted so nothing resolved. Every round I widened the field checks; every round something
structurally valid and functionally empty got through. That is the signal that the
instrument is wrong, not that it needs another clause.

The retry does not actually need the descriptor to be *well-formed*. It needs the outstanding
cleanup to have *happened*. So the marker now records what is outstanding as data
(`outstanding.hooks` — the capability ids whose retire hook failed or reported incomplete),
and the retry clears the quarantine only if each of those ids actually ran and succeeded.
Zero capabilities resolved is now an incomplete cleanup rather than a clean sweep, whatever
the reason, and no future descriptor shape can produce a silent success.

**When shape-checking an input keeps failing to keep you safe, stop checking the shape and
start checking the outcome.**

# A proof obligation of zero is not a proof

The first verification pass still had one hole, and it is the one worth remembering: the
outstanding list was required to be an ARRAY but allowed to be EMPTY. A marker claiming
nothing outstanding sails through verification — there is nothing to prove — and the home
is deleted exactly as before. Switching from validation to verification does not help if
the thing being verified can be vacuous.

Two things fixed it, and both are general:

- **Model every category of outstanding work as data, not just the loudest one.** Retire
  hooks were recorded; the rollback-owned Git debt was not, so it could not be part of the
  invariant. Anything a retry must redo has to be nameable.
- **Make "nothing outstanding" impossible by construction and rejected on read.** The
  producer only writes the marker when something IS outstanding, so an empty record is not
  one of ours — the writer fills it conservatively if both categories somehow came up
  empty, and the reader refuses it.

The other half of the same lesson: know which empty case is legitimate. Here exactly one is
— a worktree quarantine where the hooks finished and only the branch survived — and there
the Git verification is the proof. Rejecting empties wholesale would have broken a real
producer output, so the rule is scoped to the mode that cannot have Git debt, and the
legitimate shape has a positive test of its own.

Validation asks "could this work?", which is a guess about the future; verification asks
"did it work?", which is an observation. Only one of them can be wrong in the direction that
destroys data. Keep the strict contract too — versioned, and required down to the fields the
producer always writes — but as the cheap first gate, not as the guarantee.

# Silence from a capability that declares no cleanup is not evidence

The last hole in the rollback was a capability declaring a REQUIRED spawn hook and no
`retire` hook — a shape the manifest permits. Its spawn hook creates a remote identity and
writes the local key, then fails. Compensation runs zero hooks, so it reports zero
failures, `incomplete` stays empty, and the CLEAN-rollback path deletes the home and the key
while the remote state lives on. Every safeguard on this branch was downstream of
`incomplete` being non-empty; nothing asked whether compensation had been *possible*.

**An empty failure list means "nothing reported a problem", not "there was no problem".**
Before trusting it, check that something was actually in a position to report.

The first fix over-corrected and four existing tests caught it: quarantining EVERY
required-hook failure without a retire hook turns the ordinary case — a hook that fails
having created nothing — into litter only `--force` can clear. The discriminator was already
in the protocol: metadata is how a hook says "I created this, here is what you need to undo
it", and the failure path already parses it. So a failed hook that REPORTED state, with no
retire hook behind it, has handed OAS a receipt it cannot act on → quarantine; one that
reported nothing gets the clean rollback. Those four tests were not obstacles to route
around — they were the specification of the common case.

# A fail-closed default needs an operator override, or it is a trap

Verifying rather than validating creates a state that can never clear on its own: a
capability offering no way to undo its own setup, a remote that is gone for good. Retaining
forever is not safety, it is a directory the operator cannot remove through the tool that
created it. So `--force` overrides retention as well as identification — the home goes, and
everything still outstanding is PRINTED as state the operator now owns.

The pairing is the point: fail closed by default so nothing is destroyed by accident, and
give one explicit, loud override so nothing is undeletable. Either half alone is a bug —
without the default you lose credentials, without the override you strand homes.

# A path in a message to a human must be the path, not a reconstruction

The incomplete-cleanup diagnostic rebuilt the retained home as
`<root>/<agent>/instances/<name>` because that is where most instances live. Capability and
local agents home under the scope's sibling `local-agents/`, so the one message whose entire
purpose is "go look at this directory yourself" sent operators to a directory that does not
exist. The retire path already HAD the real path — it found the home to retain it.

**When code has located something, it must pass the located value on, not a rule for
deriving it.** A derivation is a second implementation of the lookup, and it will drift from
the first one exactly where the layout is unusual — which is where the human already needed
the help.

# Related: a guarantee that cannot execute is not a guarantee

The same review found required hooks gated on executable trust — an untrusted capability got
`requiredHooks: []`, so its required setup was silently skipped and the spawn proceeded.
That is the default state right after a package install. A required DECLARATION must stay
visible regardless of trust, and "declared required but cannot run" must fail closed with
the trust remedy, not degrade to a warning.
