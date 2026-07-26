---
type: Decision
title: Quick Open hands off to Spawn via a consumed-once preselect
description: Quick Open selection sets a module-level pendingPreselect in spawn.mjs consumed by the next roster paint; spawnable CLI-ready souls open the modal, while others only focus their card.
tags: [desktop, quick-open, spawn, keybindings]
timestamp: 2026-07-26
---

# Decision

The Mod+P Quick Open feature hands soul selection to the existing Spawn view instead of opening a second spawn form.

`renderer/quick-open.mjs` lists souls from `GET /api/agents`, the same source the Spawn view uses, through the shared `overlay-picker.mjs` picker machinery. Selection calls `views/spawn.mjs` `preselectSoul({ name, agentsRoot })` and then `showStage("spawn")`.

The Spawn view stores that value in a module-level pending preselect. The next roster paint (`refresh` → `applyPreselect`) consumes it exactly once; if the Spawn view is already mounted with a loaded roster, it may apply immediately. This prevents stale modal pops after later roster refreshes.

# Apply semantics

- If the soul is spawnable and `cliAvailable()` is true, open the existing spawn modal.
- If the soul is attached-only, CLI is pending/unavailable, or the name is not present in the current workspace roster, focus the soul card so its disabled button, tooltip, or degradation card explains the state.
- Do not create a second spawn form and do not bypass the Spawn view's degradation handling.
- Match by `name` plus `agentsRoot` when both sides have it, following the [composite identity lesson](/lessons/cluster-composite-identity.md).

# Terminal key policy

The action id is `app.quickOpenSouls`, default chord `Mod+P`, global context. It is not in `TERMINAL_ALLOWLIST`: on macOS, ⌘P fires inside xterm by the existing Mod-chord policy, while on Linux/Windows Ctrl+P remains shell history inside xterm. See [Keybinding engine terminal allowlist is action-id based, not chord based](/lessons/keybindings-terminal-allowlist-by-action-id.md).
