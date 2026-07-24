// Pure request-URL shaping for the desktop app's privileged API proxy.
// Kept dependency-free and separate from main.mjs so the root `node --test`
// suite can cover it without loading Electron.

/**
 * Build the URL the main process will fetch for a renderer api() call.
 *
 * SECURITY: the renderer (or anything that reaches the preload bridge) must
 * never be able to steer the privileged fetch off the loopback backend
 * origin. `new URL("//host/x", base)` — and the backslash variant
 * "/\\host/x", which WHATWG URL normalizes the same way — would resolve to a
 * DIFFERENT origin, so the resolved origin is checked, not just the input
 * shape.
 *
 * @param {string} pathname  must start with "/" and stay on `base`'s origin
 * @param {string} base      the backend server origin, e.g. http://127.0.0.1:4820
 * @param {string|null} wsId verified workspace id — pinned onto
 *                           workspace-scoped endpoints unless the caller
 *                           selects a workspace the server itself advertises
 * @param {Set<string>} [allowedWs] workspace ids the connected server
 *                           advertises (from /api/panel `workspaces[]`); a
 *                           caller ?ws= outside this set is overwritten
 * @returns {URL}
 * @throws  on off-origin or malformed input
 */
export function apiUrl(pathname, base, wsId = null, allowedWs = undefined) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) {
    throw new Error("api: pathname must start with /");
  }
  const baseUrl = new URL(base);
  const url = new URL(pathname, baseUrl);
  if (url.origin !== baseUrl.origin) {
    throw new Error("api: pathname resolved off-origin");
  }
  // Workspace-scoped endpoints: the roster/agents/brain reads AND the whole
  // instance-addressed family — the server resolves instance names per
  // workspace, and same-named instances exist across workspaces. Pinning
  // here makes an omitted ?ws= fail SAFE (verified workspace) even before
  // views append it themselves.
  const wsScoped = url.pathname === "/api/panel" || url.pathname === "/api/agents"
    || /^\/api\/(brain|diff|session|keys|interrupt|jira|chat)\//.test(url.pathname);
  if (wsId && wsScoped) {
    const asked = url.searchParams.get("ws");
    // Workspace switching is a real feature on shared multi-workspace
    // servers — but only to workspaces the server actually advertises;
    // anything else is overwritten with the verified id.
    if (!asked || !(allowedWs instanceof Set) || !allowedWs.has(asked)) {
      url.searchParams.set("ws", wsId);
    }
  }
  return url;
}

/**
 * Build fetch init for a proxied api() call. Views follow the Fetch
 * contract: common.mjs::postJson already serializes the body and sets
 * content-type — string bodies and supplied headers must pass through
 * UNCHANGED (double-serialization made /api/spawn parse a JSON string and
 * reject every spawn). Object bodies (the shell's own convenience calls)
 * are serialized here, exactly once.
 */
export function apiInit(opts) {
  const init = { method: opts?.method || "GET" };
  if (opts?.headers && typeof opts.headers === "object") init.headers = { ...opts.headers };
  if (opts?.body !== undefined) {
    if (typeof opts.body === "string") {
      init.body = opts.body;
      init.headers = { "content-type": "application/json", ...init.headers };
    } else {
      init.body = JSON.stringify(opts.body);
      init.headers = { ...init.headers, "content-type": "application/json" };
    }
  }
  return init;
}
