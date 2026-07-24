---
type: Lesson
title: Contract-test the shared desktop renderer harness against shipped views
description: Desktop renderer views should share one harness whose tabs are checked by enumerating every shipped mount-exporting view, so a new view fails tests until it has a tab and standalone dev-* harnesses stay deleted.
tags: [desktop-app, renderer, harness, testing]
timestamp: 2026-07-22
---

# The trap

Standalone per-view harnesses can drift from the renderer contract and from the knowledge that claims there is one shared harness. Brain originally shipped its own `dev-brain.html`/`dev-serve.mjs` pair while the renderer README claimed a single shared harness for all views.

# Rule

Keep one renderer harness: `harness.html`, served by the same-origin `harness-server.mjs` proxy, with one `data-view` tab per shipped view.

The regression test should enumerate every `views/*.mjs` module that exports `mount` and assert a matching `data-view` tab exists in the shared harness. It should also assert that standalone `dev-*` harness/proxy files do not reappear. Enumeration is the contract: avoid a hardcoded expected-view list so the next shipped view fails automatically until the shared harness gets a tab.

When consolidating retired per-view harnesses, repoint docs and knowledge to `harness-server.mjs` as the surviving same-origin proxy.

# Related concepts

- [Desktop renderer views port of the panel](/architecture/desktop-renderer-views-port.md)
- [Agent brain endpoint and desktop brain view](/architecture/agent-brain-endpoint-and-view.md)
