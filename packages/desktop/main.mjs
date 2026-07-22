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
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/desktop → repo root two levels up (in-tree layout).
const REPO_ROOT = resolve(HERE, "..", "..");

const PORT = Number(process.env.OAS_DESKTOP_PORT || 4820);
const BASE = `http://127.0.0.1:${PORT}`;
// Workspace the panel shows: --dir <path> or OAS_DESKTOP_DIR or the repo root.
const argDir = (() => {
  const i = process.argv.indexOf("--dir");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
})();
const WORKSPACE = resolve(argDir || process.env.OAS_DESKTOP_DIR || REPO_ROOT);

// ---- oas-web server management ----------------------------------------
let serverChild = null; // set only when WE spawned it

async function serverAlive() {
  try {
    const r = await fetch(`${BASE}/api/panel`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

async function ensureServer() {
  if (await serverAlive()) return { spawned: false };
  const bin = join(REPO_ROOT, "capabilities", "oas-web", "bin", "oas-web.mjs");
  if (!existsSync(bin)) throw new Error(`oas-web server not found at ${bin} and none running on port ${PORT}`);
  serverChild = spawn(process.execPath, [bin, "start", "--port", String(PORT), "--dir", WORKSPACE], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: WORKSPACE,
  });
  serverChild.stdout.on("data", (d) => process.stdout.write(`[oas-web] ${d}`));
  serverChild.stderr.on("data", (d) => process.stderr.write(`[oas-web] ${d}`));
  serverChild.on("exit", () => { serverChild = null; });
  // wait for the server to come up (max ~10s)
  for (let i = 0; i < 40; i++) {
    if (await serverAlive()) return { spawned: true };
    await new Promise((ok) => setTimeout(ok, 250));
  }
  throw new Error("spawned oas-web server but it never answered /api/panel");
}

// ---- IPC: API proxy -----------------------------------------------------
// The renderer never talks to the network directly; ctx.api() lands here.
ipcMain.handle("api", async (_e, pathname, opts) => {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) throw new Error("api: pathname must start with /");
  const init = { method: opts?.method || "GET", signal: AbortSignal.timeout(20000) };
  if (opts?.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { "content-type": "application/json" };
  }
  const r = await fetch(`${BASE}${pathname}`, init);
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: r.ok, status: r.status, body: json };
});

// ---- IPC: integrated terminal (node-pty ↔ tmux attach) ------------------
const ptys = new Map(); // id -> IPty
let nextPtyId = 1;

ipcMain.handle("term:open", (e, { session, window: win, cols, rows }) => {
  if (typeof session !== "string" || !/^[\w@%.:-]+$/.test(session)) throw new Error("term:open: bad session name");
  const target = win !== undefined && win !== null ? `${session}:${win}` : session;
  const id = nextPtyId++;
  // Direct attach: tmux stays the durable session host; the pty is a viewer.
  const p = pty.spawn("tmux", ["attach-session", "-t", target], {
    name: "xterm-256color",
    cols: Math.max(20, Number(cols) || 80),
    rows: Math.max(5, Number(rows) || 24),
    cwd: process.env.HOME,
    env: process.env,
  });
  const wc = e.sender;
  p.onData((data) => { if (!wc.isDestroyed()) wc.send(`term:data:${id}`, data); });
  p.onExit(({ exitCode }) => {
    ptys.delete(id);
    if (!wc.isDestroyed()) wc.send(`term:exit:${id}`, exitCode);
  });
  ptys.set(id, p);
  return id;
});
ipcMain.on("term:write", (_e, id, data) => { ptys.get(id)?.write(String(data)); });
ipcMain.on("term:resize", (_e, id, cols, rows) => {
  const p = ptys.get(id);
  if (p && cols > 0 && rows > 0) { try { p.resize(cols, rows); } catch { /* racing exit */ } }
});
ipcMain.on("term:close", (_e, id) => {
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
