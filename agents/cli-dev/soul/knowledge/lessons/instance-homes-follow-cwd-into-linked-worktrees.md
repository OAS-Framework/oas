---
type: Lesson
title: Instance homes follow CWD into linked worktrees invisibly
description: findRoot walks up from the invocation directory, so spawning from a linked worktree or after cd ./work creates the instance home inside that worktree, where .gitignore hides it and it dies with the tree.
tags: [kernel, spawn, worktrees, instance-home, cli]
timestamp: 2026-07-27
---

# Lesson

`findRoot()` (`lib/core.mjs:132`) returns the first `agents/` directory found
walking up from CWD, and `spawnCmd` uses `ensureRoot(dirFlag())` where
`dirFlag()` defaults to `process.cwd()` (`bin/oas.mjs:49-61`, `:1574`). Verified:

```text
findRoot("/tmp/oas-strict-curriculum-spike")  ->  /tmp/oas-strict-curriculum-spike/agents
```

A human spawning from a linked worktree, or **any agent that ran `cd ./work`
first**, homes the new instance inside that linked worktree. `.gitignore:2`
ignores `agents/*/instances/`, so nothing looks wrong in Git status, and the
home dies with the tree.

At capture time, the worktree injection actively taught the failure: "`cd work/`
once, at the start of the session, and stay there".

## Design separation

Three concepts are collapsed into one CWD walk and need to be split:

- **deployment root** — where instance homes live: the canonical checkout of the
  soul-owning repo;
- **invocation scope** — which config/packages apply: `--dir` or CWD;
- **work context** — the assigned tree: work mode plus `--work-dir`, already a
  separate concept.

## Identifying the canonical checkout safely

`git worktree list --porcelain` reports the main worktree as the **first
record**. Verified from a linked worktree: it reports the primary checkout
without relying on a branch name.

`--git-common-dir` is only a fallback. It breaks on separate-gitdir and bare
layouts. When the main worktree cannot be established, fail closed with an error
such as `E_NO_CANONICAL_ROOT`; guessing reproduces the bug.

## Env contract

The launcher exports only `OAS_INSTANCE`, `PI_AGENT_INSTANCE`, and
`PI_AGENT_HOME` (`lib/core.mjs:3110`) — pi-branded names even for Claude
instances. Lifecycle hooks get a different, hook-only `OAS_HOME` (`:2207`). A
runtime-neutral absolute `OAS_INSTANCE_HOME` should be exported to both surfaces.

Do not drop the aliases yet:

- `PI_AGENT_HOME` is read by `packages/pi/extension/index.ts:15` and
  `bin/oas.mjs:1754`;
- `OAS_HOME` is read by `capabilities/oas-aweb/bin/oas-aweb.mjs:40` and
  `capabilities/oas-okf/bin/oas-okf.mjs:54`.

`OAS_HOME_DIR` (`:478`) is the package-store root and must not be overloaded.

# Related

[Kernel/CLI shape](/architecture/kernel-and-cli-shape.md) records the current
closest-`agents/` root behavior. [Canonical agents root Git identity](/lessons/canonical-agents-root-git-identity.md)
records the implemented redirect from linked-worktree roots to the primary
checkout. [Canonical worktree verification](/lessons/canonical-worktree-verification.md)
records a separate worktree identity gotcha: Git canonicalizes symlinked
worktree paths, so rollback checks must keep the canonical record.
