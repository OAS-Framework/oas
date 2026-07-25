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

test("layoutForest tolerates sibling-link fields — every instance placed, parent edges intact", () => {
  // feature/agent-relations: rosters may carry sibling-link metadata; the
  // hierarchy layout is parentInstance-driven and must neither crash nor
  // drop sibling-linked nodes (they lay out as separate roots).
  const { nodes } = hier.layoutForest([
    { instance: "coord-1", running: true },
    { instance: "dev-a", parentInstance: "coord-1", running: true },
    { instance: "dev-b", parentInstance: "coord-1", running: false },
    { instance: "peer-1", siblingInstance: "peer-2", relation: "sibling", relativeTo: "peer-2", running: false },
    { instance: "peer-2", siblingInstance: "peer-1", running: false },
  ]);
  assert.equal(nodes.length, 5, "sibling metadata never hides an instance");
  const byName = new Map(nodes.map((n) => [n.inst.instance, n]));
  assert.ok(byName.get("coord-1").children.some((c) => c.inst.instance === "dev-a"), "parent edges survive");
  assert.equal(byName.get("peer-1").y, 0, "sibling-only nodes are roots");
  assert.equal(byName.get("peer-2").y, 0);
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

test("cluster cards are anonymous: header carries counts only, never the derived cluster name", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(`<div id="root"></div>`, { pretendToBeVisual: true });
  const g = globalThis;
  const prev = { window: g.window, document: g.document, localStorage: g.localStorage };
  g.window = dom.window; g.document = dom.window.document;
  g.localStorage = { getItem: () => null, setItem: () => {} };
  try {
    const panel = { instances: [
      { instance: "named-root", running: true, parentInstance: null, siblingInstance: null },
      { instance: "kid", running: false, parentInstance: "named-root", siblingInstance: null },
      { instance: "solo", running: true, parentInstance: null, siblingInstance: null },
    ], workspaces: [], workspace: null };
    const ctx = { api: async () => ({ ok: true, status: 200, json: async () => panel }), openTerminal() {} };
    const el = dom.window.document.getElementById("root");
    const un = hier.mount(el, ctx);
    await new Promise((r) => setTimeout(r, 30));
    const head = el.querySelector(".hier-cluster .hier-chead");
    assert.ok(head, "cluster card has a header");
    assert.equal(head.textContent, "1/2 running", "counts only — no cluster name");
    assert.ok(!head.textContent.includes("named-root"), "derived name never shown");
    const card = el.querySelector(".hier-cluster");
    assert.equal(card.getAttribute("aria-label"), "Cluster of 2 agents, 1 running",
      "aria-label is counts-only — accessibility surfaces are part of the anonymity contract");
    assert.ok(!card.getAttribute("aria-label").includes("named-root"), "derived name never spoken");
    const soloCard = el.querySelector(".hier-solo");
    assert.equal(soloCard.getAttribute("aria-label"), "Independent agents: 1",
      "Independent is an allowed category label, not a cluster name");
    const soloHead = el.querySelector(".hier-solo .hier-chead");
    assert.ok(soloHead.textContent.startsWith("Independent"), "strip keeps its category label");
    un();
  } finally {
    g.window = prev.window; g.document = prev.document; g.localStorage = prev.localStorage;
  }
});

test("duplicate names across agents roots render as DISTINCT nodes; terminal opens carry identity", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(`<div id="root"></div>`, { pretendToBeVisual: true });
  const g = globalThis;
  const prev = { window: g.window, document: g.document, localStorage: g.localStorage };
  g.window = dom.window; g.document = dom.window.document;
  g.localStorage = { getItem: () => null, setItem: () => {} };
  try {
    const panel = { instances: [
      { instance: "dev", agentsRoot: "/a/agents", home: "/a/agents/dev/i/dev", running: true },
      { instance: "dev", agentsRoot: "/b/agents", home: "/b/agents/dev/i/dev", running: true },
      { instance: "kid", agentsRoot: "/a/agents", home: "/a/agents/kid/i/kid", parentInstance: "dev", running: true },
    ], workspaces: [], workspace: null };
    const opened = [];
    const ctx = { api: async () => ({ ok: true, status: 200, json: async () => panel }),
                  openTerminal: (ref) => opened.push(ref) };
    const el = dom.window.document.getElementById("root");
    const un = hier.mount(el, ctx);
    await new Promise((r) => setTimeout(r, 30));
    const nodes = [...el.querySelectorAll(".hnode")];
    assert.equal(nodes.length, 3, "duplicate-named instances are distinct nodes — none dropped");
    assert.equal(new Set(nodes.map((n) => n.dataset.id)).size, 3, "node identity keys are unique");
    // the OTHER-root dev is a singleton in the Independent strip, not merged
    assert.equal(el.querySelectorAll(".hier-cluster .hnode").length, 2);
    assert.equal(el.querySelectorAll(".hier-solo .hnode").length, 1);
    // double-click opens with full identity (home/agentsRoot), not a bare name
    const soloNode = el.querySelector(".hier-solo .hnode");
    soloNode.dispatchEvent(new dom.window.Event("dblclick", { bubbles: true }));
    assert.equal(opened.length, 1);
    assert.equal(opened[0].home, "/b/agents/dev/i/dev", "terminal open addresses the exact instance");
    assert.equal(opened[0].agentsRoot, "/b/agents");
    un();
  } finally {
    g.window = prev.window; g.document = prev.document; g.localStorage = prev.localStorage;
  }
});

test("relation resolution keeps FULL-roster scope after clustering: globally-ambiguous edge never reintroduced", () => {
  // /c/kid joins /a/dev's component via an unambiguous sibling link, but
  // kid.parentInstance="dev" is globally AMBIGUOUS (/a/dev vs /b/dev):
  // clustering drops it — the per-cluster forest must NOT resurrect it.
  const roster = [
    { instance: "dev", agentsRoot: "/a", home: "/a/dev", running: true },
    { instance: "dev", agentsRoot: "/b", home: "/b/dev", running: true },
    { instance: "kid", agentsRoot: "/c", home: "/c/kid", parentInstance: "dev",
      siblingInstance: "uniq", running: true },
    // uniq shares /a with its parent "dev" — same-root resolution validly
    // pulls /a/dev into kid's component, making "dev" unique WITHIN the
    // cluster while staying ambiguous in the full roster.
    { instance: "uniq", agentsRoot: "/a", home: "/a/uniq", parentInstance: "dev", running: true },
  ];
  const { placed } = hier.layoutClusters(roster);
  const cl = placed.find((pc) => pc.nodes.some((n) => n.inst.home === "/c/kid"));
  assert.ok(cl.nodes.some((n) => n.inst.home === "/a/dev"),
    "fixture: /a/dev must share kid's cluster for the test to bite");
  const kid = cl.nodes.find((n) => n.inst.home === "/c/kid");
  const parentOfKid = cl.nodes.find((n) => n.children.includes(kid));
  assert.equal(parentOfKid, undefined,
    "ambiguous parent stays dropped inside the cluster forest — kid renders as a root");
});

test("layout determinism with duplicate names: identity tie-break keeps coordinates stable across roster order", () => {
  const roster = [
    { instance: "root", home: "/r/root", running: true },
    { instance: "dev", agentsRoot: "/a", home: "/a/dev", parentInstance: "root", running: true },
    { instance: "dev", agentsRoot: "/b", home: "/b/dev", parentInstance: "root", running: true },
  ];
  const posOf = (lay, home) => {
    const n = lay.nodes.find((x) => x.inst.home === home);
    return `${n.x}:${n.y}`;
  };
  const l1 = hier.layoutForest(roster);
  const l2 = hier.layoutForest([...roster].reverse());
  assert.equal(posOf(l1, "/a/dev"), posOf(l2, "/a/dev"), "same-named children never swap slots");
  assert.equal(posOf(l1, "/b/dev"), posOf(l2, "/b/dev"));
});
