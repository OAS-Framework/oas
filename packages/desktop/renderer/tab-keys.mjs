// Tab dedup-key registry for the desktop shell — extracted so the
// close→fast-reopen host behavior is unit-testable without a DOM.
//
// A key is reserved while a closed tab's DEFERRED cleanup is still running
// (see view-lifecycle.mjs). A reopen requested during the reservation must
// NOT be dropped — it queues behind the cleanup and proceeds when the key
// frees (review 3cfc66d: addTab() returning null for "reserved" silently
// discarded the user's reopen).
const pendingCleanups = new Map(); // key -> promise resolving when cleanup ran

/** Reserve `key` until `cleanupPromise` settles (errors are absorbed —
 * a failed cleanup must not wedge the key forever). */
export function reserveKey(key, cleanupPromise) {
  if (!key) return;
  const p = Promise.resolve(cleanupPromise)
    .catch(() => {})
    .finally(() => { if (pendingCleanups.get(key) === p) pendingCleanups.delete(key); });
  pendingCleanups.set(key, p);
}

/** Resolves when `key` has no pending cleanup (immediately if free).
 * Await this BEFORE the dedup scan + mount of a keyed open. */
export function whenKeyFree(key) {
  return key && pendingCleanups.has(key) ? pendingCleanups.get(key) : Promise.resolve();
}

/** True while a cleanup holds the key (exposed for tests/debug). */
export function isKeyReserved(key) {
  return !!key && pendingCleanups.has(key);
}
