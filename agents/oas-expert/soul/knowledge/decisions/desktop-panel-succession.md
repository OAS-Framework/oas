---
type: Decision
title: Desktop succeeds the web and terminal panels as a standalone product
description: The Electron desktop app becomes OAS's sole panel, owns its bundled backend outside the kernel, degrades to observation without an installed OAS CLI, and replaces oas.web and oas pane through a gated one-release sunset.
status: accepted
tags: [desktop, control-pane, distribution, deprecation, architecture]
timestamp: 2026-07-24
---

# Context

OAS developed two operator surfaces before the desktop product: the universal
CLI's `oas pane` TUI and the `oas.web` browser capability. The desktop app now
combines the useful panel model with a hierarchy-first interface, brain and
markdown readers, and real tmux terminals through Electron and node-pty.

Keeping three panels would split product ownership and duplicate behavior.
Turning the desktop app into a capability would also confuse two different
contracts: OAS capabilities compose behavior into agent instances, while a
signed desktop installer is an operator-facing application that must be able
to start before the machine has installed the OAS CLI.

This decision supersedes the product and packaging direction in the [web pane
decision](/decisions/web-pane.md) and the continuing-product implications of
the [standalone TUI decision](/decisions/control-pane-live-standalone-tui.md),
[card architecture](/decisions/control-pane-v3-card-architecture.md), and
[visual language](/decisions/control-pane-visual-language.md). Those concepts
remain as the history and migration source for the replacement.

# Decision

## One panel, distributed as a product

The desktop app becomes the OAS panel. It remains in the OAS monorepo under
`packages/desktop/`, but it is never acquired, activated, or targeted as an OAS
capability. Electron-builder produces signed installers through GitHub Actions;
the repository's GitHub Releases distribute those artifacts.

The desktop package stays private and outside the root npm package's published
files. `@oas-framework/oas` remains the runtime-neutral kernel and universal
CLI, with no Electron, node-pty, xterm, or desktop-application dependencies.

## The desktop package owns its backend

Once the browser capability is retired, the local HTTP/backend process has one
product consumer. Its source therefore belongs to `packages/desktop/` and is
bundled into the application. It does not move into `lib/` merely because the
transitional server imports kernel functions; `lib/` remains the reusable
runtime-neutral kernel surface.

Operational integration uses the public CLI boundary from the [standalone CLI
decision](/decisions/standalone-cli.md). The desktop backend detects a
compatible installed `oas` executable and invokes lifecycle or capability
operations through structured `oas ... --json` commands. If an operation needs
a stronger JSON seam, the CLI contract is extended rather than teaching the
desktop server to import an adjacent kernel implementation. A shared read-only
model belongs in `lib/` only if a non-desktop consumer independently justifies
it.

## No OAS means observe, not administer

Without an installed compatible OAS CLI, the app may open a recognizable
existing deployment and:

- display roster, hierarchy, brain, markdown, task/state, and git read views;
- attach to existing tmux sessions through its real terminal; and
- pass terminal input to those already-running sessions.

It does not perform OAS lifecycle, configuration, package, or memory mutations:
spawn, retire, create, harvest, install, trust, use, and related administration
remain disabled behind one consistent install-or-update affordance. Tmux is a
separate host prerequisite and receives its own diagnostic. After OAS is
installed, the app re-probes compatibility and enables operations without
requiring the desktop app to be reinstalled.

A machine with neither OAS nor an existing deployment receives workspace
selection and installation guidance, not a fabricated empty deployment. The
installer does not hide a second full operational kernel inside the app; doing
so would erase the degradation boundary and permit version skew against the
workspace's actual OAS installation.

## Gated N/N+1 sunset

Removal is not immediate. The deprecation clock begins only after replacement
installers and the replacement workflows are operational and stable.

- **Release N:** desktop is the recommended panel. `oas pane`, `oas web`,
  installation of `oas.web`, the control-pane package export, and their docs
  are marked deprecated and point to desktop. Migration guidance covers user
  configs and locks that name `oas.web`.
- **Release N+1:** remove `capabilities/oas-web/`, `lib/control-pane/`, the
  `oas pane` command, the `./control-pane` export, and their tests, docs, and
  marketplace references. Diagnostics or explicit cleanup guidance prevent
  old config and lock entries from failing mysteriously.

A full notice release is required because both the capability and the package
export have shipped publicly, so repository search cannot establish the full
external dependency set.

## Soul succession

A durable `oas-desktop-engineer` soul owns the full desktop product:
`packages/desktop/`, its bundled backend, and desktop release automation. It
pairs with the durable UX designer role. The `tui-dev` and `webpanel-dev` souls
retire only after their still-relevant terminal, server, renderer, security,
testing, and release knowledge has been migrated topic by topic and is
reachable from the successor's indexes.

# Transition constraint

The first desktop feature may retain `oas.web` as a coherent in-tree backend
bridge. Its adjacent-checkout paths and exact web-capability identity are
transitional seams, not installer contracts. Dormant Diff and Jira source may
remain inert during that bridge, but it is not a product promise and does not
enter installer scope without explicit approval. No new browser-panel or TUI
features are added beyond correctness and security fixes while the successor is
being prepared.

# Consequences

The desktop product can deliver a rich native experience without bloating the
kernel npm package or pretending to administer OAS when no compatible kernel is
installed. The cost is a deliberate migration: the desktop backend must own
read behavior, CLI JSON seams must cover mutations, installer stability gates
the legacy sunset, and publicly shipped config/export references require a
notice period.
