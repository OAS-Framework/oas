// Latest-intent ownership for asynchronous shell opens.
export function createIntentGate() {
  let generation = 0;
  return {
    begin() {
      const token = ++generation;
      return () => token === generation;
    },
    invalidate() { generation++; },
  };
}

/** Wait for key cleanup and module loading while checking ownership after every
 * awaited success AND rejection. Stale errors are discarded with stale data. */
export async function prepareOwnedOpen({ owns, waitForKey, load }) {
  try {
    await waitForKey();
  } catch (error) {
    if (!owns()) return null;
    throw error;
  }
  if (!owns()) return null;
  try {
    const module = await load();
    if (!owns()) return null;
    return module;
  } catch (error) {
    if (!owns()) return null;
    throw error;
  }
}

/** Run an async open flow with a failure policy (review ff70e1c nit):
 * quiet (automated callers — the post-spawn handoff fires without awaiting)
 * catches EVERY rejection into notify so an unhandled rejection can never
 * escape; interactive opens rethrow so their callers surface errors their
 * own way. Importable so the rejection-path regression exercises this exact
 * layer (composition-root rule). */
export async function runOpenFlow(flow, { quiet = false, notify = () => {} } = {}) {
  if (!quiet) return flow();
  try {
    return await flow();
  } catch (e) {
    notify(e?.message || String(e));
  }
}
