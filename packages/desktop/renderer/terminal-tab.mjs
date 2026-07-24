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
        term.onResize(({ cols, rows }) => { if (life.ptyId() !== null) desk.termResize(life.ptyId(), cols, rows); });
        unobserve = (observe || defaultObserve)(wrap);
        term.focus();
      },
      (e) => banner(`could not attach: ${e?.message || e}`),
    ),
    close: () => life.close(disposeUi),
  };
}
