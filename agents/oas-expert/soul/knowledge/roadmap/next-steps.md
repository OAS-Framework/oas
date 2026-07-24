---
type: Roadmap
title: Roadmap and open threads
description: What is planned, in flight, and unresolved for the OAS framework.
tags: [roadmap]
timestamp: 2026-07-24
---

# In flight / next

1. **Desktop panel succession**: PR #19 now owns the complete pre-release cut —
   move the backend under the private desktop package and immediately remove
   oas.web plus `oas pane`/`lib/control-pane` as a documented breaking impact.
   Before release, replace PR #19's explicitly temporary adjacent-core bridge
   with installed-CLI mutations and observation-only no-OAS behavior; block the
   next release until desktop installers and migration diagnostics are
   operational, and migrate relevant
   TUI/web-panel knowledge into the durable desktop-engineer soul before the
   old developer souls retire. See the [binding decision](/decisions/desktop-panel-succession.md).
2. **Capability registry/npm acquisition**: git/path artifacts are
   exact-locked and restorable via bare `oas install`; add registry/npm source
   resolution and explicit upgrade/remove workflows without weakening
   no-silent-update behavior.
3. **Selector evolution**: V1 groups are explicit soul lists. Consider tags or
   selectors only after real group maintenance pressure, preserving
   deterministic specificity/conflict rules.
4. **Claude session-event parity**: file/skill/instruction composition is
   already instance-local and harness-neutral. A future thin Claude adapter may
   add resume/compaction memory nudges equivalent to pi; operations remain CLI.
5. **First-run diagnosis**: no config means no activated layer. Make empty
   chains and unresolved fundamental layers clearer without silently enabling
   acquired packages.
6. **Desktop telemetry**: preserve the existing truthful current-state model;
   define a runtime-neutral adapter event contract before adding token/cost,
   model, tool, capability/trust, or activity telemetry. Do not inspect one
   harness's internals from the universal desktop UI.
7. **Layout adapters**: alternative agents-root structures, after package
   targeting semantics stabilize.

# Watch items

- **Agent-initiated harvest reliability**: if souls accumulate pending notes,
  add a knowledge-integration-owned nudge/backstop rather than kernel memory
  assumptions.
- **Semantic instruction conflicts**: doctor exposes final composed prose, but
  machines cannot reliably detect contradictory natural-language blocks.
- **Roster concurrency** in task integrations and session-only model scope.
- **Pi package copy**: `@oas-framework/pi` package.json/README should describe
  a runtime bridge for memory session events and pre-workspace bootstrap, not
  instance-local skill discovery.

# Done

Capability packages and formal integration subtype; global/group/soul targets;
settings specificity, exclusions, conflict errors; exact pi/Claude
instance-local skills; generated instructions without soul mutation;
lock/integrity/trust; active-context commands; deterministic hooks and scaffold
ownership; capability/layer doctor output; first clean capability contract;
config cascade; universal CLI; tool-less pi adapter; all three work modes;
continuous OKF harvest; bundled OKF/aweb/Jira/Linear packages; live standalone
`oas pane` Control Pane; tag-driven CI; scoped installed/owned capability
store with restorable bare `oas install`, config templates, and per-capability
injection overrides (resolves the former lock-cache-sharing watch item).

# Later

- Memory forms beyond markdown while preserving durable, portable souls.
