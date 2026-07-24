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
import { existsSync, readdirSync, statSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReaper } from "./proc-reaper.mjs";
import { runAbiProbe } from "./smoke-probes.mjs";
import { WATCHDOG_MS, PHASE_BUDGET_MS, boundedTail, readDevToolsPort, awaitClose } from "./launch-probe.mjs";

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
const watchdog = setTimeout(() => { console.error(`dist:smoke FAIL — watchdog: exceeded ${WATCHDOG_MS / 1000}s (derived from phase budgets)`); reapAll(); process.exit(1); }, WATCHDOG_MS);
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
  const r = await runAbiProbe(reaper, app.exe, join(app.resources, "app.asar", "main.mjs"), { timeout: PHASE_BUDGET_MS.abiProbe });
  if (!r.ok) fail(r.detail);
  ok(r.detail);
}

// ---- 3. packaged app launches and the renderer reaches the shell ------------
// (CI-oriented phase: on operator machines run only the static phases — see
// the soul's no-GUI-launches policy; OAS_SMOKE_SKIP_LAUNCH=1 skips this.)
if (process.env.OAS_SMOKE_SKIP_LAUNCH === "1") {
  // The guard (review ee04a44-r2) stops a RELEASE CI run from silently
  // degrading the smoke by skipping the launch. But the packaged GUI launch
  // is unreliable in CI (no interactive windowserver for an unsigned app on
  // mac runners → DevToolsActivePort never written), and the meaningful
  // installer evidence is BUILD + inventory + node-pty ABI. A dedicated
  // build-verify CI (build-installers.yml) opts out explicitly with
  // OAS_SMOKE_BUILD_VERIFY=1; only an UNMARKED skip under GITHUB_ACTIONS is
  // rejected (the accidental-release-degradation case the guard exists for).
  if (process.env.GITHUB_ACTIONS === "true" && process.env.OAS_SMOKE_BUILD_VERIFY !== "1")
    fail("OAS_SMOKE_SKIP_LAUNCH must not be set in a release CI run — set OAS_SMOKE_BUILD_VERIFY=1 for the build-only installer workflow");
  ok("launch phase skipped (OAS_SMOKE_SKIP_LAUNCH=1) — build + inventory + node-pty ABI verified; GUI launch needs a display");
} else {
  // Readiness probing (review ee04a44 + r2). The port is obtained race-free
  // and IDENTITY-BOUND: launch with --remote-debugging-port=0 and read the
  // DevToolsActivePort file Chromium writes into --user-data-dir — the port
  // is definitionally OUR child's, so no stale/foreign listener can be
  // mistaken for the app (no check-then-use free-port race). The backend
  // port is app-selected: main.mjs's ensureServer runs its own freePort
  // from OAS_DESKTOP_PORT, so a random start value cannot collide fatally.
  // stdio is captured (bounded rolling tail) and drained on 'close' before
  // any crash tail is reported; startup exit fails fast; one launch, one
  // bounded wait — never a blind retry.
  const userData = mkdtempSync(join(tmpdir(), "oas-desktop-smoke-"));
  const args = [`--remote-debugging-port=0`, `--user-data-dir=${userData}`,
    "--no-sandbox", "--disable-gpu", "--dir", userData /* empty workspace: picker path, no deployment needed */];
  const child = spawnTracked(app.exe, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OAS_DESKTOP_PORT: String(10000 + Math.floor(Math.random() * 1500)) } });
  let childLog = "", childExit = null;
  child.stdout?.on("data", (d) => { childLog = boundedTail(childLog, d); });
  child.stderr?.on("data", (d) => { childLog = boundedTail(childLog, d); });
  child.on("exit", (code, sig) => { childExit = { code, sig }; });
  // Slice G resource-containment baseline: capture the `oasdesk-*` tmux
  // viewer count before launch and assert it is RESTORED after the app is
  // reaped — on BOTH the success and the forced-failure/timeout paths.
  // Proves the app's shutdown + orphan sweep leave no viewer residue.
  // (async count — the smoke bans synchronous child execution.)
  async function oasdeskViewerCount() {
    const r = await runTracked("tmux", ["list-sessions", "-F", "#{session_name}"], { timeout: 5000 });
    if (r.timedOut) return null;                     // tmux wedged — skip (unusual)
    return String(r.stdout).split("\n").filter((s) => s.startsWith("oasdesk-")).length;
  }
  const viewerBaseline = await oasdeskViewerCount(); // 0 when tmux is absent/no-server (ENOENT/nonzero → empty stdout → 0); null only on a tmux timeout
  let launchError = null;
  // drainTail: return the current bounded output tail. Only wait for a
  // final flush when the child has ALREADY EXITED (a live child's tail is
  // already current, and awaiting its 'close' would block until the
  // watchdog — review 7bdaf1e-r2 finding 2). awaitClose is total-bounded
  // regardless, so even the exited path cannot hang.
  const drainTail = async () => { if (childExit !== null) await awaitClose(child, { drainMs: 2000 }); return childLog.slice(-1500); };
  try {
    // ONE shared launchReady deadline across the port wait AND the /json
    // poll (review 7bdaf1e-r2 finding 1: spending launchReady twice made
    // worst-case success 240s > the 180s watchdog — the premature-kill this
    // commit exists to prevent). /json answers ~immediately after
    // DevToolsActivePort is written, so sharing the budget is ample.
    const launchDeadline = Date.now() + PHASE_BUDGET_MS.launchReady;
    const portRes = await readDevToolsPort(userData, { join, existsSync, readFileSync, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }, {
      timeoutMs: Math.max(0, launchDeadline - Date.now()), pollMs: 250, childExited: () => childExit !== null,
    });
    if (portRes.error) throw new Error(`${portRes.error} (app alive=${!childExit}); output tail:\n${await drainTail()}`);
    const port = portRes.port;
    let targets = null, lastDiag = 0;
    while (!targets && Date.now() < launchDeadline) {
      if (childExit) throw new Error(`packaged app exited during startup (code=${childExit.code} sig=${childExit.sig}); output tail:\n${await drainTail()}`);
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) });
        const list = await res.json();
        targets = list.find((t) => t.type === "page" && /index\.html/.test(t.url || ""));
      } catch { /* not up yet */ }
      if (!targets && Date.now() - lastDiag > 10_000) {
        lastDiag = Date.now();
        console.log(`dist:smoke … waiting for CDP (${Math.round((launchDeadline - Date.now()) / 1000)}s budget left; app alive=${!childExit})`);
      }
    }
    if (!targets) throw new Error(`packaged app never exposed its renderer over CDP within ${PHASE_BUDGET_MS.launchReady / 1000}s (app alive=${!childExit}); output tail:\n${await drainTail()}`);
    // Evaluate in the page: the shell booted if the nav rail rendered.
    const ws = new WebSocket(targets.webSocketDebuggerUrl);
    const result = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("CDP evaluate timeout")), PHASE_BUDGET_MS.cdpEvaluate);
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
    if (!String(result).startsWith("SHELL_OK")) throw new Error(`renderer did not reach the shell: ${result}`);
    ok(`packaged app launched; ${result}`);
  } catch (e) {
    launchError = e;
  } finally {
    reapGroup(child);
    // Baseline restoration assertion — runs on success AND failure (the
    // catch above converted every launch failure to a caught error so this
    // finally always executes; no fail()/process.exit skips it).
    if (viewerBaseline !== null) {
      let restored = false;
      for (let i = 0; i < 10 && !restored; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const now = await oasdeskViewerCount();
        if (now !== null && now <= viewerBaseline) restored = true;
      }
      if (!restored) fail(`tmux viewer baseline not restored after ${launchError ? "forced failure" : "success"} (baseline ${viewerBaseline}, still elevated)`);
      ok(`tmux viewer baseline restored (${viewerBaseline}) after ${launchError ? "forced failure" : "success"}`);
    }
  }
  if (launchError) fail(launchError.message);
}

reapAll();
clearTimeout(watchdog);
console.log("dist:smoke PASS");
