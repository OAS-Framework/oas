import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createWorkspaceLabel } from "../renderer/workspace-label.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((ok) => { resolve = ok; });
  return { promise, resolve };
};

test("workspace label: A→B with deferred A completing last keeps B", async () => {
  const dom = new JSDOM(`<!doctype html><body><span id="ws"></span></body>`);
  const label = createWorkspaceLabel(dom.window.document.getElementById("ws"));
  const aGate = deferred(), bGate = deferred();
  const commitA = label.begin();
  const a = aGate.promise.then(commitA);
  const commitB = label.begin();
  const b = bGate.promise.then(commitB);

  bGate.resolve({ id: "B", name: "Workspace B" });
  assert.equal(await b, true);
  assert.equal(dom.window.document.getElementById("ws").textContent, "· Workspace B");
  aGate.resolve({ id: "A", name: "Workspace A" });
  assert.equal(await a, false);
  assert.equal(dom.window.document.getElementById("ws").textContent, "· Workspace B");
  dom.window.close();
});

test("workspace label reset clears text and invalidates an in-flight response", () => {
  const dom = new JSDOM(`<!doctype html><body><span id="ws">old</span></body>`);
  const label = createWorkspaceLabel(dom.window.document.getElementById("ws"));
  const stale = label.begin();
  label.reset();
  assert.equal(dom.window.document.getElementById("ws").textContent, "");
  assert.equal(stale({ name: "stale" }), false);
  dom.window.close();
});
