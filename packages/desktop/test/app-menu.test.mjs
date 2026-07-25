// Application menu policy regression (review befe75b important 1): role
// menus on Linux/Windows register Ctrl accelerators (Ctrl+C/A/Z/R/W …) that
// fire before web content and steal xterm's terminal control chords — the
// menu must exist ONLY on macOS, where its Cmd accelerators cannot collide
// with Ctrl-based terminal keys and are required for clipboard shortcuts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appMenuTemplate } from "../app-menu.mjs";

test("app menu: macOS gets the full role menu including editMenu", () => {
  const t = appMenuTemplate("darwin");
  assert.ok(Array.isArray(t), "darwin gets a template");
  const roles = t.map((i) => i.role);
  assert.ok(roles.includes("editMenu"), "editMenu present (Cmd+C/V/X/A live)");
  assert.ok(roles.includes("appMenu"), "standard macOS app menu present");
  // role-only entries: no custom accelerators or click handlers to audit
  for (const item of t) {
    assert.deepEqual(Object.keys(item), ["role"], `role-only menu item (got ${JSON.stringify(item)})`);
  }
});

test("app menu: Linux and Windows get NO menu — terminal Ctrl chords stay with xterm", () => {
  assert.equal(appMenuTemplate("linux"), null);
  assert.equal(appMenuTemplate("win32"), null);
  assert.equal(appMenuTemplate("freebsd"), null);
});
