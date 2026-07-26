---
type: Lesson
title: Package engine implementation gotchas in the OAS kernel
description: Concrete pitfalls hit while implementing distribution packages — YAML subset config shape in tests, path-vs-git source disambiguation via file://, spawnInstance needs an agent object, hook meta lands in instance.json capabilityMeta, and empty npm closures create no node_modules.
tags: [packages, kernel, testing]
timestamp: 2026-07-26
---

# Package engine implementation gotchas

- The dependency-free YAML parser does NOT support list-form capability
  entries (`- capability: x`); test configs must use the map form
  (`additive:\n    x.cap:\n      global: true`). List-form silently parses
  into a garbage map key and activation resolves to [].
- A pinned local git dependency spec can't be `path@commit` (parses as a
  path); use `file://<dir>@<commit>` so it takes the git branch of
  parsePackageSource. I added `file://` to the raw-git-URL regex for this.
- `spawnInstance(root, agent, ...)` takes the agent OBJECT from
  `findAgent(root, name)`, not a name string.
- Spawn-hook JSON meta surfaces as `instance.json` `capabilityMeta[capId]`,
  not `hookMeta`.
- `capabilityIntegrity` was reused as `packageIntegrity` with node_modules
  excluded so `npm ci --ignore-scripts` materialization never changes the
  locked hash — approvals survive dep materialization.
- Trust carry-over rule that made update/restore semantics compose cleanly:
  acquirePackage carries prior trustedCapabilities over ONLY when the new
  integrity equals the prior locked integrity; update with replace:true then
  gets approval invalidation for free.
- writeCapabilityLock had to stop force-setting lockfileVersion 1, or legacy
  residue writes would downgrade a v2 lock.
- An empty npm dependency closure can make `npm ci` create no `node_modules`
  directory. CI probes for package materialization should test resource path
  resolvability, not the existence of `node_modules` itself.
