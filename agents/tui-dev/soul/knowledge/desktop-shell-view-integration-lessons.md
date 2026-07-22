---
type: Lesson
title: Desktop shell view integration lessons
description: Ported panel views rely on singleton modules, key-deduped tabs, context-owning picker tabs, .mjs loader naming, workspace-aware API pinning, exactly-once Fetch body serialization, and inline degradation when older shared servers lack endpoints.
tags: [desktop, view-host, integration, ipc, workspace]
timestamp: 2026-07-22
---

When integrating webpanel-dev's ported views (`instances`, `spawn`, `jira`,
`common`/`theme`, and `brain`) into the desktop shell, preserve these points
with the [Desktop shell view-host contract and layout](desktop-shell-layout.md):

- View modules may keep module-level state (`let state = null`) and are
  singletons by design. The tab host must dedup by key (`view:<name>`,
  `term:<instance>`, `file:<path>`) and activate the existing tab instead of
  mounting a twin.
- Async terminal opens need a pending-key reservation. A flow that scans keys,
  awaits, then calls `addTab` lets two quick opens pass the scan; reserve the
  terminal key for the duration of the async open and null-check `addTab` so an
  orphan terminal can be disposed instead of crashing.
- Shell chrome stays slimmed to a nav rail; `instances.mjs` is the roster and
  calls `ctx.openTerminal` for the handoff to the shell's terminal.
- Views requiring per-tab context that the nav rail does not have, such as a
  diff tab needing `ctx.instance`, should get a small shell-owned picker tab
  rather than a bare nav entry.
- The desktop host loads `views/<name>.mjs`; `brain` arrived as `brain.js` and
  had to be renamed, with references fixed in `dev-brain.html` and the header
  comment. It needs no extra `ctx` fields because it has its own agent selector.
- Fetch-contract callers own stringification. `postJson` already sends a string
  body and content-type, so the IPC proxy must forward string bodies and caller
  headers unchanged; only object bodies should be serialized at the proxy seam.
  If the server says the body needs an object while the caller clearly sent the
  fields, suspect double serialization.
- For workspace switching, `common.mjs` sends explicit `?ws=` on `/api/panel`
  and `/api/agents`, and `brain.mjs` sends it on `/api/brain/<agent>`.
  Main-process pinning should allow caller workspace values the connected
  server advertises in `workspaces[]`, while still overwriting unknown ids.
  Keep the proxy's scoped-endpoint pin list coupled to every endpoint views
  query with `?ws=` (currently `/api/panel`, `/api/agents`, and
  `/api/brain/*`) and extend its tests in the same change; otherwise a stale
  persisted workspace id can fall through to the server's first-workspace
  fallback and render wrong-workspace data.
- Roster-derived actions must also honor the workspace bus. Terminal open must
  read `currentWorkspace()`, query `/api/panel?ws=...`, and include the
  workspace in the terminal dedup key so a secondary advertised workspace does
  not open the wrong same-named instance or hit an unknown-instance error.
- Shared older servers may lack new endpoints: the lfx `oas-web` on `4820`
  predated `/api/brain` and returned `404`. Views must show such errors inline;
  the dedicated-server path after workspace mismatch usually avoids it.
