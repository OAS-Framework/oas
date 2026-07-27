---
type: Decision
title: Agent-centered desktop information architecture
description: "Keep agents permanently visible while treating terminals, brains, and files as context-scoped artifacts rather than primary destinations."
tags:
  - desktop
  - information-architecture
  - agents
timestamp: 2026-07-24T10:35:50Z
---

# Decision

The OAS desktop shell uses agents and their instances as its primary objects. A single fixed-width sidebar keeps the instance hierarchy visible beneath a small set of first-class navigation surfaces. Terminal, brain, and markdown views open as context-scoped tabs rather than becoming additional global destinations.

# Rationale

A permanent roster lets users answer “which agent am I acting on?” before opening an artifact. Removing redundant global destinations prevents width changes and navigation duplication. Workspace, instance, and artifact identity must remain visible together because same-named instances can exist in different workspaces.

# Practical rules

- Keep primary navigation intentionally small.
- Keep the instance tree in one stable sidebar instead of replacing it per view.
- Open a selected running instance directly into its exact terminal.
- Return to the previous navigation stage after the final artifact tab closes.
- Scope terminal and brain tabs to the workspace that created them.
