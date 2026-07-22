---
type: Lesson
title: Desktop shell view integration lessons
description: Ported panel views rely on singleton modules, key-deduped tabs, .mjs loader naming, workspace-aware API pinning, and inline degradation when older shared servers lack endpoints.
tags: [desktop, view-host, integration]
timestamp: 2026-07-22
---

When integrating webpanel-dev's ported views (`instances`, `spawn`, `jira`,
`common`/`theme`, and `brain`) into the desktop shell, preserve these points
with the [Desktop shell view-host contract and layout](desktop-shell-layout.md):

- View modules may keep module-level state (`let state = null`) and are
  singletons by design. The tab host must dedup by key (`view:<name>`,
  `term:<instance>`, `file:<path>`) and activate the existing tab instead of
  mounting a twin.
- Shell chrome stays slimmed to a nav rail; `instances.mjs` is the roster and
  calls `ctx.openTerminal` for the handoff to the shell's terminal.
- The desktop host loads `views/<name>.mjs`; `brain` arrived as `brain.js` and
  had to be renamed, with references fixed in `dev-brain.html` and the header
  comment. It needs no extra `ctx` fields because it has its own agent selector.
- For workspace switching, `common.mjs` sends explicit `?ws=` on `/api/panel`
  and `/api/agents`. Main-process pinning should allow caller workspace values
  the connected server advertises in `workspaces[]`, while still overwriting
  unknown ids.
- Shared older servers may lack new endpoints: the lfx `oas-web` on `4820`
  predated `/api/brain` and returned `404`. Views must show such errors inline;
  the dedicated-server path after workspace mismatch usually avoids it.
