---
type: Lesson
title: Dormant compatibility paths in exported resolvers are liabilities, not safety
description: When production stops needing a legacy fallback in an exported resolver, delete it with the policing logic it required instead of adding gates that can silently break unbind semantics.
tags: [desktop, keybindings, api-design]
---

# Delete dead fallback paths

The keybindings wiring's `resolveViewKey` kept a "legacy chord" fallback from the pre-`defaultChord` era. Reviews first tried to make that fallback safe by yielding to explicit bindings, then by limiting collisions to context-eligible actions and engine-unknown ids; each gate added registry or context-scanning logic.

Review `4f57091` named the durable fix: production callers had stopped passing chord fields, so the fallback was dormant. A dormant fallback in an exported resolver invites a future caller to silently break unbind semantics, because `getBinding` returning `null` cannot distinguish "unbound by choice" from "no default here."

Deleting the path also deleted the registry scan and `context` parameter that existed only to police it. The engine's effective binding stayed the single source of truth, and the resolver shrank to a chord-match loop.

# Rule

When a compatibility path loses its last production caller, delete it in the same breath. Keep gates only while a live migration still needs them; do not let gating logic become permanent safety theater for a dormant exported API path.

# Related concepts

- [Dynamic action registrations carry their own default chords](/lessons/dynamic-action-registration-default-chords.md)
- [View-default suppression must use context-aware conflict checks](/lessons/view-default-suppression-context-collision.md)
- [Real keybindings engine integration keeps defaults engine-owned](/lessons/real-keybindings-engine-integration.md)
