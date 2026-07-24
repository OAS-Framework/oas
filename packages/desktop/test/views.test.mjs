import { test } from "node:test";
import assert from "node:assert/strict";

// Importing the view modules also proves they resolve/parse as ESM with the
// package's real deps (marked, highlight.js) — what Electron's bundler sees.
const md = await import("../renderer/views/markdown.mjs");

test("views export the contract surface", () => {
  for (const m of [md]) {
    assert.equal(typeof m.mount, "function");
    assert.equal(typeof m.unmount, "function");
  }
});

test("markdown: relative links resolve against the open file's directory", () => {
  assert.equal(md.resolveRelative("/a/b/README.md", "docs/x.md"), "/a/b/docs/x.md");
  assert.equal(md.resolveRelative("/a/b/README.md", "../x.md"), "/a/x.md");
  assert.equal(md.resolveRelative("/a/b/README.md", "./x.md"), "/a/b/x.md");
});

test("markdown: highlight falls back safely and escapes", () => {
  assert.ok(md.highlight("const x = 1;", "javascript").includes("hljs-"));
  assert.ok(!md.escapeHtml("<script>").includes("<script>"));
});

test("markdown: active link schemes are rejected, safe ones allowed", () => {
  assert.equal(md.externalHref("javascript:alert(1)"), null);
  assert.equal(md.externalHref("data:text/html,x"), null);
  assert.equal(md.externalHref("vbscript:x"), null);
  assert.equal(md.externalHref("https://example.com"), "https://example.com");
  assert.equal(md.externalHref("mailto:a@b.c"), "mailto:a@b.c");
});

test("markdown: sanitizeHtml strips scripts/handlers and normalizes every anchor", async () => {
  const { JSDOM } = await import("jsdom");
  const doc = new JSDOM("<!doctype html><body>").window.document;
  const dirty = [
    `<script>bad()</script>`,
    `<img src=x onerror="bad()">`,
    `<a href="https://evil.example" target="_self" rel="opener">nav</a>`,
    `<a href="javascript:bad()">js</a>`,
    `<a href="relative.md">raw-rel</a>`,
    `<a href="#" data-open-file="/ws/x.md" target="_top">open</a>`,
    `<p onclick="bad()">text</p>`,
  ].join("");
  const out = md.sanitizeHtml(dirty, doc);
  assert.ok(!/script>|onerror|onclick|javascript:/i.test(out), "active content removed");
  const div = doc.createElement("div"); div.innerHTML = out;
  for (const a of div.querySelectorAll("a")) {
    if (a.hasAttribute("data-open-file")) {
      assert.equal(a.getAttribute("href"), "#");
      assert.equal(a.getAttribute("target"), null, "file links carry no target");
    } else {
      assert.equal(a.getAttribute("target"), "_blank", "external anchors forced to _blank");
      assert.equal(a.getAttribute("rel"), "noreferrer noopener", "rel re-forced");
      assert.ok(/^https:/.test(a.getAttribute("href")), "only allowlisted schemes survive");
    }
  }
  assert.ok(div.textContent.includes("js") && !out.includes('href="javascript:'), "js: anchor neutralized to text");
  assert.ok(div.textContent.includes("raw-rel"), "raw relative anchor neutralized to text");
  // plain fragment links stay local — never rewritten to target=_blank
  const frag = doc.createElement("div");
  frag.innerHTML = md.sanitizeHtml('<a href="#section">frag</a>', doc);
  const fa = frag.querySelector("a");
  assert.ok(fa, "fragment anchor survives");
  assert.equal(fa.getAttribute("target"), null, "fragment link is not externalized");
});

test("brain: stale rejection cannot replace a newer selection's rendered brain", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body><div id=el></div>", { url: "http://127.0.0.1/" });
  // brain.mjs builds DOM via the global document
  const g = globalThis;
  const saved = { document: g.document, window: g.window, localStorage: g.localStorage };
  g.document = dom.window.document; g.window = dom.window; g.localStorage = dom.window.localStorage;
  try {
    const brain = await import("../renderer/views/brain.mjs");
    const el = dom.window.document.getElementById("el");
    const inflight = []; // { pathname, resolve, reject }
    const mkBrain = (agent) => ({ agent, description: "", agentsRoot: "/r",
      soul: { agentsMd: null, skills: [], knowledge: { index: null, tree: [] } },
      instances: [{ instance: `${agent}-inst`, home: `/h/${agent}`, running: false,
                    agentsMd: null, skills: [], state: null, task: null, notes: [] }] });
    const ctx = {
      api: (pathname) => {
        if (pathname.startsWith("/api/agents"))
          return Promise.resolve({ agents: [{ name: "agent-a", description: "" }, { name: "agent-b", description: "" }] });
        return new Promise((resolve, reject) => inflight.push({ pathname, resolve, reject }));
      },
      openFile: () => {}, openTerminal: () => {},
    };
    const mountP = brain.mount(el, ctx);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(inflight.length, 1, "initial brain request (agent-a) in flight");
    const reqA = inflight.shift();
    // user selects agent-b while agent-a's request is still pending
    const sel = el.querySelector("select");
    sel.value = "agent-b";
    sel.dispatchEvent(new dom.window.Event("change"));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(inflight.length, 1, "agent-b request in flight");
    const reqB = inflight.shift();
    // B renders first...
    reqB.resolve(mkBrain("agent-b"));
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(el.innerHTML.includes("agent-b-inst"), "agent-b brain rendered");
    // ...then A REJECTS late — the round-4 race: the stale error must not
    // replace agent-b's rendered brain
    reqA.reject(new Error("boom-stale-a"));
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(el.innerHTML.includes("agent-b-inst"), "agent-b render survives the stale rejection");
    assert.ok(!el.innerHTML.includes("boom-stale-a"), "stale error never painted");
    // reversed SUCCESS order too: stale success must not clobber either
    sel.value = "agent-a";
    sel.dispatchEvent(new dom.window.Event("change"));
    sel.value = "agent-b";
    sel.dispatchEvent(new dom.window.Event("change"));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(inflight.length, 2, "two selection requests in flight");
    const [oldA, newB] = inflight.splice(0, 2);
    newB.resolve(mkBrain("agent-b"));
    await new Promise((r) => setTimeout(r, 10));
    oldA.resolve(mkBrain("agent-a"));
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(el.innerHTML.includes("agent-b-inst"), "newer selection survives stale success");
    assert.ok(!el.innerHTML.includes("agent-a-inst"), "stale success never rendered");
    await Promise.race([mountP, new Promise((r) => setTimeout(r, 30))]);
    brain.unmount();
  } finally {
    g.document = saved.document; g.window = saved.window; g.localStorage = saved.localStorage;
  }
});

test("brain: a selection during an in-flight roster refresh cannot cancel it", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body><div id=el></div>", { url: "http://127.0.0.1/" });
  const g = globalThis;
  const saved = { document: g.document, window: g.window, localStorage: g.localStorage };
  g.document = dom.window.document; g.window = dom.window; g.localStorage = dom.window.localStorage;
  try {
    const brain = await import("../renderer/views/brain.mjs");
    const common = await import("../renderer/views/common.mjs");
    const el = dom.window.document.getElementById("el");
    const rosterInflight = []; // manually resolved /api/agents requests
    const mkBrain = (agent) => ({ agent, description: "", agentsRoot: "/r",
      soul: { agentsMd: null, skills: [], knowledge: { index: null, tree: [] } }, instances: [] });
    let rosterCalls = 0;
    const ctx = {
      api: (pathname) => {
        if (pathname.startsWith("/api/agents")) {
          rosterCalls++;
          // first roster (mount) resolves immediately; later ones held in flight
          if (rosterCalls === 1) return Promise.resolve({ agents: [{ name: "old-a" }, { name: "old-b" }] });
          return new Promise((resolve) => rosterInflight.push(resolve));
        }
        return Promise.resolve(mkBrain(decodeURIComponent(pathname.match(/brain\/([^?]+)/)[1])));
      },
      openFile: () => {}, openTerminal: () => {},
    };
    await brain.mount(el, ctx);
    const sel = el.querySelector("select");
    assert.equal(sel.value, "old-a", "old workspace roster loaded");
    // workspace switches → roster refresh starts and stays in flight
    common.setWorkspace("ws-new");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(rosterInflight.length, 1, "new roster request in flight");
    assert.ok(sel.disabled, "selector disabled while the roster refreshes");
    // user tries to select on the STALE selector anyway (programmatic change
    // event — the regression: this used to ++gen and cancel the roster)
    sel.value = "old-b";
    sel.dispatchEvent(new dom.window.Event("change"));
    await new Promise((r) => setTimeout(r, 10));
    // the roster response must still be accepted
    rosterInflight.shift()({ agents: [{ name: "new-x" }] });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sel.value, "new-x", "new workspace roster populated despite the mid-flight selection");
    assert.ok(!sel.disabled, "selector re-enabled after the refresh");
    brain.unmount();
    common.setWorkspace(""); // restore shared state for other tests
  } finally {
    g.document = saved.document; g.window = saved.window; g.localStorage = saved.localStorage;
  }
});

test("brain: roster failure re-enables the selector; a stale failure cannot unlock a newer refresh", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body><div id=el></div>", { url: "http://127.0.0.1/" });
  const g = globalThis;
  const saved = { document: g.document, window: g.window, localStorage: g.localStorage };
  g.document = dom.window.document; g.window = dom.window; g.localStorage = dom.window.localStorage;
  try {
    const brain = await import("../renderer/views/brain.mjs");
    const common = await import("../renderer/views/common.mjs");
    const el = dom.window.document.getElementById("el");
    const rosterInflight = []; // { resolve, reject }
    let rosterCalls = 0;
    const ctx = {
      api: (pathname) => {
        if (pathname.startsWith("/api/agents")) {
          rosterCalls++;
          if (rosterCalls === 1) return Promise.resolve({ agents: [{ name: "a1" }] });
          return new Promise((resolve, reject) => rosterInflight.push({ resolve, reject }));
        }
        return Promise.resolve({ agent: "a1", description: "", agentsRoot: "/r",
          soul: { agentsMd: null, skills: [], knowledge: { index: null, tree: [] } }, instances: [] });
      },
      openFile: () => {}, openTerminal: () => {},
    };
    await brain.mount(el, ctx);
    const sel = el.querySelector("select");
    // CURRENT roster refresh fails → selector must come back
    common.setWorkspace("ws-fail");
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(sel.disabled, "selector locked during the refresh");
    rosterInflight.shift().reject(new Error("roster down"));
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(!sel.disabled, "current-request failure re-enables the selector");
    assert.ok(el.innerHTML.includes("roster down"), "failure surfaced");
    // STALE failure must NOT unlock a newer in-flight refresh
    common.setWorkspace("ws-a");
    await new Promise((r) => setTimeout(r, 10));
    const staleReq = rosterInflight.shift();
    common.setWorkspace("ws-b"); // newer refresh supersedes; selector locked for it
    await new Promise((r) => setTimeout(r, 10));
    const newerReq = rosterInflight.shift();
    assert.ok(sel.disabled, "selector locked for the newer refresh");
    staleReq.reject(new Error("stale boom"));
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(sel.disabled, "stale failure does not unlock the newer refresh");
    assert.ok(!el.innerHTML.includes("stale boom"), "stale error never painted");
    newerReq.resolve({ agents: [{ name: "b1" }] });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(!sel.disabled, "newer refresh completes and unlocks");
    assert.equal(sel.value, "b1");
    brain.unmount();
    common.setWorkspace("");
  } finally {
    g.document = saved.document; g.window = saved.window; g.localStorage = saved.localStorage;
  }
});
