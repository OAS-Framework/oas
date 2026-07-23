// Server compatibility probe for the desktop app — extracted from main.mjs
// so the reuse decision is unit-testable (and mutation-checkable).
//
// Reusing ANY server that answers /api/panel is not enough: an OLDER
// installed oas-web (e.g. a global panel on the default port) passes the
// workspace probe while lacking the desktop endpoints (/api/version,
// /api/brain, /api/file, /api/diff) — Brain then 404s and looks broken.
// Reuse requires the server to identify itself as THIS checkout's oas-web:
// GET /api/version must answer { capability: "oas.web", version } matching
// the local capabilities/oas-web/oas.json. On any mismatch — 404 (older
// server), wrong capability, different version — the caller spawns its own
// checkout's server on a free port and NEVER kills the foreign one.

/**
 * Decide whether an existing server may be reused.
 *
 * @param {{ ok: boolean, status?: number, body?: any } | null} versionResponse
 *        result of probing GET /api/version (null = network failure)
 * @param {{ capability: string, version: string }} local
 *        this checkout's capabilities/oas-web/oas.json identity
 * @returns {{ compatible: boolean, reason: string }}
 */
export function serverCompatible(versionResponse, local) {
  if (!versionResponse || !versionResponse.ok) {
    return { compatible: false, reason: "no /api/version (older oas-web without desktop endpoints)" };
  }
  const b = versionResponse.body || {};
  if (b.capability !== local.capability) {
    return { compatible: false, reason: `capability "${b.capability}" != "${local.capability}"` };
  }
  if (b.version !== local.version) {
    return { compatible: false, reason: `version ${b.version} != local ${local.version}` };
  }
  return { compatible: true, reason: "matches local checkout" };
}

/**
 * The server-selection decision — the seam main.mjs::ensureServer runs, with
 * injectable probes so the reuse/spawn choice is testable end-to-end
 * (review srvcompat: fake-server tests that re-implement the decision leave
 * the production gate unprotected).
 *
 * @param {object} io
 * @param {() => Promise<Array<{id:string,name:string}>|null>} io.panelWorkspaces
 * @param {() => Promise<{ok:boolean,status?:number,body?:any}|null>} io.probeVersion
 * @param {(workspaces: Array<{id:string}>) => string|null} io.matchWorkspace
 * @param {{capability:string,version:string}} io.local
 * @returns {Promise<{ action: "reuse", wsId: string } |
 *                    { action: "spawn", portOccupied: boolean, reason: string }>}
 *   portOccupied: a server IS listening on the port (wrong workspace or
 *   incompatible) — the caller must pick another port; reason is for logs.
 */
export async function selectServer(io) {
  const existing = await io.panelWorkspaces();
  if (!existing) return { action: "spawn", portOccupied: false, reason: "no server on the port" };
  const wsId = io.matchWorkspace(existing);
  if (!wsId) {
    return { action: "spawn", portOccupied: true, reason: `serves ${existing.map((w) => w.name).join(", ")} — not the requested workspace` };
  }
  // Workspace coverage is necessary but NOT sufficient: an older installed
  // oas-web answers /api/panel yet lacks the desktop endpoints. Reuse only a
  // server that identifies as THIS checkout via /api/version.
  const compat = serverCompatible(await io.probeVersion(), io.local);
  if (!compat.compatible) return { action: "spawn", portOccupied: true, reason: `incompatible (${compat.reason})` };
  return { action: "reuse", wsId };
}

/**
 * The full ensure step — selection PLUS the caller's consumption of it
 * (review srvcompat3: tests proved selectServer emits portOccupied but not
 * that the caller consumes it; reverting the caller to reason-string
 * matching left tests green). Injectable port/spawn effects.
 *
 * @param {object} io   selectServer's io PLUS:
 * @param {number} io.port                       current port
 * @param {(from: number) => Promise<number>} io.freePort
 * @param {(port: number) => void} io.spawnServer
 * @param {(msg: string) => void} [io.log]
 * @returns {Promise<{ spawned: boolean, port: number, wsId: string|null }>}
 *   wsId is null when spawned (the caller verifies the new server's
 *   workspace during its readiness wait).
 */
export async function ensureServerOnPort(io) {
  const choice = await selectServer(io);
  if (choice.action === "reuse") return { spawned: false, port: io.port, wsId: choice.wsId };
  let port = io.port;
  if (choice.portOccupied) {
    io.log?.(`server on ${port} — ${choice.reason} — starting a dedicated one`);
    port = await io.freePort(port + 1);
  }
  io.spawnServer(port);
  return { spawned: true, port, wsId: null };
}
