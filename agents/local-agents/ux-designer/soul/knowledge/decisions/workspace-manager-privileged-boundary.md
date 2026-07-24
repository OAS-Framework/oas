---
type: Decision
title: Workspace manager privileged boundary
description: "Keep workspace discovery, path validation, persistence, native picking, and server replacement in the privileged process while the renderer owns only interaction state."
tags:
  - workspace
  - electron
  - security
  - architecture
timestamp: 2026-07-24T10:35:50Z
---

# Decision

The renderer presents a searchable workspace switcher and Add workspace modal but never scans arbitrary filesystem paths. Privileged methods return validated suggestions, run the native directory picker, and add a workspace through stable domain results.

# Contract principles

- Suggestions come from bounded known roots, team-scope siblings, and path-validated recents rather than recursive filesystem scanning.
- Suggestion `id` scopes APIs; suggestion absolute `path` feeds the add mutation.
- Domain failures resolve with stable codes and renderable prose; transport failure rejects.
- Switch only after success proves the panel advertises the new ID and the proxy allow-list is refreshed.
- Replacement must be serialized, identity-checked, ownership-safe, and transactional; persist recents only after readiness and restore prior state on failure.
- Existing terminal viewers must survive server replacement because they attach directly to tmux.

# UX consequences

Disambiguate duplicate names with team and canonical path. Keep the modal non-dismissible during mutation, clear filtered-out selection, point expired suggestions to the native picker, and preserve discovery independently from picker ownership.
