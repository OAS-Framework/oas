---
type: Decision
title: Standalone oas CLI as the single integration point
description: Ship @oas-framework/oas on npm as a global CLI + runtime-neutral lib; runtimes (pi extension, future Claude plugin) adapt to it rather than embedding the kernel.
timestamp: 2026-07-14
---

# Context

The `oas` CLI existed but was reachable only via the pi package (npm link
after `pi install`), and `bin/oas.mjs` imported `extension/core.mjs`,
coupling the CLI to the pi extension layout. A Claude Code plugin is planned;
its skills must be able to call `oas` without depending on pi.

# Decision (2026-07-10)

One repo, one npm package (`@oas-framework/oas`, npm org `oas-framework`),
two faces:

* **`lib/core.mjs`** — the runtime-neutral kernel (zero pi imports). Both
  `bin/oas.mjs` and `extension/index.ts` import it; the package `exports`
  map exposes it as the package entry.
* **Global CLI** — `npm install -g @oas-framework/oas` gives `oas`
  (`doctor [--json]`, `install`, `use`, `init`, `sync`). `doctor --json`
  exists so non-JS runtimes (the Claude plugin) shell out instead of
  importing.
* **pi package** — unchanged `pi` block; the extension is now a thin adapter.
* **`oas install <name|git-url|path>`** — acquisition command. As refined by
  [capability packages](/decisions/capability-packages.md), external sources
  land in `~/.oas/capabilities/` or `<level>/.agents/capabilities/`, are
  integrity-locked, and remain inactive until an explicit `oas use` binding.
* `files` whitelist in package.json so `npm publish` never ships `agents/`
  (souls/instances) or workspace config.

Alternative rejected for now: splitting `oas-cli` / `oas-pi` packages —
version-skew and publish overhead without immediate gain; the `lib/` boundary
keeps the split cheap later.

# Runtime refinement (2026-07-11)

The capability-package decision resolves the former cross-runtime skill
constraint: spawn materializes one exact instance-local `.agents/skills` set.
Pi disables ambient discovery and Claude receives instance-local project and
config-home views. Runtime adapters no longer bridge workspace skill roots or
provide a fallback skill-resolution model; their runtime value is memory-session
events and harness/bootstrap integration.

# Status

Implemented 2026-07-10 across v0.3.0–v0.6.1 (all published to npm via the
tag-driven CI pipeline):

- v0.3.0: core → `lib/`, @oas-framework scope, `install` + `doctor --json`.
- v0.4.0: **adapter split** — @oas-framework/pi is a separate thin package;
  the kernel package no longer ships the pi extension; `oas root` for
  adapter resolution.
- v0.5.0: oas-jira bundled; attached work mode first-class; agent-initiated
  harvest (`oas okf harvest` via manifest `commands:`); init per-layer
  flags; global getting-started skill.
- v0.6.x: **the CLI became the universal command surface** — status/spawn/
  retire(--self)/create in the CLI with `--json` everywhere; the pi adapter
  dropped ALL tools (glue only: memory session events, instance resource
  exposure, and the pre-workspace `oas-getting-started` bootstrap);
  skills/injections teach CLI commands exclusively. This completes the
  original intent: runtime adapters ship zero operations.
