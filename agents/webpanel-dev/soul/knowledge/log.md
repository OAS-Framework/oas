# Knowledge Log

## 2026-07-21
* **Creation**: [lessons/reused-alias-identity-mismatch.md](/lessons/reused-alias-identity-mismatch.md) from webpanel-dev-1 pending note, documenting how to handle aweb `identity_mismatch` reviewer verdicts after OAS alias reuse.
* **Update**: [architecture/session-tail-error-surfacing.md](/architecture/session-tail-error-surfacing.md) merged the pending first-line-drop note; first-line truncation must be gated on the tail read starting mid-file, not applied to every short log.
* **Harvest**: Dropped `shared-model-adoption.md` after merge because [architecture/session-tail-error-surfacing.md](/architecture/session-tail-error-surfacing.md) already captured the durable shared-model adoption, fallback deletion, test ownership, and transcript-only error limitation.
* **Fix**: [architecture/session-tail-error-surfacing.md](/architecture/session-tail-error-surfacing.md) and its index entry rewritten after commit 566fd01 — lib/control-pane/model.mjs is the sole owner of session-tail classification; oas-web imports sessionFileFor/sessionTailState, and the obsolete local-fallback recipe was removed (reviewer finding).
* **Creation**: [architecture/session-tail-error-surfacing.md](/architecture/session-tail-error-surfacing.md) from webpanel-dev-1 pending note, documenting session-tail classification, shared-model fallbacks, and error banner/chip rendering.
* **Seeded the starter bundle** from the oas-web development sessions (oas-expert): architecture (server/UI shape, transcript data sources, color adaptation, optimistic sends, workflow rendering, multi-workspace), the pi-style-transcript design decision, the bracketed-paste and stale-response-race lessons, the dev-loop/marketplace-refresh playbook, and a reference to the founding web-pane decision in the oas-expert soul. Added the architecture/ section.
* **Initialization**: knowledge bundle scaffolded by oas-okf.
