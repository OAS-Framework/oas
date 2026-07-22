// Pure request-URL shaping for the desktop app's privileged API proxy.
// Kept dependency-free and separate from main.mjs so the root `node --test`
// suite can cover it without loading Electron.

/**
 * Build the URL the main process will fetch for a renderer api() call.
 *
 * SECURITY: the renderer (or anything that reaches the preload bridge) must
 * never be able to steer the privileged fetch off the loopback oas-web
 * origin. `new URL("//host/x", base)` — and the backslash variant
 * "/\\host/x", which WHATWG URL normalizes the same way — would resolve to a
 * DIFFERENT origin, so the resolved origin is checked, not just the input
 * shape.
 *
 * @param {string} pathname  must start with "/" and stay on `base`'s origin
 * @param {string} base      the oas-web server origin, e.g. http://127.0.0.1:4820
 * @param {string|null} wsId verified workspace id — force-pinned onto
 *                           workspace-scoped endpoints (a caller-supplied
 *                           ?ws= must not select another workspace on a
 *                           shared server)
 * @returns {URL}
 * @throws  on off-origin or malformed input
 */
export function apiUrl(pathname, base, wsId = null) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) {
    throw new Error("api: pathname must start with /");
  }
  const baseUrl = new URL(base);
  const url = new URL(pathname, baseUrl);
  if (url.origin !== baseUrl.origin) {
    throw new Error("api: pathname resolved off-origin");
  }
  if (wsId && (url.pathname === "/api/panel" || url.pathname === "/api/agents")) {
    url.searchParams.set("ws", wsId); // overwrite, never trust a caller's ws
  }
  return url;
}
