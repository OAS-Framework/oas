---
type: Lesson
title: Missing capability resources fail open while missing manifests fail closed
description: Missing capability resources are silently filtered during spawn even though missing manifests fail closed, so fresh worktrees can spawn instances whose instructions reference absent skills.
tags: [kernel, spawn, capabilities, fail-closed, composition, strict-curriculum]
timestamp: 2026-07-27
---

# Lesson

In a fresh linked worktree with no capability dependencies installed, the kernel
shows an asymmetric failure posture:

```text
capabilitySkillDirs("oas.aweb", <worktree>)  ->  []      # silently empty, no error
resolveOasConfig(<worktree>, "cli-dev")      ->  throws  # missing MANIFEST fails closed
```

A missing **manifest** fails closed loudly, while missing capability **resources**
fail open silently. Spawn proceeds and the instance can receive an aweb injection
that tells it to load `aweb-messaging` even though the skill was never composed
into `.agents/skills/`.

## Root cause

`oas.aweb`'s manifest declared skills as work-tree-relative dependency paths:

```json
"skills": [
  "node_modules/@awebai/pi/skills/aweb-messaging",
  "node_modules/@awebai/pi/skills/aweb-team-membership",
  "node_modules/@awebai/pi/skills/aweb-identity"
]
```

Those paths depend on incidental worktree `node_modules` state rather than locked
package content. Nothing installs them in a fresh linked worktree before spawn.
The same soul, config, and capability can compose correctly later from a warm
worktree, which makes the defect look like a race or local setup issue.

Observed symptoms:

- spawn succeeds;
- `instance.json` lists the reduced skill set with no marker that anything was
  expected and missing;
- nothing is written to stderr;
- `oas doctor` still prints the capability's declared skill paths under `Active
  capabilities`, which reads as if they were composed.

The self-concealing case is losing the messaging skills: the agent most needs
those skills to report that its own composition is broken.

## Declared versus resolved

`capabilitySkillDirs()` returns only paths that resolved, so "declared nothing"
and "declared three skills, none of which exist" both collapse to `[]`. Preserve
the declaration channel separately from the resolved-only convenience view:

```js
capabilityDeclaredSkills(id, ctx) // -> [{ declared, path | undefined }]
capabilitySkillDirs(id, ctx)      // unchanged: resolved-only view
```

Carry the same distinction for injections: keep the manifest's raw `inject:` as
`injectDeclared` beside the resolved `inject`. Whenever a lookup can legitimately
return nothing, an empty result must not be ambiguous with failed resolution.

## Four silent filters

At `lib/core.mjs` commit `a036634`, four sites could drop expected capability
resources without making spawn fail:

| site | code | behavior |
|---|---|---|
| capability skill paths | `:2069` `.map(manifestPath).filter(Boolean)` | missing path dropped |
| skill materialization | `:2976` `if (!existsSync(source.path)) continue` | missing source skipped |
| injections | `:2161-2164` `if (cap.inject && existsSync(...))` | missing injection omitted |
| lifecycle hooks | `runLifecycleHooks` — "Failures never block" | identity minting can fail, spawn proceeds |

## Fix shape

Use a transaction shape of **preflight → materialize → assert → commit**:

1. Compose the instance curriculum as a pure preflight (`composeInstanceAgentsMd()`
   only reads the soul, config chain, and capability content) and enumerate every
   active capability resource expected for the selected soul before any side
   effect such as `mkdir`.
2. Resolve resources only from locked/materialized package closures, not from
   arbitrary spawn-time worktree disk state, and keep declaration records rather
   than relying on resolved-only arrays.
3. Materialize the selected resources into the instance.
4. Assert expected-vs-materialized equality after materialization, including the
   intentional exclusions. For example, `composeInstanceAgentsMd()` deliberately
   drops knowledge-layer injections for capability agents because they are
   ephemeral; an assertion that ignores that rule turns correct composition into
   `E_COMPOSITION_INCOMPLETE`.
5. Record both sets in `instance.json` with provenance.

Preflight-before-`mkdir` is the cheapest rollback boundary: the common missing
resource case leaves no scaffold to compensate. Missing required resources must
fail spawn closed, with rollback and no zombie instance. Any check that truly
must happen after creation should reduce rollback to removing the scaffold by
comparing `expected == materialized`.

Declaring resources under `node_modules/` is a **manifest defect**, not a runtime
condition. The founder-decided sourcing for `oas-aweb` is to vendor reviewed,
MIT-attributed copies of `aweb-messaging`, `aweb-team-membership`, and
`aweb-identity` with exact upstream repo/tag/commit provenance and deterministic
sync tooling. Do not re-open shipping `@awebai/pi`/`@awebai/aw` and their native
or platform dependency closure just to obtain Markdown skills. Because this
changes capability source bytes, refresh package version, source, and integrity
with the implementation; see [capability source edits require lock refresh](/lessons/capability-source-edits-require-lock-refresh.md).

## Composition record

`instance.json` records the selected curriculum after spawn as
`composition.expected` (type, source, declared, resolved, origin, level) and
`composition.materialized` (the real copies, the canonical `.agents/skills`
tree, and the verified `.claude/skills` alias). That makes an instance's
curriculum auditable after the fact without re-resolving config that may have
changed.

# Related

[Strict curriculum scoping](/references/strict-curriculum-scoping.md) records the
release gate: every active-capability skill, injection, and plugin must resolve
from locked/materialized sources, appear in the real Pi and Claude runtimes with
provenance, fail closed when missing, and exclude inactive capabilities.

The dependency precondition itself is also recorded in
[test conventions](/playbooks/test-conventions.md), but that entry frames it as a
test concern. This lesson is that the same uninstalled-tree condition silently
degrades instance composition.
