// hierarchy view — layout + house async-guard regressions.
import test from "node:test";
import assert from "node:assert/strict";

const hier = await import("../renderer/views/hierarchy.mjs");
const common = await import("../renderer/views/common.mjs");

test("layoutForest: children sit below and centered under their parent; no overlaps", () => {
  const { nodes, width, height } = hier.layoutForest([
    { instance: "root", running: true },
    { instance: "kid-a", parentInstance: "root", running: true },
    { instance: "kid-b", parentInstance: "root", running: false },
    { instance: "grand", parentInstance: "kid-a", running: true },
    { instance: "lone", running: false },
  ]);
  const at = (n) => nodes.find((x) => x.inst.instance === n);
  assert.equal(nodes.length, 5);
  assert.ok(at("kid-a").y > at("root").y, "child below parent");
  assert.ok(at("grand").y > at("kid-a").y, "grandchild below child");
  assert.equal(at("lone").y, at("root").y, "second root on the root row");
  // parent centered over its children
  const mid = (at("kid-a").x + at("kid-b").x) / 2;
  assert.equal(at("root").x, mid);
  // running child ranks before idle child
  assert.ok(at("kid-a").x < at("kid-b").x, "running child laid out first");
  // no two nodes share a slot
  const seen = new Set(nodes.map((n) => `${n.x}:${n.y}`));
  assert.equal(seen.size, nodes.length, "no overlapping nodes");
  assert.ok(width > 0 && height > 0);
});

test("layoutForest: cross-root parentInstance keeps its edge and depth", () => {
  const { nodes } = hier.layoutForest([
    { instance: "parent-A", workspace: "/team/root-A", running: true },
    { instance: "child-B", workspace: "/team/root-B", parentInstance: "parent-A", running: true },
  ]);
  const parent = nodes.find((n) => n.inst.instance === "parent-A");
  const child = nodes.find((n) => n.inst.instance === "child-B");
  assert.deepEqual(parent.children.map((n) => n.inst.instance), ["child-B"],
    "visual root boundaries must not sever spawn parentage");
  assert.ok(child.y > parent.y, "cross-root child remains below its parent");
});

test("layoutForest: a parentInstance missing from the roster makes the child a root (no crash)", () => {
  const { nodes } = hier.layoutForest([
    { instance: "orphan", parentInstance: "retired-elsewhere", running: true },
  ]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].y, 0, "orphan treated as a root");
});

test("layoutForest: malformed parent cycles are promoted and never disappear", () => {
  const { nodes, width, height } = hier.layoutForest([
    { instance: "healthy", running: true },
    { instance: "cycle-a", parentInstance: "cycle-b", running: true },
    { instance: "cycle-b", parentInstance: "cycle-a", running: true },
    { instance: "cycle-child", parentInstance: "cycle-b", running: false },
  ]);
  assert.deepEqual(new Set(nodes.map((n) => n.inst.instance)),
    new Set(["healthy", "cycle-a", "cycle-b", "cycle-child"]),
    "healthy and cyclic components are all retained");
  const at = (name) => nodes.find((n) => n.inst.instance === name);
  assert.equal(at("cycle-a").y, 0, "deterministic first cycle node is promoted to root");
  assert.ok(at("cycle-b").y > at("cycle-a").y, "remaining cycle edge becomes a valid child edge");
  assert.ok(at("cycle-child").y > at("cycle-b").y, "valid descendants of cycle remain attached");
  assert.ok(width > 0 && height > 0);
});

test("layoutForest: a pure cycle terminates with unique non-overlapping nodes", () => {
  const { nodes } = hier.layoutForest([
    { instance: "a", parentInstance: "c", running: true },
    { instance: "b", parentInstance: "a", running: true },
    { instance: "c", parentInstance: "b", running: true },
  ]);
  assert.equal(nodes.length, 3);
  assert.equal(new Set(nodes.map((n) => n.inst.instance)).size, 3);
  assert.equal(new Set(nodes.map((n) => `${n.x}:${n.y}`)).size, 3);
});

test("layoutForest: a descendant sorting before idle cycle members keeps its valid parent edge", () => {
  const { nodes } = hier.layoutForest([
    { instance: "running-child", parentInstance: "cycle-b", running: true },
    { instance: "cycle-a", parentInstance: "cycle-b", running: false },
    { instance: "cycle-b", parentInstance: "cycle-a", running: false },
  ]);
  const at = (name) => nodes.find((n) => n.inst.instance === name);
  assert.equal(nodes.filter((n) => n.y === 0).length, 1, "one actual cycle member—not its descendant—is promoted");
  assert.ok(at("running-child").y > at("cycle-b").y, "valid child stays below its declared parent");
  assert.ok(at("cycle-b").children.some((n) => n.inst.instance === "running-child"),
    "cycle recovery does not sever the descendant edge");
});

test("ws generation: a deferred roster from workspace A never paints after switching to B", async () => {
  const gate = [];
  const payload = (name) => ({ ok: true, status: 200, json: async () => ({ instances: [{ instance: name, running: true }], workspaces: [], workspace: null }) });
  const ctx = { api: (pathname) => new Promise((ok) => gate.push({ pathname, ok })) };
  // minimal state double: refresh() touches q('wssel') + render() via s.panel
  const painted = [];
  const s = {
    alive: true, ctx,
    panel: { instances: [] },
    groupOffsets: new Map(), nodeOffsets: new Map(), nodeEls: new Map(), fitted: true, tx: 0, ty: 0, z: 1,
    q: () => ({ style: {}, innerHTML: "", value: "", addEventListener() {} }),
  };
  // stub render by intercepting panel assignment: refresh assigns s.panel then renders,
  // so make canvas/render dependencies inert
  s.canvas = { innerHTML: "", querySelector: () => null, append() {}, classList: { toggle() {}, add() {}, remove() {} } };
  s.nodeEls = new Map();
  const fakeEl = () => ({
    style: {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {} },
    innerHTML: "", textContent: "", title: "",
    append() {}, appendChild() {}, prepend() {}, remove() {},
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, setAttribute() {},
  });
  const hadDoc = Object.prototype.hasOwnProperty.call(globalThis, "document");
  if (!hadDoc) globalThis.document = { createElement: fakeEl, createElementNS: fakeEl };
  const prevWs = common.currentWorkspace();
  try {
    common.setWorkspace("wsA");
    const inFlightA = hier.refresh(s);
    assert.match(gate[0].pathname, /ws=wsA/);
    common.setWorkspace("wsB");
    const inFlightB = hier.refresh(s);
    assert.match(gate[1].pathname, /ws=wsB/);
    // B lands and paints
    gate[1].ok(payload("from-B"));
    await inFlightB;
    assert.equal(s.panel.instances[0].instance, "from-B");
    // A's STALE response lands — must not clobber B's panel
    gate[0].ok(payload("from-A"));
    await inFlightA;
    assert.equal(s.panel.instances[0].instance, "from-B", "stale workspace roster must never paint");
  } finally {
    common.setWorkspace(prevWs);
    if (!hadDoc) delete globalThis.document;
  }
});

test("refresh after teardown (alive=false) never mutates state", async () => {
  const gate = [];
  const ctx = { api: () => new Promise((ok) => gate.push(ok)) };
  const s = { alive: true, ctx, panel: { instances: [] }, q: () => ({ style: {}, addEventListener() {} }), canvas: {}, nodeEls: new Map() };
  const inFlight = hier.refresh(s);
  s.alive = false; // tab closed while the fetch was in flight
  gate[0]({ ok: true, status: 200, json: async () => ({ instances: [{ instance: "late", running: true }] }) });
  await inFlight;
  assert.equal(s.panel.instances.length, 0, "post-unmount response must not paint");
});

test("layoutClusters: multi-member clusters get cards; singletons collect in one Independent block", () => {
  const { placed, soloBlock, width, height } = hier.layoutClusters([
    { instance: "root", running: true },
    { instance: "kid", parentInstance: "root", running: true },
    { instance: "peer", running: true, siblingInstance: "root" },
    { instance: "solo-1", running: false },
    { instance: "solo-2", running: true },
  ]);
  assert.equal(placed.length, 1, "one multi-member cluster");
  assert.equal(placed[0].cluster.size, 3);
  assert.deepEqual(placed[0].sibs, [{ a: "peer", b: "root" }], "sibling edge surfaces for rendering");
  assert.equal(soloBlock.nodes.length, 2, "singletons share the Independent block");
  assert.ok(soloBlock.y >= placed[0].y + placed[0].h, "Independent block sits below cluster cards");
  // node coordinates are group-local and inside the card's padded area
  for (const n of placed[0].nodes) assert.ok(n.x >= 0 && n.y > 0);
  assert.ok(width > 0 && height > 0);
});

test("layoutClusters: deterministic across roster order; no instance lost", () => {
  const roster = [
    { instance: "b-root", running: false },
    { instance: "b-kid", parentInstance: "b-root", running: true },
    { instance: "a-root", running: true },
    { instance: "a-kid", parentInstance: "a-root", running: true },
    { instance: "lone", running: false },
  ];
  const l1 = hier.layoutClusters(roster);
  const l2 = hier.layoutClusters([...roster].reverse());
  const namesOf = (l) => l.placed.map((p) => p.cluster.name);
  assert.deepEqual(namesOf(l1), ["a-root", "b-root"], "running-heavy cluster first");
  assert.deepEqual(namesOf(l2), namesOf(l1), "stable across shuffles");
  const all = (l) => [...l.placed.flatMap((p) => p.nodes), ...(l.soloBlock?.nodes || [])].map((n) => n.inst.instance).sort();
  assert.deepEqual(all(l1), ["a-kid", "a-root", "b-kid", "b-root", "lone"]);
});

test("layoutClusters: all-singleton roster yields only the Independent block", () => {
  const { placed, soloBlock } = hier.layoutClusters([
    { instance: "x", running: true }, { instance: "y", running: false },
  ]);
  assert.equal(placed.length, 0);
  assert.equal(soloBlock.nodes.length, 2);
  assert.equal(soloBlock.y, 0, "no cluster cards above — block starts at the top");
});
