// Process-group reaper for smoke scripts that launch Electron trees.
//
// Invariants (review 4e2667b — the leak-proofing contract):
//   * every child is spawned detached (own process group, pgid = pid);
//   * GROUP IDS ARE RETAINED UNTIL EXPLICIT REAPING — a leader exiting does
//     NOT remove its group, because descendants can outlive the leader and
//     killing -pgid still reaps them;
//   * reapAll() kills every retained group + live leader handle; it is
//     installed on process exit, signals, and uncaught/unhandled paths by
//     the consumer;
//   * runTracked() is the ONLY child-execution primitive — asynchronous,
//     group-killing on timeout; never execFileSync (synchronous execution
//     blocks the event loop so signal handlers and watchdogs cannot run,
//     and its timeout kills only the immediate PID, never the tree).
//
// `io` injection makes the kill/retention semantics unit-testable without
// real processes (mutation-checkable: dropping retention fails the tests).
export function createReaper(io = {}) {
  const spawnImpl = io.spawn;
  const killGroup = io.killGroup || ((pgid) => process.kill(-pgid, "SIGKILL"));
  const groups = new Set();          // pgids — retained until reaped, NOT on leader exit
  const leaders = new Set();         // live child handles (direct-kill fallback)

  function spawnTracked(exe, args, opts) {
    const c = spawnImpl(exe, args, { ...opts, detached: true }); // pgid = pid
    groups.add(c.pid);                                           // retained until reap*
    leaders.add(c);
    c.on("exit", () => leaders.delete(c));                       // handle cleanup ONLY — group stays
    return c;
  }

  /** Kill one tracked child's WHOLE GROUP now (descendants included).
   * Idempotent: a group already reaped (e.g. timeout then leader exit)
   * is not killed twice. */
  function reapGroup(c) {
    if (!groups.has(c.pid)) { leaders.delete(c); return; }
    try { killGroup(c.pid); } catch { /* group already empty */ }
    try { c.kill("SIGKILL"); } catch { /* gone */ }
    groups.delete(c.pid);
    leaders.delete(c);
  }

  /** Kill every retained group and live leader. */
  function reapAll() {
    for (const c of leaders) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
    leaders.clear();
    for (const pgid of groups) { try { killGroup(pgid); } catch { /* empty */ } }
    groups.clear();
  }

  /** Async, detached, group-tracked run: collects stdout+stderr, group-kills
   * on timeout, resolves { stdout, stderr, code, timedOut }.
   * Settles on CLOSE, not exit: Node guarantees stdio completion only at
   * `close` — resolving on `exit` can race the final data events (review
   * ac366f9: the ABI probe's PTY_OK could arrive after exit). stderr is
   * consumed too so a chatty child can never back-pressure itself into a
   * hang. Group reaping still happens at exit (descendants must not
   * outlive the leader's window). */
  function runTracked(exe, args, { timeout, env } = {}) {
    return new Promise((resolve) => {
      const c = spawnTracked(exe, args, { stdio: ["ignore", "pipe", "pipe"], env });
      let stdout = "", stderr = "", timedOut = false, exitCode = null;
      c.stdout?.on("data", (d) => { stdout += d; });
      c.stderr?.on("data", (d) => { stderr += d; });
      const t = setTimeout(() => { timedOut = true; reapGroup(c); }, timeout || 30000);
      c.on("exit", (code) => {
        exitCode = code;
        reapGroup(c); // group may still hold descendants — reap regardless of leader exit
      });
      c.on("close", (code) => {
        clearTimeout(t);
        resolve({ stdout, stderr, code: exitCode ?? code, timedOut });
      });
      c.on("error", () => { clearTimeout(t); reapGroup(c); resolve({ stdout, stderr, code: -1, timedOut }); });
    });
  }

  return {
    spawnTracked, reapGroup, reapAll, runTracked,
    pendingGroups: () => new Set(groups),   // observability for tests
  };
}
