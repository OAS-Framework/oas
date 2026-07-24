#!/usr/bin/env node
// OAS Desktop — installed-artifact smoke (CI: `npm run dist:smoke`).
//
// Proves the PACKAGED app (not the source tree) is runnable on this
// platform/arch:
//   1. inventory: dist/ contains exactly the expected oas-desktop-*
//      distributables for this platform (DMG+ZIP on mac, AppImage+DEB on
//      linux) and they are non-trivially sized;
//   2. the packaged app bundle launches headlessly and its renderer
//      reaches the shell (CDP probe), which also proves the bundled server
//      spawned and answered — i.e. no source-checkout dependency;
//   3. node-pty (the native module) loads INSIDE the packaged app's
//      Electron ABI (ELECTRON_RUN_AS_NODE against the packaged
//      resources), catching ABI-mismatch and lost spawn-helper exec bits.
//
// Runs on the bare CI runner — no display server needed on linux when
// xvfb-run is present (the workflow provides it); on macOS Electron runs
// headless-ish natively.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReaper } from "./proc-reaper.mjs";
import { runAbiProbe } from "./smoke-probes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const DIST = join(PKG, "dist");
const fail = (msg) => { console.error(`dist:smoke FAIL — ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`dist:smoke ok — ${msg}`);

// ---- leak-proofing (hard requirement after a local process-swarm incident) --
// The reaper (scripts/proc-reaper.mjs, unit-tested) owns the contract:
// detached process groups, GROUP RETENTION until explicit reaping (leader
// exit never drops a group — descendants can outlive it), async-only child
// execution (runTracked only; synchronous child execution is banned — it blocks
// signal handlers and the watchdog, and its timeout kills only the
// immediate PID). reapAll is installed on EVERY exit path — fail() calls
// process.exit() which skips finally-blocks — plus a wall-clock watchdog.
const reaper = createReaper({ spawn });
const { spawnTracked, reapGroup, reapAll, runTracked } = reaper;
process.on("exit", reapAll);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { reapAll(); process.exit(1); });
process.on("uncaughtException", (e) => { console.error(`dist:smoke FAIL — uncaught: ${e.message}`); reapAll(); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(`dist:smoke FAIL — unhandled: ${e?.message || e}`); reapAll(); process.exit(1); });
const WATCHDOG_MS = 120_000;
const watchdog = setTimeout(() => { console.error(`dist:smoke FAIL — watchdog: exceeded ${WATCHDOG_MS / 1000}s`); reapAll(); process.exit(1); }, WATCHDOG_MS);
watchdog.unref?.();

// ---- 1. artifact inventory -------------------------------------------------
if (!existsSync(DIST)) fail(`no dist/ — run npm run dist first`);
const files = readdirSync(DIST).filter((f) => f.startsWith("oas-desktop-"));
const need = process.platform === "darwin" ? ["dmg", "zip"] : ["AppImage", "deb"];
for (const ext of need) {
  const hit = files.find((f) => f.endsWith(`.${ext}`));
  if (!hit) fail(`missing .${ext} in dist/ (have: ${files.join(", ") || "none"})`);
  const size = statSync(join(DIST, hit)).size;
  if (size < 50 * 1024 * 1024 * 0.5) fail(`${hit} is implausibly small (${size} bytes)`);
  ok(`${hit} present (${(size / 1024 / 1024).toFixed(0)} MB)`);
}

// ---- locate the unpacked packaged app ---------------------------------------
// electron-builder leaves the unpacked build in dist/<platform>-unpacked (or
// mac{,-arm64}/): smoke against THAT — it is byte-identical app content to
// the installers without needing a mount/install step in CI.
function unpackedAppPath() {
  if (process.platform === "darwin") {
    for (const d of readdirSync(DIST)) {
      const app = join(DIST, d, "OAS Desktop.app");
      if (d.startsWith("mac") && existsSync(app)) {
        return { exe: join(app, "Contents", "MacOS", "OAS Desktop"), resources: join(app, "Contents", "Resources") };
      }
    }
  } else {
    const d = join(DIST, "linux-unpacked");
    if (existsSync(d)) return { exe: join(d, "oas-desktop"), resources: join(d, "resources") };
  }
  return null;
}
const app = unpackedAppPath();
if (!app) fail("no unpacked app found in dist/");
if (!existsSync(app.exe)) fail(`packaged executable missing: ${app.exe}`);

// ---- 2. node-pty loads under the packaged Electron ABI ----------------------
// Load node-pty the way the APP does: createRequire from inside app.asar.
// Electron's fs reads the asar transparently and node-pty's own
// app.asar → app.asar.unpacked replacement finds the native module and the
// spawn-helper. (Loading from the unpacked path directly is WRONG: the
// replace() then produces app.asar.unpacked.unpacked and posix_spawnp
// fails with ENOENT — exactly the class of bug this smoke exists to catch.)
{
  const unpacked = join(app.resources, "app.asar.unpacked", "node_modules", "node-pty");
  if (!existsSync(unpacked)) fail("node-pty not asar-unpacked in the package");
  // spawn-helper must be executable (lesson: npm can drop the exec bit)
  const helpers = [];
  const collect = (d) => { if (existsSync(d)) for (const e of readdirSync(d)) { const h = join(d, e, "spawn-helper"); if (existsSync(h)) helpers.push(h); } };
  collect(join(unpacked, "prebuilds"));
  const buildHelper = join(unpacked, "build", "Release", "spawn-helper");
  if (existsSync(buildHelper)) helpers.push(buildHelper);
  for (const h of helpers) {
    const mode = statSync(h).mode & 0o111;
    if (!mode) fail(`spawn-helper not executable in the package: ${h}`);
  }
  // Probe via the extracted runner (scripts/smoke-probes.mjs): the runner
  // CONTRACTUALLY requires the reaper's runTracked — async, detached,
  // group-tracked; reintroducing synchronous execution fails its tests.
  const r = await runAbiProbe(reaper, app.exe, join(app.resources, "app.asar", "main.mjs"), { timeout: 30000 });
  if (!r.ok) fail(r.detail);
  ok(r.detail);
}

// ---- 3. packaged app launches and the renderer reaches the shell ------------
{
  const port = 9500 + Math.floor(Math.random() * 400);
  const userData = mkdtempSync(join(tmpdir(), "oas-desktop-smoke-"));
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
    "--no-sandbox", "--disable-gpu", "--dir", userData /* empty workspace: picker path, no deployment needed */];
  // spawnTracked: detached process group + registered for unconditional
  // reaping on every exit path (see leak-proofing block above).
  const child = spawnTracked(app.exe, args, { stdio: "ignore", env: { ...process.env, OAS_DESKTOP_PORT: String(10000 + Math.floor(Math.random() * 2000)) } });
  try {
    let targets = null;
    for (let i = 0; i < 60 && !targets; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json`);
        const list = await res.json();
        targets = list.find((t) => t.type === "page" && /index\.html/.test(t.url || ""));
      } catch { /* not up yet */ }
    }
    if (!targets) fail("packaged app never exposed its renderer over CDP");
    // Evaluate in the page: the shell booted if the nav rail rendered.
    const ws = new WebSocket(targets.webSocketDebuggerUrl);
    const result = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("CDP evaluate timeout")), 20000);
      ws.onopen = () => ws.send(JSON.stringify({
        id: 1, method: "Runtime.evaluate",
        params: {
          expression: `new Promise((ok) => {
            const probe = () => {
              const nav = document.querySelectorAll("#nav .nav-item").length;
              if (nav > 0) ok("SHELL_OK nav=" + nav);
              else setTimeout(probe, 500);
            }; probe();
            setTimeout(() => ok("SHELL_TIMEOUT html=" + document.body.innerHTML.slice(0, 200)), 15000);
          })`,
          awaitPromise: true, returnByValue: true,
        },
      }));
      ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.id === 1) { clearTimeout(to); resolve(d.result?.result?.value || ""); }
      };
      ws.onerror = (e) => { clearTimeout(to); reject(new Error(`CDP socket error`)); };
    });
    ws.close();
    if (!String(result).startsWith("SHELL_OK")) fail(`renderer did not reach the shell: ${result}`);
    ok(`packaged app launched; ${result}`);
  } finally { reapGroup(child); }
}

reapAll();
clearTimeout(watchdog);
console.log("dist:smoke PASS");
