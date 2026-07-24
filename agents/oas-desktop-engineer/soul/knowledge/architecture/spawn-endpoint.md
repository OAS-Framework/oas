---
type: Concept
title: Spawn endpoint root allowlist and empty-task semantics
description: POST /api/spawn treats browser-supplied agentsRoot as a selector into the server's workspace roots, while task "" intentionally spawns an awaiting-instructions instance.
tags: [desktop-backend, spawn, endpoint, security, task]
timestamp: 2026-07-24
---

# Endpoint contract

`POST /api/spawn` receives the agent to spawn, an `agentsRoot`, and task text from
the browser. The `agentsRoot` value is path-shaped but must not be treated as an
arbitrary client-selected filesystem location: the server accepts it only when
its `resolve()` matches one of the roots already computed for the watched
workspaces (`workspaces().flatMap((w) => w.roots)`). The client path is therefore
a selector into a server-side allowlist, not a path-injection surface.

Apply the same allowlist pattern to any future panel endpoint that accepts a
path-shaped parameter from the browser.

# Empty task semantics

The kernel needs no separate web-panel "no task" mode. Calling
`spawnInstance(root, agent, { task: "" })` produces a `TASK.md` whose task section
says "No task was provided at spawn time — await instructions." This matches the
panel's default spawn flow: the default spawn button sends `task: ""`, and the
optional "+task" flow prompts for task text before spawning.

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

Unknown agent names and spawn failures return HTTP 409 with the kernel error
message truncated to 300 characters, matching the shape of other panel error
responses.

This was verified end to end in v0.8.0 by spawning an instance through the panel
API, observing it in `/api/panel`, capturing its tmux pane through
`/api/session`, and retiring it with `oas retire`.
