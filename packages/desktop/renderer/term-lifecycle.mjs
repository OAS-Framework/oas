// Terminal open lifecycle for the desktop shell — the terminal-tab variant
// of view-lifecycle.mjs, extracted so the close-during-pending-termOpen
// semantics are unit-testable without Electron.
//
// Hazard (merged-state review @3e1a611): closing a terminal tab while the
// async termOpen() IPC call is pending saw ptyId === null in cleanup; the
// open then resolved AFTER the tab was gone and the created pty — an
// invisible attached tmux client — leaked until app shutdown.
//
// Semantics:
//  - close before the open settles → when it resolves, the pty is closed
//    IMMEDIATELY (detach; never the tmux session); onReady is not called.
//  - open rejects → onOpenError runs (repaint) unless the tab is already
//    closed; nothing leaks (no pty was created).
//  - close after settle → normal cleanup with the known pty id.
// close() returns a promise resolving when cleanup has actually run, so the
// host can keep the tab's dedup key reserved until then (tab-keys.mjs).

/**
 * @param {{ open: () => Promise<number>, closePty: (id: number) => void }} io
 *   open(): performs the async termOpen; closePty(): detaches the pty.
 * @param {(e: unknown) => void} [onError] error sink for cleanup failures
 * @returns {{
 *   start(onReady: (id: number) => void, onOpenError: (e: unknown) => void): Promise<void>,
 *   close(disposeUi?: () => void): Promise<void>,
 *   ptyId(): number | null,
 * }}
 */
export function createTermLifecycle(io, onError = () => {}) {
  let ptyId = null;
  let closed = false;
  let settled = false;
  let disposeUi = null;
  let settleSignal;
  const settledP = new Promise((r) => { settleSignal = r; });

  const detach = () => {
    if (ptyId === null) return;
    const id = ptyId;
    ptyId = null;
    try { io.closePty(id); } catch (e) { onError(e); }
  };

  return {
    async start(onReady, onOpenError) {
      try {
        const id = await io.open();
        settled = true;
        if (closed) {
          // Tab closed while the open was in flight — the pty exists now;
          // detach it immediately instead of leaking an invisible client.
          try { io.closePty(id); } catch (e) { onError(e); }
        } else {
          ptyId = id;
          onReady(id);
        }
      } catch (e) {
        settled = true;
        if (!closed) onOpenError(e);
      } finally {
        settleSignal();
      }
    },
    async close(ui) {
      closed = true;
      disposeUi = ui || disposeUi;
      if (!settled) await settledP; // the start() continuation detaches
      detach();
      try { disposeUi?.(); } catch (e) { onError(e); }
    },
    ptyId: () => ptyId,
    /** the shell's exit handler clears the id (session ended, pty gone) */
    forget: () => { ptyId = null; },
  };
}
