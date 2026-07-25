// Terminal tab composition for the desktop shell — the glue between
// createTermLifecycle and the concrete xterm/IPC/DOM resources, extracted
// from shell.mjs so the SHELL-LEVEL setup/teardown ordering is testable
// (review termlc2: a lifecycle-only test passes even if the shell performs
// setup after `await start()`, i.e. on a disposed terminal).
//
// All post-attach setup happens inside onReady (before the lifecycle's
// settle signal), so a close-during-pending resumes only after setup — or
// skips it entirely — and disposeUi covers every resource created here.
import { createTermLifecycle } from "./term-lifecycle.mjs";

/**
 * @param {object} deps
 * @param {{ termOpen: Function, termClose: Function, termWrite: Function,
 *           termResize: Function, onTermData: Function, onTermExit: Function }} deps.desk
 *        the preload bridge (or a test double)
 * @param {object} deps.term        xterm Terminal (or a test double with
 *        cols/rows/onData/onResize/focus/dispose)
 * @param {{ session: string, window?: string|number }} deps.tmux
 * @param {Element} deps.wrap       the tab's terminal container
 * @param {() => boolean} deps.isActive  whether the tab is visible (fit gate)
 * @param {() => void} deps.fit     refit callback
 * @param {(el: Element) => void} [deps.observe]  install a resize observer on
 *        wrap, return handled via the returned disposer (defaults to a real
 *        ResizeObserver; injectable for tests)
 * @param {(e: unknown) => void} [deps.onError]
 * @returns {{ start: () => Promise<void>, close: () => Promise<void> }}
 */
/* Shift+Enter must insert a newline in the agent's input line, not send the
   message. xterm.js emits a plain \r for Enter regardless of Shift, so the
   modifier is lost before tmux or the agent runtime ever sees it. pi binds
   Ctrl+J (a raw \n linefeed) as its default newline alias precisely for
   terminals that cannot deliver a real shift+enter through tmux (see pi
   docs/terminal-setup.md), so translating Shift+Enter → \n here composes a
   newline in every runtime that follows that convention while plain Enter
   keeps sending.

   xterm invokes the custom handler for keydown, keypress AND keyup of the
   same physical press. Suppressing only the keydown is NOT enough: the
   browser still fires keypress (charCode 13), xterm's _keyPress path is
   reached because the handler returned true for it, and a \r goes to the
   pty right after our \n — newline immediately followed by SEND (the
   v0.18.4 field failure: Shift+Enter looked like it "did nothing" because
   the message submitted anyway). Every event of a Shift+Enter press must
   be suppressed; the \n is written once, on the keydown.

   Returns { suppress, byte } — byte is the payload to write (only on
   keydown), suppress covers keypress/keyup of the same chord. Pure —
   exported for tests. */
export function shiftEnterAction(ev) {
  if (ev.key !== "Enter" || !ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) {
    return { suppress: false, byte: null };
  }
  return { suppress: true, byte: ev.type === "keydown" ? "\n" : null };
}

/* xterm Terminal construction options for a shell terminal tab — exported
   (rather than inlined in shell.mjs) so the invariant-bearing lines are
   testable (lesson: regression tests must exercise the bug layer).

   macOptionClickForcesSelection: the tab attaches to a tmux viewer session
   running with `mouse on` (wheel scrollback — tmux-target.mjs), so tmux
   grabs the mouse and a plain drag never creates an xterm selection — copy
   looked broken (v0.18.4 field report). xterm's escape hatch is a modifier-
   forced LOCAL selection, and it is platform-split (shouldForceSelection):
   Option+drag on macOS — only when this option is on (default off) — and
   Shift+drag on non-mac platforms. */
export function terminalOptions({ fontSize, fontFamily, theme }) {
  return {
    fontSize,
    fontFamily,
    theme,
    scrollback: 5000,
    macOptionClickForcesSelection: true,
  };
}

export function createTerminalTab({ desk, term, tmux, wrap, isActive, fit, observe, onError = (e) => console.error(e) }) {
  let offData = null, offExit = null;
  let unobserve = null;

  const life = createTermLifecycle(
    { open: async () => {
        // term:open now returns a STRUCTURED result (Slice G resource
        // registry): {id} | {reused,id} | {capped,active,max} | {error}.
        // Translate to the lifecycle's numeric-id contract, classifying
        // the two rejections so the banner is actionable.
        const r = await desk.termOpen({ session: tmux.session, window: tmux.window, cols: term.cols, rows: term.rows });
        if (r && typeof r === "object") {
          if (r.capped) { const e = new Error(`Terminal limit reached (${r.max}). Close a terminal tab first.`); e.code = "cap"; throw e; }
          if (r.reused) { const e = new Error("This terminal is already open."); e.code = "reused"; throw e; }
          if (r.error) throw new Error(r.error);
          if (r.id !== undefined) return r.id;
        }
        return r; // legacy numeric id (test doubles)
      },
      closePty: (id) => desk.termClose(id) },
    onError,
  );

  const disposeUi = () => {
    // Detach-only semantics live in the lifecycle; this is the UI teardown.
    offData?.(); offExit?.();
    unobserve?.();
    term.dispose();
  };

  const banner = (text) => {
    const el = wrap.ownerDocument.createElement("div");
    el.className = "term-banner";
    el.textContent = text;
    wrap.append(el);
  };

  const defaultObserve = (el) => {
    const ro = new ResizeObserver(() => {
      if (!isActive()) return;
      try { fit(); } catch { /* zero-size while hidden */ }
    });
    ro.observe(el);
    return () => ro.disconnect();
  };

  return {
    start: () => life.start(
      (ptyId) => {
        // ALL post-attach setup — runs before the settle signal, so close()
        // cannot resolve mid-setup and disposeUi covers everything below.
        offData = desk.onTermData(ptyId, (data) => term.write(data));
        offExit = desk.onTermExit(ptyId, () => {
          life.forget(); // pty is gone; close() must not double-kill
          banner("session ended — close this tab");
        });
        term.onData((data) => { if (life.ptyId() !== null) desk.termWrite(life.ptyId(), data); });
        // Shift+Enter → newline (Ctrl+J alias); returning false suppresses
        // xterm's handling for EVERY event of the chord — keydown (would
        // send \r) and keypress (would ALSO send \r; see shiftEnterAction).
        term.attachCustomKeyEventHandler?.((ev) => {
          const { suppress, byte } = shiftEnterAction(ev);
          if (!suppress) return true;
          if (byte !== null && life.ptyId() !== null) desk.termWrite(life.ptyId(), byte);
          return false;
        });
        term.onResize(({ cols, rows }) => { if (life.ptyId() !== null) desk.termResize(life.ptyId(), cols, rows); });
        unobserve = (observe || defaultObserve)(wrap);
        term.focus();
      },
      (e) => banner(`could not attach: ${e?.message || e}`),
    ),
    close: () => life.close(disposeUi),
  };
}
