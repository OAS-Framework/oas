// Packaged-app probe runners for dist-smoke — extracted so the execution
// discipline is CONTRACT-TESTED (review ac366f9: reverting the smoke to
// synchronous execution previously left every reaper test green).
//
// Contract: every probe of the packaged app runs through the injected
// reaper's runTracked — asynchronous, detached, group-tracked, settled on
// close. There is NO synchronous execution primitive in this module, and
// the tests import it to assert the probe call goes through runTracked.
export function abiProbeSource(asarMainPath) {
  return `
    const { createRequire } = require("node:module");
    const req = createRequire(${JSON.stringify(asarMainPath)});
    const pty = req("node-pty");
    const p = pty.spawn("/bin/sh", ["-c", "echo pty-alive"], { cols: 20, rows: 5, cwd: "/tmp" });
    let out = "";
    p.onData((d) => { out += d; });
    p.onExit(() => { console.log(out.includes("pty-alive") ? "PTY_OK" : "PTY_NO_OUTPUT"); process.exit(0); });
    setTimeout(() => { console.log("PTY_TIMEOUT"); process.exit(1); }, 8000);
  `;
}

/**
 * Run the node-pty ABI probe against the packaged app.
 * `reaper` MUST provide runTracked (the group-tracked async runner); this
 * function never falls back to synchronous execution.
 * Returns { ok, detail }.
 */
export async function runAbiProbe(reaper, appExe, asarMainPath, {
  timeout = 30000, env = process.env, targetArch,
  platform = process.platform, hostArch = process.arch,
} = {}) {
  if (typeof reaper?.runTracked !== "function") {
    return { ok: false, detail: "probe runner requires a reaper with runTracked (async group-tracked execution is the contract)" };
  }
  // macos-14 runners are arm64. For the x64 cross-build, invoke the packaged
  // x64 Electron explicitly through Rosetta — auto-translation is not a
  // sufficient CI contract and may not engage predictably. Executing the
  // REAL x64 app + node-pty catches a wrong-arch native module.
  const rosetta = platform === "darwin" && hostArch === "arm64" && targetArch === "x64";
  const exe = rosetta ? "/usr/bin/arch" : appExe;
  const args = rosetta
    ? ["-x86_64", appExe, "-e", abiProbeSource(asarMainPath)]
    : ["-e", abiProbeSource(asarMainPath)];
  const r = await reaper.runTracked(exe, args, {
    timeout,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const mode = rosetta ? " under Rosetta x86_64" : "";
  if (r.timedOut) return { ok: false, detail: `node-pty ABI probe${mode} timed out (group killed)` };
  if (!r.stdout.includes("PTY_OK")) {
    const combined = `${String(r.stdout)}\n${String(r.stderr || "")}`.trim().slice(-500);
    return { ok: false, detail: `node-pty ABI probe${mode} failed (exit ${r.code}): ${combined}` };
  }
  return { ok: true, detail: `node-pty loads and spawns under the packaged Electron ABI${mode} (via app.asar)` };
}
