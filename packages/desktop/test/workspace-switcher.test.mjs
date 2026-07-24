import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { workspaceChoiceLabels, createWorkspaceSwitcher } from "../renderer/workspace-switcher.mjs";

const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
const deferred = () => {
  let resolve;
  const promise = new Promise((ok) => { resolve = ok; });
  return { promise, resolve };
};
const setup = (overrides = {}) => {
  const dom = new JSDOM(html, { url: "file:///renderer/index.html" });
  const selected = [];
  const controller = createWorkspaceSwitcher({
    document: dom.window.document,
    selectWorkspace: (id) => selected.push(id),
    discoverSuggestions: async () => [],
    addWorkspace: async (candidate) => ({ workspace: candidate }),
    pickWorkspace: async () => null,
    ...overrides,
  });
  return { dom, document: dom.window.document, selected, controller };
};

const A = { id: "/org-a/oas", name: "oas", team: { name: "alpha" } };
const B = { id: "/org-b/oas", name: "oas", team: { name: "beta" } };

test("workspace choice labels disambiguate duplicate names with team and canonical ID", () => {
  assert.deepEqual(workspaceChoiceLabels([A, B, { id: "/docs", name: "docs" }]), [
    "oas — alpha · /org-a/oas", "oas — beta · /org-b/oas", "docs",
  ]);
});

test("workspace switcher: deferred A completing after B cannot overwrite B", async () => {
  const { dom, document, controller } = setup();
  const aGate = deferred(), bGate = deferred();
  const commitA = controller.begin();
  const a = aGate.promise.then((workspace) => commitA(workspace, [workspace]));
  const commitB = controller.begin();
  const b = bGate.promise.then((workspace) => commitB(workspace, [workspace]));
  bGate.resolve(B);
  assert.equal(await b, true);
  assert.equal(document.getElementById("ws-name").textContent, "oas");
  assert.equal(document.getElementById("ws-trigger").title, "Active workspace: /org-b/oas");
  aGate.resolve(A);
  assert.equal(await a, false);
  assert.equal(document.getElementById("ws-trigger").title, "Active workspace: /org-b/oas");
  dom.window.close();
});

test("workspace menu is searchable, disambiguated, keyboard closable, and switches explicitly", () => {
  const { dom, document, selected, controller } = setup();
  controller.begin()(B, [A, B]);
  document.getElementById("ws-trigger").click();
  assert.equal(document.getElementById("ws-trigger").getAttribute("aria-expanded"), "true");
  const options = [...document.querySelectorAll(".ws-option")];
  assert.deepEqual(options.map((option) => option.querySelector(".ws-option-name").textContent), [
    "oas — alpha · /org-a/oas", "oas — beta · /org-b/oas",
  ]);
  assert.equal(options[1].getAttribute("aria-selected"), "true");
  options[0].click();
  assert.deepEqual(selected, ["/org-a/oas"]);
  assert.equal(document.getElementById("ws-menu").hidden, true);

  document.getElementById("ws-trigger").click();
  const search = document.getElementById("ws-menu-search");
  search.value = "beta";
  search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(document.querySelectorAll(".ws-option").length, 1);
  search.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(document.activeElement, document.getElementById("ws-trigger"));
  dom.window.close();
});

test("add workspace modal discovers, filters, selects and confirms a suggestion", async () => {
  const calls = [];
  const C = { id: "/org-c/tools", path: "/org-c/tools", name: "tools", team: { name: "gamma" }, reason: "Team-scope sibling" };
  const { dom, document, selected, controller } = setup({
    discoverSuggestions: async () => ({ suggestions: [A, C] }),
    addWorkspace: async (candidate) => { calls.push(candidate.id); return { workspace: candidate, workspaces: [B, candidate] }; },
  });
  controller.begin()(B, [B]);
  document.getElementById("ws-trigger").click();
  document.getElementById("ws-add-open").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const modal = document.getElementById("ws-modal");
  assert.equal(modal.hidden, false);
  assert.equal(document.activeElement, document.getElementById("ws-suggestion-search"));
  assert.deepEqual([...document.querySelectorAll(".ws-suggestion-title")].map((node) => node.textContent), ["oas", "tools"]);
  const choices = [...document.querySelectorAll(".ws-suggestion")];
  choices[1].click();
  assert.equal(document.getElementById("ws-confirm").disabled, false);
  document.getElementById("ws-confirm").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["/org-c/tools"]);
  assert.deepEqual(selected, ["/org-c/tools"]);
  assert.equal(modal.hidden, true);
  assert.equal(document.activeElement, document.getElementById("ws-trigger"));
  dom.window.close();
});

test("stale suggestion discovery cannot repaint a reopened modal", async () => {
  const first = deferred(), second = deferred();
  let request = 0;
  const { dom, document, controller } = setup({
    discoverSuggestions: () => (++request === 1 ? first.promise : second.promise),
  });
  controller.begin()(B, [B]);
  const one = controller.openModal();
  document.querySelector(".ws-dialog").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const two = controller.openModal();
  second.resolve({ suggestions: [{ id: "/new", name: "new" }] });
  await two;
  assert.equal(document.querySelector(".ws-suggestion-title").textContent, "new");
  first.resolve({ suggestions: [{ id: "/stale", name: "stale" }] });
  await one;
  assert.equal(document.querySelector(".ws-suggestion-title").textContent, "new");
  dom.window.close();
});
