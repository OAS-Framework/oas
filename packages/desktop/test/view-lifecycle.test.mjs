// Regressions for the tab-host mount/close lifecycle (reviews 2fa4b4b and
// b1d7269): closing a tab while its async mount() is pending must not fall
// back to the module-wide unmount() mid-flight; a REJECTED mount must never
// trigger the module-wide fallback (it would destroy healthy siblings); and
// deferred cleanup completion is observable via close()'s promise so the
// host can keep the tab key reserved until it ran (close → reopen → old
// mount settles).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createViewLifecycle } from "../renderer/view-lifecycle.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
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
  const closing = life.close();       // close while mount is pending
  assert.equal(moduleUnmounts, 0, "must not run module unmount mid-flight");
  assert.equal(disposed, 0, "disposer not known yet");
  gate.resolve();                     // API responds; mount settles
  await mounting;
  await closing;
  assert.equal(disposed, 1, "the settled mount's disposer ran");
  assert.equal(moduleUnmounts, 0, "module unmount never involved");
});

test("close during pending mount of a legacy view (no disposer) runs unmount after settle", async () => {
  const gate = deferred();
  let moduleUnmounts = 0;
  const mod = { mount: async () => { await gate.promise; }, unmount: () => { moduleUnmounts++; } };
  const life = createViewLifecycle(mod);
  const mounting = life.mounted({}, {});
  const closing = life.close();
  assert.equal(moduleUnmounts, 0, "not before settle");
  gate.resolve();
  await mounting;
  await closing;
  assert.equal(moduleUnmounts, 1, "legacy cleanup after settle");
});

test("normal close after settle uses the disposer", async () => {
  let disposed = 0, moduleUnmounts = 0;
  const mod = { mount: async () => () => { disposed++; }, unmount: () => { moduleUnmounts++; } };
  const life = createViewLifecycle(mod);
  await life.mounted({}, {});
  await life.close();
  assert.equal(disposed, 1);
  assert.equal(moduleUnmounts, 0);
});

test("mount errors still surface and close-after-error is safe", async () => {
  const mod = { mount: async () => { throw new Error("boom"); }, unmount: () => {} };
  const life = createViewLifecycle(mod);
  await assert.rejects(() => life.mounted({}, {}), /boom/);
  await life.close(); // must not throw
});

test("rejected mount never triggers the module-wide fallback (healthy sibling survives)", async () => {
  const gate = deferred();
  let healthyDisposed = 0, moduleUnmounts = 0;
  const mod = {
    mount: async ({ fail }) => {
      if (fail) { await gate.promise; throw new Error("load failed"); }
      return () => { healthyDisposed++; };
    },
    unmount: () => { moduleUnmounts++; },
  };
  const healthy = createViewLifecycle(mod);
  await healthy.mounted({ fail: false }, {});
  const failing = createViewLifecycle(mod);
  const mounting = failing.mounted({ fail: true }, {});
  const closing = failing.close();          // closed while pending...
  gate.resolve();                           // ...then the mount REJECTS
  await assert.rejects(() => mounting, /load failed/);
  await closing;
  assert.equal(moduleUnmounts, 0, "rejection must not look like a legacy mount");
  assert.equal(healthyDisposed, 0, "healthy sibling untouched");
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
  const closing = l2.close();                 // quick close of the loading tab
  assert.equal(d1, 0, "first tab untouched");
  assert.equal(moduleUnmounts, 0);
  gate.resolve();
  await m2;
  await closing;
  assert.equal(d2, 1, "second tab disposed on settle");
  assert.equal(d1, 0, "first tab STILL untouched");
});

test("close → reopen → old mount settles: deferred cleanup completion is observable", async () => {
  // Host contract: the tab key stays reserved until close() resolves, so the
  // reopen happens only AFTER the stale lifecycle's cleanup — the module-wide
  // unmount of the old legacy mount must not be able to tear down the new one.
  const gate = deferred();
  let moduleUnmounts = 0;
  const mod = { mount: async ({ slow }) => { if (slow) await gate.promise; }, unmount: () => { moduleUnmounts++; } };

  const stale = createViewLifecycle(mod);
  const staleMounting = stale.mounted({ slow: true }, {});
  const closing = stale.close();              // user closes the loading tab

  let reopened = false;
  const reopen = closing.then(async () => {   // host reopens only after cleanup ran
    const fresh = createViewLifecycle(mod);
    await fresh.mounted({ slow: false }, {});
    reopened = true;
    return fresh;
  });

  assert.equal(reopened, false, "reopen blocked while cleanup is pending");
  gate.resolve();                             // old mount finally settles
  await staleMounting;
  const fresh = await reopen;
  assert.equal(moduleUnmounts, 1, "exactly the stale mount's cleanup ran");
  assert.equal(reopened, true);
  await fresh.close();
  assert.equal(moduleUnmounts, 2, "fresh tab cleans up on its own close");
});
