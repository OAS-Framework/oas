import { test } from "node:test";
import assert from "node:assert/strict";

// Importing the view modules also proves they resolve/parse as ESM with the
// package's real deps (marked, highlight.js) — what Electron's bundler sees.
const md = await import("../renderer/views/markdown.mjs");
const dv = await import("../renderer/views/diff.mjs");

test("views export the contract surface", () => {
  for (const m of [md, dv]) {
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

test("diff: parseUnifiedDiff extracts files, hunks and line numbers", () => {
  const diff = [
    "diff --git a/foo.js b/foo.js",
    "index 111..222 100644",
    "--- a/foo.js",
    "+++ b/foo.js",
    "@@ -1,3 +1,4 @@ ctx",
    " keep",
    "-old line",
    "+new line",
    "+added line",
    " tail",
  ].join("\n");
  const files = dv.parseUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "foo.js");
  const lines = files[0].hunks[0].lines;
  assert.deepEqual(lines.map((l) => l.kind), [" ", "-", "+", "+", " "]);
  assert.equal(lines[0].oldNo, 1); assert.equal(lines[0].newNo, 1);
  assert.equal(lines[1].oldNo, 2); assert.equal(lines[1].newNo, null);
  assert.equal(lines[2].newNo, 2);
  assert.equal(lines[4].oldNo, 3); assert.equal(lines[4].newNo, 4);
});

test("diff: pairForSideBySide aligns delete/add runs row-by-row", () => {
  const lines = [
    { kind: " ", text: "a" },
    { kind: "-", text: "b1" }, { kind: "-", text: "b2" },
    { kind: "+", text: "c1" },
    { kind: " ", text: "d" },
  ];
  const rows = dv.pairForSideBySide(lines);
  assert.equal(rows.length, 4);
  assert.equal(rows[1].left.text, "b1"); assert.equal(rows[1].right.text, "c1");
  assert.equal(rows[2].left.text, "b2"); assert.equal(rows[2].right, null);
});

test("markdown: active link schemes are rejected, safe ones allowed", () => {
  assert.equal(md.externalHref("javascript:alert(1)"), null);
  assert.equal(md.externalHref("data:text/html,x"), null);
  assert.equal(md.externalHref("vbscript:x"), null);
  assert.equal(md.externalHref("https://example.com"), "https://example.com");
  assert.equal(md.externalHref("mailto:a@b.c"), "mailto:a@b.c");
});

test("diff: newline-terminated diff does not fabricate a trailing context line", () => {
  const diff = [
    "diff --git a/f b/f",
    "@@ -1,1 +1,1 @@",
    "-a",
    "+b",
    "", // split artifact of the trailing newline
  ].join("\n");
  const lines = dv.parseUnifiedDiff(diff)[0].hunks[0].lines;
  assert.deepEqual(lines.map((l) => l.kind), ["-", "+"], "no fabricated context row");
});

test("diff: context rows keep distinct old/new numbers when offsets differ", () => {
  const diff = [
    "diff --git a/f b/f",
    "@@ -10,2 +20,2 @@",
    " ctx",
    "+add",
  ].join("\n");
  const lines = dv.parseUnifiedDiff(diff)[0].hunks[0].lines;
  assert.equal(lines[0].oldNo, 10);
  assert.equal(lines[0].newNo, 20, "right side of a context row must use newNo");
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

test("diff: two live generations resolved in reverse order — older cannot clobber newer", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body><div id=el></div>");
  const el = dom.window.document.getElementById("el");
  const inflight = []; // { staged, resolve } — resolved manually, in test-chosen order
  const mkData = (tag, staged) => ({ repo: "/r", branch: tag, staged, files: [], diff: "" });
  const ctx = {
    instance: "inst-x",
    api: (pathname) => new Promise((resolve) => inflight.push({ staged: /staged=1/.test(pathname), resolve })),
    openFile: () => {}, openTerminal: () => {},
  };
  const mountP = dv.mount(el, ctx);
  await new Promise((r) => setTimeout(r, 10));
  inflight.shift().resolve(mkData("initial", false));
  const dispose = await mountP;
  // Retain the toggle before the loading screen detaches it — a click on the
  // retained node still fires the handler, which is exactly the rapid-toggle
  // user behavior (two renders in flight at once).
  const stagedBtn = [...el.querySelectorAll("button")].find((b) => b.textContent === "show staged");
  assert.ok(stagedBtn, "staged toggle rendered");
  stagedBtn.dispatchEvent(new dom.window.Event("click"));   // gen A: staged=1
  stagedBtn.dispatchEvent(new dom.window.Event("click"));   // gen B: staged=0 (newer)
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(inflight.length, 2, "two concurrent requests in flight");
  const [older, newer] = inflight.splice(0, 2);
  assert.equal(older.staged, true, "older generation requested staged");
  assert.equal(newer.staged, false, "newer generation requested worktree");
  // REVERSED completion order: newer lands first, older (stale) last
  newer.resolve(mkData("newer-view", false));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(el.innerHTML.includes("newer-view"), "newer render displayed");
  older.resolve(mkData("stale-view", true));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(el.innerHTML.includes("newer-view"), "newer render survives the stale completion");
  assert.ok(!el.innerHTML.includes("stale-view"), "stale generation never rendered");
  if (typeof dispose === "function") dispose(); else dv.unmount();
});

test("diff: a response landing after dispose never renders", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body><div id=el></div>");
  const el = dom.window.document.getElementById("el");
  const inflight = [];
  const ctx = {
    instance: "inst-x",
    api: () => new Promise((resolve) => inflight.push(resolve)),
    openFile: () => {}, openTerminal: () => {},
  };
  const mountP = dv.mount(el, ctx); // initial request stays in flight
  await new Promise((r) => setTimeout(r, 10));
  dv.unmount(); // tab closed while awaiting (module-level dispose-all)
  inflight.shift()({ repo: "/r", branch: "post-dispose", staged: false, files: [], diff: "" });
  await Promise.race([mountP, new Promise((r) => setTimeout(r, 30))]);
  assert.ok(!el.innerHTML.includes("post-dispose"), "post-dispose response never rendered");
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
