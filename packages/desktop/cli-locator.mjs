// OAS desktop — CLI locator/probe (Desktop CLI API v1).
//
// The app's ONLY path to lifecycle mutations is a compatible installed
// `oas` CLI (desktop-dist contract). This module finds it:
//
//   discovery order (first acceptable candidate wins):
//     1. persisted user-selected absolute executable
//     2. OAS_DESKTOP_OAS_BIN (test/development only)
//     3. the app process PATH
//     4. npm global-prefix candidates
//     5. login-shell `command -v oas` with a timeout
//
// Every candidate is canonicalized to an absolute executable and accepted
// ONLY if executable and `<bin> version --json` returns the v1 probe:
//   {"schemaVersion":1,"name":"@oas-framework/oas","version":"0.18.x","desktopApi":1}
// Desktop 0.18 accepts desktopApi === 1 and semver >=0.18.0 <0.19.0.
// API version — not source adjacency — is authoritative.
//
// Pure/injected: all process, fs and exec effects come through `io` so the
// discovery matrix and acceptance rules are unit-testable and
// mutation-checkable without a real CLI.
import { delimiter, isAbsolute, join } from "node:path";

export const DESKTOP_API = 1;
export const ACCEPT_RANGE = { min: [0, 18, 0], maxExclusive: [0, 19, 0] };
export const PROBE_NAME = "@oas-framework/oas";

// ---- acceptance --------------------------------------------------------

export function parseSemver(v) {
  const m = String(v || "").match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Accept/reject one probe payload. Returns { ok } or { ok:false, reason }. */
export function acceptProbe(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "no probe payload" };
  if (payload.schemaVersion !== 1) return { ok: false, reason: `unexpected schemaVersion ${payload.schemaVersion}` };
  if (payload.name !== PROBE_NAME) return { ok: false, reason: `not the oas CLI (name: ${payload.name || "missing"})` };
  if (payload.desktopApi !== DESKTOP_API) return { ok: false, reason: `desktopApi ${payload.desktopApi ?? "missing"} (need ${DESKTOP_API})` };
  const v = parseSemver(payload.version);
  if (!v) return { ok: false, reason: `unparsable version "${payload.version}"` };
  if (cmp(v, ACCEPT_RANGE.min) < 0 || cmp(v, ACCEPT_RANGE.maxExclusive) >= 0) {
    return { ok: false, reason: `version ${payload.version} outside >=0.18.0 <0.19.0` };
  }
  return { ok: true };
}

/** stdout must be exactly one JSON document (the CLI contract). */
export function parseProbeStdout(stdout) {
  try {
    const doc = JSON.parse(String(stdout));
    return doc && typeof doc === "object" ? doc : null;
  } catch { return null; }
}

// ---- discovery -----------------------------------------------------------

/**
 * Candidate absolute paths, in contract order, each tagged with its source.
 * io = {
 *   persisted: () => string|null            — user-chosen absolute path
 *   env: Record<string,string|undefined>    — process env
 *   isExecutableFile: (p) => boolean        — X_OK regular file
 *   npmGlobalBin: () => string|null         — `npm prefix -g`/bin (may be slow/absent)
 *   loginShellWhich: () => string|null      — `$SHELL -l -c 'command -v oas'` w/ timeout
 * }
 */
export function candidates(io) {
  const out = [];
  const push = (path, source) => {
    if (typeof path === "string" && path && isAbsolute(path)) out.push({ path, source });
  };
  push(io.persisted?.(), "persisted");
  // test/development only — never documented for end users
  push(io.env?.OAS_DESKTOP_OAS_BIN, "env");
  for (const dir of String(io.env?.PATH || "").split(delimiter)) {
    if (dir) push(join(dir, "oas"), "path");
  }
  push(io.npmGlobalBin?.() && join(io.npmGlobalBin(), "oas"), "npm-global");
  push(io.loginShellWhich?.(), "login-shell");
  return out;
}

/**
 * Discover the first acceptable CLI. `probe(path)` runs `<path> version
 * --json` (execFile, absolute binary, no shell) and returns { stdout } or
 * throws. Returns:
 *   { ok:true,  bin, source, version }
 *   { ok:false, tried: [{path, source, reason}] }   — stable diagnostics
 */
export async function discover(io, probe) {
  const tried = [];
  const seen = new Set();
  for (const c of candidates(io)) {
    let path = c.path;
    try { path = io.canonicalize ? io.canonicalize(path) : path; } catch { /* keep as-is */ }
    if (seen.has(path)) continue;
    seen.add(path);
    if (!io.isExecutableFile(path)) { tried.push({ path, source: c.source, reason: "not an executable file" }); continue; }
    let payload = null;
    try {
      const r = await probe(path);
      payload = parseProbeStdout(r.stdout);
    } catch (e) {
      tried.push({ path, source: c.source, reason: `probe failed: ${String(e.message || e).slice(0, 120)}` });
      continue;
    }
    const a = acceptProbe(payload);
    if (a.ok) return { ok: true, bin: path, source: c.source, version: payload.version };
    tried.push({ path, source: c.source, reason: a.reason, version: payload?.version });
  }
  return { ok: false, tried };
}
