// OAS desktop — Electron main process.
//
// Responsibilities (per the desktop-app contract):
//   * window + security posture: contextIsolation ON, nodeIntegration OFF,
//     all privileged work behind explicit IPC channels.
//   * server management: connect to a running oas-web server (default
//     127.0.0.1:4820) or spawn `capabilities/oas-web/bin/oas-web.mjs start`
//     as a child; the renderer's ctx.api() proxies to it over IPC.
//   * integrated terminal: node-pty running `tmux attach-session` per
//     terminal tab, bytes streamed to xterm.js over IPC. Closing a tab kills
//     the pty ONLY — the tmux session is the durable host and must survive.
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { apiUrl, apiInit } from "./api-url.mjs";
import { openTerm } from "./tmux-target.mjs";
import { serverCompatible } from "./server-compat.mjs";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/desktop → repo root two levels up (in-tree layout).
const REPO_ROOT = resolve(HERE, "..", "..");

let port = Number(process.env.OAS_DESKTOP_PORT || 4820);
const base = () => `http://127.0.0.1:${port}`;
// Workspace the panel shows: --dir <path> or OAS_DESKTOP_DIR or the repo root.
const argDir = (() => {
  const i = process.argv.indexOf("--dir");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
})();
const WORKSPACE = resolve(argDir || process.env.OAS_DESKTOP_DIR || REPO_ROOT);

// ---- oas-web server management ----------------------------------------
let serverChild = null; // set only when WE spawned it
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

/** This checkout's oas-web identity, for the reuse compatibility probe. */
function localServerIdentity() {
  const m = JSON.parse(readFileSync(join(REPO_ROOT, "capabilities", "oas-web", "oas.json"), "utf8"));
  return { capability: m.capability, version: m.version };
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

function spawnServer(onPort) {
  const bin = join(REPO_ROOT, "capabilities", "oas-web", "bin", "oas-web.mjs");
  if (!existsSync(bin)) throw new Error(`oas-web server not found at ${bin} and no usable server on port ${port}`);
  serverChild = spawn(process.execPath, [bin, "start", "--port", String(onPort), "--dir", WORKSPACE], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: WORKSPACE,
  });
  serverChild.stdout.on("data", (d) => process.stdout.write(`[oas-web] ${d}`));
  serverChild.stderr.on("data", (d) => process.stderr.write(`[oas-web] ${d}`));
  serverChild.on("exit", () => { serverChild = null; });
}

async function ensureServer() {
  // A healthy server on the port is only usable if it actually serves OUR
  // workspace — otherwise `--dir B` against a server for workspace A would
  // silently show (and type into!) the wrong agents.
  const existing = await panelWorkspaces();
  if (existing) {
    const id = matchWorkspace(existing);
    // Workspace coverage is necessary but NOT sufficient: an older installed
    // oas-web answers /api/panel yet lacks the desktop endpoints (/api/brain,
    // /api/file, /api/diff) — Brain would 404. Reuse only a server that
    // identifies as THIS checkout via /api/version.
    const compat = id ? serverCompatible(await probeVersion(), localServerIdentity()) : null;
    if (id && compat.compatible) { wsId = id; return { spawned: false }; }
    // wrong workspace or incompatible — leave that server alone and start
    // our own on the next free port (deterministic scan)
    console.log(id
      ? `oas-desktop: server on ${port} is incompatible (${compat.reason}) — starting a dedicated one`
      : `oas-desktop: server on ${port} serves ${existing.map((w) => w.name).join(", ")}, not ${WORKSPACE} — starting a dedicated one`);
    port = await freePort(port + 1);
  }
  spawnServer(port);
  // wait for the server to come up (max ~10s) and verify its workspace
  for (let i = 0; i < 40; i++) {
    const ws = await panelWorkspaces();
    if (ws) {
      const id = matchWorkspace(ws);
      if (!id) throw new Error(`spawned oas-web serves ${ws.map((w) => w.id).join(", ")} — does not cover ${WORKSPACE}`);
      wsId = id;
      return { spawned: true };
    }
    await new Promise((ok) => setTimeout(ok, 250));
  }
  throw new Error("spawned oas-web server but it never answered /api/panel");
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

// ---- IPC: integrated terminal (node-pty ↔ tmux attach) ------------------
const ptys = new Map(); // id -> IPty
let nextPtyId = 1;

ipcMain.handle("term:open", (e, { session, window: win, cols, rows }) => {
  guard(e);
  // openTerm (tmux-target.mjs) anchors the target (=session:=window — tmux
  // -t prefix-matches by default), PREFLIGHTS it so a missing exact target
  // rejects here (→ the renderer's "could not attach" banner) instead of
  // surfacing as a late async pty exit, then spawns the viewer pty.
  const { pty: p } = openTerm({ session, window: win, cols, rows }, {
    preflight: (target) => execFileSync("tmux", ["list-panes", "-t", target], { stdio: "ignore", timeout: 4000 }),
    // Direct attach: tmux stays the durable session host; the pty is a viewer.
    spawnPty: (target, c, r) => pty.spawn("tmux", ["attach-session", "-t", target], {
      name: "xterm-256color", cols: c, rows: r, cwd: process.env.HOME, env: process.env,
    }),
  });
  const id = nextPtyId++;
  const wc = e.sender;
  p.onData((data) => { if (!wc.isDestroyed()) wc.send(`term:data:${id}`, data); });
  p.onExit(({ exitCode }) => {
    ptys.delete(id);
    if (!wc.isDestroyed()) wc.send(`term:exit:${id}`, exitCode);
  });
  ptys.set(id, p);
  return id;
});
ipcMain.on("term:write", (e, id, data) => { guard(e); ptys.get(id)?.write(String(data)); });
ipcMain.on("term:resize", (e, id, cols, rows) => {
  guard(e);
  const p = ptys.get(id);
  if (p && cols > 0 && rows > 0) { try { p.resize(cols, rows); } catch { /* racing exit */ } }
});
ipcMain.on("term:close", (e, id) => {
  guard(e);
  // Kill the pty ONLY — tmux detaches the client; the session lives on.
  const p = ptys.get(id);
  ptys.delete(id);
  try { p?.kill(); } catch { /* already gone */ }
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
  try { await ensureServer(); }
  catch (e) { console.error(`oas-desktop: ${e.message}`); }
  await createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { app.quit(); });

function shutdown() {
  // Detach every viewer pty (never the tmux sessions) and stop the server
  // only if we started it.
  for (const p of ptys.values()) { try { p.kill(); } catch { /* best-effort */ } }
  ptys.clear();
  if (serverChild) { try { serverChild.kill(); } catch { /* best-effort */ } serverChild = null; }
}
app.on("before-quit", shutdown);
// SIGTERM/SIGINT (e.g. `kill <pid>`, Ctrl-C from a launcher shell) do not run
// before-quit on their own — without this the spawned oas-web child leaks.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => { shutdown(); app.quit(); });
}
