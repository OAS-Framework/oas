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
 *   GET  /api/brain/<agent>?ws=<id> agent "brain" JSON: soul (AGENTS.md, skills,
 *                                   knowledge tree) + per-instance artifacts (abs paths)
 *   GET  /api/file?path=<abs>       text file content, guarded to workspace roots + agent homes
 *   GET  /api/diff/<instance>?staged=0|1   unified git diff of the instance's work tree + stats
 *
 * SECURITY: binds 127.0.0.1 ONLY. This process can type into your terminals.
 * Interaction model: terminal-direct (tmux send-keys / capture-pane) — the
 * feel of sitting at the agent's terminal; identical for pi and claude runs.
 */
import { createServer } from "node:http";
import { execFile, execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, realpathSync, lstatSync, readlinkSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
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
  // execFileSync exposes normal non-zero exits as e.status; e.code carries
  // spawn-level errno strings (ETIMEDOUT, ENOENT). Prefer status.
  const code = e && (e.status ?? e.code) != null ? String(e.status ?? e.code) : "unknown";
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

// ---- Agent brain: soul + instance artifacts as absolute paths ----
// The desktop brain view renders this map; file CONTENT is fetched separately
// through /api/file (path-guarded there). This endpoint only walks known
// agent directories under the workspace's agents roots — the agent name is
// resolved through the same kernel seams as spawn (findAgent /
// findCapabilityAgent), never from a caller-supplied path.
function listSkills(dir) {
  // skills live as <dir>/<skill>/SKILL.md with `name`/`description` frontmatter
  const skills = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const s = skillEntry(join(dir, e.name));
      if (s) skills.push(s);
    }
  } catch { /* no skills dir */ }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
function skillEntry(skillDir) {
  const p = join(skillDir, "SKILL.md");
  if (!existsSync(p)) return null;
  let meta = {};
  try { meta = core.parseFrontmatter(readFileSync(p, "utf8")).meta || {}; } catch { /* unreadable skill */ }
  return { name: meta.name || basename(skillDir), path: p, description: String(meta.description || "").trim() };
}
function mdTree(dir) {
  // all markdown files of a knowledge bundle, depth-first, absolute paths
  const out = [];
  const walk = (d, depth) => {
    if (depth > 6) return; // bundles are shallow; guard against cycles
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}
const mdIf = (p) => (existsSync(p) ? p : null);
function brainData(agentName, wsId) {
  const ws = wsId ? workspaceById(wsId) : workspaces()[0];
  let def, root;
  for (const r of ws?.roots || []) {
    def = core.findAgent(r, agentName) || core.findCapabilityAgent(dirname(r), r, agentName);
    if (def) { root = r; break; }
  }
  if (!def) return null;
  // capability agents keep their canonical soul read-only in the package
  const soulDir = def._soulDir || join(def._dir, "soul");
  // Skills: local souls carry soul/skills/; capability agents ALSO declare
  // skills at the package level (manifest `skills:` paths). Runtime
  // composition includes both sources — mirror that: merge local + package,
  // deterministic duplicate handling (local soul wins, then first-seen).
  /* OASWEB_BRAINSKILLS_BEGIN — capability skill-path expansion, extracted by tests */
  const expandSkillPath = (p, exists, list, entry) =>
    // manifest paths are either a leaf skill dir (contains SKILL.md) or a
    // parent tree of skill dirs (the `skills: ["skills"]` form) — core
    // materialization accepts both, so must we.
    exists(join(p, "SKILL.md")) ? [entry(p)].filter(Boolean) : list(p);
  const mergeSkills = (...groups) => {
    const byName = new Map();
    for (const g of groups) for (const s of g) if (!byName.has(s.name)) byName.set(s.name, s);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  /* OASWEB_BRAINSKILLS_END */
  const localSkills = listSkills(join(soulDir, "skills"));
  let packageSkills = [];
  if (def.capability) {
    try {
      packageSkills = core.capabilitySkillDirs(def.capability, dirname(root))
        .flatMap((p) => expandSkillPath(p, existsSync, listSkills, skillEntry));
    } catch { /* manifest unreadable — no package skills */ }
  }
  const soulSkills = mergeSkills(localSkills, packageSkills);
  const knowledgeDir = join(soulDir, "knowledge");
  const instances = [];
  const instancesDir = join(def._dir, "instances");
  let instNames = [];
  try { instNames = readdirSync(instancesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* no instances yet */ }
  for (const name of instNames.sort()) {
    const home = join(instancesDir, name);
    const live = findInstance(name);
    const notesDir = join(home, "notes");
    instances.push({
      instance: name, home, running: live ? !!live.running : false,
      agentsMd: mdIf(join(home, "AGENTS.md")),
      skills: listSkills(join(home, ".agents", "skills")),
      state: mdIf(join(home, "STATE.md")),
      task: mdIf(join(home, "TASK.md")),
      notes: existsSync(notesDir) ? mdTree(notesDir) : [],
    });
  }
  return {
    agent: def.name, description: def.description || "", agentsRoot: root,
    soul: {
      agentsMd: mdIf(join(soulDir, "AGENTS.md")),
      skills: soulSkills,
      knowledge: {
        index: mdIf(join(knowledgeDir, "index.md")),
        tree: existsSync(knowledgeDir) ? mdTree(knowledgeDir) : [],
      },
    },
    instances,
  };
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

// ---- File serving (markdown/brain viewers) + git diff (diff viewer) ----

/* OASWEB_FILEGUARD_BEGIN — path-traversal guard for /api/file, extracted by
   tests. A requested path is readable ONLY if its realpath (symlinks resolved)
   sits under one of the allowed roots — realpaths themselves — so `..`
   segments, sneaky prefixes (/root-evil vs /root) and symlink escapes all
   fail closed. */
function underRoot(realPath, realRoot) {
  return realPath === realRoot || realPath.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
}
function resolveGuardedFile(requested, allowedRoots) {
  if (typeof requested !== "string" || !requested.startsWith("/")) return { error: "path must be absolute", code: 400 };
  let real;
  try { real = realpathSync(resolve(requested)); } catch { return { error: "no such file", code: 404 }; }
  const roots = [];
  for (const r of allowedRoots) { try { roots.push(realpathSync(r)); } catch { /* skip missing */ } }
  if (!roots.some((root) => underRoot(real, root))) return { error: "path outside allowed roots", code: 403 };
  return { real };
}
/* OASWEB_FILEGUARD_END */

const MARKDOWN_EXT = new Set([".md", ".markdown", ".mdown", ".mkd"]);
const FILE_MAX_BYTES = 2 * 1024 * 1024;

/** Allowed roots for /api/file: every agents root of every workspace (agent
 * homes — souls, instances, knowledge) plus the known instances' work trees
 * and repos (the brain/diff viewers open files there too). */
function fileRoots() {
  const roots = workspaces().flatMap((w) => w.roots);
  for (const d of snapshot.byWs.values()) {
    for (const i of d.instances) {
      if (i.home) { roots.push(i.home); roots.push(join(i.home, "work")); } // <home>/work = the work tree (i.work is the MODE)
      if (i.repo) roots.push(i.repo);
    }
  }
  return roots;
}

function fileData(requested) {
  const g = resolveGuardedFile(requested, fileRoots());
  if (g.error) return g;
  const st = statSync(g.real);
  if (!st.isFile()) return { error: "not a regular file", code: 400 };
  if (st.size > FILE_MAX_BYTES) return { error: `file too large (${st.size} bytes)`, code: 413 };
  const buf = readFileSync(g.real);
  if (buf.includes(0)) return { error: "binary file", code: 415 };
  return {
    body: {
      path: g.real, name: basename(g.real), size: st.size, mtime: st.mtime.toISOString(),
      markdown: MARKDOWN_EXT.has(extname(g.real).toLowerCase()),
      content: buf.toString("utf8"),
    },
  };
}

function git(cwd, argv) {
  return execFileSync("git", ["-C", cwd, ...argv], { encoding: "utf8", timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
}

/* OASWEB_DIFFSTAT_BEGIN — -z diff stat parsing, extracted by tests. Rename
   records carry explicit old NUL new fields — never parse the human
   "dir/{old => new}" form; both maps key by the NEW path. numstat -z rename
   records are "adds\tdels\t" followed by old NUL new as separate fields. */
function parseDiffStats(numstatZ, nameStatusZ) {
  const statusOf = new Map();
  {
    const f = String(nameStatusZ).split("\0");
    for (let i = 0; i < f.length - 1; ) {
      const st = f[i++][0];
      if (!st) continue;
      const a = f[i++];
      const b = st === "R" || st === "C" ? f[i++] : a; // rename/copy: old, new
      statusOf.set(b, st);
    }
  }
  const files = [];
  {
    const f = String(numstatZ).split("\0");
    for (let i = 0; i < f.length - 1; ) {
      const c = f[i++].split("\t");
      if (c.length < 3) continue;
      const path = c[2] !== "" ? c[2] : (i++, f[i++]); // rename: skip old, take new
      files.push({ path, status: statusOf.get(path) || "M",
                   additions: c[0] === "-" ? null : Number(c[0]),
                   deletions: c[1] === "-" ? null : Number(c[1]) });
    }
  }
  return files;
}
/* OASWEB_DIFFSTAT_END */

/** Git diff of an instance's work tree: unified diff + per-file stats.
 * staged=1 diffs the index (--cached); default diffs the work tree and
 * includes untracked files as added (intent-to-add view via numstat merge). */
function diffData(inst, staged) {
  // inst.work is the work MODE (worktree/checkout/attached); the tree itself
  // lives at <home>/work by convention (model.mjs gitState uses the same path).
  const cwd = existsSync(join(inst.home || "", "work")) ? join(inst.home, "work") : inst.repo;
  if (!cwd || !existsSync(cwd)) return { error: "instance has no work tree", code: 404 };
  let branch = null;
  try { branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(); } catch { return { error: "not a git repository", code: 409 }; }
  const mode = staged ? ["--cached"] : [];
  const files = parseDiffStats(
    git(cwd, ["diff", ...mode, "--numstat", "-M", "-z"]),
    git(cwd, ["diff", ...mode, "--name-status", "-M", "-z"]));
  let diff = git(cwd, ["diff", ...mode, "-M"]);
  if (!staged) {
    const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
    diff += synthUntracked(cwd, untracked, files, { lstatSync, readlinkSync, readFileSync, join, maxBytes: FILE_MAX_BYTES });
  }
  return { body: { repo: cwd, branch, staged: !!staged, files, diff } };
}

/* OASWEB_UNTRACKED_BEGIN — untracked-file diff synthesis, extracted by tests.
   SECURITY: lstat first — an untrusted worktree can plant a symlink to
   ~/.ssh keys (leak) or a FIFO/device (server hang); only regular files are
   read, and symlinks render as their link text (readlink), never the target. */
function synthUntracked(cwd, untracked, files, io) {
  let diff = "";
  for (const path of untracked) {
    let text;
    try {
      const full = io.join(cwd, path);
      const st = io.lstatSync(full);
      if (st.isSymbolicLink()) { text = io.readlinkSync(full); }
      else if (!st.isFile()) { files.push({ path, status: "A", additions: null, deletions: null }); continue; }
      else {
        const buf = io.readFileSync(full);
        if (buf.includes(0) || buf.length > io.maxBytes) { files.push({ path, status: "A", additions: null, deletions: null }); continue; }
        text = buf.toString("utf8");
      }
    } catch { continue; }
    const lines = text.length ? text.replace(/\n$/, "").split("\n") : [];
    files.push({ path, status: "A", additions: lines.length, deletions: 0 });
    diff += `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => "+" + l).join("\n")}\n`;
  }
  return diff;
}
/* OASWEB_UNTRACKED_END */

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
  // DNS-rebinding guard: EVERY request must carry a loopback Host — a hostile
  // page rebinding its hostname to 127.0.0.1 must neither type into terminals
  // (POST) nor read workspace files via the GET APIs (/api/file, /api/diff).
  const host = String(req.headers.host || "").replace(/:\d+$/, "");
  const okHost = (h) => h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
  if (!okHost(host)) return send(res, 403, { error: "forbidden origin" });
  // CSRF guard: mutating requests must also come from a loopback origin.
  if (req.method === "POST") {
    let originOk = true;
    if (req.headers.origin !== undefined) {
      // "Origin: null" (sandboxed pages) and malformed origins must 403, not throw.
      try { originOk = okHost(new URL(String(req.headers.origin)).hostname); } catch { originOk = false; }
    }
    if (!originOk) return send(res, 403, { error: "forbidden origin" });
  }
  try {
    if (req.method === "GET" && path === "/") return send(res, 200, UI, "text/html");
    if (req.method === "GET" && path === "/api/panel") {
      const d = snapshotPanel(url.searchParams.get("ws") || undefined);
      // first request before the initial snapshot lands: collect inline once
      return send(res, 200, d || panelData(url.searchParams.get("ws") || undefined));
    }
    if (req.method === "GET" && path === "/api/agents") return send(res, 200, agentsData(url.searchParams.get("ws") || undefined));
    const bm = path.match(/^\/api\/brain\/([A-Za-z0-9._-]+)$/);
    if (bm && req.method === "GET") {
      const d = brainData(bm[1], url.searchParams.get("ws") || undefined);
      return d ? send(res, 200, d) : send(res, 404, { error: `unknown agent "${bm[1]}"` });
    }
    if (req.method === "POST" && path === "/api/spawn") {
      const body = await readBody(req);
      if (typeof body.agent !== "string" || !body.agent || typeof body.agentsRoot !== "string" || !body.agentsRoot)
        return send(res, 400, { error: "body needs { agent, agentsRoot }" });
      try { return send(res, 200, { spawned: true, ...spawnAgent(body) }); }
      catch (e) { return send(res, 409, { error: String(e.message || e).slice(0, 300) }); }
    }
    if (req.method === "GET" && path === "/api/file") {
      const r = fileData(url.searchParams.get("path") || "");
      return r.error ? send(res, r.code, { error: r.error }) : send(res, 200, r.body);
    }
    const m = path.match(/^\/api\/(session|keys|interrupt|jira|chat|diff)\/([A-Za-z0-9._-]+)$/);
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
      if (m[1] === "diff" && req.method === "GET") {
        const r = diffData(inst, url.searchParams.get("staged") === "1");
        return r.error ? send(res, r.code, { error: r.error }) : send(res, 200, r.body);
      }
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
