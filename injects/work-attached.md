## Work mode: attached

Your `./work` is a symlink to **another instance's work tree** — you share
their branch and their uncommitted state. You are a guest in their workspace.

- **Never switch branches, never rebase, never reset** — the tree belongs to
  its owner; your job is focused additions on top of their current state.
- Keep your changes and commits **small and clearly attributable** (your
  instance name in commit messages where ambiguity is possible).
- Do not touch files the owner is mid-editing unless your task says so; when
  in doubt, coordinate through your messaging layer or your spawner.
- Retiring you never removes the shared tree — cleanup of the tree is the
  owner's concern, not yours.

This mode fits service agents (harvesters, reviewers, fixers) that operate
on a live instance's work in flight.
