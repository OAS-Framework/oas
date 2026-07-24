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
