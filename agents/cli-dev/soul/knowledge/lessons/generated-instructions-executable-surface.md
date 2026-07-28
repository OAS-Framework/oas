---
type: Lesson
title: A bug taught in the instructions survives every fix in the code
description: The kernel was hardened for three rounds against instance homes landing outside the deployment while the generated work-mode briefing still told every agent to cd into the work tree and stay there.
tags: [kernel, instructions, injections, contract, spawn]
timestamp: 2026-07-27
---

# Lesson

The whole spike existed because instance homes and command scope resolved from wherever a
command happened to run. I fixed the resolution, then the containment, then the containment's
bases, then the race — six rounds of review on the code path. The packaged work-mode
briefing meanwhile still said:

> **`cd work/` once, at the start of the session, and stay there.** Home is where you wake
> up; `work/` is where you live.

Every worktree instance read that at wake-up and then ran `aw` and `oas` from the work tree —
which is the exact misresolution the code was being hardened against. The kernel and its own
instructions were arguing, and the instructions win, because they are what the agent acts on.

**Generated instructions are executable surface.** When a class of bug is "the agent operates
from the wrong place", the fix is not complete until the text that teaches placement says the
new thing. Grep the injections for the behaviour you just made impossible in code; if they
still teach it, you have shipped a contradiction that costs a full review cycle to find.

# Say what each directory is FOR, not where to sit

The replacement is deliberately not "cd home and stay there" — that would be the same failure
mirrored. The contract states the PURPOSE of each directory and lets the agent move:
`<instance-home>` (`$OAS_INSTANCE_HOME`) holds the brain, task, provenance and episodic
state, and is where `aw` and OAS lifecycle commands resolve their scope from — with
`--dir <path>` as the deliberate way to reach a different one; `<instance-home>/work` is
where git, edits, builds, tests and commits happen, and durable changes go through tracked
paths there, never the home's read-only `soul` link.

Two more things that made it correct rather than merely better:

- **It is runtime-neutral and mode-independent.** It ships once and precedes every mode
  block, so checkout, attached and workspace instances — and capability service agents like
  reviewers, whose knowledge layer is deliberately suppressed — all get the same frame. The
  reviewer that mails a verdict from the work tree is the same bug wearing a different hat.
- **The tests pin the exact generated text AND the absence of the old line**, comparing
  wording rather than line wrapping, across every mode and at the source file level so a
  future briefing cannot reintroduce it.

# "Mode-neutral" text is a claim you have to check against every mode

My first boundary said `work` "is the repository", that all reading, editing and git happen
there, and that "nothing you produce belongs anywhere else". It read as neutral because it
never named a mode — but it was the worktree mode's rules with the mode label filed off, and
it contradicted three things at once: workspace mode (`work` is the deployment scope, not a
repo, and read-only), the episodic state the same text places in the home, and the shipped
reviewer's own instruction to write its report to a temp file before mailing it. I forbade
the artifact our own service agent is required to produce.

**Shared text must state the invariant and DEFER on the variable part.** The fix was to call
`work` the "repository or workspace view", scope the rule to repository content, name the
mode block as the authority on which operations are permitted, and say explicitly that
episodic files and role artifacts are not exceptions to a rule about where the repository
lives. Write the general text last, after the specific cases, or it will be one case in
disguise.

Same correction on the soul link: I wrote that it is read-only and that writes through it
are never reviewed or committed. It is an ordinary writable symlink, and for a local soul
the harvester writes it directly. The true statement is the useful one — TREAT it as
read-only, because writes bypass your branch and the review path.

# Composed instructions are a SET — check the combinations, not the pieces

Each block was defensible alone. `local-soul.md` said soul updates are plain edits through
`./soul/`; the boundary said treat that link as read-only. Both shipped, and a local agent
composes BOTH — so the one instance that needed a clear answer got two opposite ones. My
tests missed it because all four mode compositions passed `kind` undefined, so the local
block never appeared in anything under test.

**Composition means the contract is the combination, not the blocks.** Anything conditional
— a kind, a mode, a capability layer — is a variant that needs its own composed assertion,
because a contradiction can only exist where two blocks meet. The fix was to make the
mutation path single across every custody (write `notes/`, the harvester promotes; where the
soul then changes is the harvester's business — branch and PR for a committed soul, direct
edit for a local one) and to assert it on a genuinely local composition.

# Kernel-composed text may not prescribe what a capability provides

Fixing the local-soul contradiction, I wrote the resolution INTO the kernel boundary: "you
write what you learn to `notes/`, and the harvester promotes it." One layer down, that is
the same mistake again. `notes/` and `oas okf harvest` come from the oas.okf capability;
an instance without it has neither. Worse, capability service agents have their knowledge
layer suppressed BY DESIGN, and the shipped reviewer's own soul says "do not write notes/,
do not run any harvest" — so my always-composed block told it to do exactly what its
instructions forbid. I had reproduced the bug I was fixing, in the block I was fixing it in.

**Text composed for every instance can only assert what every instance has.** Anything a
capability supplies — its files, its commands, its protocol — belongs in that capability's
own injection, where it appears exactly when the capability does. The kernel block's job is
to state the invariant and DEFER: "how your own learnings reach your soul is your knowledge
layer's business, and its instructions below say so if you have one."

The same audit caught two more of my own: the boundary listed `oas okf harvest` among the
commands to run from home, and the workspace briefing enumerated `STATE.md/log.md/notes/` as
"your episodic files". Both name OKF artifacts in kernel-composed text. Generalised to "your
role's working state" and "any other `oas` subcommand your capabilities add", they are true
for everyone.

The test that holds it: compose kind x mode x knowledge-layer and assert NEGATIVELY —
without the layer, no kernel block may mention the protocol at all; with it, exactly one
block does.

# Negative assertions need a property, not a phrase list

My first "no kernel block prescribes the knowledge protocol" test used a three-alternative
regex — `` `notes/` ``, `okf harvest`, "the harvester promotes" — and passed while the
workspace briefing carried "Memory promotion writes there, on a branch, delivered as a PR".
The test could not see the very sentence that broke the rule.

Worse, the companion test asserted only that the composed text matched the protocol at least
once, which is true whether ONE block owns it or three compete. The fix was to stop testing
prose and test structure: `composeInstanceAgentsMd(...).blocks` gives every block with its source,
so the property becomes an equality — the set of blocks matching the protocol must be exactly
`["capability:oas.okf"]`, and exactly `[]` when the layer is suppressed. That cannot pass
vacuously, and it names the offender when it fails.

Widening the regex then flagged "service agents (harvesters, reviewers, fixers)" — a MENTION,
not a prescription. Distinguishing them is part of the property: naming a kind of agent is
fine, telling an instance to write notes or promising how its promotions are delivered is not.
A negative assertion is only as good as its definition of the thing being forbidden.

# A revert check that does not revert proves nothing either

Twice in this branch my revert check silently no-opped, and both times it briefly convinced
me a weak test was strong. The second was the sharpest: I "restored" a bad sentence with a
single-line Python `str.replace`, but the shipped text is WRAPPED, so the phrase never
matched, nothing changed, and the test passed — which I read as "the property holds for this
variant" when in truth I had tested nothing at all.

**Assert that the revert applied.** `re.subn` returning a count, `assert n == 1`, `git diff
--stat` showing a change — any of them turns a silent no-op into a loud failure. A revert
check is itself a test, and an unverified one is worth exactly as much as the code it was
meant to challenge.

The same wrapping bites the assertions themselves, which is why every text check here
compares whitespace-flattened strings: the contract is the wording an agent reads, not the
column it happens to break at.

# Extract the predicate, then test the predicate

Three times I wrote a one-line regex inside a loop to enforce "every mention of `aw` must be
conditional", and three times it admitted a violation: a stray "active" elsewhere in the
sentence satisfied it; then a NEGATED clause satisfied it ("If no messaging capability is
active, run aw here" — conditional, and exactly backwards); then a sentence-wide exemption
for "aware" swallowed "Please be aware and run aw here".

An inline regex has no tests of its own. Pulling it out as a named function and giving it a
table of sentences it must accept and must reject turned the rule into something I could
check directly — and the table is where each of those bypasses now lives permanently.
**When an assertion encodes a judgement, the judgement deserves its own test.**

But the table only exposed the real problem: the FOURTH version still admitted
"For example, run `aw`." and rejected the valid "Run `aw` only with an active messaging
capability." I was writing a natural-language parser one counterexample at a time, and there
is no version of that which converges — "is this English sentence conditional, and does the
condition scope THIS clause?" is not decidable by regex, and each fix moved the hole rather
than closing it.

**When a property is undecidable in general, stop deciding and start enumerating.** The
kernel ships exactly one sentence that may mention `aw`; the test is now an allowlist of that
sentence, so every other phrasing fails regardless of how it is worded, and there is no
grammar left to outsmart. The bypass table survives as the record of what the heuristics let
through. The lesson generalises past prose: an approximate check on an unbounded input space
is a leak with a schedule, and the exact check is usually available if you are willing to
name the finite thing you actually allow.

Even then, be exact about WHAT you allow. My first allowlist used `includes`, so a sentence
holding the approved clause AND a second command passed — "run `aw` even when no messaging
capability is active; for example, when the aweb messaging capability is active, run `aw`
there too." Containment says the good text is present; it says nothing about what else is.
The approved clause carries exactly one `aw` token, so the sentence must carry exactly one
too. **An allowlist has to bound the whole input, not find a substring in it.**

And it has to count what the reader counts. My token regex used character classes to exclude
backticks, which meant ``` ``aw`` ``` — a perfectly ordinary Markdown spelling — matched
nothing at all and sailed through. `\baw\b` counts the word, since backticks are already
non-word characters. The same check had the opposite fault too: OAS provenance markers embed
absolute PATHS, so composing from a directory whose name contained "aw" made unchanged prose
fail. Strip the machine-generated markers before reading text as prose — provenance is not
instruction.

And the same failure at the file level: a DENYLIST of provider names could never establish
neutrality — SMTP, Slack, email and "the direct message" all sailed past one built from this
deployment's brands, because the space of transports is open and my imagination is not the
limit of it. The delivery instructions are now pinned as exact SNAPSHOTS: editing them
requires updating the test, which is precisely the review gate that prose contract deserves.

Snapshotting two PASSAGES was still not enough, twice over. A passage snapshot is anchored by
markers, and markers are not unique — prepending a commented decoy made `indexOf` select the
copy while the live text said "send the report over Matrix". And everything outside the two
passages was still guarded by the denylist, so "Send review questions over Matrix." in a
declared SKILL passed all 118 tests. The terminal form is a content hash of EVERY shipped
surface, with the file list itself asserted so an added or removed file fails too. Any change
to any shipped instruction now fails until a human re-reads it and re-approves the hash.

The progression is worth remembering as a ladder, because I climbed every rung: substring
denylist → broader denylist → passage snapshot → whole-surface hash. Each rung was defeated
by an input I had not imagined, and only the last one does not depend on imagining anything.

**And the maintainer then removed the last rung, correctly.** A byte hash does not prove
provider neutrality; it proves nobody refreshed a checksum. Any contributor can update the
number without reading a word, so it converts a semantic property into a mechanical chore
while failing every legitimate edit in the meantime. The human approval gate for prose
already exists — it is the PR review — and a machine test that pretends to be that gate is
worse than one that admits its limits.

The correction I should have reached myself: **decide what the test can actually decide.**
Bounded, observable properties (this file issues no `aw` command; the no-layer paragraph
exists; exactly one composed block owns the knowledge protocol) are worth pinning. "This
prose assumes no provider anywhere" is not machine-decidable from prose, and the honest
response is a comment saying it needs semantic review when these surfaces change — not five
rounds of increasingly elaborate machinery that still cannot do it.

I spent five review rounds climbing that ladder. The signal I missed: when each fix is
strictly more clever than the last and the finding rate does not fall, the target is probably
not machine-checkable at all.

The same move fixed the neutrality check: instead of four branded spellings on a hand-listed
set of files, walk every shipped surface and reject the PROTOCOL as well as the brand —
"say so in the mail" assumes a messaging layer as surely as naming aweb does, and a skill
added tomorrow is held to the rule without anyone remembering to add it to a list.

And the walk itself had the same shape of hole: filtering to known extensions SKIPS what it
does not recognise, and a manifest may point `inject` at any path. Enumerate every shipped
file and FAIL on an unclassified one — an unknown surface should force a decision, never a
silent pass. Skipping is the default that hides things; erroring is the default that finds
them.

That hole had a second mouth: a manifest may declare `inject` at ANY path, and the runtime
reads it as UTF-8 whatever the suffix — so a rogue `.png` was scanned by the runtime and
skipped by my "known binary" classifier. **Whatever a manifest declares is text by
definition**, because something will read it; classify by ROLE first and by extension only
for the rest.

# A test that restates the text proves nothing

My first tests asserted that the composed output contained the literals I had just written.
They passed while the text contradicted workspace mode and the shipped reviewer, because
they never asked what the words MEANT for a given instance. The replacements assert the
contract: workspace output must keep its read-only rule and must not call `work` the
repository; a REAL spawned packaged reviewer must still be able to write its mandated
report; no shipped instructional surface — injects, docs, skills, capability instructions,
README — may teach the retired rule. That last one is a property, not a case, and it is what
would have caught the stale public-doc line I missed in the same commit.

# Accepted risk has to be documented where operators read

The same round: a residual we deliberately accepted (a narrow filesystem race the runtime
cannot close) was described only in a source comment. A prerequisite that lives in code is
one no deployment ever reads. If a security decision shifts responsibility to the operator,
the public docs have to say so, in the section they would look in — and a test can assert
that much, because prose drifts exactly like code.
