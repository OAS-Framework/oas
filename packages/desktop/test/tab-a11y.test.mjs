import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createTabChrome, tabKeyAction } from "../renderer/tab-a11y.mjs";

test("tab chrome uses related semantic tab, panel, and focusable close controls", () => {
  const dom = new JSDOM("<!doctype html><body>");
  const { tabEl, triggerEl, closeEl, paneEl } = createTabChrome(dom.window.document, 7, "Agent terminal", true);
  assert.equal(tabEl.getAttribute("role"), "presentation");
  assert.equal(triggerEl.tagName, "BUTTON");
  assert.equal(triggerEl.getAttribute("role"), "tab");
  assert.equal(triggerEl.getAttribute("aria-selected"), "false");
  assert.equal(triggerEl.tabIndex, -1);
  assert.equal(triggerEl.getAttribute("aria-controls"), paneEl.id);
  assert.equal(paneEl.getAttribute("role"), "tabpanel");
  assert.equal(paneEl.getAttribute("aria-labelledby"), triggerEl.id);
  assert.equal(paneEl.hidden, true);
  assert.equal(closeEl.tagName, "BUTTON");
  assert.equal(closeEl.getAttribute("aria-label"), "Close Agent terminal");
  assert.match(closeEl.title, /Delete.*⌘\+W/);
  dom.window.close();
});

test("tab keyboard policy wraps arrows, supports Home/End, and closes", () => {
  const action = (key, index = 1, mods = {}) => tabKeyAction({ key, ...mods }, index, 3);
  assert.deepEqual(action("ArrowRight", 2), { type: "move", index: 0 });
  assert.deepEqual(action("ArrowLeft", 0), { type: "move", index: 2 });
  assert.deepEqual(action("Home"), { type: "move", index: 0 });
  assert.deepEqual(action("End"), { type: "move", index: 2 });
  assert.deepEqual(action("Delete"), { type: "close" });
  assert.deepEqual(action("w", 1, { metaKey: true }), { type: "close" });
  assert.deepEqual(action("w", 1, { ctrlKey: true }), { type: "close" });
  assert.equal(action("Enter"), null, "native button activation handles Enter/Space");
});
