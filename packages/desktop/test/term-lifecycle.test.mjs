// Regression for merged-state review round 2 @3e1a611: closing a terminal
// tab while termOpen() is pending must detach the pty the moment it
// materializes — the old code saw ptyId === null at close and leaked an
// invisible attached tmux client until app shutdown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTermLifecycle } from "../renderer/term-lifecycle.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}

test("close before open resolves: pty detached immediately on materialization", async () => {
  const gate = deferred();
  const closedPtys = [];
  let ready = 0, openErrors = 0, uiDisposed = 0;
  const life = createTermLifecycle({ open: () => gate.promise, closePty: (id) => closedPtys.push(id) });
  const starting = life.start(() => { ready++; }, () => { openErrors++; });
  const closing = life.close(() => { uiDisposed++; });   // close while pending
  assert.deepEqual(closedPtys, [], "nothing to detach yet");
  gate.resolve(42);                                      // pty materializes late
  await starting;
  await closing;
  assert.deepEqual(closedPtys, [42], "late pty detached immediately — no leak");
  assert.equal(ready, 0, "onReady skipped for a closed tab");
  assert.equal(openErrors, 0);
  assert.equal(uiDisposed, 1, "UI teardown ran");
  assert.equal(life.ptyId(), null);
});

test("close before open REJECTS: no detach call, no repaint, cleanup completes", async () => {
  const gate = deferred();
  const closedPtys = [];
  let openErrors = 0, uiDisposed = 0;
  const life = createTermLifecycle({ open: () => gate.promise, closePty: (id) => closedPtys.push(id) });
  const starting = life.start(() => {}, () => { openErrors++; });
  const closing = life.close(() => { uiDisposed++; });
  gate.reject(new Error("attach failed"));
  await starting;
  await closing;
  assert.deepEqual(closedPtys, [], "no pty was created — nothing to detach");
  assert.equal(openErrors, 0, "no repaint on an already-closed tab");
  assert.equal(uiDisposed, 1);
});

test("open rejection on a LIVE tab repaints via onOpenError", async () => {
  let openErrors = 0;
  const life = createTermLifecycle({ open: () => Promise.reject(new Error("bad target")), closePty: () => {} });
  await life.start(() => {}, (e) => { openErrors++; assert.match(String(e), /bad target/); });
  assert.equal(openErrors, 1);
  await life.close(() => {}); // safe afterwards
});

test("normal path: ready, then close detaches the known pty once", async () => {
  const closedPtys = [];
  let ready = null;
  const life = createTermLifecycle({ open: () => Promise.resolve(7), closePty: (id) => closedPtys.push(id) });
  await life.start((id) => { ready = id; }, () => {});
  assert.equal(ready, 7);
  assert.equal(life.ptyId(), 7);
  await life.close(() => {});
  await life.close(() => {}); // idempotent
  assert.deepEqual(closedPtys, [7], "detached exactly once");
});

test("forget() (pty exited) prevents a double-kill at close", async () => {
  const closedPtys = [];
  const life = createTermLifecycle({ open: () => Promise.resolve(9), closePty: (id) => closedPtys.push(id) });
  await life.start(() => {}, () => {});
  life.forget(); // session ended; main already dropped the pty
  await life.close(() => {});
  assert.deepEqual(closedPtys, [], "no close call for an already-gone pty");
});

test("closePty failure is absorbed and cleanup still completes", async () => {
  let uiDisposed = 0;
  const errors = [];
  const life = createTermLifecycle(
    { open: () => Promise.resolve(3), closePty: () => { throw new Error("ipc gone"); } },
    (e) => errors.push(e),
  );
  await life.start(() => {}, () => {});
  await life.close(() => { uiDisposed++; });
  assert.equal(uiDisposed, 1, "UI teardown despite detach failure");
  assert.equal(errors.length, 1);
});
