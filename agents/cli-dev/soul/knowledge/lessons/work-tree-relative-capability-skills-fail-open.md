---
type: Lesson
title: Capability skills declared under the work tree are dropped silently when deps are not installed
description: oas.aweb declares its skill dirs as work-tree-relative node_modules paths, so an instance spawned into a fresh worktree before npm install composes without its messaging skills and spawn reports no warning.
tags: [kernel, spawn, capabilities, skills, fail-open]
timestamp: 2026-07-27
---

# Lesson

`oas.aweb`'s manifest declares its skills as paths that resolve inside the
instance's **work tree**:

```json
"skills": [
  "node_modules/@awebai/pi/skills/aweb-messaging",
  "node_modules/@awebai/pi/skills/aweb-team-membership",
  "node_modules/@awebai/pi/skills/aweb-identity"
]
```

Spawn composes `.agents/skills/` once, at spawn time. When the work tree is a
freshly created worktree whose dependencies have not been installed yet, those
directories do not exist, and skill composition **drops them silently**:

- spawn succeeds;
- `instance.json` lists the reduced set (8 skills instead of 11) with no marker
  that anything was expected and missing;
- nothing is written to stderr, and `oas doctor` still prints the capability's
  declared skill paths under `Active capabilities`, which reads as if they were
  composed.

Observed directly: this instance was composed at 12:22:13; running `npm ci` in
the work tree at 12:31:49 for an unrelated reason created
`node_modules/@awebai` afterwards. The instance's AGENTS.md instructs it to
load `aweb-messaging` before its first `aw mail` of a session, and the skill
was simply not in its set — it had to be read from its on-disk path instead.

Two things make this worse than a generic missing-file bug:

1. **The gap is silent and self-concealing.** The skills most likely to be lost
   are the messaging ones, i.e. the ones an agent needs in order to report that
   its own composition is broken.
2. **It is a spawn-time race, not a static misconfiguration.** The same soul,
   same config, and same capability compose correctly a minute later. Anything
   that reproduces "works for me" from a warm tree will not see it.

Composition should not fail open here. A declared skill directory that does not
exist is either a hard spawn error or, at minimum, a loud warning naming the
capability and the unresolved path — the same fail-closed posture the kernel
already applies to trust and hoisted-path containment. Whether capability skill
paths should resolve against the work tree at all (rather than the capability's
own installed root) is a contract question for the maintainer, since changing
it would move every consumer's declared paths.

# Related

The dependency precondition itself is already recorded in
[test-conventions](/playbooks/test-conventions.md) ("a clean checkout needs
dependencies installed in both the repo root and `packages/desktop`") — but
that entry frames it as a *test* concern. This lesson is that the same
uninstalled-tree condition silently degrades *instance composition*, which no
test currently covers.
