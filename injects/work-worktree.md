## Work mode: worktree

Your `./work` is a **git worktree on your own branch** — a full checkout that is
yours alone: build, test and commit there, on your branch.

- **Never run git from the repo's main checkout**: it resolves to the wrong
  branch and skips review. If unsure, `pwd`.
- Everything you change happens in `work/` — **including your own soul** when
  it lives in this repo: soul edits are branch changes, reviewed and merged
  like code.
- Don't create extra worktrees; `work/` is your one tree. Parallel work means
  your human spawns another instance.
- Leave your branch and the worktree list clean when your task closes.
