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
