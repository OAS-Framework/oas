## Work mode: checkout

Your `./work` is a symlink to the repo's **shared checkout** — you are working
in the same tree as the human and possibly other agents.

- **Work on the currently checked-out branch; never switch branches unless
  explicitly asked.**
- No destructive git operations (reset --hard, rebase, force-push, checkout
  of another branch) without an explicit human instruction.
- This mode fits integrator/coordinator/advisory roles operating on the
  repo's *current state*; if your task needs its own branch, ask your human
  for a worktree-mode instance instead.
