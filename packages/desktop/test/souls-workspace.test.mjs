import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const tick = () => new Promise((r) => setTimeout(r, 0));

// These suites exercise the spawn-form races; mutations require a VERIFIED
// compatible CLI (frozen contract), so seed the shared CLI state as
// available before each mount — the CLI dimension has its own suite
// (cli-degradation.test.mjs).
const cliStatusMod = await import("../renderer/views/cli-status.mjs");
const CLI_OK = { ok: true, bin: "/seed/oas", version: "0.18.0", source: "path", required: { desktopApi: 1, range: ">=0.18.0 <0.19.0" }, probedAt: 1, tried: [] };
async function seedCliAvailable() {
  await cliStatusMod.refreshCli({
    api: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, bin: "/seed/oas", version: "0.18.0", source: "path", required: { desktopApi: 1, range: ">=0.18.0 <0.19.0" }, probedAt: 1, tried: [] }) }),
  });
}

test("Soul roster: switching A→B during a hanging spawn removes A form and agentsRoot", async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body><div id=host></div></body></html>", { url: "http://localhost" });
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;

  const common = await import("../renderer/views/common.mjs");
  const spawn = await import("../renderer/views/spawn.mjs");
  await seedCliAvailable();
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
      if (pathname === "/api/cli" || pathname === "/api/cli/reprobe") return Promise.resolve(CLI_OK);
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
  await seedCliAvailable();
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
      if (pathname === "/api/cli" || pathname === "/api/cli/reprobe") return Promise.resolve(CLI_OK);
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
  await seedCliAvailable();
  const previousWs = common.currentWorkspace();
  const agent = { name: "dev", agentsRoot: "/a", description: "", runtime: "pi", work: "workspace", repo: true, repoName: "r" };
  const posts = [];
  const ctx = {
    api: (pathname, opts = {}) => {
      if (pathname === "/api/cli" || pathname === "/api/cli/reprobe") return Promise.resolve(CLI_OK);
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


test("Soul roster: selector-metacharacter agent names spawn cleanly and still block poll repaints", async () => {
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
  await seedCliAvailable();
  const previousWs = common.currentWorkspace();
  const evil = 'bad"name]:\'x';                 // querySelector metacharacters
  const agent = { name: evil, agentsRoot: "/a", description: "", runtime: "pi", work: "workspace", repo: true, repoName: "r" };
  const posts = [];
  const ctx = {
    api: (pathname, opts = {}) => {
      if (pathname === "/api/cli" || pathname === "/api/cli/reprobe") return Promise.resolve(CLI_OK);
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
    // opening the form must not throw an invalid-selector error
    dom.window.document.querySelector(".spawn-act").click();
    const taskEl = dom.window.document.querySelector(".ftask");
    assert.ok(taskEl, "form opens for a metacharacter-named agent");
    taskEl.value = "task for evil-named soul";
    // poll under the open form: guard must still hold without a dynamic selector
    await polls[0]();
    await tick(); await tick();
    assert.equal(dom.window.document.querySelector(".ftask"), taskEl, "poll repaint blocked for metacharacter names too");
    dom.window.document.querySelector(".fspawn").click();
    await tick(); await tick(); await tick();
    assert.equal(posts[0].task, "task for evil-named soul");
    assert.equal(posts[0].agent, evil);
  } finally {
    spawn.unmount();
    common.setWorkspace(previousWs);
    globalThis.setInterval = oldSetInterval;
    dom.window.close();
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  }
});

test("Soul roster: relation + reference instance pass through POST /api/spawn; unrelated sends neither", async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body><div id=host></div></body></html>", { url: "http://localhost" });
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  const oldSetInterval = globalThis.setInterval;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.setInterval = () => ({ fake: true });
  const common = await import("../renderer/views/common.mjs");
  const spawn = await import("../renderer/views/spawn.mjs");
  await seedCliAvailable();
  const previousWs = common.currentWorkspace();
  const agent = { name: "dev", agentsRoot: "/a", description: "", runtime: "pi", work: "workspace", repo: true, repoName: "r" };
  const posts = [];
  const ctx = {
    api: (pathname, opts = {}) => {
      if (pathname === "/api/cli" || pathname === "/api/cli/reprobe") return Promise.resolve(CLI_OK);
      if (opts.method === "POST") {
        posts.push(JSON.parse(opts.body));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ instance: "dev-1", launched: false }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => pathname.startsWith("/api/agents")
        ? { agents: [agent] }
        : { instances: [{ instance: "coord-1", running: true }, { instance: "dev-1" }], workspace: { id: "w" }, workspaces: [] } });
    },
    openTerminal: () => {},
  };
  try {
    common.setWorkspace("w");
    spawn.mount(dom.window.document.getElementById("host"), ctx);
    await tick(); await tick();
    dom.window.document.querySelector(".spawn-act").click();
    const doc = dom.window.document;
    // spawn opens a MODAL dialog (human change request): a11y contract
    const dialog = doc.querySelector(".spawn-dialog");
    assert.ok(dialog, "spawn opens a modal dialog");
    assert.equal(dialog.getAttribute("role"), "dialog");
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.ok(dialog.getAttribute("aria-labelledby"), "dialog is labelled");
    // relation options DIRECTLY VISIBLE; picker disabled until a relation is chosen
    const relSel = doc.querySelector(".frelation");
    assert.equal(relSel.value, "unrelated", "relation defaults to unrelated");
    assert.equal(relSel.disabled, false, "relation select enabled on a relation-capable CLI");
    const refSel = doc.querySelector(".frelto");
    assert.ok(refSel, "reference picker is visible in the modal");
    assert.equal(refSel.disabled, true, "reference picker disabled while unrelated");
    assert.ok([...refSel.options].some((o) => o.value === "coord-1"), "reference picker lists roster instances");

    // 1) unrelated spawn: no relation fields on the wire
    doc.querySelector(".fspawn").click();
    await tick(); await tick(); await tick();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].relation, undefined, "unrelated sends no relation");
    assert.equal(posts[0].relativeTo, undefined, "unrelated sends no relativeTo");

    // 2) choosing a relation ENABLES the picker; missing reference fails BEFORE dispatch
    if (!doc.querySelector(".spawn-dialog")) doc.querySelector(".spawn-act").click(); // reopen if closed
    const form = doc.querySelector(".spawn-dialog");
    const rel2 = form.querySelector(".frelation");
    rel2.value = "child";
    rel2.dispatchEvent(new dom.window.Event("change"));
    assert.equal(form.querySelector(".frelto").disabled, false, "picker enables for a real relation");
    form.querySelector(".fspawn").click();
    await tick();
    assert.equal(posts.length, 1, "relation without a reference never dispatches");
    assert.match(form.querySelector(".fstatus").textContent, /needs a reference instance/);

    // 3) full pair passes through
    form.querySelector(".frelto").value = "coord-1";
    form.querySelector(".fspawn").click();
    await tick(); await tick(); await tick();
    assert.equal(posts.length, 2);
    assert.equal(posts[1].relation, "child");
    assert.equal(posts[1].relativeTo, "coord-1");

    // 4) modal close paths: Escape closes and clears the selection
    if (!doc.querySelector(".spawn-dialog")) doc.querySelector(".spawn-act").click();
    const dlg2 = doc.querySelector(".spawn-dialog");
    dlg2.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(doc.querySelector(".spawn-dialog"), null, "Escape closes the spawn modal");
    // Cancel button closes too
    doc.querySelector(".spawn-act").click();
    doc.querySelector(".spawn-dialog .fcancel").click();
    assert.equal(doc.querySelector(".spawn-dialog"), null, "Cancel closes the spawn modal");
  } finally {
    spawn.unmount();
    common.setWorkspace(previousWs);
    globalThis.setInterval = oldSetInterval;
    dom.window.close();
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  }
});

test("Spawn modal: every option always visible; runtime/model pass through; defaults omitted", async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body><div id=host></div></body></html>", { url: "http://localhost" });
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  const oldSetInterval = globalThis.setInterval;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.setInterval = () => ({ fake: true });
  const common = await import("../renderer/views/common.mjs");
  const spawn = await import("../renderer/views/spawn.mjs");
  await seedCliAvailable();
  const previousWs = common.currentWorkspace();
  const agent = { name: "dev", agentsRoot: "/a", description: "d", runtime: "pi", model: "opus", work: "worktree", repo: true, repoName: "r" };
  const posts = [];
  const ctx = {
    api: (pathname, opts = {}) => {
      if (pathname === "/api/cli" || pathname === "/api/cli/reprobe") return Promise.resolve(CLI_OK);
      if (opts.method === "POST") {
        posts.push(JSON.parse(opts.body));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ instance: "dev-1", launched: false }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => pathname.startsWith("/api/agents")
        ? { agents: [agent] }
        : { instances: [{ instance: "dev-1" }], workspace: { id: "w" }, workspaces: [] } });
    },
    openTerminal: () => {},
  };
  try {
    common.setWorkspace("w");
    spawn.mount(dom.window.document.getElementById("host"), ctx);
    await tick(); await tick();
    const doc = dom.window.document;
    doc.querySelector(".spawn-act").click();
    // the human requirement: ALL options visible in the modal, none hidden
    for (const cls of ["fpurpose", "ftask", "frelation", "frelto", "fruntime", "fmodel"]) {
      const el = doc.querySelector(`.spawn-dialog .${cls}`);
      assert.ok(el, `${cls} control present in the modal`);
    }
    // defaults: empty runtime/model are OMITTED from the wire (agent default)
    doc.querySelector(".fspawn").click();
    await tick(); await tick(); await tick();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].runtime, undefined, "default runtime not sent");
    assert.equal(posts[0].model, undefined, "default model not sent");
    // explicit overrides pass through
    if (!doc.querySelector(".spawn-dialog")) doc.querySelector(".spawn-act").click();
    doc.querySelector(".fruntime").value = "claude";
    doc.querySelector(".fmodel").value = "sonnet";
    doc.querySelector(".fspawn").click();
    await tick(); await tick(); await tick();
    assert.equal(posts.length, 2);
    assert.equal(posts[1].runtime, "claude");
    assert.equal(posts[1].model, "sonnet");
  } finally {
    spawn.unmount();
    common.setWorkspace(previousWs);
    globalThis.setInterval = oldSetInterval;
    dom.window.close();
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  }
});

test("Spawn modal: pre-relations CLI shows relation controls DISABLED with the required version named — never hidden", async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body><div id=host></div></body></html>", { url: "http://localhost" });
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  const oldSetInterval = globalThis.setInterval;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.setInterval = () => ({ fake: true });
  const common = await import("../renderer/views/common.mjs");
  const spawn = await import("../renderer/views/spawn.mjs");
  const cliStatusMod2 = await import("../renderer/views/cli-status.mjs");
  // verified CLI, but PROVEN relations-incapable (relations:false from the probe)
  const CLI_OLD = { ok: true, bin: "/seed/oas", version: "0.18.0", source: "path",
    required: { desktopApi: 1, range: ">=0.18.0 <0.19.0" }, relations: false, relationsMin: "0.18.3", probedAt: 1, tried: [] };
  await cliStatusMod2.refreshCli({ api: async () => ({ ok: true, status: 200, json: async () => CLI_OLD }) });
  const previousWs = common.currentWorkspace();
  const agent = { name: "dev", agentsRoot: "/a", description: "", runtime: "pi", work: "workspace", repo: true, repoName: "r" };
  const ctx = {
    api: (pathname, opts = {}) => {
      if (pathname === "/api/cli" || pathname === "/api/cli/reprobe") return Promise.resolve({ ok: true, status: 200, json: async () => CLI_OLD });
      if (opts.method === "POST") return Promise.resolve({ ok: true, status: 200, json: async () => ({ instance: "x" }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => pathname.startsWith("/api/agents")
        ? { agents: [agent] }
        : { instances: [], workspace: { id: "w" }, workspaces: [] } });
    },
    openTerminal: () => {},
  };
  try {
    common.setWorkspace("w");
    spawn.mount(dom.window.document.getElementById("host"), ctx);
    await tick(); await tick();
    const doc = dom.window.document;
    doc.querySelector(".spawn-act").click();
    const rel = doc.querySelector(".spawn-dialog .frelation");
    assert.ok(rel, "relation selector still RENDERED on a pre-relations CLI");
    assert.equal(rel.disabled, true, "…but disabled");
    assert.ok(doc.querySelector(".spawn-dialog .frelto"), "reference picker still rendered");
    const note = doc.querySelector(".spawn-dialog .frelnote");
    assert.ok(note, "explanatory note present");
    assert.match(note.textContent, /oas >= 0\.18\.3/, "note names the required version");
  } finally {
    spawn.unmount();
    await seedCliAvailable(); // restore shared CLI state for later suites
    common.setWorkspace(previousWs);
    globalThis.setInterval = oldSetInterval;
    dom.window.close();
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  }
});
