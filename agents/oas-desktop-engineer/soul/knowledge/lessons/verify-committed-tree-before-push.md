---
type: Lesson
title: Verify the committed tree matches the commit message before pushing
description: A merge commit's message can advertise edits left only in the working tree, so verify the committed tree, not just local tests, before pushing.
tags: [git, merge, process]
timestamp: 2026-07-25
---

During the v0.18.5 main merge (`0762d85`), the `RELATIONS_MIN` 0.18.5 → 0.18.6 bump was edited in the working tree after the conflict-resolution `git add -A`. The merge was then committed via a single chained command whose `git commit` picked up only the staged state.

The commit message described the bump in detail, but the committed tree did not contain it. Tests passed locally because the suite ran against the working tree, which still had the edits. The reviewer caught it by testing the committed tree.

# Rules

- After committing, check `git status --short` is clean before pushing; leftover modifications are a red flag that the commit missed edits.
- When a commit message claims a specific change, verify the claim with `git show HEAD -- <file>` or `git show HEAD:<file> | grep` before pushing.
- Do not rely on a green local test run as proof the commit is green: run the gate only when the working tree is clean, or the run validates the wrong tree.
