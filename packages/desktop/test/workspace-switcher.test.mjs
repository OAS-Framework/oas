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
    addWorkspace: async (path) => ({ ok: true, workspace: { id: path, path, name: "workspace" } }),
    pickWorkspace: async () => ({ ok: false, code: "cancelled", reason: "cancelled" }),
    ...overrides,
  });
  return { dom, document: dom.window.document, selected, controller };
};

const A = { id: "/org-a/oas", path: "/org-a/oas", name: "oas", team: { name: "alpha" } };
const B = { id: "/org-b/oas", path: "/org-b/oas", name: "oas", team: { name: "beta" } };

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
  assert.equal(document.getElementById("ws-name").textContent, "oas — beta · /org-b/oas");
  document.getElementById("ws-trigger").click();
  assert.equal(document.getElementById("ws-trigger").getAttribute("aria-expanded"), "true");
  const options = [...document.querySelectorAll(".ws-option")];
  assert.deepEqual(options.map((option) => option.querySelector(".ws-option-name").textContent), [
    "oas — alpha · /org-a/oas", "oas — beta · /org-b/oas",
  ]);
  assert.equal(options[1].getAttribute("aria-selected"), "true");
  options[0].focus();
  controller.begin()(B, [A, B]);
  assert.equal(document.activeElement.dataset.workspaceId, "/org-a/oas",
    "roster refresh preserves the focused workspace option identity");
  document.activeElement.click();
  assert.deepEqual(selected, ["/org-a/oas"]);
  assert.equal(document.getElementById("ws-menu").hidden, true);
  assert.equal(document.activeElement, document.getElementById("ws-trigger"));

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
    addWorkspace: async (path) => { calls.push(path); return { ok: true, workspace: C }; },
  });
  controller.begin()(B, [B]);
  document.getElementById("ws-trigger").click();
  document.getElementById("ws-add-open").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const modal = document.getElementById("ws-modal");
  assert.equal(modal.hidden, false);
  assert.equal(document.activeElement, document.getElementById("ws-suggestion-search"));
  assert.deepEqual([...document.querySelectorAll(".ws-suggestion-title")].map((node) => node.textContent), ["oas", "tools"]);
  let choices = [...document.querySelectorAll(".ws-suggestion")];
  assert.deepEqual(choices.map((choice) => choice.tabIndex), [0, -1]);
  choices[0].focus();
  choices[0].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  choices = [...document.querySelectorAll(".ws-suggestion")];
  assert.equal(document.activeElement.dataset.workspaceId, "/org-c/tools");
  assert.equal(choices[1].getAttribute("aria-checked"), "true");
  assert.deepEqual(choices.map((choice) => choice.tabIndex), [-1, 0]);
  assert.equal(document.getElementById("ws-confirm").disabled, false);
  document.getElementById("ws-confirm").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["/org-c/tools"]);
  assert.deepEqual(selected, ["/org-c/tools"]);
  assert.equal(modal.hidden, true);
  assert.equal(document.activeElement, document.getElementById("ws-trigger"));
  dom.window.close();
});

test("picker success uses its completed add result and picker cancellation is silent", async () => {
  const C = { id: "/org-c/tools", path: "/org-c/tools", name: "tools", team: { name: "gamma" } };
  let pickResult = { ok: false, code: "cancelled", reason: "not rendered" };
  const { dom, document, selected, controller } = setup({
    discoverSuggestions: async () => ({ stale: false, suggestions: [A] }),
    pickWorkspace: async () => pickResult,
  });
  controller.begin()(B, [B]);
  await controller.openModal();
  const before = document.getElementById("ws-dialog-status").textContent;
  document.getElementById("ws-browse").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.getElementById("ws-modal").hidden, false);
  assert.equal(document.getElementById("ws-dialog-status").textContent, before);
  assert.deepEqual(selected, []);

  pickResult = { ok: true, workspace: C };
  document.getElementById("ws-browse").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.getElementById("ws-modal").hidden, true);
  assert.deepEqual(selected, ["/org-c/tools"]);
  dom.window.close();
});

test("picker cancellation does not orphan an in-flight discovery loading state", async () => {
  const discovery = deferred();
  const { dom, document, controller } = setup({
    discoverSuggestions: () => discovery.promise,
    pickWorkspace: async () => ({ ok: false, code: "cancelled", reason: "not rendered" }),
  });
  controller.begin()(B, [B]);
  const opening = controller.openModal();
  document.getElementById("ws-browse").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.querySelector(".ws-dialog").getAttribute("aria-busy"), "false");
  assert.equal(document.getElementById("ws-dialog-status").textContent, "Finding OAS workspaces…",
    "loading remains truthful while the still-owned discovery is pending");
  discovery.resolve({ stale: false, suggestions: [A] });
  await opening;
  assert.equal(document.getElementById("ws-dialog-status").textContent, "1 suggested workspace");
  assert.equal(document.querySelector(".ws-suggestion").dataset.workspaceId, "/org-a/oas");
  dom.window.close();
});

test("same-generation stale discovery settles to a neutral idle state", async () => {
  const { dom, document, controller } = setup({
    discoverSuggestions: async () => ({ stale: true, suggestions: [] }),
  });
  controller.begin()(B, [B]);
  await controller.openModal();
  assert.equal(document.getElementById("ws-dialog-status").textContent, "No current workspace suggestions.");
  assert.equal(document.getElementById("ws-dialog-status").classList.contains("error"), false);
  assert.equal(document.querySelector(".ws-dialog").getAttribute("aria-busy"), "false");
  dom.window.close();
});

test("resolved add domain failure renders prose and never switches", async () => {
  const { dom, document, selected, controller } = setup({
    discoverSuggestions: async () => ({ stale: false, suggestions: [A] }),
    addWorkspace: async () => ({ ok: false, code: "foreign-server", reason: "This server is managed outside the app." }),
  });
  controller.begin()(B, [B]);
  await controller.openModal();
  document.querySelector(".ws-suggestion").click();
  document.getElementById("ws-confirm").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.getElementById("ws-modal").hidden, false);
  assert.equal(document.querySelector(".ws-dialog").getAttribute("aria-busy"), "false");
  assert.equal(document.getElementById("ws-dialog-status").textContent, "This server is managed outside the app.");
  assert.deepEqual(selected, []);
  dom.window.close();
});

test("not-suggested failure explicitly points to the picker", async () => {
  const { dom, document, controller } = setup({
    discoverSuggestions: async () => ({ stale: false, suggestions: [A] }),
    addWorkspace: async () => ({ ok: false, code: "not-suggested", reason: "This suggestion expired." }),
  });
  controller.begin()(B, [B]);
  await controller.openModal();
  document.querySelector(".ws-suggestion").click();
  document.getElementById("ws-confirm").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.getElementById("ws-dialog-status").textContent,
    "This suggestion expired. Use Browse… to choose it explicitly.");
  assert.equal(document.getElementById("ws-modal").hidden, false);
  dom.window.close();
});

test("pending add is single-flight, cannot be dismissed, and always reconciles", async () => {
  const addGate = deferred();
  const C = { id: "/org-c/tools", path: "/org-c/tools", name: "tools" };
  const mutationCalls = [];
  const { dom, document, selected, controller } = setup({
    discoverSuggestions: async () => ({ stale: false, suggestions: [A, C] }),
    addWorkspace: (path) => { mutationCalls.push(path); return addGate.promise; },
  });
  controller.begin()(B, [B]);
  await controller.openModal();
  document.querySelector(".ws-suggestion").click();
  document.getElementById("ws-confirm").click();
  const modal = document.getElementById("ws-modal");
  const dialog = document.querySelector(".ws-dialog");
  assert.equal(dialog.getAttribute("aria-busy"), "true");
  assert.equal(document.getElementById("ws-cancel").disabled, true);
  assert.equal(document.getElementById("ws-dialog-close").disabled, true);
  assert.equal(document.getElementById("ws-suggestion-search").disabled, true);
  const suggestionButtons = [...document.querySelectorAll(".ws-suggestion")];
  assert.deepEqual(suggestionButtons.map((button) => button.disabled), [true, true]);
  suggestionButtons[1].click();
  suggestionButtons[0].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  document.getElementById("ws-confirm").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(mutationCalls, ["/org-a/oas"], "busy UI and handler guard enforce one mutation");
  assert.equal(document.querySelector('.ws-suggestion[aria-checked="true"]').dataset.workspaceId, "/org-a/oas");
  dialog.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  modal.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
  assert.equal(modal.hidden, false, "Escape and backdrop cannot abandon an in-flight mutation");
  addGate.resolve({ ok: true, workspace: A });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(modal.hidden, true);
  assert.deepEqual(selected, ["/org-a/oas"]);
  assert.equal(document.getElementById("ws-trigger").title, "Active workspace: /org-a/oas");
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
