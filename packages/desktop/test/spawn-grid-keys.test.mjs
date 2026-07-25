// Spawn view grid keyboard — DOM-level regressions (review 93ff03d: the
// default "/" must focus the filter FROM A FOCUSED CARD, the primary
// non-editable surface, not only from grid whitespace).
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const tick = () => new Promise((r) => setTimeout(r, 0));

const cliStatusMod = await import("../renderer/views/cli-status.mjs");
const CLI_OK = { ok: true, bin: "/seed/oas", version: "0.18.0", source: "path", required: { desktopApi: 1, range: ">=0.18.0 <0.19.0" }, probedAt: 1, tried: [] };
async function seedCliAvailable() {
  await cliStatusMod.refreshCli({
    api: async () => ({ ok: true, status: 200, json: async () => CLI_OK }),
  });
}

async function mountSpawn(dom) {
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const spawn = await import("../renderer/views/spawn.mjs");
  await seedCliAvailable();
  const agent = (name) => ({
    name, agentsRoot: "/w/agents", description: `${name} soul`, runtime: "pi",
    work: "worktree", repo: true, repoName: "repo",
  });
  const opened = [];
  const ctx = {
    api(pathname) {
      if (pathname === "/api/cli" || pathname === "/api/cli/reprobe") return Promise.resolve(CLI_OK);
      if (pathname.startsWith("/api/agents")) return Promise.resolve({ agents: [agent("alpha"), agent("beta")] });
      if (pathname.startsWith("/api/panel")) return Promise.resolve({ instances: [], workspace: { id: "w" }, workspaces: [] });
      throw new Error(`unexpected ${pathname}`);
    },
    openTerminal: () => {},
    openBrain: (name) => opened.push(name),
  };
  spawn.mount(dom.window.document.getElementById("host"), ctx);
  await tick(); await tick();
  return { spawn, opened };
}

const key = (doc, target, key, opts = {}) => {
  const e = new doc.defaultView.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts });
  target.dispatchEvent(e);
  return e;
};

test("spawn grid: '/' focuses the filter and 'b' opens brain from a FOCUSED CARD", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id=host></div></body></html>', { url: "http://localhost" });
  const oldDoc = globalThis.document, oldWin = globalThis.window;
  try {
    const { spawn, opened } = await mountSpawn(dom);
    const doc = dom.window.document;
    const cards = [...doc.querySelectorAll(".soul-card")];
    assert.ok(cards.length >= 2, `cards rendered (got ${cards.length})`);
    cards[0].focus();
    assert.equal(doc.activeElement, cards[0], "card is the roving focus target");

    // review 93ff03d: '/' from the focused card must reach spawn.filter
    const slash = key(doc, cards[0], "/");
    assert.equal(slash.defaultPrevented, true, "'/' consumed as a shortcut");
    assert.equal(doc.activeElement, doc.querySelector(".filter"), "filter focused from a focused card");

    cards[1].focus();
    key(doc, cards[1], "b");
    assert.deepEqual(opened, ["beta"], "'b' opens the focused card's brain");
    spawn.unmount();
  } finally {
    globalThis.document = oldDoc; globalThis.window = oldWin;
  }
  dom.window.close();
});

test("spawn grid: typing '/' or 'b' inside the filter input stays text entry", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id=host></div></body></html>', { url: "http://localhost" });
  const oldDoc = globalThis.document, oldWin = globalThis.window;
  try {
    const { spawn, opened } = await mountSpawn(dom);
    const doc = dom.window.document;
    const filter = doc.querySelector(".filter");
    filter.focus();
    const slash = key(doc, filter, "/");
    assert.equal(slash.defaultPrevented, false, "'/' types into the filter");
    const b = key(doc, filter, "b");
    assert.equal(b.defaultPrevented, false, "'b' types into the filter");
    assert.deepEqual(opened, [], "no brain opened from an editable field");
    spawn.unmount();
  } finally {
    globalThis.document = oldDoc; globalThis.window = oldWin;
  }
  dom.window.close();
});

test("surface guard: window-level dispatch of spawn actions is inert outside the view (review 0e63834)", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id=host></div><button id=rail>rail button</button></body></html>', { url: "http://localhost" });
  const oldDoc = globalThis.document, oldWin = globalThis.window;
  try {
    const { spawn, opened } = await mountSpawn(dom);
    const doc = dom.window.document;
    const kb = await import("../renderer/keybindings.mjs");
    kb.setActiveContexts(new Set(["stage:spawn"]));
    const cards = [...doc.querySelectorAll(".soul-card")];
    // engine window dispatch from INSIDE the view (focused card): runs once
    cards[0].focus();
    const inside = { key: "b", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: cards[0], preventDefault() {} };
    // simulate the window listener path directly (grid handler not involved: no bubbling here)
    assert.equal(kb.handleKeydown(inside, { isMac: false }), true, "engine matches spawn.brain in context");
    assert.deepEqual(opened, ["alpha"], "guarded run executes for an in-view target");
    // engine window dispatch from OUTSIDE the view (rail button): matches but must be inert
    const rail = doc.getElementById("rail");
    const outside = { key: "b", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: rail, preventDefault() {} };
    kb.handleKeydown(outside, { isMac: false });
    assert.deepEqual(opened, ["alpha"], "no brain opened from a rail/sidebar target (surface guard)");
    kb.setActiveContexts(new Set());
    spawn.unmount();
  } finally {
    globalThis.document = oldDoc; globalThis.window = oldWin;
  }
  dom.window.close();
});
