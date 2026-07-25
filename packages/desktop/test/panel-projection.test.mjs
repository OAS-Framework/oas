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
