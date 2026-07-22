// Regression for review 2fa4b4b's finding: closing a tab while its async
// mount() is still pending must NOT fall back to the module-wide unmount()
// (which clears every open mount) — cleanup waits for the mount to settle
// and then runs that mount's own disposer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createViewLifecycle } from "../renderer/view-lifecycle.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("close during pending mount defers to the mount's own disposer", async () => {
  const gate = deferred();
  let disposed = 0, moduleUnmounts = 0;
  const mod = {
    mount: async () => { await gate.promise; return () => { disposed++; }; },
    unmount: () => { moduleUnmounts++; },
  };
  const life = createViewLifecycle(mod);
  const mounting = life.mounted({}, {});
  life.close();                       // close while mount is pending
  assert.equal(moduleUnmounts, 0, "must not run module unmount mid-flight");
  assert.equal(disposed, 0, "disposer not known yet");
  gate.resolve();                     // API responds; mount settles
  await mounting;
  assert.equal(disposed, 1, "the settled mount's disposer ran");
  assert.equal(moduleUnmounts, 0, "module unmount never involved");
});

test("close during pending mount of a legacy view (no disposer) runs unmount after settle", async () => {
  const gate = deferred();
  let moduleUnmounts = 0;
  const mod = { mount: async () => { await gate.promise; }, unmount: () => { moduleUnmounts++; } };
  const life = createViewLifecycle(mod);
  const mounting = life.mounted({}, {});
  life.close();
  assert.equal(moduleUnmounts, 0, "not before settle");
  gate.resolve();
  await mounting;
  assert.equal(moduleUnmounts, 1, "legacy cleanup after settle");
});

test("normal close after settle uses the disposer", async () => {
  let disposed = 0, moduleUnmounts = 0;
  const mod = { mount: async () => () => { disposed++; }, unmount: () => { moduleUnmounts++; } };
  const life = createViewLifecycle(mod);
  await life.mounted({}, {});
  life.close();
  assert.equal(disposed, 1);
  assert.equal(moduleUnmounts, 0);
});

test("mount errors still surface and close-after-error is safe", async () => {
  const mod = { mount: async () => { throw new Error("boom"); }, unmount: () => {} };
  const life = createViewLifecycle(mod);
  await assert.rejects(() => life.mounted({}, {}), /boom/);
  life.close(); // must not throw
});

test("two lifecycles of one module are independent (multi-tab)", async () => {
  const gate = deferred();
  let d1 = 0, d2 = 0, moduleUnmounts = 0;
  const mod = {
    mount: async ({ slow }) => { if (slow) await gate.promise; return slow ? () => { d2++; } : () => { d1++; }; },
    unmount: () => { moduleUnmounts++; },
  };
  const l1 = createViewLifecycle(mod);
  const l2 = createViewLifecycle(mod);
  await l1.mounted({ slow: false }, {});      // first tab settled
  const m2 = l2.mounted({ slow: true }, {});  // second tab still loading
  l2.close();                                 // quick close of the loading tab
  assert.equal(d1, 0, "first tab untouched");
  assert.equal(moduleUnmounts, 0);
  gate.resolve();
  await m2;
  assert.equal(d2, 1, "second tab disposed on settle");
  assert.equal(d1, 0, "first tab STILL untouched");
});
