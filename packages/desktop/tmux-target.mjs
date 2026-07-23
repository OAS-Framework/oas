// tmux attach-target construction for the desktop terminal — extracted from
// main.mjs so the exact-match anchoring is unit-testable.
//
// tmux `-t` targets are PREFIX-matched by default (the reviewer-death
// incident: `kill-window -t s:reviewer-1` matched `reviewer-15c...`). For
// the attach path the same hazard means: with a stale roster and the exact
// window gone, an unanchored `session:window` attaches to a similarly named
// live window and the user's keystrokes go to the WRONG agent's session.
// `=` anchors each component to an exact match — tmux then errors out
// ("can't find window") instead of silently prefix-matching, which the
// renderer surfaces as its "could not attach" state.

/**
 * @param {string} session  tmux session name (no ':' — it's the separator;
 *                          no leading '=' games; conservative charset)
 * @param {string|number} [window]  window name or index (optional)
 * @returns {string} an exact-match anchored target: "=session" or
 *                   "=session:=window"
 * @throws on invalid session/window values
 */
export function tmuxAttachTarget(session, window) {
  if (typeof session !== "string" || !/^[\w@%.-]+$/.test(session)) {
    throw new Error("term:open: bad session name");
  }
  if (window === undefined || window === null) return `=${session}`;
  const win = String(window);
  if (!/^[\w@%.-]+$/.test(win)) throw new Error("term:open: bad window name");
  return `=${session}:=${win}`;
}

/**
 * The term:open sequence — target anchoring, preflight, pty spawn — with
 * injectable dependencies so the ORDER is testable (review tmuxtgt2: a
 * preflight only proven by an isolated tmux test is unprotected; deleting
 * it left the suite green).
 *
 * node-pty's spawn succeeds once the tmux BINARY starts; a bad -t target
 * only surfaces as an async exit AFTER term:open resolved with an id — the
 * renderer's open-error path then never fires (a 'session ended' banner at
 * best, or a blank tab when the exit races the listener install). The
 * preflight verifies the exact target NOW and throws BEFORE any pty exists,
 * so a missing target reliably rejects term:open → the renderer's
 * 'could not attach' banner.
 *
 * @param {{ session: string, window?: string|number, cols?: number, rows?: number }} spec
 * @param {{ preflight: (target: string) => void,   // throws if target absent
 *           spawnPty: (target: string, cols: number, rows: number) => any }} io
 * @returns {{ target: string, pty: any }}
 */
/** Viewer-session name prefix: unique per app process so the orphan sweep
 * (app start/quit) is exact and can never touch foreign sessions. */
export function viewerPrefix(pid) {
  return `oasdesk-${pid}-`;
}

/**
 * The term:open sequence with a per-tab GROUPED viewer session — target
 * anchoring, preflight, viewer creation, exact window selection, pty spawn —
 * with injectable dependencies so the ORDER and the cleanup contract are
 * testable.
 *
 * WHY a grouped session: the pty client previously joined the DURABLE
 * session directly and therefore followed its current-window selection —
 * when any other client changed the selected window, every open desktop
 * terminal silently switched to it while its tab label still claimed the
 * original instance (steady-state wrong-agent keystrokes). A session
 * grouped to the durable one (`tmux new-session -t <durable>`) shares its
 * windows but owns an INDEPENDENT current-window selection; each tab gets
 * its own viewer session pinned to its exact window.
 *
 * Cleanup contract: kill ONLY the viewer session (=-anchored, unique name);
 * the durable session and its windows are never touched.
 *
 * @param {{ session: string, window?: string|number, cols?: number, rows?: number }} spec
 * @param {object} io
 * @param {(target: string) => void} io.preflight   throws if the exact source target is absent
 * @param {(args: string[]) => void} io.tmux        run a tmux command (throws on failure)
 * @param {(target: string, cols: number, rows: number) => any} io.spawnPty
 * @param {() => string} [io.uniqueName]            viewer session name (default: prefix+pid+counter+random)
 * @returns {{ target: string, viewer: string, pty: any,
 *             killViewer: () => void }}
 */
let viewerSeq = 0;
export function openTerm(spec, io) {
  const target = tmuxAttachTarget(spec.session, spec.window);
  try {
    io.preflight(target);
  } catch {
    throw new Error(`term:open: no tmux target ${target}`);
  }
  const viewer = io.uniqueName ? io.uniqueName()
    : `${viewerPrefix(process.pid)}${++viewerSeq}-${Math.random().toString(36).slice(2, 8)}`;
  // Grouped viewer session: shares the durable session's windows, owns its
  // own current-window selection. Select the exact window IN THE VIEWER, so
  // no other client's selection can ever move this tab.
  io.tmux(["new-session", "-d", "-s", viewer, "-t", `=${spec.session}`]);
  const killViewer = () => io.tmux(["kill-session", "-t", `=${viewer}`]);
  try {
    if (spec.window !== undefined && spec.window !== null) {
      io.tmux(["select-window", "-t", `=${viewer}:=${String(spec.window)}`]);
    }
    const pty = io.spawnPty(`=${viewer}`, Math.max(20, Number(spec.cols) || 80), Math.max(5, Number(spec.rows) || 24));
    return { target, viewer, pty, killViewer };
  } catch (e) {
    // window selection or pty spawn failed — do not leak the viewer session
    try { killViewer(); } catch { /* best-effort */ }
    throw e;
  }
}

/**
 * Sweep orphaned viewer sessions (crashed app instances). Safe and exact:
 * only sessions whose name starts with the oasdesk- prefix are killed —
 * optionally scoped to a specific pid's prefix, else any oasdesk- session
 * whose pid is no longer alive.
 *
 * @param {object} io
 * @param {() => string[]} io.listSessions        tmux session names
 * @param {(name: string) => void} io.killSession =-anchored kill
 * @param {(pid: number) => boolean} io.pidAlive
 * @returns {string[]} the names swept
 */
export function sweepViewers(io) {
  const swept = [];
  for (const name of io.listSessions()) {
    const m = name.match(/^oasdesk-(\d+)-/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;      // our own live viewers
    if (io.pidAlive(pid)) continue;         // another live desktop's viewers
    try { io.killSession(name); swept.push(name); } catch { /* raced its owner */ }
  }
  return swept;
}
