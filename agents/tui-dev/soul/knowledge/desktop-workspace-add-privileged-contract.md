---
type: Decision
title: Privileged workspace add contract
description: Desktop workspace-add suggestions come only from bounded validated sources, adds are provenance-gated or native-picker-gated, foreign servers fail closed, and stale completions are generation-guarded.
tags: [desktop, workspace, security, ipc, discovery]
timestamp: 2026-07-23
---

The desktop workspace-add flow (`packages/desktop/workspace-registry.mjs` plus
`main.mjs` IPC) must preserve these security and lifecycle properties:

- **No filesystem scanning.** Suggestions come only from the app's known
  `--dir` set, team siblings through the kernel seams (`resolveOasConfig` →
  `team.scope` → `teamAgentRoots`, matching oas-web's `workspaceEntry`), and a
  persisted recents list. Every candidate is re-validated at suggestion time.
- **Add requests are provenance-gated.** A renderer-supplied path may be added
  only when it was in the last suggestion set. The only bypass is an explicit
  native directory picker owned by the main process; that path still goes
  through realpath and full workspace validation. A compromised renderer must
  not be able to feed arbitrary paths into privileged flows.
- **Persisted state is input, not truth.** Recents JSON is re-validated on every
  read: entries must be absolute paths, still resolve as workspaces, and stay
  capped. A tampered userData file degrades to an empty list.
- **Foreign servers fail closed.** Server replacement may mutate or kill only
  the app-owned child. A replacement is ready only when `/api/version` identity
  matches the local checkout and `/api/panel.workspaces` advertises the new id;
  this extends the [server identity probe](server-reuse-identity-probe.md)
  rule.
- **Terminals survive server replacement by architecture.** Desktop terminal
  viewers attach directly to tmux, not oas-web, so ptys keep streaming through
  server replacement; keep restating this in lifecycle tests whenever server
  replacement changes. See [Desktop terminal is a direct tmux attach via node-pty](desktop-terminal-direct-attach.md).
- **Generation tokens make stale completions inert.** Each workspace-add verb
  needs a generation guard so late suggestion/add completions cannot apply after
  the user or runtime has moved on.
