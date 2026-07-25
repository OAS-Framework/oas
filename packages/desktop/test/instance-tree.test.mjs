import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  collapseKey, hasInstanceChildren, instanceRepoLabel, treeGuideSegments, filterInstanceTree, instanceVisibleInTree,
  captureTreeRenderState, configureDisclosure, rosterResponseOwns,
  ROSTER_SORTS, rosterRank, groupRosterFamilies, rosterGroupKey,
} from "../renderer/instance-tree.mjs";

const instances = [
  { instance: "root" },
  { instance: "child", parentInstance: "root" },
  { instance: "grand", parentInstance: "child" },
  { instance: "sibling", parentInstance: "root" },
  { instance: "other" },
];

test("instance tree collapse hides arbitrary-depth descendants but not peers", () => {
  const collapsed = new Set([collapseKey("wsA", "child")]);
  const visible = (name, ws = "wsA", filtering = false) => instanceVisibleInTree(
    instances.find((i) => i.instance === name), instances, collapsed, ws, filtering,
  );
  assert.equal(visible("root"), true);
  assert.equal(visible("child"), true, "collapsed parent itself stays visible");
  assert.equal(visible("grand"), false);
  assert.equal(visible("sibling"), true);
  assert.equal(visible("other"), true);
  assert.equal(visible("grand", "wsB"), true, "collapse state is workspace-scoped");
  assert.equal(visible("grand", "wsA", true), true, "filtering reveals matching descendants without changing state");
});

test("tree guides terminate final siblings and continue only real ancestor branches", () => {
  const flat = [
    { instance: "root", depth: 0 },
    { instance: "child-a", parentInstance: "root", depth: 1 },
    { instance: "grand", parentInstance: "child-a", depth: 2 },
    { instance: "child-b", parentInstance: "root", depth: 1 },
  ];
  assert.deepEqual(treeGuideSegments(flat, flat[1]), ["branch"], "non-final child continues below its elbow");
  assert.deepEqual(treeGuideSegments(flat, flat[2]), ["continue", "end"],
    "grandchild keeps a real ancestor continuation and ends its own branch");
  assert.deepEqual(treeGuideSegments(flat, flat[3]), ["end"], "last child line stops at its elbow");

  const onlyBranch = flat.slice(0, 3);
  assert.deepEqual(treeGuideSegments(onlyBranch, onlyBranch[2]), ["none", "end"],
    "descendants do not extend an exhausted parent sibling line");
});

test("instance repo label prefers roster name and falls back to path basename", () => {
  assert.equal(instanceRepoLabel({ repoName: "oas", repo: "/tmp/ignored" }), "oas");
  assert.equal(instanceRepoLabel({ repo: "/work/projects/desktop-app" }), "desktop-app");
  assert.equal(instanceRepoLabel({ workspace: "/work/team" }), "team");
  assert.equal(instanceRepoLabel({}), "workspace");
});

test("instance tree detects disclosure parents and survives malformed cycles", () => {
  assert.equal(hasInstanceChildren(instances, "root"), true);
  assert.equal(hasInstanceChildren(instances, "grand"), false);
  const cyclic = [
    { instance: "a", parentInstance: "b" },
    { instance: "b", parentInstance: "a" },
  ];
  assert.equal(instanceVisibleInTree(cyclic[0], cyclic, new Set(), "ws"), true);
  assert.equal(instanceVisibleInTree(cyclic[0], cyclic, new Set([collapseKey("ws", "b")]), "ws"), false);
});

test("DOM rerender preserves focused disclosure/terminal identity and scroll across toggle and poll", () => {
  const dom = new JSDOM(`<!doctype html><body><div id="list"></div></body>`);
  const list = dom.window.document.getElementById("list");
  Object.defineProperty(list, "scrollTop", { value: 73, writable: true });
  const paint = (control = "disclosure") => {
    list.innerHTML = `<button data-tree-instance="root" data-tree-control="${control}">${control}</button>`;
  };
  paint();
  list.querySelector("button").focus();
  let restore = captureTreeRenderState(list);
  paint(); // disclosure toggle rebuild
  list.scrollTop = 0;
  assert.equal(restore(), true);
  assert.equal(dom.window.document.activeElement.dataset.treeControl, "disclosure");
  assert.equal(list.scrollTop, 73);

  restore = captureTreeRenderState(list);
  paint(); // polling refresh/reorder rebuild
  const replacement = list.querySelector("button");
  const nativeFocus = replacement.focus.bind(replacement);
  let focusOptions;
  replacement.focus = (options) => {
    focusOptions = options;
    nativeFocus(options);
    list.scrollTop = 0; // simulate Chromium scrolling the focused/reordered row
  };
  list.scrollTop = 5;
  assert.equal(restore(), true);
  assert.deepEqual(focusOptions, { preventScroll: true });
  assert.equal(dom.window.document.activeElement.dataset.treeInstance, "root");
  assert.equal(list.scrollTop, 73, "saved scroll is reapplied after focus-induced scrolling");
  dom.window.close();
});

test("filter includes ancestor paths and forces collapsed disclosures truthfully expanded without mutation", () => {
  assert.deepEqual(filterInstanceTree(instances, "grand").map((i) => i.instance), ["root", "child", "grand"]);
  const dom = new JSDOM(`<!doctype html><body><button id="d"></button></body>`);
  const disclosure = dom.window.document.getElementById("d");
  let toggles = 0;
  configureDisclosure(disclosure, {
    instance: "root", collapsed: true, filtering: true, onToggle: () => toggles++,
  });
  assert.equal(disclosure.getAttribute("aria-expanded"), "true");
  assert.equal(disclosure.getAttribute("aria-disabled"), "true");
  assert.equal(disclosure.disabled, true);
  disclosure.click();
  assert.equal(toggles, 0, "forced filter expansion never mutates persisted collapse state");
  dom.window.close();
});

test("first-launch deferred roster owns both completion orders but rejects a true switch", async () => {
  const owns = (current, dispatchGeneration = 1, currentGeneration = 1) => rosterResponseOwns({
    dispatchWorkspace: "", responseWorkspace: "wsA", currentWorkspace: current,
    dispatchGeneration, currentGeneration,
  });
  // Roster resolves first: current selection is still empty and adopts wsA.
  assert.equal(owns(""), true);
  // Hierarchy resolves first: it silently adopted the SAME server workspace.
  await Promise.resolve();
  assert.equal(owns("wsA"), true);
  // A real selection/generation change must still reject the old response.
  assert.equal(owns("wsB"), false);
  assert.equal(owns("wsA", 1, 2), false);
});

/* ── agent clusters (feature/agent-relations) ── */

test("clusterInstances: connected components over parent + sibling links; unrelated are single-node clusters", async () => {
  const { clusterInstances, instanceLinks } = await import("../renderer/instance-tree.mjs");
  const roster = [
    { instance: "coord-1", running: true },
    { instance: "dev-a", parentInstance: "coord-1", running: true },
    { instance: "dev-b", parentInstance: "coord-1", running: false },
    { instance: "reviewer-1", parentInstance: "dev-a", running: true },
    // sibling-linked pair, no shared parent — still one cluster
    { instance: "peer-1", siblingInstance: "peer-2", relation: "sibling", relativeTo: "peer-2", running: false },
    { instance: "peer-2", running: false },
    // unrelated
    { instance: "loner", running: true },
  ];
  const clusters = clusterInstances(roster);
  const byKey = new Map(clusters.map((c) => [c.key, c.instances.map((i) => i.instance)]));
  assert.equal(clusters.length, 3);
  assert.deepEqual(byKey.get("coord-1"), ["coord-1", "dev-a", "reviewer-1", "dev-b"],
    "cluster keeps parent-first tree order (running-first among siblings)");
  assert.deepEqual(new Set(byKey.get("peer-1")), new Set(["peer-1", "peer-2"]),
    "sibling link alone joins a cluster");
  assert.deepEqual(byKey.get("loner"), ["loner"], "unrelated instance is its own cluster");
  // depths: tree depth inside the cluster; sibling-only members at depth 0
  const coord = clusters.find((c) => c.key === "coord-1").instances;
  assert.deepEqual(coord.map((i) => i.depth), [0, 1, 2, 1]);
  const peers = clusters.find((c) => byKey.get(c.key).includes("peer-2")).instances;
  assert.ok(peers.every((i) => i.depth === 0), "sibling-linked peers sit at depth 0");
  // link extractor reads the canonical contract: parentInstance + siblingInstance
  assert.deepEqual(instanceLinks({ instance: "x", parentInstance: "p", siblingInstance: "s" }), ["p", "s"]);
  assert.deepEqual(instanceLinks({ instance: "x", siblingInstance: "x" }), [], "self links dropped");
  assert.deepEqual(instanceLinks({ instance: "x", siblingInstance: "" }), [], "empty links dropped");
});

test("clusterInstances: malformed parent cycles keep every member visible", async () => {
  const { clusterInstances } = await import("../renderer/instance-tree.mjs");
  const roster = [
    { instance: "a", parentInstance: "b", running: false },
    { instance: "b", parentInstance: "a", running: false },
  ];
  const clusters = clusterInstances(roster);
  assert.equal(clusters.length, 1);
  assert.deepEqual(new Set(clusters[0].instances.map((i) => i.instance)), new Set(["a", "b"]));
});

test("clusterInstances: edges to instances outside the roster do not join or crash", async () => {
  const { clusterInstances } = await import("../renderer/instance-tree.mjs");
  const clusters = clusterInstances([
    { instance: "x", parentInstance: "ghost", siblingInstance: "phantom", running: true },
    { instance: "y", running: true },
  ]);
  assert.equal(clusters.length, 2, "dangling links leave both as single-node clusters");
});

test("clusterInstances: cluster key is deterministic under liveness changes (review f921f7d nit)", async () => {
  const { clusterInstances } = await import("../renderer/instance-tree.mjs");
  const pair = (aRunning, bRunning) => [
    { instance: "b-peer", siblingInstance: "a-peer", running: bRunning },
    { instance: "a-peer", running: aRunning },
  ];
  const keyOf = (list) => clusterInstances(list)[0].key;
  assert.equal(keyOf(pair(true, false)), "a-peer");
  assert.equal(keyOf(pair(false, true)), "a-peer",
    "which member is running must not change the visible cluster name");
  // parented cluster: the label is the root, regardless of who is running
  const tree = (rootRunning) => [
    { instance: "z-root", running: rootRunning },
    { instance: "a-child", parentInstance: "z-root", running: !rootRunning },
  ];
  assert.equal(keyOf(tree(true)), "z-root");
  assert.equal(keyOf(tree(false)), "z-root", "root name labels the cluster even when idle");
});

test("sidebar cluster separator: accessible boundary with NO visible glyph or name (human re-test)", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  return import("../renderer/instance-tree.mjs").then((m) => {
    const el = m.clusterSeparator(dom.window.document, 3);
    assert.equal(el.getAttribute("role"), "separator", "AT boundary preserved");
    assert.match(el.getAttribute("aria-label"), /3 related instances/, "label carries the member count");
    assert.equal(el.textContent, "", "NO visible glyph or text — the boundary reads from spacing only");
    assert.ok(!el.getAttribute("aria-label").includes("◎"), "no glyph smuggled into the label");
    assert.equal(el.className, "ctx-cluster-sep");
    dom.window.close();
  });
});

/* ── roster grouping: repo → agent family, sort modes ── */

const roster = [
  { instance: "b-idle", agent: "beta", repoName: "repo1", running: false },
  { instance: "a-run", agent: "beta", repoName: "repo1", running: true },
  { instance: "kid", agent: "beta", repoName: "repo1", parentInstance: "a-run", running: false },
  { instance: "solo", agent: "alpha", repoName: "repo1", running: false },
  { instance: "other", agent: "gamma", repoName: "repo0", running: true },
];

test("groupRosterFamilies groups repo → family alphabetically with lineage order inside", () => {
  const grouped = groupRosterFamilies(roster, "status");
  assert.deepEqual([...grouped.keys()], ["repo0", "repo1"], "repos alphabetical");
  assert.deepEqual([...grouped.get("repo1").keys()], ["alpha", "beta"], "families alphabetical");
  const beta = grouped.get("repo1").get("beta");
  assert.deepEqual(beta.map((i) => i.instance), ["a-run", "kid", "b-idle"],
    "status sort: running root first, child under its parent, idle root last");
  assert.deepEqual(beta.map((i) => i.depth), [0, 1, 0], "depth annotated");
});

test("groupRosterFamilies name sort is alphabetical regardless of running state", () => {
  const beta = groupRosterFamilies(roster, "name").get("repo1").get("beta");
  assert.deepEqual(beta.map((i) => i.instance), ["a-run", "kid", "b-idle"],
    "children still nest under parents");
  const flat = groupRosterFamilies([
    { instance: "z", agent: "f", repoName: "r", running: true },
    { instance: "a", agent: "f", repoName: "r", running: false },
  ], "name").get("r").get("f");
  assert.deepEqual(flat.map((i) => i.instance), ["a", "z"]);
});

test("rosterRank falls back to status for unknown sort ids and ROSTER_SORTS covers both modes", () => {
  assert.deepEqual(ROSTER_SORTS.map((s) => s.id), ["status", "name"]);
  const rank = rosterRank("bogus-persisted-value");
  assert.ok(rank({ instance: "z", running: true }, { instance: "a", running: false }) < 0,
    "unknown id ranks running first (status fallback)");
});

test("groupRosterFamilies cuts cross-family parent links and survives cycles", () => {
  const cross = [
    { instance: "p", agent: "fam1", repoName: "r", running: true },
    { instance: "c", agent: "fam2", repoName: "r", parentInstance: "p", running: true },
    { instance: "x", agent: "loop", repoName: "r", parentInstance: "y", running: false },
    { instance: "y", agent: "loop", repoName: "r", parentInstance: "x", running: false },
  ];
  const grouped = groupRosterFamilies(cross);
  assert.deepEqual(grouped.get("r").get("fam2").map((i) => ({ n: i.instance, d: i.depth })),
    [{ n: "c", d: 0 }], "cross-family child renders as a root of its own family");
  const loop = grouped.get("r").get("loop").map((i) => i.instance).sort();
  assert.deepEqual(loop, ["x", "y"], "malformed cycle members all render exactly once");
});

test("rosterGroupKey is workspace-scoped and repo vs repo+family keys differ", () => {
  assert.notEqual(rosterGroupKey("wsA", "repo"), rosterGroupKey("wsB", "repo"));
  assert.notEqual(rosterGroupKey("ws", "repo"), rosterGroupKey("ws", "repo", "fam"));
});

test("groupRosterFamilies tolerates malformed workspace-controlled metadata (non-string agent/repoName)", () => {
  const grouped = groupRosterFamilies([
    { instance: "ok", agent: "fam", repoName: "r", running: true },
    { instance: "bad-agent", agent: {}, repoName: "r", running: false },
    { instance: "bad-repo", agent: "fam", repoName: { x: 1 }, running: false },
    { instance: "no-agent", repoName: "r", running: false },
  ]);
  const all = [...grouped.values()].flatMap((f) => [...f.values()].flat()).map((i) => i.instance);
  assert.deepEqual(all.sort(), ["bad-agent", "bad-repo", "no-agent", "ok"],
    "every instance renders once; no localeCompare throw blanks the roster");
  assert.ok(grouped.get("r").has("fam"), "well-formed family survives alongside malformed peers");
  assert.ok(grouped.get("r").has("?"), "missing agent coalesces to '?'");
});

test("clusterInstances: duplicate instance NAMES across repos render as distinct nodes (merged-state review f7c5769)", async () => {
  const { clusterInstances, instanceId } = await import("../renderer/instance-tree.mjs");
  // two live instances named "dev-1" in different agents roots — bare-name
  // keying would silently drop one of them
  const roster = [
    { instance: "coord-1", agentsRoot: "/ws1/agents", home: "/ws1/agents/coord/instances/coord-1", running: true },
    { instance: "dev-1", agentsRoot: "/ws1/agents", home: "/ws1/agents/dev/instances/dev-1",
      parentInstance: "coord-1", running: true },
    { instance: "dev-1", agentsRoot: "/ws2/agents", home: "/ws2/agents/dev/instances/dev-1", running: false },
  ];
  const clusters = clusterInstances(roster);
  const allNodes = clusters.flatMap((c) => c.instances);
  assert.equal(allNodes.length, 3, "every instance renders — duplicates never hide a live one");
  assert.equal(new Set(allNodes.map(instanceId)).size, 3, "three distinct identities");
  // the parent edge resolves to the SAME-ROOT dev-1 only
  const ws1Cluster = clusters.find((c) => c.instances.some((i) => i.instance === "coord-1"));
  assert.deepEqual(ws1Cluster.instances.map((i) => `${i.instance}@${i.agentsRoot}`),
    ["coord-1@/ws1/agents", "dev-1@/ws1/agents"], "same-root child nests under its parent");
  assert.equal(ws1Cluster.instances[1].depth, 1);
  const ws2 = clusters.find((c) => c.instances.some((i) => i.agentsRoot === "/ws2/agents"));
  assert.equal(ws2.instances.length, 1, "foreign same-named instance stays its own cluster");
  assert.equal(ws2.instances[0].depth, 0);
});

test("clusterInstances: ambiguous cross-root relation names fail safe (no merge, no hidden node)", async () => {
  const { clusterInstances } = await import("../renderer/instance-tree.mjs");
  // parent name matches TWO foreign instances and none in the child's root:
  // the edge must resolve to nothing rather than guess
  const roster = [
    { instance: "boss", agentsRoot: "/a/agents", home: "/a/x", running: true },
    { instance: "boss", agentsRoot: "/b/agents", home: "/b/x", running: true },
    { instance: "worker", agentsRoot: "/c/agents", home: "/c/x", parentInstance: "boss", running: true },
  ];
  const clusters = clusterInstances(roster);
  assert.equal(clusters.length, 3, "ambiguous edge creates no cluster merge");
  assert.equal(clusters.flatMap((c) => c.instances).length, 3, "all nodes still render");
  // but a globally-UNIQUE name still resolves cross-root
  const uniq = clusterInstances([
    { instance: "coord", agentsRoot: "/a/agents", home: "/a/c", running: true },
    { instance: "helper", agentsRoot: "/b/agents", home: "/b/h", parentInstance: "coord", running: true },
  ]);
  assert.equal(uniq.length, 1, "unique cross-root parent name still links");
  assert.equal(uniq[0].instances[1].depth, 1);
});

test("instanceId: home wins, agentsRoot+name fallback, bare name last", async () => {
  const { instanceId } = await import("../renderer/instance-tree.mjs");
  assert.equal(instanceId({ instance: "a", home: "/h/a", agentsRoot: "/r" }), "/h/a");
  assert.equal(instanceId({ instance: "a", agentsRoot: "/r" }), "/r\u0000a");
  assert.equal(instanceId({ instance: "a" }), "a");
});

test("resolveLinkId (shared resolver contract): same-root first, unique cross-root, ambiguous → null", async () => {
  const { resolveLinkId, instanceId } = await import("../renderer/instance-tree.mjs");
  const a1 = { instance: "x", agentsRoot: "/a/agents", home: "/a/x" };
  const b1 = { instance: "x", agentsRoot: "/b/agents", home: "/b/x" };
  const u = { instance: "uniq", agentsRoot: "/b/agents", home: "/b/u" };
  const byName = new Map([["x", [a1, b1]], ["uniq", [u]]]);
  const from = { instance: "child", agentsRoot: "/a/agents", home: "/a/c" };
  assert.equal(resolveLinkId(from, "x", byName), instanceId(a1), "same-root candidate wins over the foreign twin");
  assert.equal(resolveLinkId(from, "uniq", byName), instanceId(u), "globally-unique name resolves cross-root");
  const foreign = { instance: "far", agentsRoot: "/c/agents", home: "/c/f" };
  assert.equal(resolveLinkId(foreign, "x", byName), null, "ambiguous with no same-root candidate → null (fail safe)");
  assert.equal(resolveLinkId(from, "ghost", byName), null, "unknown name → null");
});

/* ── identity propagation past cluster construction (review 46f3fdc) ── */

test("findRosterInstance: exact identity wins; bare duplicate names refuse to guess", async () => {
  const { findRosterInstance } = await import("../renderer/instance-tree.mjs");
  const roster = [
    { instance: "dev-1", agentsRoot: "/ws1/agents", home: "/ws1/h", tmux: { session: "s1", window: "dev-1" } },
    { instance: "dev-1", agentsRoot: "/ws2/agents", home: "/ws2/h", tmux: { session: "s2", window: "dev-1" } },
    { instance: "solo", agentsRoot: "/ws1/agents", home: "/ws1/s" },
  ];
  // each duplicate row's reference resolves to ITS OWN instance (its own tmux target)
  const first = findRosterInstance(roster, { instance: "dev-1", home: "/ws1/h", agentsRoot: "/ws1/agents" });
  const second = findRosterInstance(roster, { instance: "dev-1", home: "/ws2/h", agentsRoot: "/ws2/agents" });
  assert.equal(first.tmux.session, "s1", "first duplicate opens the first root's tmux session");
  assert.equal(second.tmux.session, "s2", "second duplicate opens the SECOND root's tmux session, never the first name match");
  // agentsRoot alone (no home) still disambiguates
  assert.equal(findRosterInstance(roster, { instance: "dev-1", agentsRoot: "/ws2/agents" }).tmux.session, "s2");
  // bare names: unique resolves, duplicate refuses (null), unknown null
  assert.equal(findRosterInstance(roster, "solo").instance, "solo");
  assert.equal(findRosterInstance(roster, "dev-1"), null, "ambiguous bare name never returns the first match");
  assert.equal(findRosterInstance(roster, "ghost"), null);
});

test("terminalKey: same-named instances from different roots are DIFFERENT terminals", async () => {
  const { terminalKey } = await import("../renderer/instance-tree.mjs");
  const a = { instance: "dev-1", home: "/ws1/h", agentsRoot: "/ws1/agents" };
  const b = { instance: "dev-1", home: "/ws2/h", agentsRoot: "/ws2/agents" };
  assert.notEqual(terminalKey("w", a), terminalKey("w", b), "duplicate names dedupe separately");
  assert.equal(terminalKey("w", a), terminalKey("w", a), "same identity dedupes together");
  assert.notEqual(terminalKey("w1", a), terminalKey("w2", a), "still workspace-scoped");
  assert.equal(terminalKey("w", "legacy-name"), "term:w:legacy-name", "bare-name callers keep their key shape");
});

test("collapse state keys by identity: collapsing one duplicate never hides the other's subtree", async () => {
  const m = await import("../renderer/instance-tree.mjs");
  const roster = [
    { instance: "coord", agentsRoot: "/ws1/agents", home: "/ws1/c" },
    { instance: "kid", agentsRoot: "/ws1/agents", home: "/ws1/k", parentInstance: "coord" },
    { instance: "coord", agentsRoot: "/ws2/agents", home: "/ws2/c" },
    { instance: "kid2", agentsRoot: "/ws2/agents", home: "/ws2/k2", parentInstance: "coord" },
  ];
  // collapse ONLY the /ws1 coord (by its identity)
  const collapsed = new Set([m.collapseKey("w", m.instanceId(roster[0]))]);
  const vis = (i) => m.instanceVisibleInTree(i, roster, collapsed, "w");
  assert.equal(vis(roster[1]), false, "ws1 kid hidden under its collapsed parent");
  assert.equal(vis(roster[3]), true, "ws2 kid STAYS VISIBLE — the other root's same-named parent is not collapsed");
  assert.equal(vis(roster[2]), true, "the ws2 parent itself stays visible");
});

test("distinguishingRootTags: colliding single-segment tags grow to a unique suffix (review cbd5bb3)", async () => {
  const { distinguishingRootTags } = await import("../renderer/instance-tree.mjs");
  // the naive one-segment tag would be "project" for BOTH
  const tags = distinguishingRootTags(["/a/project/agents", "/b/project/agents"]);
  assert.notEqual(tags.get("/a/project/agents"), tags.get("/b/project/agents"),
    "duplicate option labels actually differ");
  assert.match(tags.get("/a/project/agents"), /a\/project/, "suffix grows until distinguishing");
  // non-colliding roots keep the short tag
  const short = distinguishingRootTags(["/x/alpha/agents", "/y/beta/agents"]);
  assert.equal(short.get("/x/alpha/agents"), "alpha");
  assert.equal(short.get("/y/beta/agents"), "beta");
  // identical roots (same instance listed once per name) fall back to the full root
  const same = distinguishingRootTags(["/only/one/agents"]);
  assert.equal(same.get("/only/one/agents"), "one");
});

test("hasInstanceChildren by identity: a childless duplicate-name parent gets NO disclosure (review 7d740f9)", async () => {
  const m = await import("../renderer/instance-tree.mjs");
  const roster = [
    { instance: "coord", agentsRoot: "/ws1/agents", home: "/ws1/c" },                       // has a child
    { instance: "kid", agentsRoot: "/ws1/agents", home: "/ws1/k", parentInstance: "coord" },
    { instance: "coord", agentsRoot: "/ws2/agents", home: "/ws2/c" },                       // childless twin
  ];
  assert.equal(m.hasInstanceChildren(roster, roster[0]), true, "the real parent discloses");
  assert.equal(m.hasInstanceChildren(roster, roster[2]), false,
    "the childless same-named twin gets no disclosure control");
  // legacy bare-name shape still works for identity-less rosters
  assert.equal(m.hasInstanceChildren([{ instance: "a", parentInstance: "p" }], "p"), true);
  assert.equal(m.hasInstanceChildren([{ instance: "a", parentInstance: "p" }], "a"), false);
});

test("resolveTerminalOpen: string and object refs of one identity mint ONE key; ambiguity refuses before any key exists (review 7d740f9)", async () => {
  const m = await import("../renderer/instance-tree.mjs");
  const uniqueRoster = [
    { instance: "dev-1", agentsRoot: "/ws1/agents", home: "/ws1/h", running: true, tmux: { session: "s1" } },
    { instance: "solo", agentsRoot: "/ws1/agents", home: "/ws1/s", running: true },
  ];
  // string-vs-object opens of the SAME identity dedupe to one tab key
  const byName = m.resolveTerminalOpen(uniqueRoster, "dev-1", "w");
  const byObject = m.resolveTerminalOpen(uniqueRoster, { instance: "dev-1", home: "/ws1/h", agentsRoot: "/ws1/agents" }, "w");
  assert.ok(!byName.error && !byObject.error);
  assert.equal(byName.key, byObject.key, "palette (bare name) and sidebar (object) share ONE tab for one identity");
  assert.equal(byName.inst.home, "/ws1/h", "both resolve to the canonical roster instance");
  // the name later becomes AMBIGUOUS: resolution refuses BEFORE any key can
  // match a stale bare-name tab — no wrong-session activation path
  const shadowedRoster = [...uniqueRoster,
    { instance: "dev-1", agentsRoot: "/ws2/agents", home: "/ws2/h", running: true, tmux: { session: "s2" } }];
  const nowAmbiguous = m.resolveTerminalOpen(shadowedRoster, "dev-1", "w");
  assert.equal(nowAmbiguous.error, "ambiguous", "previously unique bare name refuses once shadowed");
  assert.equal(nowAmbiguous.key, undefined, "no key minted — stale-tab dedup can never activate on ambiguity");
  // exact refs still resolve under shadowing, each to its own key
  const a = m.resolveTerminalOpen(shadowedRoster, { instance: "dev-1", home: "/ws1/h", agentsRoot: "/ws1/agents" }, "w");
  const b = m.resolveTerminalOpen(shadowedRoster, { instance: "dev-1", home: "/ws2/h", agentsRoot: "/ws2/agents" }, "w");
  assert.ok(!a.error && !b.error);
  assert.notEqual(a.key, b.key, "exact refs keep distinct terminals under shadowing");
});

test("resolveLinkId: intra-root duplicate names are inherently ambiguous — no first-candidate edge (merged-state review @7dd1e7b)", async () => {
  const m = await import("../renderer/instance-tree.mjs");
  const from = { instance: "child-1", agentsRoot: "/ws/agents", home: "/ws/agents/c/instances/child-1" };
  const dupA = { instance: "coord", agentsRoot: "/ws/agents", home: "/ws/agents/coord/instances/coord" };
  const dupB = { instance: "coord", agentsRoot: "/ws/agents", home: "/ws/agents/local~coord/instances/coord" };
  const byName = new Map([["coord", [dupA, dupB]]]);
  assert.equal(m.resolveLinkId(from, "coord", byName), null,
    "two same-root candidates: kernel classifies the name inherently ambiguous — resolve to nothing, never a false edge");
  // exactly one same-root candidate among cross-root noise still resolves
  const other = { instance: "coord", agentsRoot: "/elsewhere/agents", home: "/elsewhere/agents/coord/instances/coord" };
  const byName2 = new Map([["coord", [dupA, other]]]);
  assert.equal(m.resolveLinkId(from, "coord", byName2), m.instanceId(dupA), "single same-root candidate wins over cross-root");
  // and clustering treats the intra-root-duplicate parent edge as absent:
  // the child is NOT merged into either duplicate's cluster
  const child = { ...from, parentInstance: "coord" };
  const clusters = m.clusterInstances([child, dupA, dupB]);
  const childCluster = clusters.find((c) => c.instances.some((i) => i.instance === "child-1"));
  assert.equal(childCluster.instances.length, 1, "ambiguous edge ignored — child stays a single-node cluster");
});
