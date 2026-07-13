---
type: Decision
title: Config shape v2 — agent types in souls, layered capabilities, conventional injection overrides
description: groups become agent-types declared name-only in config with membership via type in soul.yaml; capabilities split into layers (each fundamental slot explicit, none allowed) and additive; declarations carry a from provenance field; init scaffolds commented injection overrides pointing at .agents/injections/{capabilities,workmodes,oas-defaults}.
tags: [config, capabilities, targeting, injections, agent-types]
timestamp: 2026-07-13
---

**Status: decided 2026-07-13 by the founder.** Amends the config schema of
[capability packages](/decisions/capability-packages.md) and the
[scoped store decision](/decisions/scoped-capability-store-and-templates.md);
resolution semantics (specificity, settings precedence, exclusive layers,
trust) are unchanged.

# Context

The v0.8 `oas-config.yaml` was correct but opaque: `groups` read as arbitrary
deployment lists although they conceptually name *kinds of agents*; group
membership lived in config, away from the soul it describes; capability
provenance (`bundled` vs installed vs owned) was invisible; the three
exclusive fundamental layers were implicit (derived from manifests) with only
a `layers.<name>: none` disable escape hatch; and the injection-override
machinery (`agents-md-injection` on capabilities, work modes, and the `oas:`
kernel key) existed but was undiscoverable — nothing in a scaffolded config
hinted at it.

# Decision

1. **`groups` → `agent-types`, membership moves to the soul.** Config declares
   type names (with optional description) only:

   ```yaml
   agent-types:
     framework-authors:
       description: Agents that author and steward the framework itself
   ```

   Each soul opts in via an optional single `type: <name>` in its
   `soul.yaml`. A type is identity — what kind of agent this is — so it
   travels with the soul; config no longer lists souls per group. Capability
   specs target `global` / `agent-types: {<type>: <binding>}` / `souls:`
   (per-soul stays for deployment-specific overrides). Specificity order is
   unchanged: soul > type > global. A soul referencing an undeclared type in
   the resolved chain is a doctor warning, not an error (the type may be
   declared at an outer scope the soul's context doesn't see yet).

2. **`capabilities` splits into `layers` and `additive`.** The three
   fundamental slots get an explicit, visible home:

   ```yaml
   capabilities:
     layers:
       knowledge:
         capability: oas.okf
         from: bundled
         # injection: .agents/injections/capabilities/oas.okf.md
       messaging: none
       tasks: none
     additive:
       oas.authoring:
         from: bundled
         agent-types: [framework-authors]
         # injection: .agents/injections/capabilities/oas.authoring.md
   ```

   - Every scaffolded config writes all three layer keys; `none` is the
     explicit empty. Semantics: a layer entry with a capability is a global
     binding of that capability (layer entries may also carry `agent-types:`
     / `souls:` / `settings:` like additive ones); `none` keeps the existing
     inherited-layer suppression. A layer key absent from a config means
     "inherit from outer scopes" — valid when hand-edited, but init always
     writes all three so the resolution is visible.
   - The capability's manifest must declare the same layer it is placed
     under (mismatch errors with both values); an additive entry whose
     manifest declares a layer errors ("declare it under
     capabilities.layers.<layer>").
   - The old shapes (`capabilities.<id>` flat map, top-level `layers:`)
     are removed per the clean-contract precedent — no shim; doctor and
     config loading reject them with a pointed migration message.

3. **`from:` provenance replaces `source:` in config.** Values `bundled`,
   `installed`, `owned` name the store subtree the artifact must come from;
   resolution errors when the discovered manifest origin disagrees, so the
   config line is documentation the kernel enforces. External acquisition
   URLs stay in the lockfile (they were never authoritative in config).
   `path:` dev declarations keep working via `from: path:<dir>`.

4. **Conventional injection-override locations, scaffolded as comments.**
   The per-item override key is renamed `injection:` (accepting
   `<path>|none|default` exactly as `agents-md-injection` did) and every
   scaffolded config carries a commented-out line per item pointing at the
   conventional home:

   - capability: `# injection: .agents/injections/capabilities/<id>.md`
   - work mode: `# injection: .agents/injections/workmodes/<mode>.md`
   - kernel default (`oas:` block): `# injection: .agents/injections/oas-defaults/oas.md`

   Scaffolded configs include a `work-modes:` section (checkout, worktree,
   attached) and an `oas:` section whose only content is these comments, so
   the override surface is discoverable without reading docs. The free-form
   top-level `agents-md-injection:` map (extra unconditional blocks such as
   this repo's framework sticky) is kept unchanged — it adds content rather
   than overriding a default.

5. **The CLI is the config author.** `oas init` scaffolds the complete
   commented shape (agent-types example, all three layer slots, work-modes,
   oas block); `oas use` writes capability entries into the right subtree
   (`capabilities.layers.<layer>` for layer manifests, `capabilities.additive`
   otherwise) and `oas use none --layer <l>` writes the explicit `none`;
   `oas create --type <t>` sets the soul's type. Hand-editing remains valid
   but is never required. `oas use` re-serializes only the `capabilities:`
   block (regenerating the conventional injection comments); custom comments
   inside that block are not preserved — comments elsewhere are untouched.

# Consequences

- `soul.yaml` gains an optional `type:`; `oas create` may pass `--type`.
- `oas use --group` becomes `--type`; config writer emits the new nested
  shape (layer capabilities under `capabilities.layers.<layer>`).
- `oas use none --layer <l>` now writes `capabilities.layers.<l>: none`.
- Both real configs (laptop, this repo) are migrated in place; tests, docs
  (`configuration.md`, `capabilities.md`, schema JSON), and the oas skill
  are updated in the same change.
- Breaking on 0.x with no migration shim and no user base, consistent with
  prior clean-contract removals; the loader's error names the old key and
  the new spelling.

# Options considered

1. **Keep `groups` and only rename in docs.** Rejected: the membership
   inversion (soul declares its kind) is the substantive improvement, not
   the label.
2. **Multiple types per soul (`types: []`).** Deferred: one type matches
   the "family" semantics; sets can be added compatibly later.
3. **Directory-of-fragments injection overrides.** Deferred: a single
   conventional `.md` per item is simpler; directories can be added without
   breaking the path convention.
4. **Auto-migrating loader for old configs.** Rejected per the young-contract
   precedent; a crisp error with the new spelling is cheaper and honest.
