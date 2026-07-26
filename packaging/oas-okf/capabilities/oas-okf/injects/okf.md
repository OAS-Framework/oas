## Knowledge: OKF

Your knowledge layer is **OKF** (Open Knowledge Format). Long-term knowledge
lives in your soul's OKF bundle (`./soul/knowledge/`, index-first); episodic
state lives in `STATE.md`/`log.md`/`notes/`.

**Before working — every session, no exceptions:**

1. **Load the okf skill.** It is the protocol for both reading and writing
   your knowledge — do not work your bundle from memory.
2. Read `./STATE.md` and recent `./log.md` — if STATE.md has a plan/progress
   you are resuming, continue from its `# Next`.
3. **Check your knowledge for the task at hand**: open
   `./soul/knowledge/index.md` and follow the links relevant to what you are
   about to do — index-first and selective (frontmatter `type`/`tags`/
   `description` filters what to open; never bulk-read). Prior decisions,
   lessons, and playbooks are binding context — re-deriving what the soul
   already knows is a bug. Repeat this check before each new non-trivial
   task, not just at session start.

Keep STATE.md current as you work (the test: could a fresh session resume
from files alone? its `# Next` names the single next action). Append dated
milestones to `./log.md` (newest first).

**Write down what you learn.** Anything you figured out that was not obvious
— a gotcha, a decision and its why, a procedure that worked — goes in
`./notes/`, one OKF concept per insight, as you go. Do not judge whether it
is "important enough"; that is someone else's job. Just capture it
faithfully.

**Before every commit, bring memory up to date**: STATE.md current, log.md
milestone appended, fresh insights in `./notes/`.

**After committing with pending notes, launch the harvester yourself**: run

```bash
oas okf harvest
```

from your instance home. It spawns the memory-harvest agent attached to your
work tree to promote your notes into the soul (it skips cleanly when there
are no notes or a harvester is already running — calling it "too often" is
safe; not calling it means your insights never reach the soul, and unwritten
or unharvested notes are lost when your home is retired).

**Workspace-mode instances**: your soul lives in its own home repo, and your
`./work` (the workspace) is not where it commits. `oas okf harvest` handles
this — it promotes your notes in a worktree of the soul's home repo and
delivers the update **as a PR to that repo**, never a direct push and never
a commit into member repos. Your job is unchanged: write notes, commit
nothing yourself, call the harvester.

**Local-soul instances**: your soul is uncommitted by design (it lives in
`local-agents/`, gitignored). The harvester edits your soul directly — no
commit, no PR. Your job is still unchanged: write notes, commit your WORK
normally, call the harvester.

The okf skill you loaded at session start also governs writing: notes,
concepts, index.md, and log.md follow its format craft (concepts,
frontmatter, index/log discipline, validation). Re-read the relevant section
before authoring if you have not written OKF this session — notes written
from memory tend to fail validation and stall the harvest.
