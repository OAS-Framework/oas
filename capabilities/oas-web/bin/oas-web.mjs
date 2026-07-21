#!/usr/bin/env node
/**
 * oas-web — local web control panel ("the Slack of the agents").
 *
 *   oas web start [--port <n>] [--dir <agents-root-context>] [--open]
 *
 * A zero-dependency localhost HTTP server:
 *   GET  /                          the panel UI (single HTML file)
 *   GET  /api/panel                 roster JSON (instances, git, task, tmux state)
 *   GET  /api/session/<instance>?lines=n   ANSI pane capture of the live session
 *   POST /api/send/<instance>       { text } → typed into the tmux session + Enter
 *   POST /api/interrupt/<instance>  sends Ctrl-C (Escape for pi/claude prompts stays manual)
 *   GET  /api/jira/<instance>       epic + Agent Roster for instances with oas.jira meta
 *
 * SECURITY: binds 127.0.0.1 ONLY. This process can type into your terminals.
 * Interaction model: terminal-direct (tmux send-keys / capture-pane) — the
 * feel of sitting at the agent's terminal; identical for pi and claude runs.
 */
import { createServer } from "node:http";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN && sub !== "start") {
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
      sessionTail: i.sessionTail || safeTail(i),
      jira: i.capabilityMeta?.["oas.jira"] || null,
      team: i.team || null,
    })),
  };
}

function safeTail(inst) {
  try { return sessionTailState(inst); } catch { return { state: "unknown", errorMessage: null, ts: null }; }
}

function findInstance(name) {
  for (const w of workspaces()) {
    const hit = panelData(w.id).instances.find((i) => i.instance === name);
    if (hit) return hit;
  }
  return undefined;
}

function tmuxTarget(inst) { return `${inst.tmux.session}:${inst.tmux.window}`; }

function capture(inst, lines) {
  try {
    return execFileSync("tmux", ["capture-pane", "-p", "-e", "-J", "-t", tmuxTarget(inst), "-S", `-${Math.max(16, lines)}`],
      { encoding: "utf8", timeout: 4000 });
  } catch { return ""; }
}

function sendText(inst, text) {
  if (text.includes("\n")) {
    // Multi-line: bracketed paste via a tmux buffer so the TUI treats it as one
    // pasted block (a literal \n via send-keys would submit each line).
    execFileSync("tmux", ["load-buffer", "-b", "oasweb", "-"], { input: text, timeout: 4000 });
    execFileSync("tmux", ["paste-buffer", "-p", "-d", "-b", "oasweb", "-t", tmuxTarget(inst)], { timeout: 4000 });
  } else {
    // -l = literal (no key-name interpretation), then a separate Enter.
    execFileSync("tmux", ["send-keys", "-t", tmuxTarget(inst), "-l", text], { timeout: 4000 });
  }
  execFileSync("tmux", ["send-keys", "-t", tmuxTarget(inst), "Enter"], { timeout: 4000 });
}

function sendInterrupt(inst) {
  execFileSync("tmux", ["send-keys", "-t", tmuxTarget(inst), "C-c"], { timeout: 4000 });
}

// ---- Chat transcript: parse the runtime's session log into structured turns ----
// Session-file location and tail-error classification live in the shared
// control-pane model (sessionFileFor / sessionTailState / classifySessionTail).
const { sessionFileFor, sessionTailState } = model;
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
  const empty = { state: "unknown", errorMessage: null, ts: null };
  const { file, kind } = sessionFileFor(inst);
  if (!file) return { available: false, kind, turns: [], sessionTail: empty };
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return { available: false, kind, turns: [], sessionTail: empty }; }
  const lines = text.split("\n").filter(Boolean);
  const turns = parseTranscript(lines, kind);
  return { available: true, kind, file, turns: turns.slice(-limit), sessionTail: safeTail(inst) };
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
  try {
    if (req.method === "GET" && path === "/") return send(res, 200, UI, "text/html");
    if (req.method === "GET" && path === "/api/panel") return send(res, 200, panelData(url.searchParams.get("ws") || undefined));
    const m = path.match(/^\/api\/(session|send|interrupt|jira|chat)\/([A-Za-z0-9._-]+)$/);
    if (m) {
      const inst = findInstance(m[2]);
      if (!inst) return send(res, 404, { error: `unknown instance "${m[2]}"` });
      if (m[1] === "session" && req.method === "GET") {
        if (!inst.running) return send(res, 200, { running: false, text: "" });
        return send(res, 200, { running: true, text: capture(inst, Number(url.searchParams.get("lines") || 500)) });
      }
      if (m[1] === "send" && req.method === "POST") {
        if (!inst.running) return send(res, 409, { error: "instance is not running" });
        const { text } = await readBody(req);
        if (typeof text !== "string" || !text.length) return send(res, 400, { error: "body needs { text }" });
        sendText(inst, text);
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
if (IS_MAIN) server.listen(port, "127.0.0.1", () => {
  const addr = `http://127.0.0.1:${port}`;
  console.log(`oas web — panel at ${addr}  (workspaces: ${workspaces().map((w) => w.name).join(", ") || "none"})`);
  console.log("Bound to 127.0.0.1 only. This process can type into your agent terminals — do not expose it.");
  if (flag("open")) { try { execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [addr], { stdio: "ignore" }); } catch { /* best-effort */ } }
});
