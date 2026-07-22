import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "oas.mjs");
const CAP = join(ROOT, "capabilities", "oas-web");

// ---- ANSI renderer (extracted from the panel's marked DOM-free block) ----

// ---- registry cache + attach sequencing (extracted marked blocks) ----
function extractBlock(file, marker) {
  const src = readFileSync(file, "utf8");
  const re = new RegExp(`\\/\\* OASWEB_${marker}_BEGIN[^*]*\\*\\/([\\s\\S]*?)\\/\\* OASWEB_${marker}_END \\*\\/`);
  const m = src.match(re);
  assert.ok(m, marker + " block markers present");
  return m[1];
}

test("oas-web server: collect subcommand emits the roster snapshot JSON", () => {
  const out = execFileSync(process.execPath, [join(CAP, "bin", "oas-web.mjs"), "collect", "--dir", ROOT],
    { encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  const parsed = JSON.parse(out);
  const ws = Object.values(parsed);
  assert.ok(ws.length >= 1, "at least one workspace in the snapshot");
  assert.ok(Array.isArray(ws[0].instances), "each workspace carries an instances array");
});

test("oas-web server: key-send failures never leak the payload or its hex encoding", () => {
  const src = extractBlock(join(CAP, "bin", "oas-web.mjs"), "KEYERR");
  const keySendError = new Function(src + "\nreturn keySendError;")();
  const secret = "hunter2-t0ken";
  const hex = [...Buffer.from(secret, "utf8")].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  // simulate the real execFileSync failure shape: non-zero exit → e.status,
  // argv (hex bytes) inside message
  const err = Object.assign(new Error(`Command failed: tmux send-keys -t s:1 -H ${hex}`),
                            { status: 1, signal: null });
  const safe = keySendError(err);
  for (const [what, s] of [["log", safe.log], ["http error", JSON.stringify(safe.http)]]) {
    assert.ok(!s.includes(secret), `${what} must not contain the plaintext payload`);
    assert.ok(!s.includes(hex.slice(0, 8)), `${what} must not contain the hex-encoded payload`);
    assert.ok(!s.includes("Command failed"), `${what} must not embed the child argv message`);
  }
  assert.ok(safe.http.error.includes("code 1"), "exit code is surfaced");
  // timeout shape (ETIMEDOUT + signal) stays safe too
  const t = keySendError(Object.assign(new Error(`spawnSync tmux ETIMEDOUT: -H ${hex}`), { code: "ETIMEDOUT", signal: "SIGTERM" }));
  assert.ok(!t.log.includes(hex.slice(0, 8)) && t.log.includes("ETIMEDOUT") && t.log.includes("SIGTERM"));
});

test("oas-web echo: screen signature is depth-independent and detects real change", () => {
  const src = extractBlock(join(CAP, "ui", "panel.html"), "SCREENSIG");
  const screenSignature = new Function(src + "\nreturn screenSignature;")();
  const size = { rows: 24, cols: 80, cx: 3, cy: 1, cursor: true };
  // same visible screen, fetched with different history depths → SAME sig
  const deep = { text: "h1\nh2\nh3\nprompt\n> \n", history: 3, size };
  const tail = { text: "h3\nprompt\n> \n", history: 1, size };
  assert.equal(screenSignature(deep), screenSignature(tail),
    "tail fetch after a deep poll must not read as a screen change");
  // the echoed character IS a change
  const echoed = { text: "h3\nprompt\n> x\n", history: 1, size };
  assert.notEqual(screenSignature(tail), screenSignature(echoed), "echo changes the signature");
  // geometry changes are changes too
  const resized = { text: "h3\nprompt\n> \n", history: 1, size: { ...size, cols: 100 } };
  assert.notEqual(screenSignature(tail), screenSignature(resized), "resize changes the signature");
});

test("oas-web attach: tail-then-deep order, and pane switches cancel the backfill", async () => {
  const src = extractBlock(join(CAP, "ui", "panel.html"), "ATTACH");
  const attachSequence = new Function(src + "\nreturn attachSequence;")();
  // normal attach: tail (120) first, deep (default lines) second
  const calls = [];
  const p = { gen: 1, sel: "a" };
  const refresh = (pane, force, lines) => { calls.push(lines ?? "deep"); pane.gen++; return Promise.resolve(); };
  await attachSequence(p, "a", refresh);
  assert.deepEqual(calls, [120, "deep"], "screenful tail first, deep backfill second");
  // a pane switch (extra gen bump) during the tail fetch cancels the backfill
  const calls2 = [];
  const q = { gen: 1, sel: "a" };
  const refresh2 = (pane, force, lines) => {
    calls2.push(lines ?? "deep");
    pane.gen++;
    if (calls2.length === 1) { pane.gen++; pane.sel = "b"; } // switched mid-flight
    return Promise.resolve();
  };
  await attachSequence(q, "a", refresh2);
  assert.deepEqual(calls2, [120], "backfill cancelled after a pane switch");
});

// ---- key routing (extracted from the panel's marked block, DOM stubbed) ----
function loadKeyRoute() {
  const html = readFileSync(join(CAP, "ui", "panel.html"), "utf8");
  const m = html.match(/\/\* OASWEB_KEYROUTE_BEGIN[^*]*\*\/([\s\S]*?)\/\* OASWEB_KEYROUTE_END \*\//);
  assert.ok(m, "key-route block markers present in panel.html");
  // Stub the runtime surface: capture what the window keydown handler routes.
  const env = { activeEl: null, pane: { id: 1, sel: "inst-a", fastUntil: 0, keyQueue: "", keyFlush: null } };
  const sandbox = {
    handlers: {},
    window: null,
    document: { get activeElement() { return env.activeEl; } },
    focusedPane: () => env.pane,
    refreshTerm: () => {},
    fetch: () => Promise.resolve(),
    setTimeout: () => 1,   // hold flushes: routed bytes stay in pane.keyQueue
  };
  sandbox.window = { addEventListener: (type, fn) => { sandbox.handlers[type] = fn; } };
  const src = m[1] + "\nreturn { inEditable, keyToBytes, handlers };";
  const out = new Function(...Object.keys(sandbox), src)(...Object.values(sandbox));
  return { ...out, env };
}

test("oas-web key routing: logical pane focus, editable exclusion, Ctrl-B to session", () => {
  const K = loadKeyRoute();
  const ev = (key, mods = {}) => ({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
                                    preventDefault() { this.defaulted = true; }, ...mods });
  // plain key routes to the focused pane regardless of DOM focus
  K.env.activeEl = { tagName: "DIV" };            // e.g. focus sits on a button/body
  K.handlers.keydown(ev("a"));
  assert.equal(K.env.pane.keyQueue, "a", "printable key routed with non-editable DOM focus");
  // Ctrl-B goes to the session (tmux prefix), not swallowed
  K.handlers.keydown(ev("b", { ctrlKey: true }));
  assert.equal(K.env.pane.keyQueue, "a\x02", "Ctrl-B routed to the session as 0x02");
  // Cmd shortcuts stay in the browser
  K.handlers.keydown(ev("b", { metaKey: true }));
  assert.equal(K.env.pane.keyQueue, "a\x02", "Cmd-B not routed to the session");
  // editable controls keep their keys (filter box)
  K.env.activeEl = { tagName: "INPUT" };
  K.handlers.keydown(ev("x"));
  assert.equal(K.env.pane.keyQueue, "a\x02", "keys not stolen from an input");
  K.env.activeEl = { tagName: "DIV", isContentEditable: true };
  K.handlers.keydown(ev("x"));
  assert.equal(K.env.pane.keyQueue, "a\x02", "keys not stolen from contentEditable");
  // no selected session: nothing routed
  K.env.activeEl = null; K.env.pane = { id: 2, sel: null, keyQueue: "", keyFlush: null };
  K.handlers.keydown(ev("x"));
  assert.equal(K.env.pane.keyQueue, "", "no session selected → no routing");
});

function loadRenderer() {
  const html = readFileSync(join(CAP, "ui", "panel.html"), "utf8");
  const m = html.match(/\/\* OASWEB_RENDERER_BEGIN \*\/([\s\S]*?)\/\* OASWEB_RENDERER_END \*\//);
  assert.ok(m, "renderer block markers present in panel.html");
  const src = m[1] + "\nreturn { renderCapture, renderLine, freshAttr, cellWidth, clusterWidth, adaptBg };";
  const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return new Function("escapeHtml", src)(escapeHtml);
}
const R = loadRenderer();

// ---- manifest/API compatibility: the declared kernel floor must cover the
// core APIs the server calls (regression guard: calling a helper newer than
// the compatibility floor would silently break on accepted kernel versions).

test("oas-web manifest: compatibility floor covers the core APIs the server uses", () => {
  const manifest = JSON.parse(readFileSync(join(CAP, "oas.json"), "utf8"));
  // anchor the accepted syntax: only ">=x.y.z" is a meaningful floor here —
  // a looser parse would let an inverted/unknown range (e.g. "<=0.16.0") pass.
  const floor = /^>=(\d+\.\d+\.\d+)$/.exec(manifest.compatibility?.oas || "")?.[1];
  assert.ok(floor, "manifest declares a '>=x.y.z' compatibility floor");
  const src = readFileSync(join(CAP, "bin", "oas-web.mjs"), "utf8");
  // core API → kernel version it first shipped in
  const apiFloors = [
    ["listCapabilityAgents", "0.16.0"],
    ["findCapabilityAgent", "0.16.0"],
  ];
  const cmp = (a, b) => {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
    return 0;
  };
  for (const [api, minV] of apiFloors) {
    if (!src.includes(`core.${api}`)) continue;
    assert.ok(cmp(floor, minV) >= 0,
      `server calls core.${api} (needs oas >=${minV}) but manifest floor is >=${floor}`);
  }
});

test("oas-web renderer: each capture line is one row; history maps the screen start", () => {
  const d = { text: "h1\nh2\nscreen1\nscreen2\n", history: 2, size: { rows: 5, cols: 20, cx: 0, cy: 0, cursor: false } };
  const html = R.renderCapture(d);
  assert.equal((html.match(/class="trow"/g) || []).length, 4);
  // scroll marker sits between history and screen
  assert.ok(html.indexOf("h2") < html.indexOf("scrollmark"));
  assert.ok(html.indexOf("scrollmark") < html.indexOf("screen1"));
});

test("oas-web renderer: cursor lands at cursor_y within the screen even when tmux trims blank lines", () => {
  // 3 history rows + only 2 screen rows captured (trailing blanks trimmed); cursor at row 1, col 2
  const d = { text: "a\nb\nc\nprompt\n> hi\n", history: 3, size: { rows: 50, cols: 20, cx: 2, cy: 1, cursor: true } };
  const html = R.renderCapture(d);
  const rows = html.split('class="trow"');
  assert.ok(!rows[4].includes('class="cur"'), "no cursor on the first screen row");
  assert.ok(rows[5].includes('<span class="cur">h</span>'), "cursor on 'h' of '> hi'");
});

test("oas-web renderer: adaptBg folds near-default neutral backgrounds, keeps saturated highlights", () => {
  // near-neutral pale runs (pi's default-ish bg) fold on light, kept on dark
  assert.equal(R.adaptBg("rgb(232,240,232)", false), null, "pale neutral folds on light");
  assert.equal(R.adaptBg("rgb(238,238,238)", false), null, "near-white folds on light");
  assert.equal(R.adaptBg("rgb(232,240,232)", true), "rgb(232,240,232)", "pale run kept on dark");
  // near-neutral near-black folds on dark, kept on light
  assert.equal(R.adaptBg("rgb(10,13,18)", true), null, "near-black folds on dark");
  assert.equal(R.adaptBg("rgb(10,13,18)", false), "rgb(10,13,18)", "near-black kept on light");
  // saturated colors always pass through, regardless of luminance
  assert.equal(R.adaptBg("rgb(0,0,255)", true), "rgb(0,0,255)", "saturated blue kept on dark");
  assert.equal(R.adaptBg("rgb(255,255,0)", false), "rgb(255,255,0)", "saturated yellow kept on light");
  assert.equal(R.adaptBg("rgb(220,50,47)", false), "rgb(220,50,47)", "saturated red kept");
  // mid-luminance neutral highlights pass through
  assert.equal(R.adaptBg("rgb(128,128,128)", true), "rgb(128,128,128)");
  assert.equal(R.adaptBg("rgb(128,128,128)", false), "rgb(128,128,128)");
});

test("oas-web renderer: SGR colors, colon-form 256-color, and escaping", () => {
  const attr = R.freshAttr();
  const html = R.renderLine("\x1b[31mred\x1b[0m \x1b[38:5:196mX\x1b[m <&>", attr, null);
  assert.ok(html.includes('class="a31">red<'));
  assert.ok(/style="color:[^"]+">X</.test(html), "colon-form 38:5:196 renders a colored span");
  assert.ok(html.includes("&lt;&amp;&gt;"), "HTML escaped");
  assert.ok(!html.includes("\x1b"), "no raw escapes leak");
});

test("oas-web renderer: cursor column counts terminal cells (CJK wide, combining)", () => {
  assert.equal(R.cellWidth("漢".codePointAt(0)), 2);
  assert.equal(R.cellWidth(0x0301), 0); // combining acute
  // "漢字ab": cursor_x=4 is 'a' (two wide chars occupy cells 0-3)
  const html = R.renderLine("漢字ab", R.freshAttr(), 4);
  assert.ok(html.includes('<span class="cur">a</span>'));
  // combining char stays attached, cursor at col 1 of "e\u0301x" is 'x'
  const html2 = R.renderLine("e\u0301x", R.freshAttr(), 1);
  assert.ok(html2.includes('<span class="cur">x</span>'));
});

test("oas-web renderer: grapheme clusters — ZWJ emoji, VS16, keycaps, flags, kana voicing marks", () => {
  // tmux counts the whole ZWJ family emoji as one 2-cell cluster
  assert.equal(R.clusterWidth("👨\u200D👩\u200D👧\u200D👦"), 2);
  assert.equal(R.clusterWidth("❤\uFE0F"), 2);      // VS16 emoji presentation
  assert.equal(R.clusterWidth("1\uFE0F\u20E3"), 2); // keycap
  assert.equal(R.clusterWidth("🇪🇸"), 2);           // regional-indicator pair
  assert.equal(R.clusterWidth("は\u3099"), 2);      // kana + combining voicing mark (U+3099 is a Mark, not wide)
  assert.equal(R.clusterWidth("क\u094dष"), 2);      // Devanagari क्ष: two spacing bases + virama — widths sum
  assert.equal(R.clusterWidth("👍🏽"), 2);          // emoji + skin-tone modifier collapses to one 2-cell cluster
  assert.equal(R.clusterWidth("A🏽"), 3);          // stray modifier after a non-base: no collapse, widths sum (1+2)
  // cursor after the family emoji (cursor_x=2) lands on X
  const h1 = R.renderLine("👨\u200D👩\u200D👧\u200D👦X", R.freshAttr(), 2);
  assert.ok(h1.includes('<span class="cur">X</span>'), "ZWJ emoji is one 2-cell cluster");
  // cursor after ば (cursor_x=2) lands on X
  const h2 = R.renderLine("は\u3099X", R.freshAttr(), 2);
  assert.ok(h2.includes('<span class="cur">X</span>'), "voiced kana cluster is 2 cells");
  // cursor after क्ष (cursor_x=2) lands on X — multi-base cluster widths sum
  const h3 = R.renderLine("क\u094dषX", R.freshAttr(), 2);
  assert.ok(h3.includes('<span class="cur">X</span>'), "multi-base Devanagari cluster is 2 cells");
  // cursor after 👍🏽 (cursor_x=2) lands on X — modifier does not add cells
  const h4 = R.renderLine("👍🏽X", R.freshAttr(), 2);
  assert.ok(h4.includes('<span class="cur">X</span>'), "skin-tone emoji cluster is 2 cells");
  // cursor after A🏽 (cursor_x=3) lands on X — invalid modifier sequence sums per code point
  const h5 = R.renderLine("A🏽X", R.freshAttr(), 3);
  assert.ok(h5.includes('<span class="cur">X</span>'), "non-base + modifier grapheme is 3 cells");
});

// ---- HTTP origin guard regression (server must not crash on Origin: null) ----

test("oas-web server: POST origin guard rejects hostile/null origins without crashing", async () => {
  const port = 4000 + Math.floor(Math.random() * 2000);
  const proc = spawn(process.execPath, [join(CAP, "bin", "oas-web.mjs"), "start", "--port", String(port), "--dir", ROOT], { stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { await fetch(`http://127.0.0.1:${port}/api/panel`); up = true; } catch { /* retry */ }
    }
    assert.ok(up, "server came up");
    const post = (headers) => fetch(`http://127.0.0.1:${port}/api/keys/x`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: '{"data":"x"}' });
    assert.equal((await post({ origin: "null" })).status, 403, "Origin: null is rejected, not a crash");
    assert.equal((await post({ origin: "http://evil.com" })).status, 403);
    // fetch can't override Host — use a raw request for the rebinding case
    const hostStatus = await new Promise((resolve, reject) => {
      const rq = httpRequest({ host: "127.0.0.1", port, path: "/api/keys/x", method: "POST",
        headers: { "content-type": "application/json", host: "evil.com" } }, (rs) => resolve(rs.statusCode));
      rq.on("error", reject); rq.end('{"data":"x"}');
    });
    assert.equal(hostStatus, 403, "non-loopback Host is rejected");
    const ok = await post({ origin: `http://127.0.0.1:${port}` });
    assert.equal(ok.status, 404, "loopback origin passes the guard (unknown instance)");
    // server survived the malformed origin
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/panel`)).status, 200);
  } finally { proc.kill(); }
});

// ---- /api/agents + /api/spawn: roster of spawnable souls incl. capability agents ----

test("oas-web server: /api/agents lists persistent AND capability-defined agents; /api/spawn validates", async () => {
  // CI runs from a bare checkout where .agents/capabilities/installed/ is
  // gitignored — restore locked capabilities first (no-op when present) so
  // capability-defined agents (oas.review's reviewer) can resolve.
  execFileSync(process.execPath, [CLI, "install", "--dir", ROOT], { stdio: "ignore" });
  const port = 4000 + Math.floor(Math.random() * 2000);
  const proc = spawn(process.execPath, [join(CAP, "bin", "oas-web.mjs"), "start", "--port", String(port), "--dir", ROOT], { stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { await fetch(`http://127.0.0.1:${port}/api/panel`); up = true; } catch { /* retry */ }
    }
    assert.ok(up, "server came up");
    const d = await (await fetch(`http://127.0.0.1:${port}/api/agents`)).json();
    assert.ok(Array.isArray(d.agents) && d.agents.length, "agents listed");
    for (const a of d.agents) {
      assert.ok(a.name && a.agentsRoot, "each agent has name and agentsRoot");
      assert.ok(["persistent", "tmp", "capability"].includes(a.kind), `known kind (${a.kind})`);
    }
    // capability-defined agents (e.g. oas.review's reviewer) must appear — the
    // CLI can spawn them via findCapabilityAgent, so the panel must offer them.
    const reviewer = d.agents.find((a) => a.name === "reviewer");
    assert.ok(reviewer, "capability-defined 'reviewer' is listed");
    assert.equal(reviewer.kind, "capability");
    assert.equal(reviewer.capability, "oas.review");
    // /api/spawn input validation (no real spawn: bad root / unknown agent / bad body)
    const post = (body) => fetch(`http://127.0.0.1:${port}/api/spawn`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({})).status, 400, "missing fields → 400");
    assert.equal((await post({ agent: "reviewer", agentsRoot: "/tmp" })).status, 409, "foreign agentsRoot rejected");
    const root = d.agents[0].agentsRoot;
    assert.equal((await post({ agent: "no-such-agent", agentsRoot: root })).status, 409, "unknown agent rejected");
    // capability agent RESOLVES through the spawn path (attached mode fails on
    // workDir, proving findCapabilityAgent found the soul — not "unknown agent")
    const r = await post({ agent: "reviewer", agentsRoot: root });
    assert.equal(r.status, 409);
    const err = (await r.json()).error;
    assert.ok(!/unknown agent/.test(err), `reviewer resolves via findCapabilityAgent (got: ${err})`);
  } finally { proc.kill(); }
});

// ---- /api/file guard + /api/diff (desktop viewers) ----

test("oas-web file guard: traversal, prefix-sneak, and symlink escapes fail closed", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { sep, resolve } = await import("node:path");
  const src = extractBlock(join(CAP, "bin", "oas-web.mjs"), "FILEGUARD");
  const resolveGuardedFile = new Function("realpathSync", "resolve", "sep",
    `${src}; return resolveGuardedFile;`)(realpathSync, resolve, sep);
  const base = mkdtempSync(join(tmpdir(), "oasweb-guard-"));
  const root = join(base, "root"); mkdirSync(root);
  const evil = join(base, "root-evil"); mkdirSync(evil);
  writeFileSync(join(root, "ok.md"), "# hi");
  writeFileSync(join(evil, "secret"), "no");
  writeFileSync(join(base, "outside"), "no");
  symlinkSync(join(base, "outside"), join(root, "link"));
  assert.ok(resolveGuardedFile(join(root, "ok.md"), [root]).real, "in-root file allowed");
  assert.equal(resolveGuardedFile(join(root, "..", "outside"), [root]).code, 403, "dotdot traversal rejected");
  assert.equal(resolveGuardedFile(join(evil, "secret"), [root]).code, 403, "prefix-sneak sibling rejected");
  assert.equal(resolveGuardedFile(join(root, "link"), [root]).code, 403, "symlink escape rejected");
  assert.equal(resolveGuardedFile("relative/path", [root]).code, 400, "relative path rejected");
  assert.equal(resolveGuardedFile(join(root, "missing"), [root]).code, 404, "missing file is 404");
});

test("oas-web server: /api/file serves guarded text files with markdown flag; /api/diff 404s unknown instance", async () => {
  const port = 4000 + Math.floor(Math.random() * 2000);
  const proc = spawn(process.execPath, [join(CAP, "bin", "oas-web.mjs"), "start", "--port", String(port), "--dir", ROOT], { stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { await fetch(`http://127.0.0.1:${port}/api/panel`); up = true; } catch { /* retry */ }
    }
    assert.ok(up, "server came up");
    const get = (p) => fetch(`http://127.0.0.1:${port}${p}`);
    // outside every root → 403 (or 404 if the path doesn't exist — never 200)
    const denied = await get(`/api/file?path=${encodeURIComponent("/etc/hosts")}`);
    assert.ok([403, 404].includes(denied.status), `outside path rejected (${denied.status})`);
    assert.equal((await get("/api/file?path=relative.md")).status, 400, "relative path is 400");
    // a file inside a server-reported agents root must serve
    const ad = await (await get("/api/agents")).json();
    const roots = [...new Set(ad.agents.map((a) => a.agentsRoot))];
    const { readdirSync, existsSync: ex } = await import("node:fs");
    let served = false;
    for (const agentsRoot of roots) {
      for (const a of readdirSync(agentsRoot)) {
        const p = join(agentsRoot, a, "soul", "AGENTS.md");
        if (!ex(p)) continue;
        const r = await get(`/api/file?path=${encodeURIComponent(p)}`);
        if (r.status !== 200) continue;
        const d = await r.json();
        assert.equal(d.path, p);
      assert.equal(d.markdown, true, "md extension sets markdown flag");
      assert.ok(typeof d.content === "string" && d.content.length, "content served");
      assert.ok(d.name && d.size > 0 && d.mtime, "metadata present");
      served = true; break;
      }
      if (served) break;
    }
    assert.ok(served, "an agent AGENTS.md was served through the guard");
    assert.equal((await get("/api/diff/no-such-instance")).status, 404, "diff for unknown instance is 404");
  } finally { proc.kill(); }
});
