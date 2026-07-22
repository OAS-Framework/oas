---
type: Lesson
title: Route panel keyboard by logical pane focus, not DOM focus
description: Binding keydown to the terminal element made typing silently die whenever a button or header click moved DOM focus while the pane still looked focused; route keys with a window listener to the logical focused pane and ignore real editable controls.
tags: [oas-web, keys, focus, regression]
timestamp: 2026-07-22
---

# The bug

0.7.0 shipped a "cannot type" regression (human report via oas-expert-2).
The keydown/paste handlers were bound to each pane's `.term` element and
guarded by `document.activeElement !== t`. Any click on the pane header, the
sidebar collapse button, or the split button moved DOM focus away from the
term div. The pane kept its visual focused ring from separate logical state,
but every keystroke was silently dropped.

The regression was reproduced headlessly with playwright-core plus
`chrome-headless-shell`: after `.phead`, `#sidebtn`, or `.pbtn` clicks, zero
`/api/keys` POSTs were emitted.

# Fix in 0.7.1

Keyboard routing is logical, not DOM-focus-bound:

- one `window` keydown/paste listener sends to `focusedPane()` whenever
  `document.activeElement` is not a real editable control (`INPUT`,
  `TEXTAREA`, `SELECT`, or `contentEditable`);
- any mousedown inside a pane claims logical focus;
- the term div does not need `tabIndex` or `.focus()`, and the focused ring is
  driven by `focusPane`;
- Cmd-B toggles the sidebar, while Ctrl-B always flows to the session as the
  tmux prefix rather than being special-cased through `activeElement`.

# Rule

In a panel where the terminal is the primary input surface, DOM focus is too
fragile a router: every incidental focusable control becomes a key sink. Keep
an explicit focused-pane model and route globally, excluding only real editable
controls.

# Repro tooling

playwright-core plus the cached
`~/Library/Caches/ms-playwright/chromium_headless_shell-*/.../chrome-headless-shell`
binary gives a real-browser keyboard test without installing browsers.

# Related concepts

- [Raw key passthrough and the POST host/origin guard](/architecture/raw-key-passthrough-and-host-guard.md)
- [Split panes, collapsible sidebar, and compact session header](/architecture/split-panes-and-compact-shell.md)
