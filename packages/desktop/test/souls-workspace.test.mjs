import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const tick = () => new Promise((r) => setTimeout(r, 0));

// These suites exercise the spawn-form races; mutations require a VERIFIED
// compatible CLI (frozen contract), so seed the shared CLI state as
// available before each mount — the CLI dimension has its own suite
// (cli-degradation.test.mjs).
const cliStatusMod = await import("../renderer/views/cli-status.mjs");
const CLI_OK = { ok: true, bin: "/seed/oas", version: "0.18.0", source: "path", required: { desktopApi: 1, range: ">=0.18.0 <0.20.0" }, probedAt: 1, tried: [] };
async function seedCliAvailable() {
  await cliStatusMod.refreshCli({
    api: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, bin: "/seed/oas", version: "0.18.0", source: "path", required: { desktopApi: 1, range: ">=0.18.0 <0.20.0" }, probedAt: 1, tried: [] }) }),
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
      if (pathname === "/api/models") return Promise.resolve({ ok: true, status: 200, json: async () => ({ runtime: "pi", models: [] }) });
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
    : { instances: spawned ? [{ instance: "inst-B", running: true, tmux: { session: "pi-agents" } }] : [],
        workspace: { id: ws }, workspaces: [{ id: "wsA", name: "A" }, { id: "wsB", name: "B" }] };
  const ctx = {
    api(pathname, opts = {}) {
      if (pathname === "/api/cli" || pathname === "/api/cli/reprobe") return Promise.resolve(CLI_OK);
      if (pathname === "/api/models") return Promise.resolve({ ok: true, status: 200, json: async () => ({ runtime: "pi", models: [] }) });
      if (opts.method === "POST") return new Promise((ok) => { releaseBSpawn = ok; });
      const ws = pathname.includes("ws=wsB") ? "wsB" : "wsA";
      if (ws === "wsB" && bGets++ < 2) {
        return new Promise((ok) => delayedSwitch.push(() => ok(bodyFor(pathname, ws))));
      }
      return Promise.resolve(bodyFor(pathname, ws));
    },
    openTerminal: (...args) => opened.push(args),
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
    spawned = true;            // panel snapshot now includes the new instance (ready: running + tmux)
    await tick(); await tick(); await tick();
    // openTerminal receives the COMPOSITE ref (name + selected root; the
    // spawn result had no home here) — merged-state review @7dd1e7b — and
    // the auto-open is QUIET (never a blocking alert from the handoff path)
    assert.deepEqual(opened, [[{ instance: "inst-B", agentsRoot: "/wsB-soul/agents" }, { quiet: true }]]);
    // the modal's job is done — a successful handoff closes it
    assert.equal(dom.window.document.querySelector(".spawn-dialog"), null,
      "successful spawn + terminal handoff closes the spawn modal");
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
      if (pathname === "/api/models") return Promise.resolve({ ok: true, status: 200, json: async () => ({ runtime: "pi", models: [] }) });
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
      if (pathname === "/api/models") return Promise.resolve({ ok: true, status: 200, json: async () => ({ runtime: "pi", models: [] }) });
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
      if (pathname === "/api/models") return Promise.resolve({ ok: true, status: 200, json: async () => ({ runtime: "pi", models: [] }) });
      if (opts.method === "POST") {
        posts.push(JSON.parse(opts.body));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ instance: "dev-1", launched: false }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => pathname.startsWith("/api/agents")
        ? { agents: [agent] }
        : { instances: [{ instance: "coord-1", running: true }, { instance: "dev-1", running: true, tmux: { session: "pi-agents" } }], workspace: { id: "w" }, workspaces: [] } });
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
      if (pathname === "/api/models") return Promise.resolve({ ok: true, status: 200, json: async () => ({ runtime: "pi", models: [] }) });
      if (opts.method === "POST") {
        posts.push(JSON.parse(opts.body));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ instance: "dev-1", launched: false }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => pathname.startsWith("/api/agents")
        ? { agents: [agent] }
        : { instances: [{ instance: "dev-1", running: true, tmux: { session: "pi-agents" } }], workspace: { id: "w" }, workspaces: [] } });
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

test("Spawn modal: model dropdown offers the runtime's catalog, swaps on runtime change, and out-of-order responses never win; free text stays valid", async () => {
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
  const agent = { name: "dev", agentsRoot: "/a", description: "d", runtime: "pi", work: "worktree", repo: true, repoName: "r" };
  const modelRequests = [];
  const deferred = []; // manual resolution — the race assertions drive order
  const catalogs = {
    pi: [{ id: "anthropic/claude-opus-4-5", label: "anthropic/claude-opus-4-5" }, { id: "openai/gpt-5.2", label: "openai/gpt-5.2" }],
    claude: [{ id: "opus", label: "opus (alias)" }, { id: "claude-opus-4-5", label: "claude-opus-4-5" }],
  };
  const ctx = {
    api: (pathname, opts = {}) => {
      if (pathname === "/api/cli" || pathname === "/api/cli/reprobe") return Promise.resolve(CLI_OK);
      if (pathname === "/api/models") {
        const runtime = JSON.parse(opts.body).runtime;
        modelRequests.push(runtime);
        return new Promise((resolve) => deferred.push({ runtime, resolve: () =>
          resolve({ ok: true, status: 200, json: async () => ({ runtime, models: catalogs[runtime] || [] }) }) }));
      }
      if (opts.method === "POST") return Promise.resolve({ ok: true, status: 200, json: async () => ({ instance: "dev-1", launched: false }) });
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
    await tick(); await tick();
    // opening the modal fetched the catalog for the agent's DEFAULT runtime
    assert.deepEqual(modelRequests, ["pi"], "catalog fetched for the agent default runtime");
    const dl = doc.querySelector("#spawn-model-options");
    assert.ok(dl, "datalist present");
    const input = doc.querySelector(".fmodel");
    assert.equal(input.getAttribute("list"), "spawn-model-options", "model input wired to the datalist");
    // RACE (review 9b1e3ff): flip the runtime while the initial pi request
    // is STILL PENDING, then resolve claude FIRST and pi LAST — the stale
    // pi response must never overwrite the later claude list.
    const fruntime = doc.querySelector(".fruntime");
    fruntime.value = "claude";
    fruntime.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await tick();
    assert.deepEqual(modelRequests, ["pi", "claude"], "runtime change refetches the catalog");
    deferred[1].resolve(); // claude (latest) lands first
    await tick(); await tick();
    assert.deepEqual([...dl.querySelectorAll("option")].map((o) => o.value),
      ["opus", "claude-opus-4-5"], "latest runtime's catalog rendered");
    deferred[0].resolve(); // stale pi response lands LAST
    await tick(); await tick();
    assert.deepEqual([...dl.querySelectorAll("option")].map((o) => o.value),
      ["opus", "claude-opus-4-5"], "out-of-order stale response never overwrites the latest list");
    // a fresh runtime change still repopulates normally
    fruntime.value = "";
    fruntime.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await tick();
    deferred[2].resolve();
    await tick(); await tick();
    assert.deepEqual([...dl.querySelectorAll("option")].map((o) => o.value),
      ["anthropic/claude-opus-4-5", "openai/gpt-5.2"], "agent-default runtime (pi) catalog restored");
    // free text remains valid — the field is advisory, never a hard select
    input.value = "anthropic/custom,openai/gpt-5.2";
    assert.equal(input.value, "anthropic/custom,openai/gpt-5.2");
  } finally {
    spawn.unmount();
    common.setWorkspace(previousWs);
    globalThis.setInterval = oldSetInterval;
    dom.window.close();
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  }
});

test("Spawn modal: pre-relations CLI gates the RELATED options + picker disabled with the required version named — 'unrelated' stays selectable, nothing hidden", async () => {
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
  // verified CLI, but PROVEN relations-incapable (relations:false from the
  // probe). relationsMin is deliberately OMITTED: the note must fall back to
  // spawn.mjs's own constant, so a stale fallback fails here (review 69bf9dc).
  const CLI_OLD = { ok: true, bin: "/seed/oas", version: "0.18.0", source: "path",
    required: { desktopApi: 1, range: ">=0.18.0 <0.20.0" }, relations: false, probedAt: 1, tried: [] };
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
    assert.equal(rel.disabled, false, "…select stays usable — 'unrelated' is the recovery path");
    const disabledOpts = [...rel.querySelectorAll("option")].filter((o) => o.disabled).map((o) => o.value).sort();
    assert.deepEqual(disabledOpts, ["child", "parent", "sibling"], "related options disabled, unrelated selectable");
    assert.ok(doc.querySelector(".spawn-dialog .frelto"), "reference picker still rendered");
    const note = doc.querySelector(".spawn-dialog .frelnote");
    assert.ok(note, "explanatory note present");
    assert.match(note.textContent, /oas >= 0\.18\.6/,
      "note names the required version FROM THE RENDERER FALLBACK (fixture omits relationsMin)");
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

test("Spawn modal close restores focus to the LIVE Spawn button and clears the card highlight (review 41059e0)", async () => {
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
  const ctx = {
    api: (pathname, opts = {}) => {
      if (pathname === "/api/cli" || pathname === "/api/cli/reprobe") return Promise.resolve(CLI_OK);
      if (pathname === "/api/models") return Promise.resolve({ ok: true, status: 200, json: async () => ({ runtime: "pi", models: [] }) });
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
    const closePaths = [
      ["Escape", () => doc.querySelector(".spawn-dialog")
        .dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))],
      ["Cancel", () => doc.querySelector(".spawn-dialog .fcancel").click()],
      ["close-x", () => doc.querySelector(".spawn-dialog .fcancel-x").click()],
      ["backdrop", () => {
        const modal = doc.querySelector(".spawn-modal");
        const e = new dom.window.MouseEvent("mousedown", { bubbles: true });
        Object.defineProperty(e, "target", { value: modal });
        modal.dispatchEvent(e);
      }],
    ];
    for (const [name, closeIt] of closePaths) {
      const opener = doc.querySelector(".spawn-act");
      opener.click(); // open the modal — renderGrid replaces the button node
      assert.ok(doc.querySelector(".spawn-dialog"), `${name}: modal open`);
      assert.ok(doc.querySelector(".soul-card.open"), `${name}: card highlighted while open`);
      closeIt();
      assert.equal(doc.querySelector(".spawn-dialog"), null, `${name}: modal closed`);
      assert.equal(doc.querySelector(".soul-card.open"), null,
        `${name}: card highlight cleared immediately, not on the next poll`);
      const live = doc.querySelector(".soul-card[data-agent] .spawn-act");
      assert.equal(doc.activeElement, live,
        `${name}: focus restored to the CURRENTLY CONNECTED Spawn button (opener node was replaced)`);
      assert.notEqual(doc.activeElement, opener, `${name}: not the detached original node`);
    }
  } finally {
    spawn.unmount();
    common.setWorkspace(previousWs);
    globalThis.setInterval = oldSetInterval;
    dom.window.close();
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  }
});

test("Spawn modal tracks CLI capability LIVE: relations flip disables/enables controls without wiping typed fields (review 5526b70)", async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body><div id=host></div></body></html>", { url: "http://localhost" });
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  const oldSetInterval = globalThis.setInterval;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.setInterval = () => ({ fake: true });
  const common = await import("../renderer/views/common.mjs");
  const spawn = await import("../renderer/views/spawn.mjs");
  const cliMod = await import("../renderer/views/cli-status.mjs");
  const status = (relations) => ({ ok: true, bin: "/seed/oas", version: relations ? "0.18.6" : "0.18.0",
    source: "path", required: { desktopApi: 1, range: ">=0.18.0 <0.20.0" }, relations, relationsMin: "0.18.6", probedAt: 1, tried: [] });
  const seed = (relations) => cliMod.refreshCli({ api: async () => ({ ok: true, status: 200, json: async () => status(relations) }) });
  await seed(true);
  const previousWs = common.currentWorkspace();
  const agent = { name: "dev", agentsRoot: "/a", description: "", runtime: "pi", work: "workspace", repo: true, repoName: "r" };
  const posts = [];
  const ctx = {
    api: (pathname, opts = {}) => {
      if (pathname === "/api/cli" || pathname === "/api/cli/reprobe") return Promise.resolve({ ok: true, status: 200, json: async () => status(true) });
      if (pathname === "/api/models") return Promise.resolve({ ok: true, status: 200, json: async () => ({ runtime: "pi", models: [] }) });
      if (opts.method === "POST") { posts.push(JSON.parse(opts.body)); return Promise.resolve({ ok: true, status: 200, json: async () => ({ instance: "x" }) }); }
      return Promise.resolve({ ok: true, status: 200, json: async () => pathname.startsWith("/api/agents")
        ? { agents: [agent] }
        : { instances: [{ instance: "coord-1", running: true }, { instance: "x", running: true, tmux: { session: "pi-agents" } }], workspace: { id: "w" }, workspaces: [] } });
    },
    openTerminal: () => {},
  };
  try {
    common.setWorkspace("w");
    spawn.mount(dom.window.document.getElementById("host"), ctx);
    await tick(); await tick();
    const doc = dom.window.document;
    doc.querySelector(".spawn-act").click();
    // relation-capable at open: enabled controls, no note; user types + picks
    const rel = doc.querySelector(".frelation"), ref = doc.querySelector(".frelto");
    assert.equal(rel.disabled, false);
    assert.equal(doc.querySelector(".frelnote").hidden, true, "no note while capable");
    doc.querySelector(".ftask").value = "typed task text";
    rel.value = "child";
    rel.dispatchEvent(new dom.window.Event("change"));
    ref.value = "coord-1";
    ref.dispatchEvent(new dom.window.Event("change"));
    assert.match(doc.querySelector(".freldesc").textContent, /will spawn as a child of coord-1/,
      "completed phrase announces the outcome while capable");
    // DOWNGRADE lands while the modal is open (app-focus re-probe)
    await seed(false);
    assert.equal(rel.disabled, false, "select stays usable after downgrade — recovery via 'unrelated'");
    assert.ok([...rel.querySelectorAll("option")].filter((o) => o.value !== "unrelated").every((o) => o.disabled),
      "related options disabled in the OPEN modal");
    assert.equal([...rel.querySelectorAll("option")].find((o) => o.value === "unrelated").disabled, false,
      "'unrelated' stays enabled — the advertised recovery is actually available");
    assert.equal(ref.disabled, true, "downgrade disables the reference picker");
    const note = doc.querySelector(".frelnote");
    assert.equal(note.hidden, false, "version note appears live");
    assert.match(note.textContent, /oas >= 0\.18\.6/, "note names the required version");
    assert.equal(doc.querySelector(".ftask").value, "typed task text", "typed fields survive the resync");
    assert.equal(rel.value, "child", "chosen relation value preserved (visible, disabled)");
    // the completed phrase must NOT keep promising the spawn that submit
    // will reject (review e9a9281): it flips to an unavailable-state message
    const desc = doc.querySelector(".freldesc");
    assert.ok(!/will spawn as/.test(desc.textContent),
      "outcome promise gone after the downgrade");
    assert.match(desc.textContent, /unavailable on the installed CLI/,
      "phrase states unavailability, consistent with the version note");
    assert.match(desc.textContent, /child of coord-1/, "the preserved choice is still described");
    // submitting the RETAINED related spawn on the downgraded CLI must fail
    // IN THE FORM — no POST, fields preserved (review f35c1dc)
    doc.querySelector(".fspawn").click();
    await tick(); await tick();
    assert.equal(posts.length, 0, "no POST dispatched for a related spawn on a relations-incapable CLI");
    assert.match(doc.querySelector(".fstatus").textContent, /cannot spawn related instances/,
      "form explains the failure and the way out");
    assert.equal(doc.querySelector(".ftask").value, "typed task text", "typed task still preserved after the blocked submit");
    assert.equal(rel.value, "child", "relation choice still preserved");
    // no-reference downgrade: capability error must precede the pairing
    // error (never advise picking a DISABLED reference — review 8b26317)
    ref.value = "";
    doc.querySelector(".fspawn").click();
    await tick(); await tick();
    assert.equal(posts.length, 0, "still no POST");
    assert.match(doc.querySelector(".fstatus").textContent, /cannot spawn related instances/,
      "capability failure reported, not the pairing failure against a disabled picker");
    // the advertised recovery WORKS: switch to unrelated and spawn on the old CLI
    rel.value = "unrelated";
    rel.dispatchEvent(new dom.window.Event("change"));
    doc.querySelector(".fspawn").click();
    await tick(); await tick(); await tick();
    assert.equal(posts.length, 1, "unrelated spawn dispatches on the relations-incapable CLI");
    assert.equal(posts[0].relation, undefined, "no relation on the wire");
    assert.equal(posts[0].task, "typed task text", "the preserved task spawns");
    // the successful spawn hands off and CLOSES the modal (post-spawn UX):
    // reopen it and re-query the controls for the upgrade leg
    assert.equal(doc.querySelector(".spawn-dialog"), null, "successful spawn closes the modal");
    await seed(true);
    doc.querySelector(".spawn-act").click();
    const rel3 = doc.querySelector(".frelation"), ref3 = doc.querySelector(".frelto");
    rel3.value = "child";
    rel3.dispatchEvent(new dom.window.Event("change"));
    ref3.value = "coord-1";
    await seed(false); await seed(true);
    // UPGRADE flips it back: controls re-enable, note clears, values intact
    assert.equal(rel3.disabled, false, "upgrade re-enables the selector");
    assert.ok([...rel3.querySelectorAll("option")].every((o) => !o.disabled), "all options re-enabled");
    assert.equal(ref3.disabled, false, "picker re-enables (a real relation is selected)");
    assert.equal(doc.querySelector(".frelnote").hidden, true, "note clears");
    assert.equal(ref3.value, "coord-1", "picked reference preserved");
    // after the upgrade the same retained values DO dispatch
    doc.querySelector(".fspawn").click();
    await tick(); await tick(); await tick();
    assert.equal(posts.length, 2, "upgrade lets the related spawn through");
    assert.equal(posts[1].relation, "child");
    assert.equal(posts[1].relativeTo, "coord-1");
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

test("Spawn modal: relation + instance form ONE grouped fieldset with plain-language phrasing (human round 3)", async () => {
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
  const ctx = {
    api: (pathname, opts = {}) => {
      if (pathname === "/api/cli" || pathname === "/api/cli/reprobe") return Promise.resolve(CLI_OK);
      if (pathname === "/api/models") return Promise.resolve({ ok: true, status: 200, json: async () => ({ runtime: "pi", models: [] }) });
      if (opts.method === "POST") return Promise.resolve({ ok: true, status: 200, json: async () => ({ instance: "x" }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => pathname.startsWith("/api/agents")
        ? { agents: [agent] }
        : { instances: [{ instance: "coord-1", running: true }], workspace: { id: "w" }, workspaces: [] } });
    },
    openTerminal: () => {},
  };
  try {
    common.setWorkspace("w");
    spawn.mount(dom.window.document.getElementById("host"), ctx);
    await tick(); await tick();
    const doc = dom.window.document;
    doc.querySelector(".spawn-act").click();
    // ONE grouped section: fieldset+legend contains BOTH selects
    const group = doc.querySelector(".spawn-dialog fieldset.frelgroup");
    assert.ok(group, "relation section is a fieldset");
    assert.match(group.querySelector("legend").textContent, /Relation to other agents/);
    assert.ok(group.querySelector(".frelation") && group.querySelector(".frelto"),
      "relation choice and instance picker live INSIDE the group");
    const rel = group.querySelector(".frelation"), ref = group.querySelector(".frelto");
    // plain wording: phrase-style options, no 'reference instance' jargon
    const labels = [...rel.querySelectorAll("option")].map((o) => o.textContent);
    assert.ok(labels.some((l) => /Child of/.test(l)), "child option reads as a phrase");
    assert.ok(!group.textContent.includes("Reference instance"), "jargon label gone");
    // unrelated: picker naturally disabled within the group, no phrase
    assert.equal(ref.disabled, true);
    assert.equal(group.querySelector(".freldesc").textContent, "");
    // choosing a relation re-labels the picker and prompts; picking completes the phrase
    rel.value = "child";
    rel.dispatchEvent(new dom.window.Event("change"));
    assert.equal(ref.disabled, false);
    assert.match(ref.getAttribute("aria-label"), /Child of which instance/, "picker accessible name follows the relation");
    assert.match(group.querySelector(".freldesc").textContent, /Pick the instance this one is a child of/);
    ref.value = "coord-1";
    ref.dispatchEvent(new dom.window.Event("change"));
    assert.match(group.querySelector(".freldesc").textContent, /spawn as a child of coord-1/,
      "completed choice reads as one plain-language sentence");
  } finally {
    spawn.unmount();
    common.setWorkspace(previousWs);
    globalThis.setInterval = oldSetInterval;
    dom.window.close();
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  }
});

test("Spawn modal: picker sends the anchor's agents root; E_RELATIVE_AMBIGUOUS surfaces with guidance", async () => {
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
  // duplicate name "dev-1" across two roots — picker must disambiguate
  const roster = [
    { instance: "dev-1", agentsRoot: "/ws1/agents", running: true },
    { instance: "dev-1", agentsRoot: "/ws2/agents", running: false },
    { instance: "solo", agentsRoot: "/ws1/agents", running: true },
  ];
  const posts = [];
  let failNext = null;
  const ctx = {
    api: (pathname, opts = {}) => {
      if (pathname === "/api/cli" || pathname === "/api/cli/reprobe") return Promise.resolve(CLI_OK);
      if (pathname === "/api/models") return Promise.resolve({ ok: true, status: 200, json: async () => ({ runtime: "pi", models: [] }) });
      if (opts.method === "POST") {
        posts.push(JSON.parse(opts.body));
        if (failNext) { const body = failNext; failNext = null;
          return Promise.resolve({ ok: false, status: 409, json: async () => body }); }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ instance: "x" }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => pathname.startsWith("/api/agents")
        ? { agents: [agent] }
        : { instances: roster, workspace: { id: "w" }, workspaces: [] } });
    },
    openTerminal: () => {},
  };
  try {
    common.setWorkspace("w");
    spawn.mount(dom.window.document.getElementById("host"), ctx);
    await tick(); await tick();
    const doc = dom.window.document;
    doc.querySelector(".spawn-act").click();
    const ref = doc.querySelector(".frelto");
    // duplicate-name options carry distinct data-root and a visible root tag
    const dupOpts = [...ref.options].filter((o) => o.value === "dev-1");
    assert.equal(dupOpts.length, 2, "both same-named instances are listed");
    assert.notEqual(dupOpts[0].dataset.root, dupOpts[1].dataset.root, "options carry distinct roots");
    assert.ok(dupOpts.every((o) => /\[.+\]/.test(o.textContent)), "duplicates show a distinguishing root tag");
    const soloOpt = [...ref.options].find((o) => o.value === "solo");
    assert.ok(!/\[.+\]/.test(soloOpt.textContent), "unique names stay untagged");
    // a related spawn sends the selected option's root as relativeRoot
    const rel = doc.querySelector(".frelation");
    rel.value = "child";
    rel.dispatchEvent(new dom.window.Event("change"));
    dupOpts[1].selected = true; // the /ws2 twin
    doc.querySelector(".fspawn").click();
    await tick(); await tick(); await tick();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].relativeTo, "dev-1");
    assert.equal(posts[0].relativeRoot, "/ws2/agents", "the anchor's agents root travels with the name");
    // kernel ambiguity error surfaces with actionable guidance (fresh modal —
    // the first spawn's roster wait still owns the old form's button)
    doc.querySelector(".spawn-dialog .fcancel").click();
    doc.querySelector(".spawn-act").click();
    const form = doc.querySelector(".spawn-dialog");
    const rel2 = form.querySelector(".frelation");
    rel2.value = "child";
    rel2.dispatchEvent(new dom.window.Event("change"));
    form.querySelector(".frelto").value = "dev-1";
    // realistic case-(d) payload: INHERITED edge whose ambiguous name is NOT
    // the picked anchor, two absolute homes, >300 chars — the endpoint
    // preserves E_RELATIVE_AMBIGUOUS messages past the generic cap (review
    // f1e3211) and the renderer must surface the tail verbatim
    const caseD = `relation "child": inherited lineage edge "other-coord" is ambiguous — it matches `
      + `/Users/u/very/long/workspace/path/agents/other-coord/instances/other-coord and `
      + `/Users/u/second/equally/long/team/checkout/local-agents/other-coord/instances/other-coord; `
      + `qualify with --relative-root or rename one instance`;
    assert.ok(caseD.length > 300, "fixture exercises the truncation boundary");
    failNext = { error: caseD, code: "E_RELATIVE_AMBIGUOUS" };
    form.querySelector(".fspawn").click();
    await tick(); await tick(); await tick();
    const status = form.querySelector(".fstatus").textContent;
    assert.ok(status.includes(caseD),
      "the COMPLETE kernel message surfaces — both homes and the remedy tail, ambiguous name ≠ picked anchor");
    assert.match(status, /rename or retire the shadowing instance/,
      "general remedy — never advises re-picking, which the always-sent root makes futile");
  } finally {
    spawn.unmount();
    common.setWorkspace(previousWs);
    globalThis.setInterval = oldSetInterval;
    dom.window.close();
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  }
});

test("Spawn modal picker: hostile paths stay inert; colliding root tags render distinct labels (review cbd5bb3)", async () => {
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
  const agent = { name: "dev", agentsRoot: "/a", description: "", runtime: "pi", work: "workspace", repo: true, repoName: "r",
    // SECURITY fixture (merged-state review @3e76616): workspace-controlled
    // model with an attribute breakout — escapeHtml does not escape quotes,
    // so attribute interpolation would mint an onpointerenter handler with
    // access to the privileged bridge
    model: `x" onpointerenter="window.__pwned=1` };
  // hostile path: HTML-significant characters in a valid workspace path;
  // plus two roots whose naive one-segment tag collides ("project")
  const evilRoot = `/tmp/x"><img src=x onerror=alert(1)>/agents`;
  const roster = [
    { instance: "dev-1", agentsRoot: "/a/project/agents", running: true },
    { instance: "dev-1", agentsRoot: "/b/project/agents", running: true },
    { instance: "evil", agentsRoot: evilRoot, running: true },
    { instance: "evil", agentsRoot: "/plain/agents", running: true },
  ];
  const ctx = {
    api: (pathname, opts = {}) => {
      if (pathname === "/api/cli" || pathname === "/api/cli/reprobe") return Promise.resolve(CLI_OK);
      if (pathname === "/api/models") return Promise.resolve({ ok: true, status: 200, json: async () => ({ runtime: "pi", models: [] }) });
      if (opts.method === "POST") return Promise.resolve({ ok: true, status: 200, json: async () => ({ instance: "x" }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => pathname.startsWith("/api/agents")
        ? { agents: [agent] }
        : { instances: roster, workspace: { id: "w" }, workspaces: [] } });
    },
    openTerminal: () => {},
  };
  try {
    common.setWorkspace("w");
    spawn.mount(dom.window.document.getElementById("host"), ctx);
    await tick(); await tick();
    const doc = dom.window.document;
    doc.querySelector(".spawn-act").click();
    const ref = doc.querySelector(".frelto");
    // hostile MODEL never escapes the attribute context: the placeholder is
    // assigned as a DOM property, so no event handler attribute can exist
    const fmodel = doc.querySelector(".fmodel");
    assert.equal(fmodel.placeholder, `x" onpointerenter="window.__pwned=1`, "model preserved byte-for-byte as placeholder TEXT");
    assert.equal(fmodel.getAttribute("onpointerenter"), null, "no event-handler attribute minted from a hostile model");
    assert.ok(![...doc.querySelectorAll("*")].some((el) => [...el.attributes].some((at) => at.name.startsWith("on"))),
      "no on* attribute anywhere in the modal from workspace-controlled data");
    // hostile path never becomes markup: no injected node, dataset intact
    assert.equal(doc.querySelector("img"), null, "no element injected from a hostile workspace path");
    const evilOpt = [...ref.options].find((o) => o.dataset.root === evilRoot);
    assert.ok(evilOpt, "hostile path preserved byte-for-byte in dataset.root");
    assert.ok(evilOpt.textContent.includes("evil"), "option renders as text");
    // colliding tags: both dev-1 labels differ
    const devLabels = [...ref.options].filter((o) => o.value === "dev-1").map((o) => o.textContent);
    assert.equal(devLabels.length, 2);
    assert.notEqual(devLabels[0], devLabels[1], "duplicate option labels are actually distinguishable");
  } finally {
    spawn.unmount();
    common.setWorkspace(previousWs);
    globalThis.setInterval = oldSetInterval;
    dom.window.close();
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  }
});

test("spawn: post-spawn poll and terminal open use COMPOSITE identity — a same-named twin never satisfies the wait (merged-state review @7dd1e7b)", async () => {
  const spawn = await import("../renderer/views/spawn.mjs");
  // twin with the SAME NAME but a different home is already in the panel;
  // a bare-name match would return true on the first poll and the follow-up
  // open would then refuse the ambiguous name
  const twin = { instance: "dev-1", home: "/ws/local-agents/dev/instances/dev-1", agentsRoot: "/ws/local-agents", running: true, tmux: { session: "pi-agents" } };
  const mine = { instance: "dev-1", home: "/ws/agents/dev/instances/dev-1", agentsRoot: "/ws/agents", running: true, tmux: { session: "pi-agents" } };
  let polls = 0;
  const panels = [
    { instances: [twin] },           // roster lag: only the twin yet
    { instances: [twin, mine] },     // catch-up: the spawned instance appears
  ];
  const s = { ctx: { api: () => { const p = panels[Math.min(polls++, 1)]; return Promise.resolve({ ok: true, status: 200, json: async () => p }); } } };
  const ref = { instance: "dev-1", home: mine.home, agentsRoot: mine.agentsRoot };
  const ok = await spawn.waitForInstanceInPanel(s, ref, () => true, { tries: 5, delayMs: 0, sleep: async () => {} });
  assert.equal(ok, true, "wait succeeds once the composite identity appears");
  assert.equal(polls, 2, "the twin alone did NOT satisfy the first poll — bare-name early success is the bug");
  // legacy panels without home/agentsRoot fields still match by name
  let polls2 = 0;
  const s2 = { ctx: { api: () => { polls2++; return Promise.resolve({ ok: true, status: 200, json: async () => ({ instances: [{ instance: "dev-1", running: true, tmux: { session: "pi-agents" } }] }) }); } } };
  assert.equal(await spawn.waitForInstanceInPanel(s2, ref, () => true, { tries: 2, delayMs: 0, sleep: async () => {} }), true,
    "identity-less roster rows keep matching by name (no regression for old servers)");
  assert.equal(polls2, 1);
});

test("spawn: post-spawn wait requires TERMINAL READINESS — a listed-but-not-running instance (tmux not registered yet) never satisfies the poll", async () => {
  const spawn = await import("../renderer/views/spawn.mjs");
  // The roster snapshot lists a fresh spawn from its instance.json BEFORE
  // its tmux window registers: running:false, no tmux.session. Opening the
  // terminal at that point hits the shell's "no live tmux session" refusal
  // (the original bug — blocking alert + stuck modal). The wait must hold
  // until the row is running WITH a tmux session.
  const ref = { instance: "dev-1", home: "/ws/agents/dev/instances/dev-1" };
  let polls = 0;
  const panels = [
    { instances: [{ instance: "dev-1", home: ref.home, running: false, tmux: { session: "pi-agents" } }] }, // present, not running
    { instances: [{ instance: "dev-1", home: ref.home, running: true }] },                                   // running, tmux unregistered
    { instances: [{ instance: "dev-1", home: ref.home, running: true, tmux: { session: "pi-agents" } }] },   // READY
  ];
  const s = { ctx: { api: () => { const p = panels[Math.min(polls++, 2)]; return Promise.resolve({ ok: true, status: 200, json: async () => p }); } } };
  const ok = await spawn.waitForInstanceInPanel(s, ref, () => true, { tries: 5, delayMs: 0, sleep: async () => {} });
  assert.equal(ok, true, "wait succeeds once the instance is terminal-ready");
  assert.equal(polls, 3, "mere presence (not running / no tmux session) did NOT satisfy earlier polls — early success is the alert bug");
  // timeout degradation: a never-ready instance returns false (caller
  // degrades to the sidebar-roster status line — no auto-open, no alert)
  const s2 = { ctx: { api: () => Promise.resolve({ ok: true, status: 200, json: async () => ({ instances: [{ instance: "dev-1", home: ref.home, running: false }] }) }) } };
  assert.equal(await spawn.waitForInstanceInPanel(s2, ref, () => true, { tries: 3, delayMs: 0, sleep: async () => {} }), false,
    "a never-ready instance times out to the graceful degradation path");
});

test("common: instanceApiPath carries the home qualifier for object refs (merged-state review @7dd1e7b)", async () => {
  const common = await import("../renderer/views/common.mjs");
  const prev = common.currentWorkspace();
  try {
    common.setWorkspace("w1");
    // object ref → exact-home qualified (server refuses ambiguous bare names)
    const p = common.instanceApiPath("keys", { instance: "dev-1", home: "/ws/agents/dev/instances/dev-1" });
    assert.equal(p, `/api/keys/dev-1?home=${encodeURIComponent("/ws/agents/dev/instances/dev-1")}&ws=w1`);
    // extra query composes with the qualifier
    const p2 = common.instanceApiPath("session", { instance: "dev-1", home: "/h" }, "lines=200");
    assert.equal(p2, `/api/session/dev-1?lines=200&home=${encodeURIComponent("/h")}&ws=w1`);
    // legacy string ref unchanged
    assert.equal(common.instanceApiPath("chat", "solo"), "/api/chat/solo?ws=w1");
  } finally { common.setWorkspace(prev); }
});

test("shell api errors: httpError carries the server's stable domain code (merged-state review @3e76616)", async () => {
  const common = await import("../renderer/views/common.mjs");
  // Electron-bridge shape: parsed body, no .json() — the shell's ctx.api
  // throws via httpError. Dropping body.code made doSpawn's
  // E_RELATIVE_AMBIGUOUS branch unreachable in PRODUCTION while
  // fetch-shaped tests stayed green.
  const e = common.httpError({ ok: false, status: 409,
    body: { error: 'relation "child": ambiguous', code: "E_RELATIVE_AMBIGUOUS" } }, "/api/spawn");
  assert.equal(e.message, 'relation "child": ambiguous');
  assert.equal(e.status, 409);
  assert.equal(e.code, "E_RELATIVE_AMBIGUOUS", "domain code survives the shell-parsed path");
  // code-less errors stay code-less; message falls back to status text
  const e2 = common.httpError({ ok: false, status: 500, body: {} }, "/api/x");
  assert.equal(e2.message, "HTTP 500 for /api/x");
  assert.ok(!("code" in e2));
  // the SHELL actually routes through httpError (composition root is not
  // importable — pin the wiring textually like the nav-manifest tests do)
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  assert.ok(/if \(!r\.ok\) throw httpError\(r, pathname\);/.test(src), "shell ctx.api throws via the shared httpError");
  assert.ok(/httpError\s*\}?\s*from ".\/views\/common.mjs"|,\s*httpError\s*\}/.test(src), "shell imports httpError from common");
});
