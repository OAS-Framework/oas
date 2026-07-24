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
export async function runAbiProbe(reaper, appExe, asarMainPath, { timeout = 30000, env = process.env } = {}) {
  if (typeof reaper?.runTracked !== "function") {
    return { ok: false, detail: "probe runner requires a reaper with runTracked (async group-tracked execution is the contract)" };
  }
  const r = await reaper.runTracked(appExe, ["-e", abiProbeSource(asarMainPath)], {
    timeout,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
  });
  if (r.timedOut) return { ok: false, detail: "node-pty ABI probe timed out (group killed)" };
  if (!r.stdout.includes("PTY_OK")) return { ok: false, detail: `node-pty ABI probe failed (exit ${r.code}): ${String(r.stdout).trim().slice(0, 300)}` };
  return { ok: true, detail: "node-pty loads and spawns under the packaged Electron ABI (via app.asar)" };
}
