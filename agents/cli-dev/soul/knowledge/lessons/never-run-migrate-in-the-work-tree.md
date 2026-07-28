---
type: Lesson
title: Never smoke mutating oas commands in the work tree
description: `node bin/oas.mjs migrate --help` executed a real migration because command-specific help flags are ignored, so mutating oas commands must be checked only inside temp deployments with explicit --dir.
tags: [cli, oas-migrate, developer-workflow]
timestamp: 2026-07-28
---

# What happened

A manual help-text smoke ran `node bin/oas.mjs migrate --help` from the
repository work tree. `bin/oas.mjs` has no per-command `--help` interception:
`flag()` only reads flags the command asks for, and unknown flags are ignored.
The dispatcher therefore ran `migrateCmd()` with the work tree as the default
scope.

The repository's own `oas-lock.json` was v1 and contained `oas.okf`,
`oas.review`, and `oas.authoring`; the accidental command rewrote it to
lockfileVersion 2 with all three entries as residue. It was recoverable only
because the repo lock was tracked and could be restored with
`git checkout -- oas-lock.json`. In a user's deployment, the same mistake would
be a real mutation.

# Future posture

- Help lives at `oas help` / `oas --help` only. To inspect a command's help text
  while this dispatcher shape remains true, use `node bin/oas.mjs help | grep
  -A6 '<command>'` instead of passing `--help` to the command.
- Never exercise a mutating `oas` command from the work tree or an instance
  home. Kernel tests build temp deployments for this reason; manual checks
  should do the same with `mkdtemp`, a purpose-built `oas-config.yaml`, and an
  explicit `--dir`.
- After any accidental run, inspect deployment files before continuing:
  `oas-lock.json`, `oas-config.yaml`, and `.agents/`. A mutation there can look
  like unrelated noise in a later diff.

This is the manual-smoke companion to the guided official migration decision:
[guided official migration shape](/decisions/guided-official-migration-shape.md).
