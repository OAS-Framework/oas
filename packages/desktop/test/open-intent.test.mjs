import test from "node:test";
import assert from "node:assert/strict";
import { createIntentGate, prepareOwnedOpen } from "../renderer/open-intent.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
};

test("brain open latest intent wins when B module resolves before A", async () => {
  const intents = createIntentGate();
  const aLoad = deferred(), bLoad = deferred();
  const ownsA = intents.begin();
  const a = prepareOwnedOpen({ owns: ownsA, waitForKey: async () => {}, load: () => aLoad.promise });
  await Promise.resolve(); // A is now awaiting its module
  const ownsB = intents.begin();
  const b = prepareOwnedOpen({ owns: ownsB, waitForKey: async () => {}, load: () => bLoad.promise });
  bLoad.resolve({ agent: "B" });
  assert.deepEqual(await b, { agent: "B" });
  aLoad.resolve({ agent: "A" });
  assert.equal(await a, null, "late A completion cannot reach addTab/dedup");
});

test("brain open stale wait/load rejections are discarded; current rejection propagates", async () => {
  const intents = createIntentGate();
  const waitA = deferred();
  const ownsA = intents.begin();
  const a = prepareOwnedOpen({ owns: ownsA, waitForKey: () => waitA.promise, load: async () => ({ agent: "A" }) });
  intents.begin(); // B supersedes A before A's wait rejection
  waitA.reject(new Error("stale A wait"));
  assert.equal(await a, null);

  const loadB = deferred();
  const ownsB = intents.begin();
  const b = prepareOwnedOpen({ owns: ownsB, waitForKey: async () => {}, load: () => loadB.promise });
  await Promise.resolve();
  const ownsC = intents.begin();
  loadB.reject(new Error("stale B load"));
  assert.equal(await b, null);
  await assert.rejects(
    prepareOwnedOpen({ owns: ownsC, waitForKey: async () => {}, load: async () => { throw new Error("current C"); } }),
    /current C/,
  );
});

test("runOpenFlow: quiet swallows EVERY rejection into notify; interactive rethrows (review ff70e1c nit)", async () => {
  const { runOpenFlow } = await import("../renderer/open-intent.mjs");
  // quiet: a rejecting flow (e.g. the /api/panel fetch inside the post-spawn
  // handoff) must resolve — the caller fires without awaiting, so a rethrow
  // here would surface as an unhandled rejection, not the promised warn
  const warned = [];
  await assert.doesNotReject(
    runOpenFlow(() => Promise.reject(new Error("panel fetch failed")), { quiet: true, notify: (m) => warned.push(m) }));
  assert.deepEqual(warned, ["panel fetch failed"], "quiet failures route through notify");
  // message-less rejections still produce a readable notification
  await runOpenFlow(() => Promise.reject("raw"), { quiet: true, notify: (m) => warned.push(m) });
  assert.deepEqual(warned, ["panel fetch failed", "raw"]);
  // quiet success passes the flow's value through
  assert.equal(await runOpenFlow(async () => 42, { quiet: true, notify: () => { throw new Error("must not notify on success"); } }), 42);
  // interactive: rejections rethrow to the caller, notify untouched
  const alerts = [];
  await assert.rejects(
    runOpenFlow(() => Promise.reject(new Error("boom")), { quiet: false, notify: (m) => alerts.push(m) }),
    /boom/);
  assert.deepEqual(alerts, [], "interactive failures are the caller's to surface");
});
