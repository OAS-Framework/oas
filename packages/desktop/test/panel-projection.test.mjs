// /api/panel per-instance contract projection (review 2092e0f): renderer
// clustering and ux-designer's cluster-first overview consume these exact
// fields, but renderer tests inject them directly — a dropped or typo'd
// projection field would stay green there. Extract the REAL projection
// function from server/oas-web.mjs via block markers (house pattern,
// keySendError) and assert the relation contract fields end to end.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRV = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "oas-web.mjs");

function projection() {
  const src = readFileSync(SRV, "utf8");
  const m = src.match(/\/\* OASWEB_PANELPROJ_BEGIN[^*]*\*\/([\s\S]*?)\/\* OASWEB_PANELPROJ_END \*\//);
  assert.ok(m, "PANELPROJ block markers present");
  return new Function("dirname", m[1] + "\nreturn projectPanelInstance;")(dirname);
}

test("/api/panel projection forwards the agent-relations contract fields (present values)", () => {
  const project = projection();
  const out = project({
    instance: "dev-a", agent: "dev", description: "", repo: "/r", work: "worktree",
    running: true, home: "/h", agentsRoot: "/ws/agents",
    parentInstance: "coord-1", siblingInstance: "peer-9",
    relation: "sibling", relativeTo: "peer-9",
    tmux: {}, git: {}, task: "t", next: "n",
  });
  assert.equal(out.parentInstance, "coord-1");
  assert.equal(out.siblingInstance, "peer-9", "siblingInstance must reach the renderer");
  assert.equal(out.relation, "sibling");
  assert.equal(out.relativeTo, "peer-9");
});

test("/api/panel projection: absent relation metadata is stable null, never undefined/dropped", () => {
  const project = projection();
  const out = project({ instance: "loner", agentsRoot: "/ws/agents", tmux: {}, git: {} });
  for (const field of ["parentInstance", "siblingInstance", "relation", "relativeTo"]) {
    assert.ok(field in out, `${field} present in the payload`);
    assert.equal(out[field], null, `${field} is a stable null when absent`);
  }
});

/* ── /api/spawn error shaping (review f1e3211) ── */

function spawnError() {
  const src = readFileSync(SRV, "utf8");
  const m = src.match(/\/\* OASWEB_SPAWNERR_BEGIN[^*]*\*\/([\s\S]*?)\/\* OASWEB_SPAWNERR_END \*\//);
  assert.ok(m, "SPAWNERR block markers present");
  return new Function(m[1] + "\nreturn spawnErrorPayload;")();
}

test("/api/spawn errors: E_RELATIVE_AMBIGUOUS passes through UNSLICED; others stay tightly capped", () => {
  const shape = spawnError();
  // realistic case-(d) inherited-edge message: two absolute homes, ambiguous
  // name differs from any picked anchor, >300 chars end to end
  const homes = [
    "/Users/someone/very/long/workspace/path/agents/dev-coordinator/instances/dev-coordinator-parallel",
    "/Users/someone/other/equally/long/team/checkout/local-agents/dev-coordinator/instances/dev-coordinator-parallel",
  ];
  const long = `relation "sibling": inherited lineage edge "dev-coordinator-parallel" is ambiguous — `
    + `it matches ${homes[0]} and ${homes[1]}; qualify with --relative-root or rename one instance`;
  assert.ok(long.length > 300, "fixture exercises the truncation boundary");
  const err = Object.assign(new Error(long), { code: "E_RELATIVE_AMBIGUOUS" });
  const { status, body } = shape(err);
  assert.equal(status, 409);
  assert.equal(body.code, "E_RELATIVE_AMBIGUOUS");
  assert.equal(body.error, long, "the full kernel message survives — both homes and the remedy tail reach the renderer");
  // other codes keep the tight cap (unbounded upstream text guard)
  const noisy = Object.assign(new Error("x".repeat(1000)), { code: "E_SPAWN_FAILED" });
  assert.equal(shape(noisy).body.error.length, 300, "non-ambiguity errors stay capped at 300");
  // NO fixed cap for this code: even paths past any arbitrary threshold
  // survive (the adapter's 4 MiB envelope bound is the real upstream guard;
  // review 835a05f)
  const huge = Object.assign(new Error("y".repeat(5000)), { code: "E_RELATIVE_AMBIGUOUS" });
  assert.equal(shape(huge).body.error.length, 5000, "deeply nested multi-home diagnostics are never sliced");
  // degradation code maps to 503
  assert.equal(shape(Object.assign(new Error("no cli"), { code: "cli-unavailable" })).status, 503);
});
