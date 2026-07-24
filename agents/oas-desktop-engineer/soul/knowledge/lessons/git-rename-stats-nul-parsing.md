---
type: Lesson
title: Parse git rename stats from NUL-delimited porcelain, not human summaries
description: Diff viewers must parse git --numstat -z and --name-status -z output with explicit old-NUL-new rename fields instead of the human dir/{old => new} form.
tags: [desktop-backend, desktop-viewers, git, diff]
timestamp: 2026-07-22
---

# The trap

Git's human rename summary, such as `dir/{old => new}`, is display formatting. It is not a stable data contract for a diff viewer to parse.

# Rule

Parse the machine forms instead:

- `git --numstat -z`
- `git --name-status -z`

For renames, handle the explicit `old` NUL `new` fields rather than trying to reverse-engineer the human summary.

# Related concepts

- [desktop backend architecture](/architecture/desktop-backend-architecture.md)
- [Instance work is a mode, not a filesystem path](/lessons/instance-work-mode-not-path.md)
