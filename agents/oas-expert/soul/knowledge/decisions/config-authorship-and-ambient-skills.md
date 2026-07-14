---
type: Decision
title: Config authorship completeness and ambient skill coexistence
status: accepted
description: Amendments to config shape v2 — rename injection to injection-override and forbid it on owned/path capabilities, add CLI verbs (oas type, oas inject eject, use --settings) so mainstream config operations never require hand-editing, and stop restricting harness skill discovery so ambient skills coexist with the OAS-materialized set.
tags: [config, cli, injections, skills, adoption]
timestamp: 2026-07-14
---

Decided with the founder, 2026-07-14, as follow-ups to
[config shape v2](config-shape-agent-types-and-injections.md).

# 1. `injection:` → `injection-override:`

The per-entry key on capability entries, work modes, and the `oas:` kernel
block is renamed to `injection-override:` (values `<path>|none|default`
unchanged). Rationale: the old name read as "where the injection lives"; the
mechanism is an override of a packaged default, and the name should say so.

It is **rejected on `from: owned` and `from: path:` entries** with a pointed
error: the scope owns the package source, so the injection is edited directly
at `.agents/capabilities/owned/<id>/injects/<file>.md`. An override there
would be a second place to edit the same text — the drift trap this design
avoids. Scaffolding (`oas init` / `oas use`) emits the commented override
line only for `bundled`/`installed` entries; owned entries get a pointer
comment to their own `injects/` directory instead.

Rejected alternative: `oas install` auto-copying packaged injections into
`.agents/injections/capabilities/<id>.md` — it silently converts defaults
into pins, so package updates stop reaching deployments that never
consciously customized anything.

# 2. CLI verbs for the remaining mainstream config operations

Audit outcome: `init`/`use`/`install`/`trust`/`create --type` covered the
capabilities block, but two mainstream operations still required hand-edits.
Added:

- **`oas type add <name> [--description ...] [--dir ...]`** and
  **`oas type list`** — structural authorship of the `agent-types:` block
  (previously: `create --type` set soul membership but nothing declared the
  type, leaving a doctor warning whose fix was manual).
- **`oas inject eject <capability-id|work-mode|oas> [--dir ...]`** — copies
  the packaged default injection to the conventional
  `.agents/injections/...` path and sets `injection-override:` on the entry.
  Explicit intent; un-ejected deployments keep tracking packaged defaults
  through updates.
- **`oas use ... --settings key=value`** (repeatable) — binding settings
  without hand-edits.

Deliberately left as documented hand-edits (rare/expert surface):
`skill-overrides:`, the top-level `agents-md-injection:` map, `templates:`.

# 3. Ambient skills coexist (restriction flags dropped)

Previously spawn launched pi with `--no-skills --skill <home>/.agents/skills`
and Claude with an instance-local `CLAUDE_CONFIG_DIR` + `--setting-sources
user`, making the OAS-composed set the *only* skill surface. The founder
judged this an adoption barrier: users migrating to OAS lose their existing
personal/workspace skills inside instances.

Now: pi keeps the explicit `--skill <home>/.agents/skills` but drops
`--no-skills`; Claude drops the config-dir override entirely (the instance's
`.claude/skills → ../.agents/skills` symlink surfaces the OAS set as project
skills). Harnesses discover ambient skills (user-level, packages, work tree)
*in addition to* the materialized set.

**Consciously traded away**: strict determinism of the instance skill
surface. The same soul on different machines may see different ambient
skills, and an ambient skill can shadow or duplicate an OAS-composed one
without failing spawn (the duplicate-skill error only arbitrates within the
OAS set). `instance.json` still records exactly what OAS composed; it no
longer describes everything the harness can see. Revisit if ambient
collisions cause real support burden — a per-scope `strict-skills: true`
config switch is the natural escape hatch.

# 4. Skill split

`skills/oas` was approaching the point where operating knowledge and
configuration craft crowd each other. Split: **oas** keeps
instance-operating content (layout, lifecycle, status/spawn/retire, memory,
canonical-vs-generated); **oas-config** takes configuration craft (scopes,
capabilities/layers, agent types, targeting, injections, acquisition/trust,
CLI verbs). Both ship in the kernel skill set.
