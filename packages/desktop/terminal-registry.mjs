// OAS desktop — terminal viewer resource registry (Slice G).
//
// HARD invariant (human release blocker): the Desktop app must never fan out
// enough terminal/viewer sessions to hang the machine. The main process owns
// every node-pty and its `oasdesk-*` tmux viewer session, so the ceiling and
// the dedupe live HERE — not in the renderer, whose tab-key dedupe is a
// best-effort UX nicety scoped to one workspace's tab list, NOT a resource
// bound.
//
// Two guarantees:
//   1. DEDUPE by intended target: one live pty/viewer per distinct terminal
//      target. Repeated opens of the same target (clicks, re-renders,
//      polling, focus, reconnect, stale async completion) REUSE the existing
//      terminal — they never create a second viewer.
//   2. HARD CAP: at most `max` (default 20) simultaneous terminals. A
//      distinct open beyond the cap is REJECTED, visibly and actionably —
//      never a silent eviction, never a silent extra create.
//
// The registry is pure and synchronous; main.mjs's term:open handler is
// synchronous end to end (openTerm uses execFileSync/pty.spawn), so
// plan()->create->commit() is atomic on the single main thread and
// concurrent IPC opens cannot interleave to exceed the cap.

// The cap is the machine-protecting ceiling, not a UX preference: it exists
// so the app can never fan out enough attached tmux clients + ptys to hang
// the host. 20 is a generous working ceiling (operator-directed) well below
// the fan-out that caused the hang.
export const MAX_TERMINALS = 20;

/**
 * @param {{ max?: number }} [opts]
 * @returns {{
 *   plan(targetKey: string): { action: "reuse", id: any }
 *                          | { action: "cap", active: number, max: number }
 *                          | { action: "create" },
 *   commit(targetKey: string, id: any): void,
 *   release(id: any): void,
 *   has(targetKey: string): boolean,
 *   activeCount(): number,
 *   ids(): any[],
 * }}
 */
export function createTerminalRegistry({ max = MAX_TERMINALS } = {}) {
  const byKey = new Map(); // targetKey -> id
  const byId = new Map();  // id -> targetKey

  return {
    /** Decide the action for an open of `targetKey` WITHOUT mutating state.
     * The caller creates the pty only on "create", then commit()s it. */
    plan(targetKey) {
      if (byKey.has(targetKey)) return { action: "reuse", id: byKey.get(targetKey) };
      if (byKey.size >= max) return { action: "cap", active: byKey.size, max };
      return { action: "create" };
    },
    /** Record a successfully created terminal. Idempotent per (key,id). */
    commit(targetKey, id) {
      // Defensive: a commit for a key that somehow already exists must not
      // orphan the prior id — release it first (should not happen given
      // plan() gates creation, but keeps the maps consistent).
      const prior = byKey.get(targetKey);
      if (prior !== undefined && prior !== id) byId.delete(prior);
      byKey.set(targetKey, id);
      byId.set(id, targetKey);
    },
    /** Drop a terminal by id (pty exit, tab close, failed/aborted open). */
    release(id) {
      const key = byId.get(id);
      if (key === undefined) return;
      byId.delete(id);
      // Only clear the key if it still points at THIS id (a reuse could have
      // re-pointed it — it cannot today, but keep the maps honest).
      if (byKey.get(key) === id) byKey.delete(key);
    },
    has(targetKey) { return byKey.has(targetKey); },
    activeCount() { return byKey.size; },
    ids() { return [...byId.keys()]; },
  };
}

/** Stable target key for a tmux terminal target. NUL-joined so no
 * session/window value can forge a different key (both are already charset-
 * validated by tmuxAttachTarget before a viewer is ever built). */
export function terminalTargetKey(session, window) {
  return `${String(session)}\u0000${window === undefined || window === null ? "" : String(window)}`;
}
