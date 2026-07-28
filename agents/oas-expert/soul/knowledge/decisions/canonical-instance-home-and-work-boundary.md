---
type: Decision
title: Instance homes belong to the canonical deployment root, never a secondary worktree
description: Every instance stores its transient brain and lifecycle state under the canonical deployment agents root while all tracked repository reads and writes happen through its explicit work path according to work mode.
tags: [instances, worktrees, work-modes, spawn, instructions, git]
timestamp: 2026-07-27
---

# Decision

`<instance-home>` means this specific OAS instance's gitignored startup directory containing its generated brain, task, provenance, runtime resources, episodic state, and `work/`. It never means the user's `~`, repository root, or Git worktree. At runtime its provider-neutral absolute path is `$OAS_INSTANCE_HOME`.

The founder confirmed a strict home/work boundary:

- An instance home belongs under the canonical deployment agents root—normally the repository's primary checkout—and is gitignored local runtime state.
- A secondary Git worktree must never contain the instance home. Invoking spawn from inside a worktree must not change home placement.
- The home is the authoritative place to inspect the instantiated brain and lifecycle state: generated `AGENTS.md`, linked `soul/` and knowledge, exact `.agents/skills/`, `TASK.md`, provenance in `instance.json`, and knowledge-integration episodic files.
- Repository work happens only through `<instance-home>/work`, whose meaning is explicit by mode: dedicated branch worktree, shared checkout, attached owner's tree, or read-only workspace.
- `aw` and OAS operational/lifecycle commands run from the instance home, which owns the aweb identity workspace and canonical deployment-root context. Git, tracked edits, builds, tests, and commits run from `./work`. An OAS package/config command intentionally targeting another scope is invoked from home with an explicit resolved `--dir`; agents do not rely on worktree CWD for OAS context.
- Generated brain files in the home are not code-edit targets. Episodic `STATE.md`, `log.md`, and `notes/` remain writable when the knowledge integration provides them. Durable soul/code edits must use the corresponding tracked path inside `./work`, not follow `./soul` into the canonical checkout.
- These instructions apply to every soul and capability-defined agent, including reviewers and harvesters.

# Verified current gap

The repository already ignores `agents/*/instances/`, and the OAS skill plus worktree briefing say repository work belongs in `./work`. But the rule is neither complete in all work-mode injections nor enforced by root discovery.

A scaffold-only probe invoked from a detached secondary worktree successfully created:

```text
<secondary-worktree>/agents/docs-expert/instances/docs-expert-home-root-probe
```

instead of homing under the primary checkout. The probe was retired and its detached worktree removed. Therefore current behavior is correct only when spawn is anchored from the canonical checkout (or receives an equivalent root anchor); it is not a kernel invariant yet.

# Implementation requirements

1. Separate deployment/home-root identity from command CWD and assigned work context. Expose one provider-neutral absolute instance-home environment variable to every runtime and lifecycle hook (proposed `OAS_INSTANCE_HOME`); do not make Pi-prefixed `PI_AGENT_HOME` the public contract. Preserve it temporarily only if compatibility requires it, and avoid collision with package-store `OAS_HOME_DIR` or existing hook-only `OAS_HOME`.
2. Agent-initiated child/reviewer spawns inherit the canonical deployment root even after the agent changes directory into `./work`.
3. Direct CLI spawn from a linked Git worktree resolves the primary checkout's deployment root, or fails with a deterministic instruction when that identity cannot be established; it never silently creates homes in the linked worktree.
4. Preserve team/cross-repo ownership: an instance homes with the canonical root of the repository that owns its soul.
5. Keep homes gitignored and test all four work modes plus capability-defined reviewers.
6. Put one concise common home/work boundary in every generated instance, then add only mode-specific rules in checkout/worktree/attached/workspace injections.
7. Tests assert home placement, work target/branch, generated instruction wording, and no tracked repository modifications from home paths. They also prove `aw`/bare OAS operations use home context, child/reviewer operations remain anchored after repository work, and explicit `--dir` is the only intentional way to target a different config/package scope.
