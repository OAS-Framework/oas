// View mount lifecycle for the desktop tab host — extracted from shell.mjs so
// the close-while-mount-pending semantics are unit-testable without a DOM.
//
// Contract (amended, coordinator-recorded): mount(el, ctx) MAY return a
// disposer; the host prefers it over the module-level unmount(). Two hazards
// this module exists to prevent:
//   1. A close while the async mount is pending must WAIT for the mount to
//      settle and then run that mount's own cleanup — a module-wide
//      unmount() mid-flight clears every open mount of the module.
//   2. A REJECTED mount must never fall back to the module-wide unmount():
//      the failed mount produced nothing to clean up module-wide, and the
//      fallback would tear down healthy sibling mounts.
// The host must also keep the tab's dedup key reserved until close()'s
// returned promise resolves — deferred legacy cleanup (module unmount after
// settle) would otherwise tear down a tab the user reopened in the meantime.

/**
 * @param {{ mount: Function, unmount?: Function }} mod   the view module
 * @param {(e: unknown) => void} [onError]                error sink
 * @returns {{ close(): Promise<void>, mounted(el, ctx): Promise<void> }}
 *   close(): call when the tab closes (any time, including mid-mount); the
 *   returned promise resolves when cleanup has actually run — keep the tab
 *   key reserved until then.
 *   mounted(): call once with the mount target — runs mod.mount and wires
 *   the disposer.
 */
export function createViewLifecycle(mod, onError = () => {}) {
  let fulfilled = false;   // mount resolved (disposer may or may not exist)
  let settled = false;     // mount resolved OR rejected
  let closed = false;
  let dispose = null;
  let settleSignal;
  const settledP = new Promise((r) => { settleSignal = r; });

  const cleanup = () => {
    try {
      if (typeof dispose === "function") dispose();
      // Module-wide fallback ONLY for a fulfilled legacy mount (no disposer).
      // After a rejection there is nothing of ours to clean up — the
      // fallback would destroy healthy sibling mounts.
      else if (fulfilled) mod.unmount?.();
    } catch (e) { onError(e); }
  };

  return {
    async close() {
      closed = true;
      if (!settled) await settledP;   // defer until the pending mount settles
      cleanup();
    },
    async mounted(el, ctx) {
      let mountError = null;
      try {
        const r = await mod.mount(el, ctx);
        if (typeof r === "function") dispose = r;
        fulfilled = true;
      } catch (e) { mountError = e; }
      settled = true;
      settleSignal();
      // If close() already ran, IT performs the cleanup (awaiting settledP).
      if (mountError) throw mountError;
    },
  };
}
