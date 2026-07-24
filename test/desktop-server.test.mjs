import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "oas.mjs");
const SRV = join(ROOT, "packages", "desktop", "server", "oas-web.mjs");

// ---- registry cache + attach sequencing (extracted marked blocks) ----
function extractBlock(file, marker) {
  const src = readFileSync(file, "utf8");
  const re = new RegExp(`\\/\\* OASWEB_${marker}_BEGIN[^*]*\\*\\/([\\s\\S]*?)\\/\\* OASWEB_${marker}_END \\*\\/`);
  const m = src.match(re);
  assert.ok(m, marker + " block markers present");
  return m[1];
}

test("desktop server: collect subcommand emits the roster snapshot JSON", () => {
  const out = execFileSync(process.execPath, [SRV, "collect", "--dir", ROOT],
    { encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  const parsed = JSON.parse(out);
  const ws = Object.values(parsed);
  assert.ok(ws.length >= 1, "at least one workspace in the snapshot");
  assert.ok(Array.isArray(ws[0].instances), "each workspace carries an instances array");
});

test("desktop server: key-send failures never leak the payload or its hex encoding", () => {
  const src = extractBlock(SRV, "KEYERR");
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













// ---- HTTP origin guard regression (server must not crash on Origin: null) ----

test("desktop server: POST origin guard rejects hostile/null origins without crashing", async () => {
  const port = 4000 + Math.floor(Math.random() * 2000);
  const proc = spawn(process.execPath, [SRV, "start", "--port", String(port), "--dir", ROOT], { stdio: "ignore" });
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

// ---- /api/brain/<agent>: soul + instance artifact map per the desktop-app contract ----

test("desktop server: brain: findInstance is workspace-scoped — same-named instance elsewhere doesn't mark this one running", () => {
  const src = extractBlock(SRV, "FINDINST");
  // two workspaces with a same-named instance: running in ws-b, stopped in ws-a
  const snapshot = { byWs: new Map([
    ["ws-a", { instances: [{ instance: "dev-1", running: false }] }],
    ["ws-b", { instances: [{ instance: "dev-1", running: true }, { instance: "only-b", running: true }] }],
  ]) };
  const findInstance = new Function("snapshot", "collectNow", "Date",
    src + "\nreturn findInstance;")(snapshot, () => snapshot.byWs, Date);
  // scoped lookups resolve within their workspace only — the regression:
  // /api/brain marked ws-a's stopped dev-1 as running via ws-b's twin
  assert.equal(findInstance("dev-1", "ws-a").running, false, "ws-a's dev-1 is stopped");
  assert.equal(findInstance("dev-1", "ws-b").running, true, "ws-b's dev-1 is running");
  assert.equal(findInstance("only-b", "ws-a"), undefined, "scoped lookup never leaks another workspace");
  // unscoped (legacy callers) still searches all workspaces
  assert.equal(findInstance("only-b").running, true);
  // the brain endpoint passes its resolved workspace id to findInstance
  const serverSrc = readFileSync(SRV, "utf8");
  assert.ok(/const live = findInstance\(name, ws\?\.id\)/.test(serverSrc),
    "brainData scopes its running lookup to the resolved workspace");
});

test("desktop server: brain: capability skill paths expand leaf AND parent-tree forms; local + package merge", () => {
  const src = extractBlock(SRV, "BRAINSKILLS");
  const { expandSkillPath, mergeSkills } = new Function("join",
    src + "\nreturn { expandSkillPath, mergeSkills };")((...p) => p.join("/"));
  const entry = (p) => ({ name: p.split("/").pop(), path: p + "/SKILL.md", description: "" });
  const list = (p) => [entry(p + "/a"), entry(p + "/b")];
  // leaf form: the path itself contains SKILL.md → one skill
  assert.deepEqual(expandSkillPath("/cap/skills/code-review", (f) => f === "/cap/skills/code-review/SKILL.md", list, entry)
    .map((s) => s.name), ["code-review"]);
  // parent-tree form (`skills: ["skills"]`): no SKILL.md at the path → list children
  assert.deepEqual(expandSkillPath("/cap/skills", () => false, list, entry).map((s) => s.name), ["a", "b"]);
  // merge: local soul skill wins on duplicate names; result sorted
  const merged = mergeSkills(
    [{ name: "dup", path: "/soul/skills/dup/SKILL.md" }, { name: "z", path: "/soul/skills/z/SKILL.md" }],
    [{ name: "dup", path: "/cap/skills/dup/SKILL.md" }, { name: "a", path: "/cap/skills/a/SKILL.md" }]);
  assert.deepEqual(merged.map((s) => s.name), ["a", "dup", "z"]);
  assert.equal(merged.find((s) => s.name === "dup").path, "/soul/skills/dup/SKILL.md", "local soul wins duplicates");
});

test("desktop harness: every shipped view has a tab in the shared harness", () => {
  // README claims a single shared harness for ALL views — enforce it: each
  // views/*.mjs exporting the view contract (mount) must be reachable from a
  // harness.html tab (regression: Brain shipped with a standalone harness).
  const rendererDir = join(ROOT, "packages", "desktop", "renderer");
  const viewsDir = join(rendererDir, "views");
  const views = readdirSync(viewsDir).filter((f) => f.endsWith(".mjs"))
    .filter((f) => /export (async )?function mount\(/.test(readFileSync(join(viewsDir, f), "utf8")))
    .map((f) => f.replace(/\.mjs$/, ""));
  assert.ok(views.length >= 5, `shipped views found (got: ${views.join(", ")})`);
  const harness = readFileSync(join(rendererDir, "harness.html"), "utf8");
  for (const v of views)
    assert.ok(harness.includes(`data-view="${v}"`), `harness.html has a tab for the "${v}" view`);
  // and no stray standalone harnesses reappear next to the shared one
  const strays = readdirSync(rendererDir).filter((f) => /^dev-.*\.(html|mjs)$/.test(f));
  assert.deepEqual(strays, [], "no standalone dev-* harness files alongside the shared harness");
});


test("desktop server: /api/brain returns the contract shape with absolute paths", async () => {
  // capability agents (reviewer) need installed capabilities — restore first (no-op when present)
  execFileSync(process.execPath, [CLI, "install", "--dir", ROOT], { stdio: "ignore" });
  const port = 4000 + Math.floor(Math.random() * 2000);
  const proc = spawn(process.execPath, [SRV, "start", "--port", String(port), "--dir", ROOT], { stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { await fetch(`http://127.0.0.1:${port}/api/panel`); up = true; } catch { /* retry */ }
    }
    assert.ok(up, "server came up");
    // pick a real agent from /api/agents (persistent souls have a soul/ dir)
    const agents = (await (await fetch(`http://127.0.0.1:${port}/api/agents`)).json()).agents;
    const target = agents.find((a) => a.kind === "persistent") || agents[0];
    assert.ok(target, "an agent exists to inspect");
    const d = await (await fetch(`http://127.0.0.1:${port}/api/brain/${target.name}`)).json();
    assert.equal(d.agent, target.name);
    assert.equal(typeof d.description, "string");
    assert.ok(d.agentsRoot.startsWith("/"), "agentsRoot is absolute");
    // soul block: AGENTS.md path, skills [{name,path,description}], knowledge {index,tree}
    assert.ok(d.soul && typeof d.soul === "object", "soul block present");
    if (d.soul.agentsMd) assert.ok(d.soul.agentsMd.startsWith("/") && d.soul.agentsMd.endsWith("AGENTS.md"));
    assert.ok(Array.isArray(d.soul.skills));
    for (const s of d.soul.skills) {
      assert.ok(s.name && s.path.startsWith("/") && s.path.endsWith("SKILL.md"), "skill has name + absolute SKILL.md path");
      assert.equal(typeof s.description, "string");
    }
    assert.ok(d.soul.knowledge && Array.isArray(d.soul.knowledge.tree));
    for (const p of d.soul.knowledge.tree) assert.ok(p.startsWith("/") && p.endsWith(".md"), "knowledge tree entries are absolute .md paths");
    if (d.soul.knowledge.index) assert.ok(d.soul.knowledge.tree.includes(d.soul.knowledge.index), "index is part of the tree");
    // instances block
    assert.ok(Array.isArray(d.instances));
    for (const i of d.instances) {
      assert.ok(i.instance && i.home.startsWith("/"), "instance has name + absolute home");
      assert.equal(typeof i.running, "boolean");
      assert.ok(Array.isArray(i.skills) && Array.isArray(i.notes));
      for (const k of ["agentsMd", "state", "task"]) if (i[k] !== null) assert.ok(i[k].startsWith(i.home), `${k} lives under the instance home`);
      for (const n of i.notes) assert.ok(n.startsWith(i.home) && n.endsWith(".md"));
    }
    // unknown agent → 404; hostile agent name never becomes a path probe
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/brain/no-such-agent`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/brain/..%2F..%2Fetc`)).status, 404, "traversal-shaped names don't match the route");
    // capability-defined agents: their skills are declared at the PACKAGE level
    // (manifest `skills:` paths), not under the soul dir — the brain must show
    // the canonical skill set (regression: reviewer reported soul.skills: []).
    const rev = await (await fetch(`http://127.0.0.1:${port}/api/brain/reviewer`)).json();
    assert.ok(rev.soul, "capability agent resolves a brain");
    const skillNames = rev.soul.skills.map((s) => s.name);
    assert.ok(skillNames.includes("code-review") && skillNames.includes("security-review"),
      `capability agent carries its package skills (got: ${skillNames.join(", ")})`);
    for (const s of rev.soul.skills) assert.ok(s.path.startsWith("/") && s.path.endsWith("SKILL.md"));
  } finally { proc.kill(); }
});

// ---- /api/agents + /api/spawn: roster of spawnable souls incl. capability agents ----

test("desktop server: /api/agents lists persistent AND capability-defined agents; /api/spawn validates", async () => {
  // CI runs from a bare checkout where .agents/capabilities/installed/ is
  // gitignored — restore locked capabilities first (no-op when present) so
  // capability-defined agents (oas.review's reviewer) can resolve.
  execFileSync(process.execPath, [CLI, "install", "--dir", ROOT], { stdio: "ignore" });
  const port = 4000 + Math.floor(Math.random() * 2000);
  const proc = spawn(process.execPath, [SRV, "start", "--port", String(port), "--dir", ROOT], { stdio: "ignore" });
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
    // capability agent RESOLVES through the spawn path: validation passes
    // (not "unknown agent") and the mutation boundary answers with the
    // stable cli-unavailable degradation (503) — the app never bundles a
    // kernel; spawning requires a compatible installed oas CLI.
    const r = await post({ agent: "reviewer", agentsRoot: root });
    assert.equal(r.status, 503, "mutation without a CLI adapter degrades, not crashes");
    const body = await r.json();
    assert.ok(!/unknown agent/.test(body.error), `reviewer resolves via findCapabilityAgent (got: ${body.error})`);
    assert.equal(body.code, "cli-unavailable", "stable degradation code for the UI");
  } finally { proc.kill(); }
});

// ---- /api/file guard (desktop viewers) ----

test("desktop server: file guard: traversal, prefix-sneak, and symlink escapes fail closed", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { sep, resolve } = await import("node:path");
  const src = extractBlock(SRV, "FILEGUARD");
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

test("desktop server: /api/file serves guarded text files with markdown flag", async () => {
  const port = 4000 + Math.floor(Math.random() * 2000);
  const proc = spawn(process.execPath, [SRV, "start", "--port", String(port), "--dir", ROOT], { stdio: "ignore" });
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
  } finally { proc.kill(); }
});

test("desktop server: hostile Host header is rejected on GET file APIs (DNS rebinding)", async () => {
  const port = 4000 + Math.floor(Math.random() * 2000);
  const proc = spawn(process.execPath, [SRV, "start", "--port", String(port), "--dir", ROOT], { stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { await fetch(`http://127.0.0.1:${port}/api/panel`); up = true; } catch { /* retry */ }
    }
    assert.ok(up, "server came up");
    const rawGet = (path) => new Promise((resolve, reject) => {
      const rq = httpRequest({ host: "127.0.0.1", port, path, method: "GET",
        headers: { host: "attacker.example" } }, (rs) => resolve(rs.statusCode));
      rq.on("error", reject); rq.end();
    });
    assert.equal(await rawGet(`/api/file?path=${encodeURIComponent(join(ROOT, "README.md"))}`), 403, "rebinding host cannot read files");
    assert.equal(await rawGet("/api/panel"), 403, "rebinding host cannot enumerate roots");
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/panel`)).status, 200, "loopback host still serves");
  } finally { proc.kill(); }
});

// ---- local-agents symlink escape: an untrusted workspace must not widen /api/file ----

test("desktop server: a symlinked local-agents sibling never becomes an /api/file root (403)", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  // A valid-looking workspace whose local-agents is a SYMLINK to a secret
  // directory outside it — realpath-based guards would canonicalize the
  // link and authorize its TARGET (review 4e2667b blocker).
  const secret = mkdtempSync(join(tmpdir(), "oasweb-secret-"));
  writeFileSync(join(secret, "secret.md"), "# TOP-SECRET-LOCAL-AGENTS");
  const scope = mkdtempSync(join(tmpdir(), "oasweb-symlink-ws-"));
  mkdirSync(join(scope, "agents", "dev", "soul"), { recursive: true });
  writeFileSync(join(scope, "agents", "dev", "soul", "soul.yaml"), "name: dev\ndescription: d\n");
  writeFileSync(join(scope, "agents", "dev", "soul", "AGENTS.md"), "# dev\n");
  symlinkSync(secret, join(scope, "local-agents"));
  const port = 4000 + Math.floor(Math.random() * 2000);
  const proc = spawn(process.execPath, [SRV, "start", "--port", String(port), "--dir", scope], { stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { await fetch(`http://127.0.0.1:${port}/api/panel`); up = true; } catch { /* retry */ }
    }
    assert.ok(up, "server came up");
    const get = (p) => fetch(`http://127.0.0.1:${port}${p}`);
    // the symlink target must NOT be readable through the sibling root
    for (const path of [join(scope, "local-agents", "secret.md"), join(secret, "secret.md")]) {
      const r = await get(`/api/file?path=${encodeURIComponent(path)}`);
      assert.ok([403, 404].includes(r.status), `symlinked local-agents target rejected (${path} → ${r.status})`);
      if (r.status === 200) assert.fail("secret served through a symlinked local-agents root");
    }
    // a legitimate file inside the real agents root still serves
    const okR = await get(`/api/file?path=${encodeURIComponent(join(scope, "agents", "dev", "soul", "AGENTS.md"))}`);
    assert.equal(okR.status, 200, "real agents-root files still serve");
    // and a REAL (non-symlink) local-agents sibling still works end to end
    const scope2 = mkdtempSync(join(tmpdir(), "oasweb-real-local-"));
    mkdirSync(join(scope2, "agents"), { recursive: true });
    mkdirSync(join(scope2, "local-agents", "loc", "soul"), { recursive: true });
    writeFileSync(join(scope2, "local-agents", "loc", "soul", "soul.yaml"), "name: loc\n");
    writeFileSync(join(scope2, "local-agents", "loc", "soul", "AGENTS.md"), "# loc\n");
    const port2 = 4000 + Math.floor(Math.random() * 2000);
    const proc2 = spawn(process.execPath, [SRV, "start", "--port", String(port2), "--dir", scope2], { stdio: "ignore" });
    try {
      let up2 = false;
      for (let i = 0; i < 40 && !up2; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try { await fetch(`http://127.0.0.1:${port2}/api/panel`); up2 = true; } catch { /* retry */ }
      }
      assert.ok(up2, "second server came up");
      const r2 = await fetch(`http://127.0.0.1:${port2}/api/file?path=${encodeURIComponent(join(scope2, "local-agents", "loc", "soul", "AGENTS.md"))}`);
      assert.equal(r2.status, 200, "REAL local-agents sibling files serve (local souls stay first-class)");
    } finally { proc2.kill(); }
  } finally { proc.kill(); }
});

// ---- tmux target anchoring: prefix-match hazard (reviewer-death bug class) ----

test("desktop server: tmux targets: exact-match anchoring fails closed for reads AND writes", (t) => {
  const src = extractBlock(SRV, "TMUXTGT");
  const tmuxTarget = new Function(`${src}; return tmuxTarget;`)();
  // component validation: separator/anchor injection rejected
  assert.equal(tmuxTarget({ tmux: { session: "s1", window: "reviewer-1" } }), "=s1:=reviewer-1");
  for (const bad of ["a:b", "a=b", "", "a b"]) {
    assert.throws(() => tmuxTarget({ tmux: { session: bad, window: "w" } }), `session "${bad}" rejected`);
    assert.throws(() => tmuxTarget({ tmux: { session: "s", window: bad } }), `window "${bad}" rejected`);
  }
  // live half: reviewer-1 ABSENT, reviewer-15abc PRESENT — the unanchored
  // target would prefix-match the live window; the anchored one must error.
  const session = `oaswebtgt${process.pid}`;
  try {
    execFileSync("tmux", ["new-session", "-d", "-s", session, "-n", "reviewer-15abc"], { timeout: 4000 });
  } catch { t.skip("tmux unavailable"); return; }
  try {
    const anchored = tmuxTarget({ tmux: { session, window: "reviewer-1" } });
    const unanchored = `${session}:reviewer-1`;
    // sanity: the hazard is real — unanchored prefix-match hits the live window
    const hit = execFileSync("tmux", ["display-message", "-p", "-t", unanchored, "#{window_name}"],
      { encoding: "utf8", timeout: 4000 }).trim();
    assert.equal(hit, "reviewer-15abc", "unanchored target prefix-matches the wrong live window");
    // read path fails closed
    assert.throws(() => execFileSync("tmux", ["capture-pane", "-p", "-t", anchored], { stdio: "pipe", timeout: 4000 }),
      "anchored capture-pane errors instead of exposing the wrong pane");
    assert.throws(() => execFileSync("tmux", ["list-panes", "-t", anchored, "-F", "#{pane_width}"], { stdio: "pipe", timeout: 4000 }),
      "anchored list-panes (paneInfo path) errors");
    // NOTE display-message -p -t <missing> silently falls back to a default
    // context instead of erroring — that's why paneInfo uses list-panes.
    // write path fails closed
    assert.throws(() => execFileSync("tmux", ["send-keys", "-t", anchored, "-H", "78"], { stdio: "pipe", timeout: 4000 }),
      "anchored send-keys errors instead of typing into the wrong window");
    assert.throws(() => execFileSync("tmux", ["send-keys", "-t", anchored, "C-c"], { stdio: "pipe", timeout: 4000 }),
      "anchored interrupt errors");
    // the exact-name window still works end to end
    const ok = tmuxTarget({ tmux: { session, window: "reviewer-15abc" } });
    execFileSync("tmux", ["send-keys", "-t", ok, "-H", "23"], { timeout: 4000 }); // harmless '#'
    assert.ok(execFileSync("tmux", ["capture-pane", "-p", "-t", ok], { encoding: "utf8", timeout: 4000 }) !== undefined);
  } finally {
    try { execFileSync("tmux", ["kill-session", "-t", `=${session}`], { timeout: 4000 }); } catch { /* already gone */ }
  }
});

test("desktop server: paneInfo: geometry comes from the ACTIVE pane, same pane capture/send target", (t) => {
  // Drive the REAL paneInfo (extracted marker block, with the real
  // tmuxTarget in scope) against a two-pane fixture where the active pane
  // is index 1 with a distinct width — reverting the -f '#{pane_active}'
  // filter makes this fail (row 0's width would be reported).
  const tgtSrc = extractBlock(SRV, "TMUXTGT");
  const piSrc = extractBlock(SRV, "PANEINFO");
  const paneInfo = new Function("execFileSync", `${tgtSrc}${piSrc}; return paneInfo;`)(execFileSync);
  const session = `oaswebpane${process.pid}`;
  try {
    execFileSync("tmux", ["new-session", "-d", "-s", session, "-n", "w1", "-x", "101", "-y", "30"], { timeout: 4000 });
  } catch { t.skip("tmux unavailable"); return; }
  try {
    const target = `=${session}:=w1`;
    execFileSync("tmux", ["split-window", "-h", "-t", target], { timeout: 4000 });
    execFileSync("tmux", ["resize-pane", "-t", `${target}.1`, "-x", "30"], { timeout: 4000 });
    execFileSync("tmux", ["select-pane", "-t", `${target}.1`], { timeout: 4000 });
    // print some output into pane 1 so its history/cursor differ from pane 0
    execFileSync("tmux", ["send-keys", "-t", `${target}.1`, "printf 'a\\nb\\nc\\n'", "Enter"], { timeout: 4000 });
    const paneW = (idx) => Number(execFileSync("tmux", ["display-message", "-p", "-t", `${target}.${idx}`, "#{pane_width}"],
      { encoding: "utf8", timeout: 4000 }).trim());
    const w0 = paneW(0), w1 = paneW(1);
    assert.notEqual(w0, w1, "fixture: the two panes have distinct widths");
    const info = paneInfo({ tmux: { session, window: "w1" } });
    assert.equal(info.size.cols, w1, "paneInfo reports the ACTIVE pane's width (pane 1), not row 0's");
    // same pane capture-pane operates on: the window target's active pane
    const capW = Number(execFileSync("tmux", ["display-message", "-p", "-t", `${target}.1`, "#{pane_width}"],
      { encoding: "utf8", timeout: 4000 }).trim());
    assert.equal(info.size.cols, capW, "geometry matches the pane capture/send target");
    // fail-closed path of the real function: missing window falls back to defaults
    const missing = paneInfo({ tmux: { session, window: "nope" } });
    assert.equal(missing.size.cols, 80, "missing window returns the safe default, never another pane");
  } finally {
    try { execFileSync("tmux", ["kill-session", "-t", `=${session}`], { timeout: 4000 }); } catch { /* gone */ }
  }
});
