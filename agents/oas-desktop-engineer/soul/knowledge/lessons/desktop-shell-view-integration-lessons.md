---
type: Lesson
title: Desktop shell view integration lessons
description: Ported panel views rely on key-deduped tabs, per-mount disposers for multi-tab views, context-owning picker tabs, .mjs loader naming, route-family workspace pinning, exact server identity/version reuse checks, exactly-once Fetch body serialization, and inline degradation when older shared servers lack endpoints.
tags: [desktop, view-host, integration, ipc, workspace]
timestamp: 2026-07-23
---

When integrating webpanel-dev's ported views (`instances`, `spawn`, `jira`,
`common`/`theme`, and `brain`) into the desktop shell, preserve these points
with the [Desktop shell view-host contract and layout](/playbooks/desktop-shell-layout.md):

- View modules may keep module-level state (`let state = null`) and are
  singletons by design. The tab host must dedup by key (`view:<name>`,
  `term:<instance>`, `file:<path>`) and activate the existing tab instead of
  mounting a twin.
- Views that can have several simultaneously open tabs (markdown and diff)
  cannot rely on a module-level `let mounted`; use the [per-mount disposer
  contract](/decisions/view-mount-disposer-contract.md) so closing one tab does not blank
  another. The exported `unmount()` still disposes all mounts for harness
  compatibility.
- Async terminal opens need a pending-key reservation. A flow that scans keys,
  awaits, then calls `addTab` lets two quick opens pass the scan; reserve the
  terminal key for the duration of the async open and null-check `addTab` so an
  orphan terminal can be disposed instead of crashing.
- Shell chrome stays slimmed to a nav rail; `instances.mjs` is the roster and
  calls `ctx.openTerminal` for the handoff to the shell's terminal.
- Views requiring per-tab context that the nav rail does not have, such as a
  diff tab needing `ctx.instance`, should get a small shell-owned picker tab
  rather than a bare nav entry. Diff picker tab keys must include the workspace
  when the same instance name can exist in more than one workspace.
- The desktop host loads `views/<name>.mjs`; `brain` arrived as `brain.js` and
  had to be renamed, with references fixed in `dev-brain.html` and the header
  comment. It needs no extra `ctx` fields because it has its own agent selector.
- Fetch-contract callers own stringification. `postJson` already sends a string
  body and content-type, so the IPC proxy must forward string bodies and caller
  headers unchanged; only object bodies should be serialized at the proxy seam.
  If the server says the body needs an object while the caller clearly sent the
  fields, suspect double serialization.
- For workspace switching, `common.mjs` sends explicit `?ws=` on `/api/panel`
  and `/api/agents`, `brain.mjs` sends it on `/api/brain/<agent>`, and diff
  requests carry `ctx.ws` as `?ws=`. Main-process pinning should allow caller
  workspace values the connected server advertises in `workspaces[]`, while
  still overwriting unknown ids. For instance-addressed APIs resolved by
  `findInstance(name, wsId)`, classify whole route families instead of
  enumerating endpoints; see [Scope classification by route family, not
  endpoint enumeration](/lessons/route-family-workspace-pinning.md). Tests should cover
  the family classifier so new endpoints fail safe instead of silently falling
  through to the server's first-workspace fallback and rendering wrong-workspace
  data. The observed diff fix kept `model.mjs` untouched by adding an optional
  workspace scope to oas-web `findInstance`; changes to that shared file still
  require coordinator notice.
- Roster-derived actions must also honor the workspace bus. Terminal open must
  read `currentWorkspace()`, query `/api/panel?ws=...`, and include the
  workspace in the terminal dedup key so a secondary advertised workspace does
  not open the wrong same-named instance or hit an unknown-instance error.
- Shared older servers may lack new endpoints: the lfx `oas-web` on `4820`
  predated `/api/brain` and returned `404`. Inline view errors are only
  defense-in-depth; server reuse must first follow [Server reuse needs an
  identity probe, not just a liveness probe](/lessons/server-reuse-identity-probe.md) by
  comparing the server's capability+version identity response to the local
  manifest and spawning this checkout's server on 404, mismatch, or network
  failure without killing the foreign server.
