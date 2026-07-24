// Host-level regression for review 3cfc66d: a reopen requested while the
// closed tab's deferred cleanup is still pending must QUEUE behind the
// cleanup and mount afterwards — not be silently dropped, and not mount
// early where the stale lifecycle's module-wide unmount would tear it down.
// Exercises the same primitives shell.mjs composes: createViewLifecycle for
// close-during-pending-mount, reserveKey/whenKeyFree for the key registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createViewLifecycle } from "../renderer/view-lifecycle.mjs";
import { reserveKey, whenKeyFree, isKeyReserved } from "../renderer/tab-keys.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** Minimal model of the shell's keyed open path:
 *  await whenKeyFree(key) → mount via a fresh lifecycle → on close,
 *  reserveKey(key, life.close()). */
function makeHost(mod) {
  const openTabs = new Map(); // key -> lifecycle
  return {
    async open(key, ctx = {}) {
      await whenKeyFree(key);
      if (openTabs.has(key)) return "activated";
      const life = createViewLifecycle(mod);
      openTabs.set(key, life);
      await life.mounted({}, ctx);
      return "mounted";
    },
    close(key) {
      const life = openTabs.get(key);
      if (!life) return;
      openTabs.delete(key);
      reserveKey(key, life.close());
    },
    isOpen: (key) => openTabs.has(key),
  };
}

test("reopen during deferred cleanup queues and mounts after cleanup (never dropped)", async () => {
  const gate = deferred();
  let mounts = 0, moduleUnmounts = 0;
  const mod = {
    mount: async (_el, { slow }) => { mounts++; if (slow) await gate.promise; },
    unmount: () => { moduleUnmounts++; },
  };
  const host = makeHost(mod);
  const key = "view:brain";

  const first = host.open(key, { slow: true });  // mount pending on the API
  await new Promise((r) => setImmediate(r));     // let the open register its tab
  host.close(key);                               // user closes the loading tab
  assert.ok(isKeyReserved(key), "key reserved during deferred cleanup");

  const reopen = host.open(key, { slow: false }); // fast reopen — must queue
  let reopened = false;
  reopen.then(() => { reopened = true; });
  await Promise.resolve();
  assert.equal(reopened, false, "reopen waits for the cleanup");
  assert.equal(moduleUnmounts, 0, "old cleanup hasn't run yet");

  gate.resolve();                                 // old mount settles
  await first;
  assert.equal(await reopen, "mounted", "queued reopen mounts — not dropped");
  assert.ok(!isKeyReserved(key), "reservation released");
  assert.equal(moduleUnmounts, 1, "exactly the stale mount's cleanup ran");
  assert.equal(mounts, 2, "both mounts happened, in order");
  assert.ok(host.isOpen(key), "the reopened tab exists");
});

test("whenKeyFree resolves immediately for free keys; open dedups an existing tab", async () => {
  const mod = { mount: async () => {}, unmount: () => {} };
  const host = makeHost(mod);
  assert.equal(await host.open("view:x"), "mounted");
  assert.equal(await host.open("view:x"), "activated", "second open activates, not remounts");
});

test("a failed cleanup releases the reservation (key cannot wedge)", async () => {
  reserveKey("k", Promise.reject(new Error("cleanup exploded")));
  await whenKeyFree("k"); // must resolve, not reject
  assert.ok(!isKeyReserved("k"));
});
