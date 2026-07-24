// Multi-mount regression (review de387d1): the shell opens several markdown
// tabs and several per-instance diff tabs at once — mounting a second tab
// must not empty the first, and disposing one must not blank the other.
// mount() returns a per-mount disposer the view host prefers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const md = await import("../renderer/views/markdown.mjs");
const dv = await import("../renderer/views/diff.mjs");

function dom() {
  const d = new JSDOM("<!doctype html><html><body></body></html>");
  return d.window.document;
}
const fileApi = (content) => async () => ({ path: "/x/a.md", name: "a.md", size: 1, markdown: true, content });
const diffApi = (branch) => async () => ({ repo: "/r", branch, files: [], diff: "" });

test("markdown: two mounts coexist; disposing one keeps the other", async () => {
  const doc = dom();
  const el1 = doc.createElement("div"); doc.body.append(el1);
  const el2 = doc.createElement("div"); doc.body.append(el2);
  const d1 = await md.mount(el1, { api: fileApi("# one"), openFile: () => {}, path: "/x/a.md" });
  const d2 = await md.mount(el2, { api: fileApi("# two"), openFile: () => {}, path: "/x/b.md" });
  assert.equal(typeof d1, "function", "mount must return a disposer");
  assert.ok(el1.textContent.includes("one"), "first tab intact after second mount");
  assert.ok(el2.textContent.includes("two"));
  d1();
  assert.ok(!el1.querySelector(".mdv"), "disposed tab cleared");
  assert.ok(el2.textContent.includes("two"), "other tab untouched by dispose");
  d2();
});

test("markdown heading links and code-copy controls remain keyboard focusable", async () => {
  const doc = dom();
  const el = doc.createElement("div"); doc.body.append(el);
  const dispose = await md.mount(el, {
    api: fileApi("# Keyboard heading\n\n```js\nconst answer = 42;\n```"),
    openFile: () => {}, path: "/x/keyboard.md",
  });
  const anchor = el.querySelector(".hanchor");
  const copy = el.querySelector(".md-copy");
  assert.ok(anchor && copy);
  assert.equal(anchor.tabIndex, 0, "heading permalink participates in native tab order");
  assert.equal(copy.tabIndex, 0, "copy button participates in native tab order");
  assert.notEqual(doc.defaultView.getComputedStyle(anchor).visibility, "hidden");
  assert.notEqual(doc.defaultView.getComputedStyle(copy).visibility, "hidden");
  assert.ok(parseFloat(doc.defaultView.getComputedStyle(copy.closest("pre")).paddingTop) >= 36,
    "code block reserves a non-overlapping toolbar row for its visible copy button");
  anchor.focus();
  assert.equal(doc.activeElement, anchor);
  copy.focus();
  assert.equal(doc.activeElement, copy);
  dispose();
});

test("diff: two mounts coexist; disposing one keeps the other", async () => {
  const doc = dom();
  const el1 = doc.createElement("div"); doc.body.append(el1);
  const el2 = doc.createElement("div"); doc.body.append(el2);
  const d1 = await dv.mount(el1, { api: diffApi("branch-a"), instance: "a" });
  const d2 = await dv.mount(el2, { api: diffApi("branch-b"), instance: "b" });
  assert.equal(typeof d1, "function", "mount must return a disposer");
  assert.ok(el1.textContent.includes("branch-a"), "first tab intact after second mount");
  assert.ok(el2.textContent.includes("branch-b"));
  d2();
  assert.ok(el1.textContent.includes("branch-a"), "other tab untouched by dispose");
  d1();
});

test("diff: ctx.ws is forwarded to /api/diff", async () => {
  const doc = dom();
  const el = doc.createElement("div"); doc.body.append(el);
  let seen = "";
  const api = async (p) => { seen = p; return { repo: "/r", branch: "b", files: [], diff: "" }; };
  const d = await dv.mount(el, { api, instance: "a", ws: "/Users/me/oas" });
  assert.ok(seen.includes("ws=%2FUsers%2Fme%2Foas"), `ws missing in ${seen}`);
  d();
});

test("module-level unmount() still disposes everything (harness compat)", async () => {
  const doc = dom();
  const el1 = doc.createElement("div"); doc.body.append(el1);
  const el2 = doc.createElement("div"); doc.body.append(el2);
  await md.mount(el1, { api: fileApi("# a"), openFile: () => {}, path: "/x/a.md" });
  await md.mount(el2, { api: fileApi("# b"), openFile: () => {}, path: "/x/b.md" });
  md.unmount();
  assert.ok(!el1.querySelector(".mdv") && !el2.querySelector(".mdv"));
});
