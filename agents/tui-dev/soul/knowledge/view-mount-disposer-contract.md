---
type: Decision
title: View contract extension — mount() may return a per-mount disposer
description: The desktop view host prefers a disposer function returned by mount(el, ctx) over module-level unmount() so multi-tab views can clean up independently while older single-tab views keep their original semantics.
tags: [desktop, view-host, contract, lifecycle]
timestamp: 2026-07-22
---

Review `de387d1` exposed a view-host contract gap: views are module-level
singletons, but the shell can open multiple markdown and diff tabs. A second
`mount()` could empty the first tab, and closing either tab could blank the
other.

The contract extension is backward-compatible:

- `mount(el, ctx)` may return a disposer function.
- `openViewTab` stores the returned disposer on the tab record and prefers it
  over the module's `unmount()` when closing that tab.
- Views that do not return a disposer keep the original module-level
  `unmount()` semantics.
- `markdown.mjs` and `diff.mjs` keep a module-level `mounts` set of disposers
  so the exported `unmount()` still disposes every mount for harness
  compatibility.
- If `mount()` is async, the host must treat close-during-mount as pending
  cleanup and wait for settle before choosing between the returned disposer and
  legacy `unmount()`. See [Async mount close race — cleanup must wait for
  settle](async-mount-close-race.md).

Regression coverage lives in `packages/desktop/test/multi-mount.test.mjs`: two
mounts coexist, disposers are independent, `ctx.ws` forwards, and module-level
`unmount()` disposes all mounts.

The coordinator was notified before the contract change landed (`e427db1a`).
