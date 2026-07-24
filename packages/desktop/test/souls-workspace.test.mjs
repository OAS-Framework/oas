import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("Soul roster: switching A→B during a hanging spawn removes A form and agentsRoot", async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body><div id=host></div></body></html>", { url: "http://localhost" });
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;

  const common = await import("../renderer/views/common.mjs");
  const spawn = await import("../renderer/views/spawn.mjs");
  const previousWs = common.currentWorkspace();
  let releaseA;
  const opened = [];
  const requests = [];
  const agent = (name, root) => ({
    name, agentsRoot: root, description: `${name} description`, runtime: "pi",
    work: "workspace", repo: true, repoName: name,
  });
  const ctx = {
    api(pathname, opts = {}) {
      requests.push({ pathname, opts });
      if (opts.method === "POST") return new Promise((ok) => { releaseA = ok; });
      const ws = pathname.includes("ws=wsB") ? "wsB" : "wsA";
      if (pathname.startsWith("/api/agents")) return Promise.resolve({ agents: [agent(`${ws}-soul`, `/${ws}/agents`)] });
      if (pathname.startsWith("/api/panel")) return Promise.resolve({
        instances: [], workspace: { id: ws },
        workspaces: [{ id: "wsA", name: "A" }, { id: "wsB", name: "B" }],
      });
      throw new Error(`unexpected ${pathname}`);
    },
    openTerminal: (name) => opened.push(name),
  };

  try {
    common.setWorkspace("wsA");
    spawn.mount(dom.window.document.getElementById("host"), ctx);
    await tick(); await tick();
    assert.match(dom.window.document.body.textContent, /wsA-soul/);

    dom.window.document.querySelector(".spawn-act").click();
    dom.window.document.querySelector(".fspawn").click();
    await tick();
    assert.ok(releaseA, "workspace A spawn is hanging");
    assert.ok(dom.window.document.querySelector(".soul-form button:disabled"));

    common.setWorkspace("wsB");
    // listener clears A synchronously; B paints after its two GETs resolve
    assert.doesNotMatch(dom.window.document.body.textContent, /wsA-soul/);
    await tick(); await tick();
    assert.match(dom.window.document.body.textContent, /wsB-soul/);
    assert.doesNotMatch(dom.window.document.body.textContent, /wsA-soul/);
    assert.equal(dom.window.document.querySelector(".soul-form"), null, "stale A form removed");

    releaseA({ instance: "inst-A", launched: true });
    await tick(); await tick();
    assert.deepEqual(opened, [], "late A completion never opens a terminal in B");
    assert.match(dom.window.document.body.textContent, /wsB-soul/);
    assert.doesNotMatch(dom.window.document.body.textContent, /inst-A|wsA-soul/);
    const post = requests.find((r) => r.opts.method === "POST");
    assert.match(post.opts.body, /"agentsRoot":"\/wsA\/agents"/,
      "the dispatched request was A; no stale form exists to dispatch it again in B");
  } finally {
    spawn.unmount();
    common.setWorkspace(previousWs);
    dom.window.close();
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  }
});


test("Soul roster: delayed switch refresh cannot erase a newer B spawn form", async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body><div id=host></div></body></html>", { url: "http://localhost" });
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  const oldSetInterval = globalThis.setInterval;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  let poll;
  globalThis.setInterval = (fn) => { poll = fn; return { fake: true }; };

  const common = await import("../renderer/views/common.mjs");
  const spawn = await import("../renderer/views/spawn.mjs");
  const previousWs = common.currentWorkspace();
  const delayedSwitch = [];
  let bGets = 0;
  let releaseBSpawn;
  let spawned = false;         // after the spawn POST resolves, the roster "catches up"
  const opened = [];
  const agent = (name) => ({
    name, agentsRoot: `/${name}/agents`, description: name, runtime: "pi",
    work: "workspace", repo: true, repoName: name,
  });
  const bodyFor = (pathname, ws) => pathname.startsWith("/api/agents")
    ? { agents: [agent(`${ws}-soul`)] }
    : { instances: spawned ? [{ instance: "inst-B" }] : [],
        workspace: { id: ws }, workspaces: [{ id: "wsA", name: "A" }, { id: "wsB", name: "B" }] };
  const ctx = {
    api(pathname, opts = {}) {
      if (opts.method === "POST") return new Promise((ok) => { releaseBSpawn = ok; });
      const ws = pathname.includes("ws=wsB") ? "wsB" : "wsA";
      if (ws === "wsB" && bGets++ < 2) {
        return new Promise((ok) => delayedSwitch.push(() => ok(bodyFor(pathname, ws))));
      }
      return Promise.resolve(bodyFor(pathname, ws));
    },
    openTerminal: (name) => opened.push(name),
  };

  try {
    common.setWorkspace("wsA");
    spawn.mount(dom.window.document.getElementById("host"), ctx);
    await tick(); await tick();
    common.setWorkspace("wsB"); // switch refresh's two GETs now hang
    assert.equal(delayedSwitch.length, 2);

    poll();                    // newer normal B refresh resolves first
    await tick(); await tick();
    assert.match(dom.window.document.body.textContent, /wsB-soul/);
    dom.window.document.querySelector(".spawn-act").click();
    dom.window.document.querySelector(".fspawn").click();
    await tick();
    const ownedForm = dom.window.document.querySelector(".soul-form");
    const ownedButton = ownedForm.querySelector(".fspawn");
    assert.equal(ownedButton.disabled, true, "newer B spawn owns the rendered form");

    delayedSwitch.forEach((release) => release()); // older B refresh lands last
    await tick(); await tick();
    assert.equal(dom.window.document.querySelector(".soul-form"), ownedForm,
      "delayed switch refresh preserves newer B form node");
    assert.equal(ownedButton.disabled, true, "delayed refresh cannot unlock/replace B mutation UI");

    releaseBSpawn({ instance: "inst-B", launched: true });
    spawned = true;            // panel snapshot now includes the new instance
    await tick(); await tick(); await tick();
    assert.deepEqual(opened, ["inst-B"]);
  } finally {
    spawn.unmount();
    common.setWorkspace(previousWs);
    globalThis.setInterval = oldSetInterval;
    dom.window.close();
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  }
});


test("Soul roster: the periodic refresh never wipes an open spawn form's typed task text", async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body><div id=host></div></body></html>", { url: "http://localhost" });
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  const oldSetInterval = globalThis.setInterval;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const polls = [];
  globalThis.setInterval = (fn) => { polls.push(fn); return { fake: true }; };
  const common = await import("../renderer/views/common.mjs");
  const spawn = await import("../renderer/views/spawn.mjs");
  const previousWs = common.currentWorkspace();
  const agent = { name: "dev", agentsRoot: "/a", description: "", runtime: "pi", work: "workspace", repo: true, repoName: "r" };
  const posts = [];
  const ctx = {
    api: (pathname, opts = {}) => {
      if (opts.method === "POST") {
        posts.push(JSON.parse(opts.body));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ instance: "i1", launched: true }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => pathname.startsWith("/api/agents")
        ? { agents: [agent] }
        : { instances: [{ instance: "i1" }], workspace: { id: "w" }, workspaces: [] } });
    },
    openTerminal: () => {},
  };
  try {
    common.setWorkspace("w");
    spawn.mount(dom.window.document.getElementById("host"), ctx);
    await tick(); await tick();
    // user opens the spawn form and types a multiline task (NOT submitted yet)
    dom.window.document.querySelector(".spawn-act").click();
    const taskEl = dom.window.document.querySelector(".ftask");
    taskEl.value = "important multiline\ntask text";
    // the periodic roster poll fires while the user is still typing
    await polls[0]();
    await tick(); await tick();
    assert.equal(dom.window.document.querySelector(".ftask"), taskEl,
      "poll must not rebuild the grid under an open form (a fresh empty form silently drops the task)");
    assert.equal(taskEl.value, "important multiline\ntask text");
    // user submits — the typed task must reach POST /api/spawn intact
    dom.window.document.querySelector(".fspawn").click();
    await tick(); await tick(); await tick();
    assert.equal(posts[0].task, "important multiline\ntask text",
      "the spawned instance must receive the typed task, newlines included");
  } finally {
    spawn.unmount();
    common.setWorkspace(previousWs);
    globalThis.setInterval = oldSetInterval;
    dom.window.close();
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  }
});
