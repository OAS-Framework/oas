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
 *          | { ok: false, code: "not-found"|"not-suggested"|"not-a-workspace"|"foreign-server", reason: string }}
 *   code is the STABLE machine discriminator (renderer switches on it);
 *   reason is human-renderable prose and may be reworded freely.
 */
export function decideAdd(requestedPath, io) {
  let canonical;
  try { canonical = io.realpath(requestedPath); } catch { return { ok: false, code: "not-found", reason: "path does not exist" }; }
  // Provenance: only suggestion-set members or an explicit picker path may
  // enter the privileged flow — a renderer cannot inject arbitrary paths.
  if (!io.fromPicker && !io.suggestedPaths.has(canonical) && !io.suggestedPaths.has(requestedPath)) {
    return { ok: false, code: "not-suggested", reason: "path is not in the suggestion set (use the directory picker)" };
  }
  const ws = io.validate(canonical);
  if (!ws) return { ok: false, code: "not-a-workspace", reason: "not an OAS workspace (no team scope or agents root)" };
  if (io.advertised.has(ws.id)) return { ok: true, workspace: ws, action: "already-advertised" };
  if (!io.serverOwned) {
    // Never mutate or kill a foreign server — fail closed with a reason.
    return { ok: false, code: "foreign-server", reason: "the panel server on this port is not owned by the app — cannot extend its workspaces" };
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

/**
 * Transactional add executor — the effectful lifecycle around decideAdd,
 * extracted so its ordering/rollback properties are testable (review wsadd:
 * privileged state committed before readiness/currency; kill/spawn raced;
 * readiness accepted any 2xx).
 *
 * Properties:
 *  - SERIALIZED: adds run one at a time (in-flight adds queue); a request
 *    superseded while queued or during readiness commits NOTHING.
 *  - STAGED: the prospective --dir list is passed to the server replacement
 *    but workspaceDirs/recents are committed only AFTER readiness; on any
 *    failure the previous server configuration is RESTORED (respawn with
 *    the old dirs).
 *  - Readiness = identity match (isCompatible on /api/version response,
 *    i.e. serverCompatible against the local oas.json — any 2xx is NOT
 *    enough during a same-port race) AND the new workspace id advertised.
 *
 * @param {object} io
 * @param {() => string[]} io.getDirs            current committed dir list
 * @param {(dirs: string[]) => void} io.commitDirs
 * @param {(path: string) => void} io.commitRecent
 * @param {(dirs: string[]) => Promise<void>} io.replaceServer  stop owned server
 *        (awaiting its exit) and start one with `dirs`; must not return
 *        until the old process released the port
 * @param {() => Promise<{ok:boolean,status?:number,body?:any}|null>} io.probeVersion
 * @param {(v: any) => boolean} io.isCompatible  serverCompatible(v, local).compatible
 * @param {(id: string) => Promise<boolean>} io.advertises
 * @param {(ms: number) => Promise<void>} [io.delay]
 * @param {number} [io.attempts]
 * @returns {(workspace: { id: string, path: string }, isCurrent: () => boolean) => Promise<object>}
 */
export function createAddExecutor(io) {
  const delay = io.delay || ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  const attempts = io.attempts ?? 40;
  let chain = Promise.resolve();

  async function run(workspace, isCurrent) {
    if (!isCurrent()) return { ok: false, code: "superseded", reason: "superseded by a newer request" };
    const previousDirs = io.getDirs();
    const stagedDirs = [...previousDirs, workspace.path];
    await io.replaceServer(stagedDirs);
    for (let i = 0; i < attempts; i++) {
      const v = await io.probeVersion();
      if (v?.ok && io.isCompatible(v) && await io.advertises(workspace.id)) {
        if (!isCurrent()) break; // superseded during readiness — roll back
        io.commitDirs(stagedDirs);
        io.commitRecent(workspace.path);
        return { ok: true, workspace };
      }
      await delay(250);
    }
    // failure or superseded: restore the previous configuration — nothing
    // was committed, but the running server has the staged dirs.
    await io.replaceServer(previousDirs).catch(() => { /* best-effort restore */ });
    return isCurrent()
      ? { ok: false, code: "server-timeout", reason: "replacement server did not advertise the new workspace in time" }
      : { ok: false, code: "superseded", reason: "superseded by a newer request" };
  }

  return (workspace, isCurrent) => {
    const p = chain.then(() => run(workspace, isCurrent));
    chain = p.catch(() => { /* keep the chain alive after failures */ });
    return p;
  };
}
