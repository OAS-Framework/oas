---
type: Reference
title: Claude Code project skill discovery is bounded at the repository root
description: Claude Code project skills load from the starting directory through every parent up to the repository root, and no supported flag restricts ancestor .claude/skills even though claudeMdExcludes can exclude ancestor CLAUDE.md files.
tags: [claude-code, skills, discovery, strict-curriculum, upstream-gap]
timestamp: 2026-07-27
---

# Documented behavior

Claude Code's official skills documentation says:

> "Project skills load from `.claude/skills/` in your starting directory and **in every
> parent directory up to the repository root**, so starting Claude in a subdirectory still
> picks up skills defined at the root."

Observed probes matched that bound: the walk stops at the repository root, not `~`
and not the filesystem root. From an instance home inside the OAS repo,
`~/.claude/skills/beads` was not enumerated.

Precedence for same-named skills is enterprise > personal > project; any of
those overrides a bundled skill. Plugin skills are namespaced
`plugin-name:skill-name` and cannot conflict.

# Controls and gaps

| Concern | Supported control | Verdict |
|---|---|---|
| Which settings sources load | `--setting-sources user,project,local` | works; `project` alone excludes user skills and all plugins |
| Extra settings without a source | `--settings <file-or-json>` | honored, lands in `flagSettings` |
| Ancestor `CLAUDE.md` | `claudeMdExcludes` globs or absolute paths matched against absolute paths | clean, supported |
| Ancestor `.claude/skills` | none | upstream gap |
| Adding skill dirs | `--add-dir` | adds only, never restricts; documented exception: `.claude/skills` inside an added dir is loaded |
| `permissions.additionalDirectories` | grants file access | does not load skills |

There is no `skillsExcludes` and no skill-source equivalent of
`--setting-sources`. An instance home inside a repository that carries root or
intermediate `.claude/skills` will see those skills unless the launch path uses a
stricter isolation mechanism such as the session-only plugin approach described
in [Claude strict launch](/lessons/claude-strict-launch-setting-sources.md).
That plugin mechanism gives exact skill selection but namespaces every skill,
which breaks literal `/skill-name` references and was rejected for this route.

# Founder ruling, 2026-07-27

Loading the repository's root `.claude/skills` and `CLAUDE.md` is acceptable if
no clean workaround exists. Since `claudeMdExcludes` is a clean workaround for
memory, use it; accept the skill deviation and record it in `instance.json`
provenance so it is auditable rather than silent. Do not reject spawn in
repositories that legitimately carry these files — that would be a mainstream
compatibility failure, not isolation.

This ruling belongs with the broader [strict curriculum scoping](/references/strict-curriculum-scoping.md)
record.

# Also worth knowing

`.claude/settings.local.json` is read and written at the root of the Git
repository, resolved through worktrees to the main checkout. Upstream therefore
independently treats the main checkout as canonical, matching
[canonical agents root identity](/lessons/canonical-agents-root-git-identity.md).
