---
type: Decision
title: Quick Open hands off to Spawn via a consumed-once preselect
description: Quick Open selection sets a module-level pendingPreselect in spawn.mjs consumed only by a current mounted Spawn roster paint; unmount clears deferred intents, spawnable CLI-ready souls open the modal, while others reveal and focus their card.
tags: [desktop, quick-open, spawn, keybindings]
timestamp: 2026-07-26
---

# Decision

The Mod+P Quick Open feature hands soul selection to the existing Spawn view instead of opening a second spawn form.

`renderer/quick-open.mjs` lists souls from `GET /api/agents`, the same source the Spawn view uses, through the shared `overlay-picker.mjs` picker machinery. Selection calls `views/spawn.mjs` `preselectSoul({ name, agentsRoot })` and then `showStage("spawn")`.

The Spawn view stores that value in a module-level pending preselect. The next current mounted-roster paint (`refresh` → `applyPreselect`) consumes it exactly once. If the Spawn view is already mounted, immediate application is allowed only when both the pending intent generation and the roster data generation match the current workspace generation; a loaded roster from a previous workspace is not current data. If Spawn unmounts while the preselect is deferred, `unmount()` clears it so a later remount in the same workspace generation cannot consume a dead user intent. This prevents stale modal pops after later roster refreshes and avoids consuming the handoff against a stale previous-workspace roster.

# Apply semantics

- If the soul is spawnable and `cliAvailable()` is true, open the existing spawn modal.
- If the soul is attached-only, CLI is pending/unavailable, or the name is not present in the current workspace roster, focus the soul card so its disabled button, tooltip, or degradation card explains the state.
- If the target soul exists but an active filter hides its card, clear the filter and repaint before focusing it.
- Do not consume the pending preselect until the generation checks prove both the intent and roster data are current; if the roster is stale, defer and let the current refresh paint apply it.
- Clear any deferred pending preselect on Spawn unmount, because generation checks do not prove the original mounted consumer is still alive.
- Do not create a second spawn form and do not bypass the Spawn view's degradation handling.
- Match by `name` plus `agentsRoot` when both sides have it, following the [composite identity lesson](/lessons/cluster-composite-identity.md).
- See [Consumed-once pending intents must gate on data currency and owner lifetime](/lessons/pending-intent-data-currency.md) for the race and regression shape behind the generation gate and unmount clear.

# Terminal key policy

The action id is `app.quickOpenSouls`, default chord `Mod+P`, global context. It is not in `TERMINAL_ALLOWLIST`: on macOS, ⌘P fires inside xterm by the existing Mod-chord policy, while on Linux/Windows Ctrl+P remains shell history inside xterm. See [Keybinding engine terminal allowlist is action-id based, not chord based](/lessons/keybindings-terminal-allowlist-by-action-id.md).
