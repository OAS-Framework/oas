---
type: Reference
title: Control Pane decisions in the oas-expert soul
description: The binding decisions for the pane's scope, card architecture, visual language, and the web panel live in the oas-expert soul's decisions bundle and in docs/control-pane.md; consult them before changing the pane's shape.
tags: [control-pane, decisions, reference]
timestamp: 2026-07-20
---

Do not re-derive or contradict these — they are the decided baseline:

- `agents/oas-expert/soul/knowledge/decisions/control-pane-live-standalone-tui.md`
  — the pane is a **read-only, live-only, standalone** CLI TUI (`oas pane`),
  no pi API, no historical reconstruction, no ghost nodes; tmux is
  authoritative for liveness; attach happens by switching to the tmux window
  (`Enter` → `switchToInstance`), never by write actions in the pane itself.
- `agents/oas-expert/soul/knowledge/decisions/control-pane-v3-card-architecture.md`
  — card stack + identity rail + in-place expansion + zoom + variable-height
  scrolling is the v3 baseline; changing it needs a new decision.
- `agents/oas-expert/soul/knowledge/decisions/control-pane-visual-language.md`
  — soul badges/hashed palette, branch chips, tree glyphs, lowercase role
  labels (partly superseded by v3 for structure, still governs vocabulary).
- `agents/oas-expert/soul/knowledge/decisions/web-pane.md` — the oas.web
  browser panel decision; it reuses `lib/control-pane/model.mjs` as its data
  layer and uses `tmux send-keys` for human→agent input (writes live there,
  not in the TUI).

User-facing behavior and key bindings are documented in `docs/control-pane.md`
in the framework repo — update it alongside any behavior change.
