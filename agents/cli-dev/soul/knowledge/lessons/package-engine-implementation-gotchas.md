---
type: Lesson
title: Package engine implementation gotchas in the OAS kernel
description: Concrete pitfalls hit while implementing distribution packages — YAML subset config shape in tests, path-vs-git source disambiguation via file://, spawnInstance needs an agent object, hook meta lands in instance.json capabilityMeta, depsIntegrity closes the node_modules trust gap, synthetic scanner locks must not reach npm ci, empty npm closures create no node_modules, and restore preflight must parse the full visible lock chain.
tags: [packages, kernel, testing, trust]
timestamp: 2026-07-27
---

# Package engine implementation gotchas

- The dependency-free YAML parser does NOT support list-form capability
  entries (`- capability: x`); test configs must use the map form
  (`additive:\n    x.cap:\n      global: true`). List-form silently parses
  into a garbage map key and activation resolves to [].
- A pinned local git dependency spec can't be `path@commit` (parses as a
  path); use `file://<dir>@<commit>` so it takes the git branch of
  parsePackageSource. I added `file://` to the raw-git-URL regex for this.
- Remote Git roots may be distribution packages (`oas-package.json`) or legacy
  standalone capabilities (`oas.json`); package probing must be transactional
  and fallback only on a missing package manifest. See the
  [capability-agent trust/source routing lesson](/lessons/capability-agent-trust-and-source-routing.md).
- Local dependency policy checks must classify the spelling before
  normalization. `~/bait` and `path:~/bait` from git/catalog manifests are
  host-ambient and must remain `relative:true` for no-local-base checks even
  though the final resolved path is absolute; only operator root sources may
  use tilde. See [path policy before normalization](/lessons/local-path-policy-before-expansion.md).
- `spawnInstance(root, agent, ...)` takes the agent OBJECT from
  `findAgent(root, name)`, not a name string.
- Spawn-hook JSON meta surfaces as `instance.json` `capabilityMeta[capId]`,
  not `hookMeta`.
- `capabilityIntegrity` was reused as `packageIntegrity` with `node_modules`
  excluded so `npm ci --ignore-scripts` materialization never changes the
  locked source hash. That exclusion needs a separate `depsIntegrity` binding;
  otherwise approved capabilities can execute tampered dependencies. See the
  [depsIntegrity trust-binding lesson](/lessons/deps-integrity-trust-binding.md).
- Trust carry-over rule that made update/restore semantics compose cleanly:
  acquirePackage carries prior trustedCapabilities over ONLY when both the new
  source integrity and dependency digest equal the prior locked values; update
  with replace:true then gets approval invalidation for free.
- Update identity checks must compare the resolved root identity directly with
  the expected package instead of matching that ID somewhere in the dependency
  closure; parser `normalized` output is public API and must exactly match the
  lock form, including no trailing `@` for bare catalog IDs.
- Exported contract signatures must be tested directly against the frozen doc.
  `capabilityTrust` drifted to an internal `(manifest, startDir)` shape; keep
  compatibility shims explicit when public signatures and internal shapes both
  need support.
- writeCapabilityLock had to stop force-setting lockfileVersion 1, or legacy
  residue writes would downgrade a v2 lock.
- Restore must parse and cache the full visible lock-owning chain before any
  artifact mutation, not parse one scope and immediately restore it; otherwise
  a valid outer lock can mutate artifacts before an inner malformed lock fails.
  See the [restore preflight visible-chain lesson](/lessons/restore-preflight-visible-chain.md).
- Synthetic `package-lock.json` entries that exist only to test a lock scanner
  (for example unreachable `resolved` URLs or bogus integrity on omitted
  dev/peer packages) must not flow into a test that materializes the lock with
  `npm ci`; clean-cache npm versions can still validate or resolve those
  entries before the product assertion. Call the exported scanner directly for
  detector-scope assertions, and keep any materialized lock a fully valid,
  purely local closure (`file:` / `link: true` entries only).
- An empty npm dependency closure can make `npm ci` create no `node_modules`
  directory. CI probes for package materialization should test resource path
  resolvability, not the existence of `node_modules` itself.
