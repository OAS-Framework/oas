---
type: Lesson
title: Ambient harness skill discovery cannot provide exact agent isolation
description: Harness-specific ancestor boundaries and global/package roots make ambient skill visibility non-portable; OAS must disable it and pass one exact instance-local set.
tags: [pi, claude, skills, capabilities, gotcha]
timestamp: 2026-07-11
---

Pi's project `.agents/skills` walk stops at a git repository root, while global,
settings, and package skills use other roots. Claude has different project and
config-home rules. Bridging an ancestor gap for one harness solved workspace
visibility but made per-soul isolation impossible and behavior runtime-specific.

The capability-package implementation reverses the approach: spawn resolves
kernel + soul + active package skills, materializes one instance-local
`.agents/skills`, and records it. Pi extension `resources_discover` hooks are
additive, so the adapter cannot subtract ordinary discovery from inside the
extension. Pi launches with `--no-skills` plus that one explicit path, because
Pi still accepts explicit `--skill` paths when ordinary discovery is disabled;
Claude receives project and config-home views of the same path and is launched
with only the redirected instance `user` setting source.

The durable test is no longer “can a repo see workspace skills?” Test two
runtimes with an unrelated ancestor/global skill present and verify both see
exactly the metadata-recorded instance set. For Pi, also inspect that the
launch command includes `--no-skills` and exactly one `--skill` path; correct
materialized files alone do not prove runtime isolation.

**Superseded in part (2026-07-14)**: the founder judged strict exclusion an
adoption barrier — users migrating to OAS lost their existing ambient skills
inside instances. The exclusion flags (`--no-skills`, instance
`CLAUDE_CONFIG_DIR` + `--setting-sources user`) were dropped; ambient skills
now coexist with the materialized set (see the
[authorship/ambient decision](/decisions/config-authorship-and-ambient-skills.md)).
The mechanics above remain the record of *how* exact isolation is achieved if
a future `strict-skills:` switch reinstates it.
