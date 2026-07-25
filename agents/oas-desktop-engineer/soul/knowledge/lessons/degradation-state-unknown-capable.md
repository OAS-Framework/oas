---
type: Lesson
title: CLI degradation state must distinguish pending, compatible, and unavailable
description: The Spawn view should not render a probe-pending CLI state as capable or permanently dead; pending gets retrying card-less disabled UI, compatible enables spawn, and settled unavailable gets the degradation card.
tags: [desktop, renderer, degradation, testing, spawn, cli]
timestamp: 2026-07-25
---

# Current spawn contract

The Spawn view's CLI degradation state has three operational meanings:

- **Probe pending** (`null`): no degradation card yet, and spawn actions do not
  render capable. The button tooltip should say that Desktop is checking for a
  compatible `oas` CLI, not point to a card that does not exist.
- **Compatible** (`{ ok: true }`): spawn actions can be enabled.
- **Settled unavailable or incompatible**: show the CLI degradation card and use
  the card/recovery-path tooltip for disabled controls.

A transport failure while probing `/api/cli` must not leave the renderer in the
pending state forever. The roster poll already refreshes agents; while the CLI
state is still pending it should also retry `refreshCli(ctx)`. Once the probe has
settled, stop the retry and let the settled state's card or enabled UI own the
recovery path.

# Failure mode

The silent-dead state happened when `refreshCli` ran once on mount and a
boot-time transport failure raced backend startup or a proxy blip. The 8s roster
poll kept refreshing agents but never refreshed CLI state, so Spawn buttons stayed
disabled until app focus or view remount. Because pending is card-less by design,
the disabled tooltip's old "see the card above" text sent the user to a missing
recovery surface.

# Explicit parsing is still the durable rule

The earlier false-negative regression behind this concept came from storing an
unrecognized probe payload such as `{}` as if it were a settled incompatible
result. The durable part is to parse the CLI probe contract explicitly rather
than relying on object truthiness: only the current contract's settled shapes
should move the view out of pending, and pending/null must have its own retrying
UI behavior.

# Regression pattern

Drive the real spawn view under jsdom against live-style backends:

- a current backend answering `/api/cli` ok enables the Spawn button;
- an old backend with no `/api/cli` support settles into the unavailable/carded
  path; and
- a transport-pending probe leaves the view card-less, shows the "checking"
  tooltip, and retries from the roster poll until the CLI state settles.

# Related concepts

- [Spawn endpoint root allowlist and empty-task semantics](/architecture/spawn-endpoint.md)
- [Desktop deployment reader and mutation degradation after kernel bridge removal](/architecture/desktop-deployment-reader.md)
