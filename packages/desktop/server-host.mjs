// Server host — owns the app's oas-web child process lifecycle and the
// ownership/trust-state transitions. Extracted from main.mjs so the REAL
// production seam is importable in tests (review wsadd3: regressions that
// reimplement `|| transition` or cache invalidation in mocks pin nothing —
// deleting the production line left them green).
//
// Invariants owned here:
//  - ownership persists across a replacement (owned() is true from the
//    moment replace() starts until it finishes) — adds arriving mid-
//    transition queue instead of failing foreign;
//  - a child's late exit can only clear the reference to ITSELF, never to
//    a successor;
//  - replace() awaits the old child's actual exit (SIGKILL fallback) before
//    the caller rebinds the port, and invalidates the advertised trust
//    state at transition start via onInvalidate() — stale entries from the
//    outgoing server must never validate anything.
export function createServerHost(io) {
  // io: spawnChild(dirs) -> child (kill(sig?), once/on("exit", cb));
  //     onInvalidate() -> void (clear advertised/trust caches)
  let child = null;
  let transition = false;

  function adopt(c) {
    c.on("exit", () => { if (child === c) child = null; });
    child = c;
    return c;
  }

  return {
    owned: () => !!child || transition,
    inTransition: () => transition,
    current: () => child,
    /** Start the first child (no predecessor). */
    start(dirs) {
      return adopt(io.spawnChild(dirs));
    },
    /** Stop the owned child (awaiting real exit) and start one with `dirs`. */
    async replace(dirs) {
      transition = true;
      io.onInvalidate(); // trust state belongs to the outgoing server
      try {
        const old = child;
        if (old) {
          child = null; // we own the transition; old's exit hook is now a no-op
          await new Promise((done) => {
            const t = setTimeout(() => { try { old.kill("SIGKILL"); } catch { /* gone */ } }, io.forceKillMs ?? 3000);
            old.once("exit", () => { clearTimeout(t); done(); });
            try { old.kill(); } catch { clearTimeout(t); done(); }
          });
        }
        adopt(io.spawnChild(dirs));
      } finally {
        transition = false;
      }
    },
    /** Shutdown: kill the owned child if any. */
    stop() {
      const c = child;
      child = null;
      if (c) { try { c.kill(); } catch { /* best-effort */ } }
      return c;
    },
  };
}
