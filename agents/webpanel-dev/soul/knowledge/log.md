# Knowledge Log

## 2026-07-22
* **Creation**: added [Capability manifest compatibility floor must cover core APIs](/lessons/manifest-compat-floor-core-apis.md) from the manifest-compat note: `compatibility.oas` must rise when `oas.web` starts calling newer `core.*` helpers, and the regression test's API minimum-version map should be extended with the helper.
* **Creation**: added [Spawn endpoint root allowlist and empty-task semantics](/architecture/spawn-endpoint.md) by merging the spawn endpoint notes: `agentsRoot` is a selector into server workspace roots, `task: ""` intentionally means await instructions, repo fallback mirrors the CLI, and spawn failures return 409.
* **Update**: [oas-web architecture](/architecture/oas-web-architecture.md) now lists `POST /api/spawn` and records the path-shaped browser parameter allowlist invariant.
* **Creation**: added [Split panes, collapsible sidebar, and compact session header](/architecture/split-panes-and-compact-shell.md) from the split-pane shell note: per-pane state and pollers, focused-pane key routing, modifier-click splits, persisted sidebar collapse, and compact `.phead` headers.
* **Creation**: added [One input surface — the terminal's own input line](/decisions/terminal-input-unification.md) from the terminal-input note: no separate composer, no `/api/send`, all typing/pasting through raw `/api/keys` into the focused pane.
* **Update**: [Raw key passthrough](/architecture/raw-key-passthrough-and-host-guard.md), [oas-web architecture](/architecture/oas-web-architecture.md), and [multi-line send lesson](/lessons/multiline-send-bracketed-paste.md) now reflect `/api/keys` as the sole input path and paste payloads as bracketed paste.
* **Update**: [Color adaptation](/architecture/color-adaptation.md) now captures truecolor background suppression for near-default SGR backgrounds on light/dark themes and the themed `::selection` token.
* **Creation**: added [Raw key passthrough and the POST host/origin guard](/architecture/raw-key-passthrough-and-host-guard.md) from the key endpoint note: `/api/keys`, raw tmux hex send, large-payload paste path, instance-tagged queues, and loopback POST guard.
* **Creation**: added [Terminal-faithful session renderer](/decisions/hand-rolled-terminal-renderer.md) by merging the terminal-fidelity implementation and renderer-approach notes: no xterm.js/package, SGR parser shape, screen/cursor mapping, and renderer test hook.
* **Update**: [oas-web architecture](/architecture/oas-web-architecture.md) now lists `/api/keys`, session geometry/cursor/history fields, and the loopback POST Host/Origin guard.

## 2026-07-21
* **Seeded the starter bundle** from the oas-web development sessions (oas-expert): architecture (server/UI shape, transcript data sources, color adaptation, optimistic sends, workflow rendering, multi-workspace), the pi-style-transcript design decision, the bracketed-paste and stale-response-race lessons, the dev-loop/marketplace-refresh playbook, and a reference to the founding web-pane decision in the oas-expert soul. Added the architecture/ section.
* **Initialization**: knowledge bundle scaffolded by oas-okf.
