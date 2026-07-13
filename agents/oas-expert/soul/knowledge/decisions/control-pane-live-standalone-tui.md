---
type: Decision
title: Control Pane is a live standalone TUI
description: OAS exposes its current agent constellation through `oas pane`, with a runtime-neutral data model and no historical reconstruction.
tags: [control-pane, tui, cli, instances]
timestamp: 2026-07-11
---

# Context

Operators need to see and enter a team of first-class agent sessions without
reducing agents to hidden subagent calls. OAS already has useful current-state
surfaces: instance metadata and files, tmux windows, git worktrees, tasks,
working state, and soul knowledge. It does not yet have a runtime-neutral event
or telemetry contract.

A first view could have been a pi extension, a web dashboard, or a standalone
terminal command. A pi extension would couple a framework-level operation to
one harness and work against the planned Claude Code adapter. A web application
would add a server and browser lifecycle before the current-state model was
proven. Inventing history from incomplete metadata would make the display look
richer but less truthful.

# Decision

The product is **Control Pane**, opened with **`oas pane`**. Its first version
is a keyboard-first, read-only, live-only standalone TUI:

- a runtime-neutral model gathers plain current-state objects from OAS files,
  git, and tmux;
- a separate terminal frontend owns ANSI rendering and input, with no pi API;
- the primary shape is the parent/child spawn constellation;
- spawn records lightweight forward-only `parentInstance` and `spawnOrigin`
  metadata from the caller's OAS instance environment, distinguishing children
  from intentional operator roots;
- legacy instances appear as unlinked and children whose parent is no longer
  live appear as flat roots;
- tmux is authoritative for liveness and direct window switching;
- retired history, inferred relationships, event journals, and ghost nodes are
  excluded.

The interface can be used from pi, Claude Code, or a normal terminal because
it belongs to the universal CLI rather than a harness adapter. Runtime
telemetry remains a follow-up until OAS defines an adapter-neutral event
contract; the UI must not derive a framework contract from pi internals.

# Consequences

The MVP stays small and truthful while establishing a reusable model/UI
boundary. Current instance files may show rich progress without any daemon.
The constellation becomes more useful as newly spawned instances acquire
lineage metadata, while compatibility requires no migration. Legacy absence is
shown as unknown rather than visually conflated with a deliberate root.

The tradeoff is that the view cannot yet answer historical or fine-grained
activity questions, and idle means only “no matching tmux window,” not a
semantic task state. Those limitations are explicit rather than hidden behind
inference.

The visual design vocabulary is captured separately in the [Control Pane visual
language decision](/decisions/control-pane-visual-language.md).

This decision extends the universal command-surface principle in the
[standalone CLI decision](/decisions/standalone-cli.md).
