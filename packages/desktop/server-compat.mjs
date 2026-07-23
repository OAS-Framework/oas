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
