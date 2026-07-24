---
name: electron-live-verification
description: >-
  Use when verifying live OAS desktop/Electron interactions that DOM tests,
  jsdom, screenshots, or synthetic JavaScript events cannot prove: terminal
  wheel scrolling, tmux copy mode, xterm attachment identity, ephemeral viewer
  cleanup, or interactions that must be driven through Chrome DevTools Protocol
  and checked against tmux state.
---

# Live Electron verification with CDP

Renderer unit tests cannot prove that native wheel input reaches tmux, copy mode
changes, or a terminal remains attached to the exact source window. For those
claims, launch Electron with a remote debugging port, drive the real renderer
through the Chrome DevTools Protocol (CDP), and inspect tmux independently.

## Procedure

1. Launch the integrated Electron package against a known workspace and a dedicated debugging port.
2. Select the instance through the rendered UI and locate the active xterm bounds with `Runtime.evaluate`.
3. Send trusted `Input.dispatchMouseEvent` wheel events at the xterm center; JavaScript-created wheel events are not equivalent.
4. Before and after input, query tmux for session window count, window ID, pane ID, `pane_in_mode`, history size, and scroll position.
5. Verify wheel-up enters copy mode and increases scroll position; wheel-down returns to the bottom.
6. Verify window and pane identity remain unchanged and the viewer contains only the exact linked source window.
7. Close the terminal tab and prove the ephemeral viewer is removed while the durable source session/window survives.

## Evidence quality

Record concrete before/after values and screenshots. Pair live evidence with
deterministic unit tests that inventory the locked key table, because visual
scrolling alone does not prove identity isolation.

## Gotchas

- Do not use JavaScript-created wheel events as proof of real terminal input; dispatch trusted input through CDP.
- Do not rely on visual scrolling alone; external tmux state must confirm copy mode, scroll position, and window/pane identity.
- Viewer cleanup is not enough; verify the durable source tmux session/window survives unchanged.
