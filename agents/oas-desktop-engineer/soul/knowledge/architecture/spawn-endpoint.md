---
type: Concept
title: Spawn endpoint root allowlist, empty-task semantics, and installed-CLI degradation
description: POST /api/spawn treats browser-supplied agentsRoot as a selector into the server's workspace roots, preserves task "" as the awaiting-instructions spawn shape, and returns a stable cli-unavailable 503 whenever no compatible installed oas CLI is discovered.
tags: [desktop-backend, spawn, endpoint, security, task]
timestamp: 2026-07-27
---

# Endpoint contract

`POST /api/spawn` receives the agent to spawn, an `agentsRoot`, and task text from
the browser. The `agentsRoot` value is path-shaped but must not be treated as an
arbitrary client-selected filesystem location: the server accepts it only when
its `resolve()` matches one of the roots already computed for the watched
workspaces (`workspaces().flatMap((w) => w.roots)`). The client path is therefore
a selector into a server-side allowlist, not a path-injection surface.

Apply the same allowlist pattern to any future panel endpoint that accepts a
path-shaped parameter from the browser. Keep this validation in process even
when no compatible CLI is installed, so root and agent mistakes stay
meaningful client errors instead of collapsing into generic service degradation.

# Model field semantics

The optional model value is still free-text spawn input, not an enum. The
renderer may offer an advisory catalog from `POST /api/models` (body
`{ runtime }` — a POST so the command-running route sits behind the CSRF Origin
guard, with concurrent misses coalesced into one probe), but
`POST /api/spawn` must pass the provided model preference through without checking
catalog membership. Hard-selecting or server-validating the value would break
comma-separated model preference lists and valid models absent from the probe; see
[Model selection UI must stay advisory](/lessons/model-selection-advisory-datalist.md).

# Empty task semantics

The desktop app needs no separate web-panel "no task" mode. The target OAS
mutation remains `spawnInstance(root, agent, { task: "" })` / equivalent CLI
semantics, producing a `TASK.md` whose task section says "No task was provided at
spawn time — await instructions." This matches the panel's default spawn flow:
the default spawn button sends `task: ""`, and the optional "+task" flow prompts
for task text before spawning.

Repo resolution for panel spawns mirrors the CLI fallback:
`def.repo || defaultRepo(workspaceOf(root))`.

Renderer code must preserve typed-but-unsubmitted task and purpose text before
this request is built. If a periodic roster repaint replaces the open spawn form,
the user-visible task can become an intentional empty-task request; see
[Periodic repaints must not rebuild DOM under open forms](/lessons/poll-repaint-wipes-form-input.md).

# Post-spawn follow-ups

A successful `POST /api/spawn` does not mean the new instance is immediately
visible through `/api/panel`, because the panel roster is a background snapshot.
Any follow-up that resolves the spawned instance by name, such as opening its
terminal, should wait for the workspace-scoped panel roster to include it and
degrade safely if it never appears; see [Wait for the roster snapshot before
post-spawn instance actions](/lessons/post-spawn-roster-snapshot-lag.md).

# Errors and verification

Unknown roots or agent names return HTTP 409 with the validation message
truncated to 300 characters, matching the shape of other panel error responses.
The mutation itself runs through the shipped CLI adapter
(`cli-adapter.mjs::cliSpawn`, called by `oas-web.mjs::spawnAgent`) against the
discovered installed `oas` binary — the app never bundles a kernel. When CLI
discovery has not settled on a compatible binary, requests that pass validation
fail with stable `{ code: "cli-unavailable" }` degradation mapped to HTTP 503:
the code means "install or choose a compatible oas CLI", not "bad request".
Adapter envelope failures surface their own stable codes (e.g. `E_BAD_ARGS`,
`E_RELATIVE_AMBIGUOUS`) as 409. Tests should pin
that distinction so the UI can treat bad input differently from unavailable OAS
mutation capability.

The previous direct-kernel path was verified end to end in v0.8.0 by spawning an
instance through the panel API, observing it in `/api/panel`, capturing its tmux
pane through `/api/session`, and retiring it with `oas retire`. End-to-end spawn
coverage for the CLI boundary lives in `test/desktop-cli-integration.test.mjs`
(fake-CLI envelopes through the HTTP surface).
