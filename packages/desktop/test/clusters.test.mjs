// clusters.mjs — connected-component computation for the Active overview.
import test from "node:test";
import assert from "node:assert/strict";

const { computeClusters, siblingEdges, siblingLinksOf } = await import("../renderer/views/clusters.mjs");

test("computeClusters: parent/child links form one cluster; strangers stay singletons", () => {
  const cs = computeClusters([
    { instance: "root", running: true },
    { instance: "kid", parentInstance: "root", running: true },
    { instance: "grand", parentInstance: "kid", running: false },
    { instance: "lone", running: false },
  ]);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].size, 3);
  assert.equal(cs[0].name, "root", "cluster named after its root-most member");
  assert.equal(cs[0].running, 2);
  assert.equal(cs[1].size, 1);
  assert.equal(cs[1].name, "lone");
});

test("computeClusters: sibling links merge otherwise-separate trees", () => {
  const cs = computeClusters([
    { instance: "a", running: true },
    { instance: "a-kid", parentInstance: "a", running: true },
    { instance: "b", running: true, siblingInstances: ["a"] },
    { instance: "c", running: false },
  ]);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].size, 3);
  assert.deepEqual(new Set(cs[0].instances.map((i) => i.instance)), new Set(["a", "a-kid", "b"]));
});

test("computeClusters: malformed data never breaks — self links, unknown names, cycles", () => {
  const cs = computeClusters([
    { instance: "x", parentInstance: "x", siblingInstances: ["x", "ghost"] },
    { instance: "loop-1", parentInstance: "loop-2" },
    { instance: "loop-2", parentInstance: "loop-1" },
    null,
    { notAnInstance: true },
  ]);
  assert.equal(cs.length, 2);
  const loop = cs.find((c) => c.size === 2);
  assert.ok(loop, "cycle members stay one cluster");
  assert.equal(cs.find((c) => c.size === 1).name, "x");
});

test("computeClusters: deterministic order — multi first, running-heavy first, then name", () => {
  const roster = [
    { instance: "z-solo", running: true },
    { instance: "m1", running: false }, { instance: "m2", parentInstance: "m1", running: false },
    { instance: "a1", running: true }, { instance: "a2", parentInstance: "a1", running: true },
  ];
  const names = computeClusters(roster).map((c) => c.name);
  assert.deepEqual(names, ["a1", "m1", "z-solo"]);
  // stable across shuffles
  const names2 = computeClusters([...roster].reverse()).map((c) => c.name);
  assert.deepEqual(names2, names);
});

test("siblingLinksOf: adapter tolerates array, string, and absent shapes", () => {
  assert.deepEqual(siblingLinksOf({ instance: "a", siblingInstances: ["b", "a", "", 7] }), ["b"]);
  assert.deepEqual(siblingLinksOf({ instance: "a", siblings: "b" }), ["b"]);
  assert.deepEqual(siblingLinksOf({ instance: "a" }), []);
});

test("siblingEdges: unordered dedupe, out-of-cluster names dropped", () => {
  const cluster = {
    instances: [
      { instance: "a", siblingInstances: ["b", "ghost"] },
      { instance: "b", siblingInstances: ["a"] },
      { instance: "c" },
    ],
  };
  assert.deepEqual(siblingEdges(cluster), [{ a: "a", b: "b" }]);
});
