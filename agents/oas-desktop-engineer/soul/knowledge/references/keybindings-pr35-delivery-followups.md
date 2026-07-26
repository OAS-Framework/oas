---
type: Reference
title: Keybindings PR #35 delivery follow-ups
description: PR #35 delivered the desktop keybindings engine/editor; future keybindings work should preserve the shipped DEFAULT_KEYMAP/defaultChord split and terminal action-id allowlist while sweeping stale comments.
tags: [desktop, keybindings, delivery, follow-up]
timestamp: 2026-07-25
---

# Delivery record

Desktop keyboard shortcuts merged to main via PR #35 (merge commit `7f1e5a7`, feature head `039458f`). The delivered surfaces were:

- `renderer/keybindings.mjs`: chord model, registry with `defaultChord` metadata, contexts, `DEFAULT_KEYMAP`, localStorage overrides with load-time sanitization, `matchEvent` with terminal policy plus `defaultPrevented` and editable-field guards, and `findConflict`.
- `renderer/keybindings-editor.mjs`: `Mod+,` shortcut editor modal with recording, conflict and bare-key warnings, and keyed focus restoration across rerenders.

The feature passed five post-commit reviews plus merged-state and delta reviews; all findings noted in the source delivery record were resolved.

# Queued follow-ups

- Sweep for stale comments touching the keybindings surfaces after the many-round merge history. A late review noted one stale-comment nit; the wiring comments around `view-keys.mjs` and view defaults are worth checking against the final resolution order: `override ?? DEFAULT_KEYMAP ?? registration defaultChord`, with explicit `null` winning as an unbind.
- Preserve the intentional split between default mechanisms: `DEFAULT_KEYMAP` is canonical for shipped defaults, while `defaultChord` is the API for dynamically registered actions. If they ever drift, `DEFAULT_KEYMAP` wins by construction; do not simplify one away without coordinator sign-off.
- Keep terminal allowlist policy action-id based (`TERMINAL_ALLOWLIST`). The Linux/Windows divergence from legacy `isPaletteShortcut` passthrough was coordinator-approved, and the parity test in `test/keybindings.test.mjs` documents it.

# Related concepts

- [View-local shortcuts resolve chords through the engine keymap](/decisions/view-local-shortcuts-engine-keymap.md)
- [Dynamic action registrations carry their own default chords](/lessons/dynamic-action-registration-default-chords.md)
- [Keybinding engine terminal allowlist is action-id based, not chord based](/lessons/keybindings-terminal-allowlist-by-action-id.md)
- [Real keybindings engine integration keeps defaults engine-owned](/lessons/real-keybindings-engine-integration.md)
