---
type: Lesson
title: Shared degradation state must treat unknown as capable
description: Renderer modules that gate mutation UI on backend capability probes must distinguish unknown or invalid probe data from a proven incompatible backend, because defaulting unknown to disabled can break capable mixed-version and test-stub servers.
tags: [desktop, renderer, degradation, testing, spawn]
timestamp: 2026-07-24
---

# The bug

Wiring the CLI degradation card into the Spawn view broke existing spawn-view
regression suites whose `ctx.api` stubs answered `{}` for unknown paths.
`refreshCli` stored that object as the shared capability state,
`cliAvailable()` returned false, every spawn button was disabled, forms never
opened, and the tests failed before they could exercise the spawn flow.

# Rule

Capability state needs three meanings, not a truthy object check:

- `null` / not yet probed / invalid payload = unknown;
- `{ ok: true }` = compatible;
- `{ ok: false }` = probed and incompatible.

Only a payload with `typeof d.ok === "boolean"` should count as a probe result.
Anything else — an older server without the endpoint, a harness stub that
returns `{}` for unrecognized paths, or transient garbage — must leave the state
unknown.

Unknown renders as capable: buttons stay enabled and no degradation card is
shown. Treating unknown as unavailable is a false-negative regression for users
on mixed server versions, because the actual mutation path still fails safe at
the server boundary with `503` / `cli-unavailable`; see the [spawn endpoint
contract](/architecture/spawn-endpoint.md) and [desktop deployment mutation
boundary](/architecture/desktop-deployment-reader.md).

# Regression pattern

Drive the renderer through a `ctx.api` stub that returns `{}` for the capability
probe while preserving normal `/api/agents` and spawn responses. The spawn view
must keep buttons enabled and forms openable. A separate incompatible probe with
`{ ok: false }` should be the case that disables mutation UI and shows the
inline degradation state.
