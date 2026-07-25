---
type: Lesson
title: View-default suppression must use context-aware conflict checks
description: When resolveViewKey yields local defaults to explicit bindings, it must scan only same-context or global actions; otherwise an explicit binding in an inactive foreign context can dead-key the view.
tags: [desktop, keybindings, views]
timestamp: 2026-07-25
---

# Context-aware default suppression

A view resolver may suppress a view-local default when an explicit user binding elsewhere in the registry should win. That anti-shadowing scan must apply the same collision rule the engine uses in `findConflict`: only same-context bindings or global bindings collide with the view action.

Scanning every registered context makes a key dead everywhere. For example, if `tabs.next` is explicitly bound to `b`, a hierarchy-canvas resolver that ignores context can suppress the default `hier.brain` binding on `b`; then the engine rejects `tabs.next` as context-ineligible in the hierarchy view, so no action fires.

Pass the view's context into `resolveViewKey` so explicit-binding suppression matches engine eligibility. Treat a missing context conservatively: any explicit binding wins, so untyped callers keep the previous safe behavior.

# Related concepts

- [View-local shortcuts resolve chords through the engine keymap](/decisions/view-local-shortcuts-engine-keymap.md)
- [Dynamic action registrations carry their own default chords](/lessons/dynamic-action-registration-default-chords.md)
- [Real keybindings engine integration keeps defaults engine-owned](/lessons/real-keybindings-engine-integration.md)
