// Workspace suggestions + runtime add — the privileged side's testable core.
// (Phase-2 hook 3; the renderer switcher/modal is the UX designer's.)
//
// Discovery is BOUNDED and deterministic — never arbitrary filesystem
// scanning: (a) workspaces the app already knows, (b) team-scope siblings of
// known workspaces (via the same core seams oas-web's workspaceEntry uses),
// (c) a persisted recently-added list. Every candidate must resolve to a
// real OAS config/team scope AT SUGGESTION TIME; `reason` says why it is
// offered. workspace:add canonicalizes, re-validates, persists to a recents
// store (path-validated on read-back — never trusted blindly), and the
// caller replaces only an app-OWNED oas-web server.

/**
 * Validate a directory as an OAS workspace and resolve its identity.
 * @param {string} path       canonicalized absolute path
 * @param {object} io
 * @param {(p: string) => { team?: { name: string, scope: string } } | null} io.resolveConfig
 *        core.resolveOasConfig wrapper; null/throw = not a workspace
 * @param {(p: string) => boolean} io.hasAgentsRoot   agents/ dir present (ensureRoot-style)
 * @returns {{ id: string, name: string, team: { name: string } | null, path: string } | null}
 */
export function validateWorkspace(path, io) {
  let cfg = null;
  try { cfg = io.resolveConfig(path); } catch { return null; }
  if (cfg?.team?.scope) {
    const scope = cfg.team.scope;
    return { id: scope, name: scope.split("/").pop(), team: { name: cfg.team.name }, path: scope };
  }
  if (io.hasAgentsRoot(path)) {
    return { id: path, name: path.split("/").pop(), team: null, path };
  }
  return null;
}

/**
 * Assemble the suggestion list: validated candidates NOT currently advertised.
 * @param {object} io
 * @param {string[]} io.knownPaths      workspace paths the app already knows (startup --dir set)
 * @param {(p: string) => string[]} io.teamSiblings   sibling workspace paths within p's team scope
 * @param {string[]} io.recents         persisted recently-added paths (validated on read)
 * @param {Set<string>} io.advertised   workspace ids the current server advertises
 * @param {(p: string) => ReturnType<typeof validateWorkspace>} io.validate
 * @returns {Array<{ id, name, team, path, reason }>}
 */
export function workspaceSuggestions(io) {
  const out = new Map(); // id -> candidate (first reason wins; dedup)
  const consider = (path, reason) => {
    const v = io.validate(path);
    if (!v) return;                       // must be a real workspace NOW
    if (io.advertised.has(v.id)) return;  // already advertised — not a suggestion
    if (!out.has(v.id)) out.set(v.id, { ...v, reason });
  };
  for (const p of io.knownPaths) {
    consider(p, "known workspace");
    for (const sib of io.teamSiblings(p)) consider(sib, `team sibling of ${p.split("/").pop()}`);
  }
  for (const p of io.recents) consider(p, "recently used");
  return [...out.values()];
}

/**
 * Recents store shape (app userData JSON). Read-back is VALIDATED — paths
 * that no longer resolve as workspaces are dropped, non-arrays/garbage
 * rejected; the store can never smuggle an arbitrary path into privileged
 * flows.
 */
export function parseRecents(raw, validate) {
  let data;
  try { data = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const entry of data.slice(0, 20)) {
    if (typeof entry !== "string" || !entry.startsWith("/")) continue;
    if (validate(entry)) out.push(entry);
  }
  return out;
}

export function pushRecent(recents, path, max = 10) {
  return [path, ...recents.filter((p) => p !== path)].slice(0, max);
}

/**
 * The workspace:add decision — canonicalize, validate, check candidate
 * provenance, and describe the required server action. Effects (persist,
 * server replacement, readiness wait) belong to the caller.
 *
 * @param {string} requestedPath
 * @param {object} io
 * @param {(p: string) => string} io.realpath      canonicalize; throws on nonexistent
 * @param {(p: string) => ReturnType<typeof validateWorkspace>} io.validate
 * @param {Set<string>} io.suggestedPaths          current suggestion-set paths
 * @param {boolean} io.fromPicker                  explicit native-picker action
 * @param {boolean} io.serverOwned                 the current server is app-owned
 * @param {Set<string>} io.advertised
 * @returns {{ ok: true, workspace: object, action: "already-advertised" | "replace-server" }
 *          | { ok: false, reason: string }}
 */
export function decideAdd(requestedPath, io) {
  let canonical;
  try { canonical = io.realpath(requestedPath); } catch { return { ok: false, reason: "path does not exist" }; }
  // Provenance: only suggestion-set members or an explicit picker path may
  // enter the privileged flow — a renderer cannot inject arbitrary paths.
  if (!io.fromPicker && !io.suggestedPaths.has(canonical) && !io.suggestedPaths.has(requestedPath)) {
    return { ok: false, reason: "path is not in the suggestion set (use the directory picker)" };
  }
  const ws = io.validate(canonical);
  if (!ws) return { ok: false, reason: "not an OAS workspace (no team scope or agents root)" };
  if (io.advertised.has(ws.id)) return { ok: true, workspace: ws, action: "already-advertised" };
  if (!io.serverOwned) {
    // Never mutate or kill a foreign server — fail closed with a reason.
    return { ok: false, reason: "the panel server on this port is not owned by the app — cannot extend its workspaces" };
  }
  return { ok: true, workspace: ws, action: "replace-server" };
}

/** Latest-intent generation guard (house standard): completions of stale
 * requests must be inert. One counter per verb. */
export function createGenerations() {
  const gens = new Map();
  return {
    next(verb) { const g = (gens.get(verb) || 0) + 1; gens.set(verb, g); return g; },
    isCurrent(verb, g) { return gens.get(verb) === g; },
  };
}
