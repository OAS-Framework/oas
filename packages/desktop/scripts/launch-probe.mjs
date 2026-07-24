// Packaged-launch probe helpers for dist-smoke — extracted so the readiness
// logic is DETERMINISTICALLY TESTED (review ee04a44-r2: the launch logic
// shipped untested, and the ad-hoc port picking had a check-then-use race).
// Pure/injected: no Electron, no real processes.

// Phase budgets the smoke's watchdog must exceed. The launch path is the
// long pole: readiness poll + CDP evaluate, on top of inventory and the ABI
// probe (which re-execs the packaged binary and eats the same cold-start
// cost). The watchdog is DERIVED from these so it can never fire before a
// legitimately-slow-but-succeeding run completes (review ee04a44-r2
// finding 1); a test asserts WATCHDOG_MS > sum(phase budgets).
export const PHASE_BUDGET_MS = {
  inventory: 10_000,
  abiProbe: 30_000,
  launchReady: 90_000,
  cdpEvaluate: 20_000,
};
export const PHASE_BUDGET_SUM = Object.values(PHASE_BUDGET_MS).reduce((a, b) => a + b, 0);
export const WATCHDOG_MS = PHASE_BUDGET_SUM + 30_000; // margin over the summed budgets

/** Rolling bounded tail — a pathologically noisy child must not balloon
 * memory over a 90s wait; only the tail is ever reported anyway. */
export function boundedTail(prev, chunk, max = 4096) {
  const s = prev + String(chunk);
  return s.length > max ? s.slice(-max) : s;
}

/**
 * Read the CDP port from Chromium's DevToolsActivePort file, which the app
 * writes into its --user-data-dir when launched with
 * --remote-debugging-port=0. This is RACE-FREE and IDENTITY-BINDING: the
 * port is definitionally OUR child's (review ee04a44-r2 finding 2 — a
 * pre-picked free port is check-then-use and a foreign Chromium serving a
 * matching /json target would pass). First line is the port.
 * io = { existsSync, readFileSync, sleep, now }, `childExited()` lets the
 * caller abort fast if the app died before writing the file.
 */
export async function readDevToolsPort(userDataDir, io, { timeoutMs = 90_000, pollMs = 250, childExited = () => false } = {}) {
  const file = io.join(userDataDir, "DevToolsActivePort");
  const t0 = io.now();
  while (io.now() - t0 < timeoutMs) {
    if (childExited()) return { error: "child exited before writing DevToolsActivePort" };
    if (io.existsSync(file)) {
      try {
        const lines = String(io.readFileSync(file, "utf8")).split("\n");
        const port = Number(lines[0]);
        if (Number.isInteger(port) && port > 0) return { port, wsPath: lines[1] || "" };
      } catch { /* mid-write — retry */ }
    }
    await io.sleep(pollMs);
  }
  return { error: `DevToolsActivePort not written within ${timeoutMs / 1000}s` };
}

/**
 * Resolve when the child's stdio is fully drained: Node guarantees stdio
 * completion at 'close', not 'exit' (review ee04a44-r2 finding 3 — the same
 * rule the reaper already codified). Awaits 'close' but no longer than
 * drainMs after 'exit' so a wedged stream cannot hang the smoke.
 */
export function awaitClose(child, { drainMs = 2000, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    if (child.exitCode !== null || child.signalCode !== null) {
      const t = st(finish, drainMs);
      child.on?.("close", () => { ct(t); finish(); });
      return;
    }
    child.on?.("close", finish);
    child.on?.("exit", () => { const t = st(finish, drainMs); child.on?.("close", () => { ct(t); finish(); }); });
  });
}
