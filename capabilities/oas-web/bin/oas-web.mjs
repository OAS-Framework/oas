#!/usr/bin/env node
/**
 * oas-web — local web control panel ("the Slack of the agents").
 *
 *   oas web start [--port <n>] [--dir <agents-root-context>] [--open]
 *
 * A zero-dependency localhost HTTP server:
 *   GET  /                          the panel UI (single HTML file)
 *   GET  /api/panel                 roster JSON (instances, git, task, tmux state)
 *   GET  /api/agents                available agents (souls) per workspace root
 *   POST /api/spawn                 { agent, agentsRoot, task?, purpose? } → spawn an instance
 *   GET  /api/session/<instance>?lines=n   ANSI pane capture of the live session
 *   POST /api/keys/<instance>       { data } → raw key bytes into the session (no Enter)
 *   POST /api/interrupt/<instance>  sends Ctrl-C (Escape for pi/claude prompts stays manual)
 *   GET  /api/jira/<instance>       epic + Agent Roster for instances with oas.jira meta
 *
 * SECURITY: binds 127.0.0.1 ONLY. This process can type into your terminals.
 * Interaction model: terminal-direct (tmux send-keys / capture-pane) — the
 * feel of sitting at the agent's terminal; identical for pi and claude runs.
 */
import { createServer } from "node:http";
import { execFile, execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Kernel root: in-tree (../../..) or resolved via `oas root` for marketplace installs. */
const FRAMEWORK_ROOT = (() => {
  const rel = join(HERE, "..", "..", "..");
  if (existsSync(join(rel, "lib", "core.mjs"))) return rel;
  try {
    const root = execSync("oas root", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }).trim();
    if (root && existsSync(join(root, "lib", "core.mjs"))) return root;
  } catch { /* fall through */ }
  return rel;
})();

const args = process.argv.slice(2);
const sub = args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : undefined;
};
const flagAll = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] && !args[i + 1].startsWith("--") ? [args[i + 1]] : []));

// "collect" is a hidden helper: the serving process spawns `oas-web.mjs
// collect --dir ...` so the expensive synchronous roster collection runs in a
// child and never blocks the event loop (see the snapshot refresher below).
if (sub !== "start" && sub !== "collect") {
  console.error("usage: oas web start [--port <n>] [--dir <workspace>]... [--open]  (repeat --dir for multiple workspaces)");
  process.exit(1);
}

const core = await import(pathToFileURL(join(FRAMEWORK_ROOT, "lib", "core.mjs")).href);
const model = await import(pathToFileURL(join(FRAMEWORK_ROOT, "lib", "control-pane", "model.mjs")).href);

/** Workspaces in view. Each --dir registers one (repeatable); no --dir means
 * the cwd. Every context resolves to its team scope (or config scope) so the
 * switcher shows deployment-level entries; duplicates collapse. */
const ctxs = (flagAll("dir").length ? flagAll("dir") : [process.cwd()]).map((d) => resolve(String(d)));
const port = Number(flag("port") || 4820);
const DEBUG = flag("debug") === true || process.env.OASWEB_DEBUG === "1";

function workspaceEntry(ctx) {
  let team, roots = [], scope = ctx;
  try {
    const r = core.resolveOasConfig(ctx);
    if (r.team) { team = r.team; scope = r.team.scope; roots = core.teamAgentRoots(r.team.scope); }
    else {
      const level = r.chain?.find((c) => c._level !== process.env.HOME)?._level;
      if (level) scope = level;
    }
  } catch { /* fall through to local root */ }
  if (!roots.length) { try { roots = [core.ensureRoot(ctx)]; } catch { roots = []; } }
  return { id: scope, name: scope.split("/").pop(), scope, team: team || null, roots };
}
function workspaces() {
  const map = new Map();
  for (const ctx of ctxs) { const w = workspaceEntry(ctx); if (!map.has(w.id)) map.set(w.id, w); }
  return [...map.values()];
}
function workspaceById(id) {
  return workspaces().find((w) => w.id === id) || workspaces()[0];
}

function panelData(wsId) {
  const all = workspaces();
  const ws = wsId ? workspaceById(wsId) : all[0];
  const instances = [];
  for (const root of ws?.roots || []) {
    try {
      const data = model.collectControlPane(root);
      for (const inst of data.instances) instances.push({ ...inst, agentsRoot: root });
    } catch { /* one broken root must not hide the rest */ }
  }
  instances.sort((a, b) => (a.running === b.running ? String(a.instance).localeCompare(b.instance) : a.running ? -1 : 1));
  return {
    workspace: ws ? { id: ws.id, name: ws.name, team: ws.team } : null,
    workspaces: all.map((w) => ({ id: w.id, name: w.name, team: w.team })),
    team: ws?.team || null,
    generatedAt: new Date().toISOString(),
    running: instances.filter((i) => i.running).length,
    instances: instances.map((i) => ({
      instance: i.instance, agent: i.agent, description: i.description,
      repo: i.repo, work: i.work, branch: i.branch || null, runtime: i.runtime || "pi",
      model: i.model || null, running: i.running, createdAt: i.createdAt,
      home: i.home, agentsRoot: i.agentsRoot,
      workspace: dirname(i.agentsRoot), repoName: (i.repo || dirname(i.agentsRoot)).split("/").pop(),
      parentInstance: i.parentInstance || null,
      tmux: i.tmux, git: i.git, task: i.task, next: i.next,
      jira: i.capabilityMeta?.["oas.jira"] || null,
      team: i.team || null,
    })),
  };
}

/** Available agents (souls) of a workspace — what `oas spawn <agent>` could
 * start. Same kernel seams as the CLI: core.listAgents per agents root, plus
 * capability-defined agents (packages' `agents:` souls) active in the root's
 * context — the CLI resolves those via findCapabilityAgent. */
function agentsData(wsId) {
  const ws = wsId ? workspaceById(wsId) : workspaces()[0];
  const agents = [];
  for (const root of ws?.roots || []) {
    const context = dirname(root); // the workspace/repo owning this agents root
    const pushAgent = (a) => agents.push({
      name: a.name, description: a.description || "", kind: a.kind || "persistent",
      work: a.work || "checkout", runtime: a.runtime || "pi", model: a.model || null,
      repo: a.repo || null, capability: a.capability || null, agentsRoot: root,
      workspace: context, repoName: resolve(context, a.repo || ".").split("/").pop(),
    });
    try {
      const local = core.listAgents(root);
      const seen = new Set(local.map((a) => a.name));
      for (const a of local) pushAgent(a);
      // Capability-defined agents (kind "capability") — full soul via the same
      // resolver the CLI's spawn fallback uses.
      for (const c of core.listCapabilityAgents(context)) {
        if (seen.has(c.name)) continue;
        seen.add(c.name);
        const soul = core.findCapabilityAgent(context, root, c.name);
        if (soul) pushAgent(soul);
      }
    } catch { /* one broken root must not hide the rest */ }
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));
  return { workspace: ws ? { id: ws.id, name: ws.name } : null, agents };
}

/** Spawn an instance of an available agent. Default is NO TASK — the instance
 * comes up awaiting instruction (the user talks to it through the panel). */
function spawnAgent({ agent, agentsRoot, task, purpose }) {
  const name = String(agent || "");
  const root = resolve(String(agentsRoot || ""));
  // agentsRoot must be one of the workspace roots this server was started for —
  // never spawn into an arbitrary caller-supplied directory.
  const known = workspaces().flatMap((w) => w.roots);
  if (!known.some((r) => resolve(r) === root)) throw new Error(`unknown agents root "${agentsRoot}"`);
  const def = core.findAgent(root, name)
    // CLI parity: capability-defined agents (a package's `agents:` soul active
    // in this context) resolve via findCapabilityAgent and home locally.
    || core.findCapabilityAgent(dirname(root), root, name);
  if (!def) throw new Error(`unknown agent "${name}"`);
  const r = core.spawnInstance(root, def, {
    purpose: purpose ? String(purpose) : undefined,
    task: task ? String(task) : "",
    repo: def.repo || core.defaultRepo(core.workspaceOf(root)) || undefined,
  });
  return { instance: r.instance, agent: r.agent, home: r.home, work: r.work,
           branch: r.branch || null, launched: r.launched, warnings: r.warnings || [] };
}

/* ── Non-blocking roster snapshot ──
   collectControlPane is synchronous and expensive (git status across every
   agent root — 200-600ms on team workspaces). Running it inside the serving
   process froze the event loop, so a roster poll landing between two
   keystrokes stalled /api/keys and the echo fetch — the panel felt laggy no
   matter how fast the key path itself was. The server therefore NEVER
   collects: a child process (`oas-web.mjs collect`) refreshes a snapshot in
   the background every few seconds, and all requests are served from it. */
let snapshot = { at: 0, byWs: new Map() };   // wsId -> panelData
let collecting = false;
function collectNow() {
  const byWs = new Map();
  for (const w of workspaces()) byWs.set(w.id, panelData(w.id));
  return byWs;
}
if (sub === "collect") {
  process.stdout.write(JSON.stringify(Object.fromEntries(collectNow())));
  process.exit(0);
}
function refreshSnapshot() {
  if (collecting) return;
  collecting = true;
  const argv = [fileURLToPath(import.meta.url), "collect", ...ctxs.flatMap((d) => ["--dir", d])];
  execFile(process.execPath, argv, { encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
    collecting = false;
    if (err) { if (DEBUG) console.log(`[snapshot] collect failed: ${err.message}`); return; }
    try {
      const parsed = JSON.parse(stdout);
      snapshot = { at: Date.now(), byWs: new Map(Object.entries(parsed)) };
    } catch (e) { if (DEBUG) console.log(`[snapshot] bad collect output: ${e.message}`); }
  });
}
function snapshotPanel(wsId) {
  const ids = [...snapshot.byWs.keys()];
  const id = wsId && snapshot.byWs.has(wsId) ? wsId : ids[0];
  return id ? snapshot.byWs.get(id) : null;
}
function findInstance(name) {
  if (!snapshot.byWs.size) snapshot = { at: Date.now(), byWs: collectNow() }; // cold start, once
  for (const d of snapshot.byWs.values()) {
    const hit = d.instances.find((i) => i.instance === name);
    if (hit) return hit;
  }
  return undefined;
}

function tmuxTarget(inst) { return `${inst.tmux.session}:${inst.tmux.window}`; }

function capture(inst, lines) {
  try {
    // No -J: joining wrapped rows would break the row-per-line grid mapping
    // (cursor_y is physical). Each output line is exactly one pane row.
    return execFileSync("tmux", ["capture-pane", "-p", "-e", "-t", tmuxTarget(inst), "-S", `-${Math.max(16, lines)}`],
      { encoding: "utf8", timeout: 4000 });
  } catch { return ""; }
}

/** Pane geometry + cursor + history depth in ONE tmux round-trip (these were
 * two display-message calls — attach latency is round-trip-bound).
 * cursor x/y are 0-based within the visible pane; "visible" reflects
 * cursor_flag and copy-mode (in copy mode the live cursor is not where
 * typing lands). history_size lets the client map capture lines to screen
 * rows deterministically (cursor row = history + cursor_y). */
function paneInfo(inst) {
  try {
    const out = execFileSync("tmux", ["display-message", "-p", "-t", tmuxTarget(inst),
      "#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{cursor_flag} #{pane_in_mode} #{history_size}"],
      { encoding: "utf8", timeout: 4000 }).trim().split(/\s+/).map(Number);
    return { size: { cols: out[0] || 80, rows: out[1] || 24, cx: out[2] || 0, cy: out[3] || 0,
                     cursor: out[4] === 1 && out[5] !== 1 },
             history: out[6] || 0 };
  } catch { return { size: { cols: 80, rows: 24, cx: 0, cy: 0, cursor: false }, history: 0 }; }
}

/** Raw keystroke passthrough: bytes from the browser terminal go straight into
 * the pane via send-keys -H (hex bytes) — no key-name interpretation, no Enter. */
function sendKeys(inst, data, paste = false) {
  const s = String(data);
  if (paste || s.length > 512) {
    // Pastes (any size) and large payloads go through a tmux buffer as ONE
    // bracketed paste — raw carriage returns via send-keys would let a shell
    // or TUI submit/execute each line separately.
    execFileSync("tmux", ["load-buffer", "-b", "oaswebk", "-"], { input: s.replace(/\r\n?/g, "\n"), timeout: 4000 });
    execFileSync("tmux", ["paste-buffer", "-p", "-d", "-b", "oaswebk", "-t", tmuxTarget(inst)], { timeout: 4000 });
    return;
  }
  const bytes = [...Buffer.from(s, "utf8")].map((b) => b.toString(16).padStart(2, "0"));
  if (!bytes.length) return;
  // chunk to keep argv small
  for (let i = 0; i < bytes.length; i += 256) {
    execFileSync("tmux", ["send-keys", "-t", tmuxTarget(inst), "-H", ...bytes.slice(i, i + 256)], { timeout: 4000 });
  }
}

function sendInterrupt(inst) {
  execFileSync("tmux", ["send-keys", "-t", tmuxTarget(inst), "C-c"], { timeout: 4000 });
}

/* OASWEB_KEYERR_BEGIN — safe error shaping for the /api/keys failure path,
   extracted by tests. exec errors embed the child argv (hex-encoded
   keystrokes) in e.message; only exit code and signal are safe to surface. */
function keySendError(e) {
  const code = e && e.code !== undefined ? String(e.code) : "unknown";
  const signal = (e && e.signal) || "none";
  return { code, signal,
           log: `[keys] FAILED code=${code} signal=${signal}`,
           http: { error: `send-keys failed (code ${code}) — see the terminal directly` } };
}
/* OASWEB_KEYERR_END */

// ---- Chat transcript: parse the runtime's session log into structured turns ----
// pi:     ~/.pi/agent/sessions/--<home with / -> ->--/<ts>_<id>.jsonl
// claude: ~/.claude*/projects/<cwd with / -> ->/<uuid>.jsonl
function latestFile(dir, filter = () => true) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl") && filter(f))
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch { return undefined; }
}
function sessionFileFor(inst) {
  const home = inst.home;
  if ((inst.runtime || "pi") === "pi") {
    const dir = join(homedir(), ".pi", "agent", "sessions", `-${home.replace(/\//g, "-")}--`);
    return { file: latestFile(dir), kind: "pi" };
  }
  const enc = home.replace(/\//g, "-");
  for (const base of [".claude", ".claude-personal", ".claude-work"]) {
    const dir = join(homedir(), base, "projects", enc);
    const f = latestFile(dir);
    if (f) return { file: f, kind: "claude" };
  }
  return { file: undefined, kind: "claude" };
}
const asText = (blocks, type = "text", key = "text") =>
  (Array.isArray(blocks) ? blocks : []).filter((b) => b?.type === type).map((b) => b[key] || "").join("\n");

export function parseTranscript(lines, kind) {
  const turns = [];
  const callIndex = new Map(); // toolCallId -> tool entry
  const push = (t) => { turns.push(t); return t; };
  for (const line of lines) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    const msg = kind === "pi" ? (d.type === "message" ? d.message : undefined)
                              : (d.type === "user" || d.type === "assistant" ? d.message : undefined);
    if (!msg) continue;
    const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content || "") }];
    if (msg.role === "user") {
      // claude folds tool_result into user messages; keep real user text only
      const toolResults = content.filter((b) => b.type === "tool_result");
      for (const r of toolResults) {
        const entry = callIndex.get(r.tool_use_id);
        if (entry) entry.result = (typeof r.content === "string" ? r.content : asText(r.content)).slice(0, 4000);
      }
      const text = asText(content).trim();
      if (text) push({ role: "user", text, ts: msg.timestamp || d.timestamp });
    } else if (msg.role === "assistant") {
      const text = asText(content).trim();
      const thinking = asText(content, "thinking", "thinking").trim();
      const tools = [];
      for (const b of content) {
        if (b.type !== "toolCall" && b.type !== "tool_use") continue;
        const entry = { id: b.id, name: b.name, args: b.arguments || b.input || {}, result: null };
        callIndex.set(b.id, entry);
        tools.push(entry);
      }
      if (text || thinking || tools.length) push({ role: "assistant", text, thinking, tools, ts: msg.timestamp || d.timestamp, model: msg.model });
    } else if (msg.role === "toolResult") {
      const entry = callIndex.get(msg.toolCallId);
      if (entry) entry.result = asText(content).slice(0, 4000);
    }
  }
  return turns;
}
function chatData(inst, limit = 120) {
  const { file, kind } = sessionFileFor(inst);
  if (!file) return { available: false, kind, turns: [] };
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return { available: false, kind, turns: [] }; }
  const turns = parseTranscript(text.split("\n").filter(Boolean), kind);
  return { available: true, kind, file, turns: turns.slice(-limit) };
}

// ---- Jira (P2): epic + Agent Roster via acli, using the instance's oas.jira meta ----
function acliJson(argv) {
  try { return JSON.parse(execFileSync("acli", argv, { encoding: "utf8", timeout: 20000 })); }
  catch { return undefined; }
}
function jiraPanel(inst) {
  const meta = inst.jira;
  if (!meta?.label) return { enabled: false };
  const site = meta.site, project = meta.project, label = meta.label;
  if (!site || !project) return { enabled: true, label, error: "site/project not configured" };
  const mine = acliJson(["jira", "workitem", "search", "--site", site,
    "--jql", `project = ${project} AND labels = ${label} AND statusCategory != Done ORDER BY rank`, "--json"]);
  const tickets = (Array.isArray(mine) ? mine : mine?.issues || mine?.results || []).map((t) => ({
    key: t.key, type: t.fields?.issuetype?.name || t.type || "", summary: t.fields?.summary || t.summary || "",
    status: t.fields?.status?.name || t.status || "", parent: t.fields?.parent?.key || t.parent || null,
  }));
  // The epic: a labeled epic, else the parent chain of the first labeled ticket.
  let epicKey = tickets.find((t) => /epic/i.test(t.type))?.key || tickets.find((t) => t.parent)?.parent || null;
  let epic = null;
  if (epicKey) {
    const e = acliJson(["jira", "workitem", "view", epicKey, "--site", site, "--json"]);
    if (e) {
      const desc = e.fields?.description || e.description || "";
      const text = typeof desc === "string" ? desc : JSON.stringify(desc);
      epic = { key: epicKey, summary: e.fields?.summary || e.summary || "", status: e.fields?.status?.name || e.status || "", roster: parseRoster(text) };
      if (/epic/i.test(String(e.fields?.issuetype?.name || e.type || "")) === false && !epic.summary) epic = { key: epicKey, summary: "", status: "", roster: [] };
    }
  }
  return { enabled: true, label, site, project, tickets, epic };
}
export function parseRoster(text) {
  const m = String(text).match(/##\s*Agent Roster\s*([\s\S]*?)(?=\n##\s|$)/i);
  if (!m) return [];
  const rows = m[1].split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"));
  const cells = (l) => l.split("|").slice(1, -1).map((c) => c.trim());
  if (rows.length < 2) return [];
  const header = cells(rows[0]);
  return rows.slice(2).map((r) => {
    const c = cells(r);
    return Object.fromEntries(header.map((h, i) => [h.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, ""), c[i] || ""]));
  }).filter((r) => Object.values(r).some(Boolean));
}

// ---- HTTP ----
const UI = readFileSync(join(HERE, "..", "ui", "panel.html"), "utf8");
const send = (res, code, body, type = "application/json") => {
  const data = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(code, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
  res.end(data);
};
const readBody = (req) => new Promise((ok) => {
  let b = ""; req.on("data", (c) => { b += c; if (b.length > 65536) req.destroy(); });
  req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } });
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  // DNS-rebinding / CSRF guard: mutating requests must come from a loopback
  // origin — a hostile page resolving to 127.0.0.1 must not type into terminals.
  if (req.method === "POST") {
    const host = String(req.headers.host || "").replace(/:\d+$/, "");
    const okHost = (h) => h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
    let originOk = true;
    if (req.headers.origin !== undefined) {
      // "Origin: null" (sandboxed pages) and malformed origins must 403, not throw.
      try { originOk = okHost(new URL(String(req.headers.origin)).hostname); } catch { originOk = false; }
    }
    if (!okHost(host) || !originOk) return send(res, 403, { error: "forbidden origin" });
  }
  try {
    if (req.method === "GET" && path === "/") return send(res, 200, UI, "text/html");
    if (req.method === "GET" && path === "/api/panel") {
      const d = snapshotPanel(url.searchParams.get("ws") || undefined);
      // first request before the initial snapshot lands: collect inline once
      return send(res, 200, d || panelData(url.searchParams.get("ws") || undefined));
    }
    if (req.method === "GET" && path === "/api/agents") return send(res, 200, agentsData(url.searchParams.get("ws") || undefined));
    if (req.method === "POST" && path === "/api/spawn") {
      const body = await readBody(req);
      if (typeof body.agent !== "string" || !body.agent || typeof body.agentsRoot !== "string" || !body.agentsRoot)
        return send(res, 400, { error: "body needs { agent, agentsRoot }" });
      try { return send(res, 200, { spawned: true, ...spawnAgent(body) }); }
      catch (e) { return send(res, 409, { error: String(e.message || e).slice(0, 300) }); }
    }
    const m = path.match(/^\/api\/(session|keys|interrupt|jira|chat)\/([A-Za-z0-9._-]+)$/);
    if (m) {
      const inst = findInstance(m[2]);
      if (!inst) return send(res, 404, { error: `unknown instance "${m[2]}"` });
      if (m[1] === "session" && req.method === "GET") {
        if (!inst.running) return send(res, 200, { running: false, text: "" });
        const info = paneInfo(inst);
        const hist = Math.min(info.history, Math.max(0, Number(url.searchParams.get("lines") || 500)));
        return send(res, 200, { running: true, size: info.size, history: hist, text: capture(inst, hist) });
      }
      if (m[1] === "keys" && req.method === "POST") {
        if (!inst.running) return send(res, 409, { error: "instance is not running" });
        const { data, paste } = await readBody(req);
        if (typeof data !== "string" || !data.length) return send(res, 400, { error: "body needs { data }" });
        // SECURITY: never log the payload — typed text can contain secrets.
        if (DEBUG) console.log(`[keys] inst=${inst.instance} target=${tmuxTarget(inst)} paste=${paste === true} len=${Buffer.byteLength(data, "utf8")}`);
        try {
          sendKeys(inst, data, paste === true);
        } catch (e) {
          // SECURITY: e.message embeds the child argv (hex-encoded keystrokes)
          // — never let it reach logs or the response (keySendError shapes it).
          const safe = keySendError(e);
          if (DEBUG) console.log(`${safe.log} inst=${inst.instance}`);
          return send(res, 500, safe.http);
        }
        return send(res, 200, { sent: true });
      }
      if (m[1] === "interrupt" && req.method === "POST") {
        if (!inst.running) return send(res, 409, { error: "instance is not running" });
        sendInterrupt(inst);
        return send(res, 200, { sent: true });
      }
      if (m[1] === "jira" && req.method === "GET") return send(res, 200, jiraPanel(inst));
      if (m[1] === "chat" && req.method === "GET") return send(res, 200, chatData(inst, Number(url.searchParams.get("limit") || 120)));
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 500, { error: String(e.message || e).slice(0, 300) });
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`oas web: port ${port} is already in use — an oas web server is likely already running (open http://127.0.0.1:${port}).`);
    console.error(`Use --port <n> for a second panel, or stop the old one: pkill -f "oas-web.mjs start"`);
    process.exit(1);
  }
  throw e;
});
server.listen(port, "127.0.0.1", () => {
  const addr = `http://127.0.0.1:${port}`;
  console.log(`oas web — panel at ${addr}  (workspaces: ${workspaces().map((w) => w.name).join(", ") || "none"})`);
  console.log("Bound to 127.0.0.1 only. This process can type into your agent terminals — do not expose it.");
  if (flag("open")) { try { execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [addr], { stdio: "ignore" }); } catch { /* best-effort */ } }
});
refreshSnapshot();                       // initial roster snapshot, off-thread
setInterval(refreshSnapshot, 3000).unref(); // keep it fresh; child skipped if one is running
