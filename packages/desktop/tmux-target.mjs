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
export function openTerm(spec, io) {
  const target = tmuxAttachTarget(spec.session, spec.window);
  try {
    io.preflight(target);
  } catch {
    throw new Error(`term:open: no tmux target ${target}`);
  }
  const pty = io.spawnPty(target, Math.max(20, Number(spec.cols) || 80), Math.max(5, Number(spec.rows) || 24));
  return { target, pty };
}
