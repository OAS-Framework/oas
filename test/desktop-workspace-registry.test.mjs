// Workspace suggestions + runtime add (phase-2 hook 3) — privileged-side
// decision tests: bounded discovery, validation, canonicalization,
// suggestion-set provenance, foreign-server fail-closed, recents hygiene,
// and latest-intent generations (reverse completion).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateWorkspace, workspaceSuggestions, parseRecents, pushRecent,
  decideAdd, createGenerations,
} from "../packages/desktop/workspace-registry.mjs";

const mkValidate = (worlds) => (p) => validateWorkspace(p, {
  resolveConfig: (path) => {
    const w = worlds[path];
    if (w === undefined) throw new Error("no config");
    return w.team ? { team: w.team } : {};
  },
  hasAgentsRoot: (path) => !!worlds[path]?.agents,
});

test("validateWorkspace: team scope wins, agents root fallback, garbage rejected", () => {
  const validate = mkValidate({
    "/w/team": { team: { name: "t", scope: "/w/team" } },
    "/w/solo": { agents: true },
    "/w/none": {},
  });
  assert.deepEqual(validate("/w/team"), { id: "/w/team", name: "team", team: { name: "t" }, path: "/w/team" });
  assert.deepEqual(validate("/w/solo"), { id: "/w/solo", name: "solo", team: null, path: "/w/solo" });
  assert.equal(validate("/w/none"), null);
  assert.equal(validate("/nonexistent"), null);
});

test("suggestions: known + team siblings + recents, validated, advertised excluded, deduped with first reason", () => {
  const validate = mkValidate({
    "/w/a": { team: { name: "t", scope: "/w/a" } },
    "/w/b": { team: { name: "t", scope: "/w/b" } },
    "/w/c": { agents: true },
    "/w/dead": undefined, // not a workspace anymore
  });
  const list = workspaceSuggestions({
    knownPaths: ["/w/a"],
    teamSiblings: (p) => (p === "/w/a" ? ["/w/b", "/w/dead"] : []),
    recents: ["/w/c", "/w/b", "/w/dead"],
    advertised: new Set(["/w/a"]), // current workspace — not a suggestion
    validate,
  });
  assert.deepEqual(list.map((s) => [s.id, s.reason]), [
    ["/w/b", "team sibling of a"],
    ["/w/c", "recently used"],
  ]);
});

test("parseRecents: garbage, non-arrays, relative paths, and stale workspaces are dropped", () => {
  const validate = (p) => p === "/w/live";
  assert.deepEqual(parseRecents("not json", validate), []);
  assert.deepEqual(parseRecents('{"a":1}', validate), []);
  assert.deepEqual(parseRecents('["/w/live","relative","/w/gone",42]', validate), ["/w/live"]);
});

test("pushRecent: front insertion, dedup, cap", () => {
  assert.deepEqual(pushRecent(["/a", "/b"], "/b"), ["/b", "/a"]);
  assert.deepEqual(pushRecent(["/a"], "/c", 2), ["/c", "/a"]);
  assert.deepEqual(pushRecent(["/a", "/b"], "/c", 2), ["/c", "/a"]);
});

const addIo = (over = {}) => ({
  realpath: (p) => { if (p.includes("gone")) throw new Error("ENOENT"); return p.replace("/link", "/real"); },
  validate: mkValidate({
    "/w/real": { team: { name: "t", scope: "/w/real" } },
    "/w/plain": { agents: true },
  }),
  suggestedPaths: new Set(["/w/real"]),
  fromPicker: false,
  serverOwned: true,
  advertised: new Set(),
  ...over,
});

test("decideAdd: canonicalizes (symlink) then validates; nonexistent fails", () => {
  const r = decideAdd("/w/link", addIo({ suggestedPaths: new Set(["/w/real"]) }));
  assert.equal(r.ok, true);
  assert.equal(r.workspace.id, "/w/real");
  assert.equal(r.action, "replace-server");
  const gone = decideAdd("/w/gone", addIo());
  assert.equal(gone.code, "not-found");
  assert.match(gone.reason, /does not exist/);
});

test("decideAdd: provenance — non-suggested paths rejected unless from the picker", () => {
  const io = addIo({ suggestedPaths: new Set() });
  const rej = decideAdd("/w/real", io);
  assert.equal(rej.code, "not-suggested");
  assert.match(rej.reason, /not in the suggestion set/);
  const picked = decideAdd("/w/real", addIo({ suggestedPaths: new Set(), fromPicker: true }));
  assert.equal(picked.ok, true, "explicit picker path allowed through the same validation");
});

test("decideAdd: foreign server fails closed; already-advertised short-circuits", () => {
  const foreign = decideAdd("/w/real", addIo({ serverOwned: false }));
  assert.equal(foreign.ok, false);
  assert.equal(foreign.code, "foreign-server");
  assert.match(foreign.reason, /not owned by the app/);
  const dup = decideAdd("/w/real", addIo({ advertised: new Set(["/w/real"]) }));
  assert.deepEqual(dup, { ok: true, workspace: dup.workspace, action: "already-advertised" });
});

test("decideAdd: non-workspace paths rejected even from the picker", () => {
  const r = decideAdd("/w/junk", addIo({ fromPicker: true, realpath: (p) => p }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "not-a-workspace");
  assert.match(r.reason, /not an OAS workspace/);
});

test("generations: reverse completion — a stale request's completion is not current", () => {
  const gens = createGenerations();
  const g1 = gens.next("add");
  const g2 = gens.next("add");     // newer request supersedes
  assert.equal(gens.isCurrent("add", g1), false, "stale completion inert");
  assert.equal(gens.isCurrent("add", g2), true);
  // verbs are independent
  const s1 = gens.next("suggestions");
  assert.equal(gens.isCurrent("suggestions", s1), true);
  assert.equal(gens.isCurrent("add", g2), true);
});

// createAddExecutor: the effectful lifecycle (review wsadd) — staged commit,
// restore-on-failure, identity-checked readiness, serialization, and
// reverse-completion around real deferred effects (not just the counter).
import { createAddExecutor } from "../packages/desktop/workspace-registry.mjs";

function execHarness(over = {}) {
  const state = {
    dirs: ["/w/base"],
    committedDirs: null,
    recents: [],
    serverDirs: ["/w/base"],   // what the running server was started with
    replacements: [],
    probes: 0,
  };
  const io = {
    getDirs: () => [...state.dirs],
    commitDirs: (d) => { state.dirs = d; state.committedDirs = d; },
    commitRecent: (p) => state.recents.push(p),
    replaceServer: async (d) => { state.serverDirs = d; state.replacements.push([...d]); },
    probeVersion: async () => { state.probes++; return over.version ?? { ok: true, body: { capability: "oas.web", version: "1" } }; },
    isCompatible: over.isCompatible ?? ((v) => v?.body?.capability === "oas.web"),
    advertises: over.advertises ?? (async () => true),
    delay: async () => {},
    attempts: 3,
  };
  return { state, exec: createAddExecutor(io) };
}

test("executor: success commits dirs+recents AFTER readiness", async () => {
  const { state, exec } = execHarness();
  const r = await exec({ id: "/w/new", path: "/w/new" }, () => true);
  assert.equal(r.ok, true);
  assert.deepEqual(state.dirs, ["/w/base", "/w/new"]);
  assert.deepEqual(state.recents, ["/w/new"]);
  assert.deepEqual(state.replacements, [["/w/base", "/w/new"]], "single replacement with staged dirs");
});

test("executor: readiness timeout commits NOTHING and restores the previous server config", async () => {
  const { state, exec } = execHarness({ advertises: async () => false });
  const r = await exec({ id: "/w/new", path: "/w/new" }, () => true);
  assert.equal(r.code, "server-timeout");
  assert.deepEqual(state.dirs, ["/w/base"], "dirs not committed");
  assert.deepEqual(state.recents, [], "recents not committed");
  assert.deepEqual(state.replacements.at(-1), ["/w/base"], "server restored to previous dirs");
});

test("executor: identity mismatch during readiness is not accepted (any-2xx insufficient)", async () => {
  const { state, exec } = execHarness({ isCompatible: () => false });
  const r = await exec({ id: "/w/new", path: "/w/new" }, () => true);
  assert.equal(r.code, "server-timeout");
  assert.ok(state.probes >= 3, "kept probing rather than accepting the wrong server");
  assert.deepEqual(state.dirs, ["/w/base"]);
});

test("executor: superseded DURING readiness rolls back and commits nothing", async () => {
  let current = true;
  const { state, exec } = execHarness({ advertises: async () => { current = false; return true; } });
  const r = await exec({ id: "/w/new", path: "/w/new" }, () => current);
  assert.equal(r.code, "superseded");
  assert.deepEqual(state.dirs, ["/w/base"], "stale request committed nothing");
  assert.deepEqual(state.replacements.at(-1), ["/w/base"], "restored");
});

test("executor: superseded BEFORE start performs no effects at all", async () => {
  const { state, exec } = execHarness();
  const r = await exec({ id: "/w/new", path: "/w/new" }, () => false);
  assert.equal(r.code, "superseded");
  assert.deepEqual(state.replacements, [], "no server replacement for a stale request");
});

test("executor: adds serialize — the second waits for the first, effects in order", async () => {
  const order = [];
  let release;
  const gate = new Promise((ok) => { release = ok; });
  const { exec } = (() => {
    const h = execHarness();
    const orig = h.io ?? null;
    return h;
  })();
  // custom harness with a blocking first replacement
  const state = { dirs: ["/w/base"], replacements: [] };
  const io = {
    getDirs: () => [...state.dirs],
    commitDirs: (d) => { state.dirs = d; order.push(["commit", d.at(-1)]); },
    commitRecent: () => {},
    replaceServer: async (d) => {
      order.push(["replace", d.at(-1)]);
      state.replacements.push(d);
      if (d.at(-1) === "/w/one" && state.replacements.length === 1) await gate;
    },
    probeVersion: async () => ({ ok: true }),
    isCompatible: () => true,
    advertises: async () => true,
    delay: async () => {},
    attempts: 2,
  };
  const run = createAddExecutor(io);
  const p1 = run({ id: "/w/one", path: "/w/one" }, () => true);
  const p2 = run({ id: "/w/two", path: "/w/two" }, () => true);
  await new Promise((ok) => setImmediate(ok));
  assert.deepEqual(order, [["replace", "/w/one"]], "second add queued behind the first");
  release();
  await p1; await p2;
  assert.deepEqual(order, [
    ["replace", "/w/one"], ["commit", "/w/one"],
    ["replace", "/w/two"], ["commit", "/w/two"],
  ], "strictly serialized; second staged on the first's committed dirs");
  assert.deepEqual(state.dirs, ["/w/base", "/w/one", "/w/two"]);
});
