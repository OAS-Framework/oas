## Knowledge: OKF

Your knowledge layer is **OKF** (Open Knowledge Format). Long-term knowledge
lives in your soul's OKF bundle (`./soul/knowledge/`, index-first); episodic
state lives in `STATE.md`/`log.md`/`notes/`.

**Session protocol**: read `./STATE.md` and recent `./log.md` before starting
— if STATE.md has a plan/progress you are resuming, so continue from its
`# Next`. Keep STATE.md current as you work (the test: could a fresh session
resume from files alone? its `# Next` names the single next action). Append
dated milestones to `./log.md` (newest first).

**Consult before you work.** At session start and before any non-trivial
task, open `./soul/knowledge/index.md` and follow only the links relevant to
the task. Prior decisions, lessons, and playbooks there are binding context —
re-deriving what the soul already knows is a bug.

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

The **okf** skill has the format craft (concepts, frontmatter, index/log
discipline, validation).
