---
type: Decision
title: Terminal focus follows user intent through activateTab's focusContent option
description: activateTab(id, { focusContent }) invokes a tab-provided focusContent callback only on user-initiated jumps — terminal tabs supply term.focus(); side-effect activations default to false and never steal focus.
tags: [desktop, terminal, focus, tabs]
timestamp: 2026-07-26
---

# Decision

Tab activation distinguishes user-intent jumps from side-effect activations with `activateTab(id, { focusContent })`.

Tabs may carry a `focusContent: () => void` callback; terminal tabs supply `term.focus()`. `activateTab(id, { focusContent = false })` runs that callback after `onShow` only when the caller declares user intent. The default-false option makes focus-stealing opt-in instead of an incidental side effect of showing a tab.

# User-initiated paths

- The already-open dedup path inside `openTerminalTab` passes `focusContent: true` for palette instance rows, roster row click/Enter, and post-spawn open.
- `addTab`'s own dedup takes `focusOnActivate: true` from the terminal tab spec.
- Fresh terminal opens already focus through `term.focus()` in `terminal-tab.mjs` `onReady`.

# Side-effect paths

These paths stay with bare `activateTab(id)` and therefore do not steal input focus:

- workspace-switch restoration through `showTerminalContext`;
- close-fallback activation;
- tab-strip clicks and arrow navigation, where focus belongs to the strip.

# Keybinding policy

`terminal.focusActive` is a global rebindable action with no default chord. Ctrl chords belong to the pty on Linux/Windows, and plain keys are guarded off editables, so there is no safe universal chord. Users can bind their own.

# Test pins

`test/terminal-focus.test.mjs` pins the source-level invariant because the composition root lives in Electron-only `shell.mjs`. Fresh-open focus ordering is behaviorally covered in `terminal-tab.test.mjs`.

# Related concepts

- [One input surface — the terminal's own input line](/decisions/terminal-input-unification.md)
- [Quick Open hands off to Spawn via a consumed-once preselect](/decisions/quick-open-spawn-preselect-handoff.md)
- [Keybinding engine terminal allowlist is action-id based, not chord based](/lessons/keybindings-terminal-allowlist-by-action-id.md)
