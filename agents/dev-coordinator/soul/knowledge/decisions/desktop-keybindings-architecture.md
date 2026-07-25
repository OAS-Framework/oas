---
type: Decision
title: Desktop keybindings — editable keymap architecture
description: Why the keybindings feature uses a central action registry, chord engine with localStorage overrides, and a strict terminal-safety policy.
tags: [desktop, keybindings, design]
---

# Desktop keybindings — editable keymap architecture

For "shortcuts for every mouse action, user-editable" in `packages/desktop`, the chosen architecture is a central `renderer/keybindings.mjs` action registry (`id`, `label`, `context`, `run`), a chord engine with `DEFAULT_KEYMAP` and localStorage overrides (`oas-desktop-keymap`, overrides-only JSON, storage-less-safe like `theme.mjs`), one window keydown dispatcher in `shell.mjs`, and a shell-owned editor dialog. It deliberately does not add a new nav-rail stage.

Key constraints that shaped it:

- **Terminal safety is the hardest requirement**: `app-menu.mjs` and `palette.mjs` already encode the policy. Inside `.xterm`, Ctrl chords belong to the attached program; only meta chords on macOS or a tiny explicit allowlist may fire. Any keymap engine must absorb `isPaletteShortcut` rather than coexist with it, or the policies drift.
- **Context scoping** (`global`, `stage:x`, `roster`, `tabs`) lets defaults use single letters in stages without stealing typing elsewhere; the shell reports active contexts on its existing state transitions.
- **View-local keys stay view-local but registered**, so view-local handlers such as the hierarchy `onKey` path show in the editor and are rebindable without routing every view keystroke through the global dispatcher.
- **Core and wiring are split cleanly**: engine/editor code is separate from registrations and roster tree keyboard operations, so two developers can parallelize against a written contract.
