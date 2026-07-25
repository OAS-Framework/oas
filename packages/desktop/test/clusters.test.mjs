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
    { instance: "b", running: true, siblingInstance: "a" },
    { instance: "c", running: false },
  ]);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].size, 3);
  assert.deepEqual(new Set(cs[0].instances.map((i) => i.instance)), new Set(["a", "a-kid", "b"]));
});

test("computeClusters: malformed data never breaks — self links, unknown names, cycles", () => {
  const cs = computeClusters([
    { instance: "x", parentInstance: "x", siblingInstance: "x" },
    { instance: "ghosted", siblingInstance: "ghost" },
    { instance: "loop-1", parentInstance: "loop-2" },
    { instance: "loop-2", parentInstance: "loop-1" },
    null,
    { notAnInstance: true },
  ]);
  assert.equal(cs.length, 3);
  const loop = cs.find((c) => c.size === 2);
  assert.ok(loop, "cycle members stay one cluster");
  assert.deepEqual(cs.filter((c) => c.size === 1).map((c) => c.name).sort(), ["ghosted", "x"],
    "self links and unknown sibling names leave instances as singletons");
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

test("siblingLinksOf: kernel contract — siblingInstance string; self/absent/non-string dropped", () => {
  assert.deepEqual(siblingLinksOf({ instance: "a", siblingInstance: "b" }), ["b"]);
  assert.deepEqual(siblingLinksOf({ instance: "a", siblingInstance: "a" }), []);
  assert.deepEqual(siblingLinksOf({ instance: "a", siblingInstance: 7 }), []);
  assert.deepEqual(siblingLinksOf({ instance: "a", siblingInstance: null }), [],
    "collect payload uses string|null — null means no sibling link");
  assert.deepEqual(siblingLinksOf({ instance: "a" }), []);
});

test("siblingEdges: unordered dedupe, out-of-cluster names dropped", () => {
  const cluster = {
    instances: [
      { instance: "a", siblingInstance: "b" },
      { instance: "b", siblingInstance: "a" },
      { instance: "d", siblingInstance: "ghost" },
      { instance: "c" },
    ],
  };
  assert.deepEqual(siblingEdges(cluster), [{ a: "a", b: "b" }]);
});
