---
type: Lesson
title: Smoke scripts that launch Electron must reap by process group on every exit path
description: CI smoke scripts that launch Electron need detached process groups, group-kill cleanup on exit/signal/error paths, and scoped process-count verification; local agent sessions on operator machines must not run packaged-app launch smoke.
tags: [electron, testing, smoke, process-management, desktop]
timestamp: 2026-07-24
---

While iterating on `packages/desktop/scripts/dist-smoke.mjs`, the operator's
machine accumulated about twenty leaked `OAS Desktop.app` helper processes and
needed manual cleanup. Three causes compounded:

1. **`fail()` calls `process.exit(1)` and skips `finally`.** Cleanup placed in
   a try/finally does not run on paths that call an early-exit helper inside
   the try.
2. **Electron is a process tree.** `child.kill("SIGKILL")` kills only the
   parent binary; `Contents/Frameworks/* Helper*` children can survive and
   linger (GPU, renderer, network helpers). This can be invisible on a happy
   path where the app exits cleanly, then become a swarm on failure paths.
3. **Debug iteration multiplies leaks.** Re-running a leaky smoke script while
   chasing an unrelated bug leaves one more process tree each time.

Follow-up incident: process-group reaping is not a local safety guarantee for
packaged GUI smoke. Detached Electron descendants and orphaned coordinator smoke
apps can keep respawning bundled-server children; [never launch packaged GUI
apps from agent sessions on operator machines](/lessons/no-packaged-gui-launches-local.md).
This lesson is for CI and throwaway harness design, not permission to run the
packaged-app launch phase locally.

For Electron smoke scripts that run in CI, keep the process management as a
structural part of the harness:

- spawn every child with `detached: true` so it leads its own process group,
  and register it in a module-level set;
- reap with `process.kill(-pid, "SIGKILL")` and retain direct `child.kill` as
  fallback;
- keep the process group tracked until the reaper explicitly kills the group;
  do not remove tracking just because the leader exits, because descendants can
  survive in the same group;
- install the reaper on `process.on("exit")`, SIGINT/SIGTERM/SIGHUP,
  `uncaughtException`, and `unhandledRejection`; exit-path coverage is the
  point, and `finally` is not enough;
- add an `unref()` wall-clock watchdog so a hung CDP probe cannot wait
  forever.

Verification discipline for CI or other throwaway runners: after both a PASS
run and a forced-failure run (SIGTERM mid-launch), `ps aux | grep
<worktree-path> | wc -l` must be zero. Scope the grep to the worktree path; do
not kill by app name because a real OAS Desktop from another checkout may be
running. On an operator machine, do not run this launch verification; use static
artifact checks instead. This is the same boundary as [scope destructive cleanup
during live desktop testing](/lessons/pkill-scoping-discipline.md).

Keep the reusable reaping path in `packages/desktop/scripts/proc-reaper.mjs` and
cover it with fake- and real-process tests: a shell leader can exit while a
`sleep` descendant survives, and the group kill must still reap that descendant.
Avoid `execFileSync` in scripts whose signal handlers must stay live, because a
synchronous child wait can prevent the JavaScript cleanup handlers from running
when the harness receives a signal.

Also: `execFileSync(..., { timeout })` sends SIGTERM by default. For Electron,
which can ignore SIGTERM while wedged, pass `killSignal: "SIGKILL"`.

Related: [headless Electron verification via CDP](/lessons/electron-headless-verification.md).
