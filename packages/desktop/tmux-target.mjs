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
  if (window === undefined || window === null || window === "") return `=${session}`;
  const win = String(window);
  if (!/^[\w@%.-]+$/.test(win)) throw new Error("term:open: bad window name");
  return `=${session}:=${win}`;
}
