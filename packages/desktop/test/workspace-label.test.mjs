import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { workspaceChoiceLabels, createWorkspaceLabel, bindWorkspaceSelect } from "../renderer/workspace-label.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((ok) => { resolve = ok; });
  return { promise, resolve };
};

test("workspace label: A→B with deferred A completing last keeps B", async () => {
  const dom = new JSDOM(`<!doctype html><body><select id="ws"></select></body>`);
  const select = dom.window.document.getElementById("ws");
  const label = createWorkspaceLabel(select);
  const aGate = deferred(), bGate = deferred();
  const commitA = label.begin();
  const a = aGate.promise.then((workspace) => commitA(workspace, [workspace]));
  const commitB = label.begin();
  const b = bGate.promise.then((workspace) => commitB(workspace, [workspace]));

  bGate.resolve({ id: "B", name: "Workspace B" });
  assert.equal(await b, true);
  assert.equal(select.selectedOptions[0].textContent, "Workspace B");
  aGate.resolve({ id: "A", name: "Workspace A" });
  assert.equal(await a, false);
  assert.equal(select.selectedOptions[0].textContent, "Workspace B");
  dom.window.close();
});

test("workspace label reset clears text and invalidates an in-flight response", () => {
  const dom = new JSDOM(`<!doctype html><body><select id="ws"><option>old</option></select></body>`);
  const select = dom.window.document.getElementById("ws");
  const label = createWorkspaceLabel(select);
  const stale = label.begin();
  label.reset();
  assert.equal(select.selectedOptions[0].textContent, "Resolving…");
  assert.equal(stale({ id: "stale", name: "stale" }, []), false);
  dom.window.close();
});

test("workspace selector disambiguates same-name workspaces with team and full ID", () => {
  const choices = [
    { id: "/org-a/oas", name: "oas", team: { name: "alpha" } },
    { id: "/org-b/oas", name: "oas", team: { name: "beta" } },
    { id: "/org-c/docs", name: "docs", team: { name: "beta" } },
  ];
  assert.deepEqual(workspaceChoiceLabels(choices), [
    "oas — alpha · /org-a/oas",
    "oas — beta · /org-b/oas",
    "docs",
  ]);
  const dom = new JSDOM(`<!doctype html><body><select id="ws"></select></body>`);
  const select = dom.window.document.getElementById("ws");
  createWorkspaceLabel(select).begin()(choices[1], choices);
  assert.equal(select.options[0].textContent, "oas — alpha · /org-a/oas");
  assert.equal(select.options[1].textContent, "oas — beta · /org-b/oas");
  assert.equal(select.options[0].title, "/org-a/oas");
  assert.equal(select.value, "/org-b/oas");
  dom.window.close();
});

test("workspace selector lists server workspaces and emits selected id", () => {
  const dom = new JSDOM(`<!doctype html><body><select id="ws"></select></body>`);
  const select = dom.window.document.getElementById("ws");
  const label = createWorkspaceLabel(select);
  const commit = label.begin();
  commit(
    { id: "/work/B", name: "Workspace B" },
    [{ id: "/work/A", name: "Workspace A" }, { id: "/work/B", name: "Workspace B" }],
  );
  assert.deepEqual([...select.options].map((option) => [option.value, option.textContent]), [
    ["/work/A", "Workspace A"], ["/work/B", "Workspace B"],
  ]);
  assert.equal(select.value, "/work/B");
  let selected = "";
  const dispose = bindWorkspaceSelect(select, (id) => { selected = id; });
  select.value = "/work/A";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal(selected, "/work/A");
  dispose();
  dom.window.close();
});
