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
    append() {}, appendChild() {}, remove() {},
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
