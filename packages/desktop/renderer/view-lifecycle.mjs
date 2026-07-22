// View mount lifecycle for the desktop tab host — extracted from shell.mjs so
// the close-while-mount-pending semantics are unit-testable without a DOM.
//
// Contract (amended, coordinator-recorded): mount(el, ctx) MAY return a
// disposer; the host prefers it over the module-level unmount(). A close
// requested while the async mount is still pending must WAIT for the mount
// to settle and then run that mount's own cleanup — falling back to the
// module-wide unmount() mid-flight would clear every open mount of the
// module (the multi-tab singleton failure).

/**
 * @param {{ mount: Function, unmount?: Function }} mod   the view module
 * @param {() => void} [onError]                          error sink (console.error)
 * @returns {{ close(): void, mounted(el, ctx): Promise<void> }}
 *   close(): call when the tab closes (any time, including mid-mount);
 *   mounted(): call once with the mount target — runs mod.mount and wires
 *   the disposer.
 */
export function createViewLifecycle(mod, onError = () => {}) {
  let settled = false;
  let closed = false;
  let dispose = null;

  const cleanup = () => {
    try {
      if (typeof dispose === "function") dispose();
      else mod.unmount?.();
    } catch (e) { onError(e); }
  };

  return {
    close() {
      closed = true;
      if (settled) cleanup();
      // not settled: the mounted() continuation runs cleanup on settle
    },
    async mounted(el, ctx) {
      let mountError = null;
      try {
        const r = await mod.mount(el, ctx);
        if (typeof r === "function") dispose = r;
      } catch (e) { mountError = e; }
      settled = true;
      if (closed) cleanup();
      if (mountError) throw mountError;
    },
  };
}
