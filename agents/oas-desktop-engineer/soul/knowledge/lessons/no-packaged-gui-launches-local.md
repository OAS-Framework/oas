---
type: Lesson
title: Never launch packaged GUI apps from agent sessions on operator machines
description: Packaged OAS Desktop launch smoke can swarm the operator machine even with process-group reapers; local checks should stay to static artifacts, the loopback server, or one operator-launched app while packaged launch smoke runs in CI.
tags: [desktop, electron, smoke, process-management, policy]
timestamp: 2026-07-24
---

Two separate incidents hung the operator's laptop with dozens of packaged
`OAS Desktop` processes:

1. A consumer-parity driver launched the packaged app headlessly. On its CDP
   timeout path, group cleanup missed detached Electron descendants.
2. A coordinator integration-smoke runner died in its temporary directory and
   left orphaned packaged apps. Those apps kept respawning bundled-server
   children, so naive one-shot kills raced the respawn and the process count
   grew during cleanup.

Policy for this soul on operator machines:

- Never launch the packaged GUI app from an agent session, even headless or
  offscreen. This includes `dist:smoke` launch phases and CDP parity drivers
  that spawn the packaged app themselves.
- Packaged-app launch and pty smoke belongs in CI on throwaway runners, with
  xvfb or equivalent isolation. Locally, run at most static artifact checks
  such as artifact inventory and helper executable bits.
- Local consumer-parity evidence is static artifact verification, the loopback
  server run directly with plain `node` and no Electron, plus at most one app
  instance that the operator manually launches and closes.
- When cleaning up a leaked packaged-app swarm, scope kills to the owning
  temporary or worktree path, repeat the kill until the count is stably zero,
  re-check after a delay for respawn races, and inspect `launchctl` for any
  persistence.

This tightens both [headless Electron verification](/lessons/electron-headless-verification.md)
and [Electron smoke process reaping](/lessons/electron-smoke-process-group-reaping.md):
process-group reaping is a CI harness requirement, not a reason to run
packaged GUI launch smoke locally.
