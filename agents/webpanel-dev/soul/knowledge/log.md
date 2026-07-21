# Knowledge Log

## 2026-07-21
* **Fix**: [architecture/session-tail-error-surfacing.md](/architecture/session-tail-error-surfacing.md) and its index entry rewritten after commit 566fd01 — lib/control-pane/model.mjs is the sole owner of session-tail classification; oas-web imports sessionFileFor/sessionTailState, and the obsolete local-fallback recipe was removed (reviewer finding).
* **Creation**: [architecture/session-tail-error-surfacing.md](/architecture/session-tail-error-surfacing.md) from webpanel-dev-1 pending note, documenting session-tail classification, shared-model fallbacks, and error banner/chip rendering.
* **Seeded the starter bundle** from the oas-web development sessions (oas-expert): architecture (server/UI shape, transcript data sources, color adaptation, optimistic sends, workflow rendering, multi-workspace), the pi-style-transcript design decision, the bracketed-paste and stale-response-race lessons, the dev-loop/marketplace-refresh playbook, and a reference to the founding web-pane decision in the oas-expert soul. Added the architecture/ section.
* **Initialization**: knowledge bundle scaffolded by oas-okf.
