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
 * The term:open sequence with a per-tab LINKED-WINDOW viewer session —
 * target anchoring, preflight, viewer creation, pty spawn — with injectable
 * dependencies so the ORDER and the cleanup contract are testable.
 *
 * WHY a linked window (not session grouping): grouping isolates the
 * current-window SELECTION but shares window MEMBERSHIP — when the selected
 * source window dies (routine retire!), tmux auto-selects a sibling in the
 * viewer, and viewer-side key bindings can navigate to sibling windows;
 * both silently steer the tab to ANOTHER AGENT under a stale label. The
 * viewer is therefore an independent ephemeral session containing ONLY a
 * link to the exact requested window:
 *   1. create placeholder session (unique unpredictable oasdesk- name);
 *   2. link-window the =-anchored exact source window in;
 *   3. kill the placeholder window — the link is the sole window;
 *   4. lock the viewer: prefix/prefix2 None + a nonexistent key-table, so
 *      no tmux window-management key can leave the linked window (normal
 *      pane interaction is raw input to the pty and unaffected).
 * Destroying the source window then TERMINATES the viewer (its only window
 * is gone → pty exits → the tab shows "session ended") — verified
 * empirically; it can never activate a sibling.
 *
 * Cleanup contract: kill ONLY the viewer session (=-anchored, unique name);
 * killing the viewer never kills the linked source window (link refcount).
 *
 * @param {{ session: string, window?: string|number, cols?: number, rows?: number }} spec
 * @param {object} io
 * @param {(target: string) => void} io.preflight   throws if the exact source target is absent
 * @param {(args: string[]) => void} io.tmux        run a tmux command (throws on failure)
 * @param {(args: string[]) => string} io.tmuxOut    run a tmux command, return trimmed stdout
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
  // 1. placeholder session — exists only to receive the link. Capture the
  //    placeholder's window ID: fixed indices (0/9) break under a custom
  //    base-index (review linkview — base-index 1 made kill-window :0 fail
  //    and every open reject); window IDs are index-agnostic.
  const placeholderId = io.tmuxOut(["new-session", "-d", "-s", viewer, "-P", "-F", "#{window_id}"]);
  const killViewer = () => io.tmux(["kill-session", "-t", `=${viewer}`]);
  try {
    if (!/^@\d+$/.test(placeholderId)) throw new Error(`unexpected window id "${placeholderId}"`);
    // 2. link the EXACT source window (anchored); bare "viewer:" lets tmux
    //    pick a free index regardless of base-index
    io.tmux(["link-window", "-s", target, "-t", `=${viewer}:`]);
    // 3. drop the placeholder BY ID — the linked window is now the ONLY window
    io.tmux(["kill-window", "-t", placeholderId]);
    // 4. lock the viewer's key handling: no prefix → no window-management
    //    bindings (next/last/new/select-window) can run; a nonexistent
    //    key-table inerts root-table bindings too. (set-option targets
    //    don't accept '=' — the unique random name cannot prefix-collide.)
    io.tmux(["set-option", "-t", viewer, "prefix", "None"]);
    io.tmux(["set-option", "-t", viewer, "prefix2", "None"]);
    io.tmux(["set-option", "-t", viewer, "key-table", "oasdesk-locked"]);
    const pty = io.spawnPty(`=${viewer}`, Math.max(20, Number(spec.cols) || 80), Math.max(5, Number(spec.rows) || 24));
    return { target, viewer, pty, killViewer };
  } catch (e) {
    // link/lock/pty failure — do not leak the viewer session
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
