---
type: Decision
title: Marketplace over bundled, work modes simplified, runtime integration at spawn
status: accepted
description: v0.13.0 breaking set — "from bundled" removed (official capabilities acquire from the kernel-shipped marketplace folder into installed/, trusted at acquisition); work-mode injection overrides removed (packaged briefings are the contract, setup: env-bootstrap stays); interactive per-layer init prompt; runtime choice (pi|claude) honored end-to-end with local-only oas-claude-config binary selection and hook-contributed launch args (aweb channel plugin for Claude Code).
tags: [capabilities, marketplace, work-modes, runtime, claude, aweb, config]
timestamp: 2026-07-17
---

Decided with the founder, 2026-07-17. Four coupled changes shipped together
as v0.13.0 (breaking; we are the only deployment, migrate-in-place).

# 1. Marketplace replaces bundled

Capability origins are now just `installed` and `owned`. The kernel package's
`capabilities/` folder is the **official marketplace** (interim home — will
eventually move to its own repo/registry): a named install source, no longer
an ambient discovery origin. `oas install <id>` copies the package into the
scope's `.agents/capabilities/installed/`, locks it with
`source: marketplace:<id>@<version>` + integrity, and — because marketplace
packages ship with the kernel you already installed — marks
`trustedExecutables: true` at acquisition (third-party git/path installs keep
explicit `oas trust`). `from: bundled` is a validation error with pointed
migration guidance (doctor-as-code). `oas init` acquires the chosen layer
capabilities as part of init. Restore understands `marketplace:` sources
(re-copies from the current kernel at locked integrity).

Hoisted resources: marketplace-sourced installs (recognized by lock source)
may still resolve framework-hoisted paths (e.g. oas-aweb's
`node_modules/@awebai/pi/skills/...`) — the containment exemption moved from
origin=bundled to marketplace provenance.

# 2. Work modes: briefings fixed, setup stays

`work-modes.<mode>.injection-override` removed — the packaged work-mode
briefings are the contract (they encode the safety discipline; overriding
them was rope). The only work-mode key is `setup:` — an env-bootstrap
command run inside each new worktree right after `git worktree add`
(installs, .env copying, direnv/mise). Scaffolded configs now showcase it.
`oas inject eject <work-mode>` refuses with the removal message.

# 3. Init asks about defaults (interactive TTY only)

Bare `oas init` in an interactive terminal prompts per layer — default shown,
marketplace options listed, "none" accepted. Explicit flags skip prompting;
non-interactive contexts (agents, CI) keep flags-or-silent-defaults, never
hang. Mirrors the tmux-mouse prompt convention.

# 4. Runtime support: claude as a first-class soul choice

`runtime: pi|claude` in soul.yaml was always stored; now it is honored
end-to-end: `oas spawn --runtime` overrides per instance, help/docs updated.
Two mechanisms complete it:

- **`oas-claude-config`** (local-only, never committed): closest file walking
  up from the repo names the claude binary (e.g. `claude-personal` for
  account selection); absent → `claude`. Deliberately NOT in oas-config.yaml:
  it is a personal machine preference, and configs are committed/shared.
- **Hook-contributed launch args**: a spawn hook may print
  `{ launch: { <runtime>: "<args>" } }`; the kernel appends the matching
  runtime's args to the session command (spawn IS session start — the
  command persists in instance.json and runs in the tmux window). The aweb
  integration (oas.aweb v1.4.0) uses this for Claude Code: it installs the
  `aweb-channel` plugin (marketplace `awebai/claude-plugins`) and contributes
  `--dangerously-load-development-channels plugin:aweb-channel@awebai-marketplace`.
  **`aw run claude` is deprecated** — the channel plugin is the supported
  push-event path for Claude Code (one-way events in; outbound stays `aw` CLI).
  Kernel stays runtime-neutral: it knows pi and claude launch shapes, nothing
  aweb-specific.

# Rejected / notes

- Keeping bundled as a trusted ambient origin: rejected — one acquisition
  story for everything; "bundled" made provenance and upgrade semantics
  special-cased.
- Claude binary choice in oas-config.yaml: rejected — committed config must
  not carry personal account selection.
- `--settings k=v k2=v2` silently dropping the second pair remains a known
  CLI footgun (each pair needs its own `--settings` flag) — candidate fix.
