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
