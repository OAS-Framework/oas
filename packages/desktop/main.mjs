// OAS desktop — Electron main process.
//
// Responsibilities (per the desktop-app contract):
//   * window + security posture: contextIsolation ON, nodeIntegration OFF,
//     all privileged work behind explicit IPC channels.
//   * server management: connect to a running desktop backend server (default
//     127.0.0.1:4820) or spawn the bundled `server/oas-web.mjs start`
//     as a child; the renderer's ctx.api() proxies to it over IPC.
//   * integrated terminal: node-pty running `tmux attach-session` per
//     terminal tab, bytes streamed to xterm.js over IPC. Closing a tab kills
//     the pty ONLY — the tmux session is the durable host and must survive.
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { apiUrl, apiInit } from "./api-url.mjs";
import { openTerm, sweepViewers } from "./tmux-target.mjs";
import { createTerminalRegistry, terminalTargetKey, MAX_TERMINALS } from "./terminal-registry.mjs";
import { ensureServerOnPort, serverCompatible } from "./server-compat.mjs";
import { createServerHost, createServerAdapter } from "./server-host.mjs";
import { validateWorkspace, workspaceSuggestions, parseRecents, pushRecent, decideAdd, createGenerations, createAddExecutor } from "./workspace-registry.mjs";
import { resolveDeployment, teamAgentRoots } from "./server/deployment.mjs";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

const HERE = dirname(fileURLToPath(import.meta.url));

let port = Number(process.env.OAS_DESKTOP_PORT || 4820);
const base = () => `http://127.0.0.1:${port}`;
// Workspace the panel shows: --dir <path> or OAS_DESKTOP_DIR or the cwd the
// app was launched from. The packaged app never infers a framework repo root
// — with no OAS deployment in view the renderer shows the workspace picker.
const argDir = (() => {
  const i = process.argv.indexOf("--dir");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
})();
const WORKSPACE = resolve(argDir || process.env.OAS_DESKTOP_DIR || process.cwd());
// Mutable workspace set: startup workspace plus runtime-added ones — the
// repeated --dir list an app-owned server is (re)started with.
const workspaceDirs = [WORKSPACE];

// ---- backend server management ----------------------------------------
// Server host (server-host.mjs): owns the child lifecycle, the ownership-
// through-transition invariant, and trust-state invalidation on replace.
const serverHost = createServerHost({
  spawnChild: (dirs, onPort) => {
    const bin = join(HERE, "server", "oas-web.mjs");
    if (!existsSync(bin)) throw new Error(`desktop backend server not found at ${bin} and no usable server on port ${onPort}`);
    // The persisted user-chosen oas binary (if any) rides along as the
    // server's top-priority discovery candidate; the server re-probes it.
    const chosen = readCliChoice();
    const child = spawn(process.execPath, [bin, "start", "--port", String(onPort),
      ...dirs.flatMap((d) => ["--dir", d]), ...(chosen ? ["--oas-bin", chosen] : [])], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: WORKSPACE,
      env: { ...process.env },
    });
    child.stdout.on("data", (d) => process.stdout.write(`[oas-desktop-server] ${d}`));
    child.stderr.on("data", (d) => process.stderr.write(`[oas-desktop-server] ${d}`));
    return child;
  },
  // trust state belongs to the outgoing server — stale entries must never
  // validate ?ws= or decideAdd; repopulated only from the current server.
  onInvalidate: () => { allowedWs = new Set(); },
});
let wsId = null;        // verified workspace id on the server we use
let allowedWs = new Set(); // workspace ids the connected server advertises

async function panelWorkspaces() {
  try {
    const r = await fetch(`${base()}/api/panel`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const d = await r.json();
    const list = d.workspaces || [];
    allowedWs = new Set(list.map((w) => w.id));
    return list;
  } catch { return null; }
}

/** This checkout's bundled-server identity, for the reuse compatibility probe. */
function localServerIdentity() {
  const m = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
  return { capability: m.name, version: m.version };
}

/** Probe GET /api/version on the current port; null on network failure. */
async function probeVersion() {
  try {
    const r = await fetch(`${base()}/api/version`, { signal: AbortSignal.timeout(1500) });
    let body = null; try { body = await r.json(); } catch { /* non-JSON */ }
    return { ok: r.ok, status: r.status, body };
  } catch { return null; }
}

/** The workspace we were asked to show, as the server would scope it: our
 * requested path equals a workspace scope or lives underneath it. */
function matchWorkspace(workspaces) {
  return workspaces.find((w) => WORKSPACE === w.id || WORKSPACE.startsWith(`${w.id}/`))?.id || null;
}

async function freePort(from) {
  const { createServer } = await import("node:net");
  for (let p = from; p < from + 50; p++) {
    const ok = await new Promise((res) => {
      const s = createServer();
      s.once("error", () => res(false));
      s.listen(p, "127.0.0.1", () => s.close(() => res(true)));
    });
    if (ok) return p;
  }
  throw new Error(`no free port in ${from}..${from + 49}`);
}

// Port-committing adapter (server-host.mjs): the production wiring between
// selection and the host — commits the module port before the child starts.
const serverAdapter = createServerAdapter({
  host: serverHost,
  getPort: () => port,
  setPort: (p) => { port = p; },
});
const spawnServer = (onPort, dirs = workspaceDirs) => serverAdapter.spawnServer(onPort, dirs);
const replaceServer = (dirs) => serverAdapter.replaceServer(dirs);

async function ensureServer() {
  // ensureServerOnPort (server-compat.mjs) is the testable seam for the
  // whole step: reuse only a server that covers OUR workspace AND identifies
  // as this checkout via /api/version; otherwise leave it alone and spawn
  // our own — on the next free port when the current one is occupied.
  const r = await ensureServerOnPort({
    panelWorkspaces, probeVersion, matchWorkspace, local: localServerIdentity(),
    port, freePort: (from) => freePort(from), spawnServer: (p) => spawnServer(p),
    log: (m) => console.log(`oas-desktop: ${m}`),
  });
  port = r.port;
  if (!r.spawned) { wsId = r.wsId; return { spawned: false }; }
  // wait for the server to come up (max ~10s) and verify its workspace
  for (let i = 0; i < 40; i++) {
    const ws = await panelWorkspaces();
    if (ws) {
      const id = matchWorkspace(ws);
      if (!id) throw new Error(`spawned backend serves ${ws.map((w) => w.id).join(", ")} — does not cover ${WORKSPACE}`);
      wsId = id;
      return { spawned: true };
    }
    await new Promise((ok) => setTimeout(ok, 250));
  }
  throw new Error("spawned backend server but it never answered /api/panel");
}

// ---- IPC hardening -------------------------------------------------------
// Privileged channels answer ONLY the app's own renderer file. Should any
// navigation slip through (or a compromised page end up in the window), a
// foreign frame gets nothing — not the API proxy, not the terminals.
const RENDERER_URL = `${pathToFileURL(join(HERE, "renderer", "index.html"))}`;
function trustedFrame(e) {
  const url = e.senderFrame?.url || "";
  return url === RENDERER_URL || url.startsWith(`${RENDERER_URL}#`);
}
function guard(e) { if (!trustedFrame(e)) throw new Error("forbidden: untrusted frame"); }

// ---- IPC: workspace suggestions + runtime add ---------------------------
// Privileged side of the runtime workspace switcher (phase-2 hook 3; the
// renderer modal is the designer's). Discovery is bounded: known dirs, team
// siblings via the app-owned read-only deployment reader, validated recents.
// workspace:add only ever replaces an app-OWNED server; foreign servers fail
// closed.
const wsGens = createGenerations();
const RECENTS_FILE = () => join(app.getPath("userData"), "workspace-recents.json");

const wsValidate = (p) => validateWorkspace(p, {
  resolveConfig: (path) => resolveDeployment(path),
  // agents/ OR local-agents/ qualifies — OAS is fully usable with local souls alone.
  hasAgentsRoot: (path) => ["agents", "local-agents"].some((d) => {
    try { return existsSync(join(path, d)) && lstatSync(join(path, d)).isDirectory(); } catch { return false; }
  }),
});

function teamSiblingsOf(p) {
  // Sibling workspaces within p's team scope — same seams as the server's
  // workspaceEntry: the team scope's child repos that themselves validate.
  try {
    const cfg = resolveDeployment(p);
    const scope = cfg?.team?.scope;
    if (!scope) return [];
    return teamAgentRoots(scope).map((root) => dirname(root)).filter((d) => d !== p);
  } catch { return []; }
}

function readRecents() {
  try { return parseRecents(readFileSync(RECENTS_FILE(), "utf8"), (p) => !!wsValidate(p)); }
  catch { return []; }
}
function writeRecents(recents) {
  try { writeFileSync(RECENTS_FILE(), JSON.stringify(recents, null, 2)); } catch { /* best-effort */ }
}

let lastSuggested = new Set(); // canonical paths offered by the latest suggestions call

const executeAdd = createAddExecutor({
  getDirs: () => [...workspaceDirs],
  commitDirs: (dirs) => { workspaceDirs.length = 0; workspaceDirs.push(...dirs); },
  commitRecent: (p) => writeRecents(pushRecent(readRecents(), p)),
  replaceServer,
  refreshAdvertised: async () => (await panelWorkspaces()) !== null, // true only when the server ANSWERED
  probeVersion,
  // any 2xx is NOT enough during a same-port race — identity must match
  isCompatible: (v) => serverCompatible(v, localServerIdentity()).compatible,
  advertises: async (id) => { await panelWorkspaces(); return allowedWs.has(id); },
});

ipcMain.handle("workspace:suggestions", async (e) => {
  guard(e);
  const gen = wsGens.next("suggestions");
  await panelWorkspaces(); // refresh allowedWs from the live server
  const list = workspaceSuggestions({
    knownPaths: [...workspaceDirs],
    teamSiblings: teamSiblingsOf,
    recents: readRecents(),
    advertised: allowedWs,
    validate: wsValidate,
  });
  if (!wsGens.isCurrent("suggestions", gen)) return { stale: true, suggestions: [] };
  lastSuggested = new Set(list.map((s) => s.path));
  return { stale: false, suggestions: list };
});

async function performAdd(requestedPath, fromPicker) {
  const gen = wsGens.next("add");
  const decision = decideAdd(requestedPath, {
    realpath: (p) => realpathSync(p),
    validate: wsValidate,
    suggestedPaths: lastSuggested,
    fromPicker,
    serverOwned: serverHost.owned(),
    advertised: allowedWs,
  });
  if (!decision.ok) return { ok: false, code: decision.code, reason: decision.reason };
  const ws = decision.workspace;
  if (decision.action === "already-advertised") return { ok: true, workspace: ws };
  // Transactional executor (workspace-registry.mjs): serialized adds, staged
  // dirs, identity-checked readiness, commit-after-ready, restore-on-failure.
  // Terminals are unaffected throughout: viewers attach to tmux, not the backend.
  return executeAdd(ws, () => wsGens.isCurrent("add", gen));
}

ipcMain.handle("workspace:add", async (e, requestedPath) => {
  guard(e);
  if (typeof requestedPath !== "string" || !requestedPath.startsWith("/")) return { ok: false, code: "bad-path", reason: "path must be an absolute string" };
  return performAdd(requestedPath, false);
});

ipcMain.handle("workspace:pick", async (e) => {
  guard(e);
  // Explicit separate action: native directory picker feeding the SAME
  // validation path (fromPicker bypasses only the suggestion-set provenance
  // check — canonicalization and workspace validation still apply).
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths?.[0]) return { ok: false, code: "cancelled", reason: "picker cancelled" };
  return performAdd(r.filePaths[0], true);
});

// ---- IPC: CLI binary picker (Choose oas…) --------------------------------
// Native file picker for the degradation card. Persistence lives here (the
// main process owns userData); the picked path goes to the server via the
// renderer's POST /api/cli/reprobe {bin} — the server re-validates with the
// full probe, so a bad pick degrades with diagnostics, never trusts a path.
const CLI_CHOICE_FILE = () => join(app.getPath("userData"), "oas-cli-choice.json");
function readCliChoice() {
  try { const p = JSON.parse(readFileSync(CLI_CHOICE_FILE(), "utf8")).bin; return typeof p === "string" && p.startsWith("/") ? p : null; }
  catch { return null; }
}
function writeCliChoice(bin) {
  try { writeFileSync(CLI_CHOICE_FILE(), JSON.stringify({ bin })); } catch { /* best-effort */ }
}
ipcMain.handle("cli:pick", async (e) => {
  guard(e);
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, {
    title: "Choose the oas CLI binary",
    properties: ["openFile", "showHiddenFiles"],
    message: "Select the oas executable (e.g. from `command -v oas`)",
  });
  if (r.canceled || !r.filePaths?.[0]) return { path: null };
  writeCliChoice(r.filePaths[0]);           // persisted — top discovery priority next launch
  return { path: r.filePaths[0] };
});

// ---- IPC: API proxy -----------------------------------------------------
// The renderer never talks to the network directly; ctx.api() lands here.
ipcMain.handle("api", async (e, pathname, opts) => {
  guard(e);
  // apiUrl rejects off-origin resolution (e.g. "//attacker/x"), and pins
  // the verified workspace on scoped endpoints unless the caller selects a
  // workspace this server actually advertises (the views' ws switcher).
  const url = apiUrl(pathname, base(), wsId, allowedWs);
  // apiInit forwards pre-serialized (string) bodies and headers unchanged —
  // views serialize once in common.mjs::postJson — and serializes object
  // bodies itself.
  const init = { ...apiInit(opts), signal: AbortSignal.timeout(20000) };
  const r = await fetch(url, init);
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: r.ok, status: r.status, body: json };
});

// ---- IPC: integrated terminal (node-pty ↔ grouped tmux viewer session) ---
const ptys = new Map(); // id -> { pty, killViewer, wc }
let nextPtyId = 1;
// Resource registry (terminal-registry.mjs): DEDUPE by target + HARD CAP.
// The main process owns the ptys and oasdesk viewer sessions, so the ceiling
// lives here — the renderer cannot be trusted to bound it.
const termRegistry = createTerminalRegistry({ max: MAX_TERMINALS });

/** Kill + release every pty owned by a renderer that navigated/reloaded/
 * died (review cb7622e-r2 important 2). On a renderer reload the OLD tabs are
 * gone but their ptys survive in main and stay committed in the registry —
 * without this they'd occupy cap slots forever with no tab to reattach them
 * (a functional dead-end and a slow cap leak). Wiring the source window's
 * lifecycle events to a drop closes it: a reloaded renderer starts clean and
 * the freed targets can be re-opened. */
function dropPtysForWebContents(wc) {
  for (const [id, t] of [...ptys]) {
    if (t.wc !== wc) continue;
    ptys.delete(id);
    termRegistry.release(id);
    try { t.pty.kill(); } catch { /* already gone */ }
    t.killViewer();
  }
}
const wcWired = new WeakSet(); // wire each renderer's lifecycle listeners once

const tmuxRun = (args) => execFileSync("tmux", args, { stdio: "ignore", timeout: 4000 });

/** Sweep viewer sessions leaked by CRASHED desktop instances (exact: only
 * oasdesk-<pid>- names whose pid is dead). Run at app start and quit. */
function sweepOrphanViewers() {
  try {
    const names = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8", timeout: 4000 })
      .split("\n").filter(Boolean);
    const swept = sweepViewers({
      listSessions: () => names,
      killSession: (name) => tmuxRun(["kill-session", "-t", `=${name}`]),
      pidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
    });
    if (swept.length) console.log(`oas-desktop: swept ${swept.length} orphaned viewer session(s): ${swept.join(", ")}`);
  } catch { /* no tmux server — nothing to sweep */ }
}

ipcMain.handle("term:open", (e, { session, window: win, cols, rows }) => {
  guard(e);
  // Resource containment (Slice G): DEDUPE by target + HARD CAP, enforced
  // atomically here (this handler is synchronous end to end, so concurrent
  // IPC opens cannot interleave to exceed the cap). Repeated opens of the
  // same target REUSE the live terminal; a distinct open beyond the cap is
  // rejected visibly and actionably — never a silent evict or extra create.
  const targetKey = terminalTargetKey(session, win);
  const plan = termRegistry.plan(targetKey);
  if (plan.action === "reuse") return { reused: true, id: plan.id };
  if (plan.action === "cap") return { capped: true, active: plan.active, max: plan.max };
  // openTerm (tmux-target.mjs): anchors + PREFLIGHTS the exact source target
  // (missing target rejects here → the renderer's "could not attach"), then
  // builds a per-tab LINKED-WINDOW viewer session (placeholder → link exact
  // window → drop placeholder → lock keys) and attaches the pty THERE. The
  // viewer contains ONLY the linked window: no client's window switch, no
  // viewer-side key binding, and no sibling auto-select on window death can
  // ever steer this tab to another agent — when the source window dies the
  // viewer terminates (pty exit → "session ended"). Durable session
  // untouched. A create FAILURE (bad target) leaks nothing: openTerm kills
  // its own partial viewer and nothing is committed to the registry.
  let opened;
  try {
    opened = openTerm({ session, window: win, cols, rows }, {
      preflight: (target) => tmuxRun(["list-panes", "-t", target]),
      tmux: tmuxRun,
      tmuxOut: (args) => execFileSync("tmux", args, { encoding: "utf8", timeout: 4000 }).trim(),
      spawnPty: (target, c, r) => pty.spawn("tmux", ["attach-session", "-t", target], {
        name: "xterm-256color", cols: c, rows: r, cwd: process.env.HOME, env: process.env,
      }),
    });
  } catch (err) {
    return { error: String(err.message || err) };
  }
  const { pty: p, killViewer } = opened;
  const id = nextPtyId++;
  const wc = e.sender;
  const dropViewer = () => { try { killViewer(); } catch { /* already gone (session ended) */ } };
  p.onData((data) => { if (!wc.isDestroyed()) wc.send(`term:data:${id}`, data); });
  p.onExit(({ exitCode }) => {
    ptys.delete(id);
    termRegistry.release(id);   // free the target slot the moment the pty ends
    dropViewer(); // pty gone (detach or session end) — the viewer session must not linger
    if (!wc.isDestroyed()) wc.send(`term:exit:${id}`, exitCode);
  });
  ptys.set(id, { pty: p, killViewer: dropViewer, wc });
  termRegistry.commit(targetKey, id);
  // Release this renderer's ptys when it reloads, navigates, or its process
  // goes away — the tabs that owned them no longer exist (wired once per wc).
  if (!wcWired.has(wc)) {
    wcWired.add(wc);
    const drop = () => dropPtysForWebContents(wc);
    wc.on("did-navigate", drop);            // full reload / navigation (not in-page hash)
    wc.on("render-process-gone", drop);     // renderer crash/replace
    wc.once("destroyed", drop);              // window/webContents torn down
  }
  return { id };
});
ipcMain.on("term:write", (e, id, data) => { guard(e); ptys.get(id)?.pty.write(String(data)); });
ipcMain.on("term:resize", (e, id, cols, rows) => {
  guard(e);
  const t = ptys.get(id);
  if (t && cols > 0 && rows > 0) { try { t.pty.resize(cols, rows); } catch { /* racing exit */ } }
});
ipcMain.on("term:close", (e, id) => {
  guard(e);
  // Kill the pty and ITS viewer session only — the durable session and its
  // windows always survive (onExit also drops the viewer; both are safe).
  const t = ptys.get(id);
  ptys.delete(id);
  termRegistry.release(id);   // free the target slot so a re-open is allowed
  try { t?.pty.kill(); } catch { /* already gone */ }
  t?.killViewer();
});

// ---- window -------------------------------------------------------------
async function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "OAS Desktop",
    backgroundColor: "#16161e",
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require() for contextBridge; renderer stays isolated
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // Navigation lock: the window may only ever show our renderer file. Links
  // in future views (markdown, chat) open externally; everything else is
  // denied — a navigated-to page would otherwise inherit the preload bridge.
  win.webContents.on("will-navigate", (event, url) => {
    if (url === RENDERER_URL || url.startsWith(`${RENDERER_URL}#`)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  await win.loadFile(join(HERE, "renderer", "index.html"));
}

app.whenReady().then(async () => {
  sweepOrphanViewers(); // a previously crashed desktop must not leak viewer sessions
  try { await ensureServer(); }
  catch (e) { console.error(`oas-desktop: ${e.message}`); }
  await createWindow();
  // Contract re-probe trigger "app focus": notify the renderer, which calls
  // POST /api/cli/reprobe (the server owns probe state and rate semantics).
  app.on("browser-window-focus", () => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.webContents.isDestroyed()) w.webContents.send("app:focus");
    }
  });
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { app.quit(); });

function shutdown() {
  // Detach every pty and kill its viewer session (never the durable
  // sessions); stop the server only if we started it; sweep any orphans.
  for (const id of [...ptys.keys()]) {
    const t = ptys.get(id);
    try { t.pty.kill(); } catch { /* best-effort */ }
    t.killViewer();
    termRegistry.release(id);
  }
  ptys.clear();
  sweepOrphanViewers();
  serverHost.stop();
}
app.on("before-quit", shutdown);
// SIGTERM/SIGINT (e.g. `kill <pid>`, Ctrl-C from a launcher shell) do not run
// before-quit on their own — without this the spawned backend child leaks.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => { shutdown(); app.quit(); });
}
