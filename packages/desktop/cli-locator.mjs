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
  // Capture prerelease presence: semver precedence puts 0.18.0-rc.1 BELOW
  // 0.18.0, so a prerelease of the minimum version is OUTSIDE >=0.18.0.
  const m = String(v || "").match(/^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: !!m[4] };
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
  // Prerelease policy: prereleases are NOT accepted. Precedence-wise
  // 0.18.0-rc.1 < 0.18.0 (below the minimum), and a prerelease of any
  // in-range version is not a released CLI — desktop 0.18 pairs with
  // released 0.18.x only.
  if (v.prerelease) return { ok: false, reason: `prerelease version ${payload.version} not accepted (need a released >=0.18.0 <0.19.0)` };
  if (cmp(v.nums, ACCEPT_RANGE.min) < 0 || cmp(v.nums, ACCEPT_RANGE.maxExclusive) >= 0) {
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
 * Candidate absolute paths as LAZY thunks in contract order, each tagged
 * with its source. Sources are evaluated only when discovery reaches them
 * (review 53a20c7: the npm-prefix and login-shell helpers cost seconds —
 * they must not run when an earlier candidate already wins) and each
 * expensive source is invoked AT MOST ONCE.
 * io = {
 *   persisted: () => string|null            — user-chosen absolute path
 *   env: Record<string,string|undefined>    — process env
 *   isExecutableFile: (p) => boolean        — X_OK regular file
 *   npmGlobalBin: () => string|null|Promise — npm prefix -g /bin (slow)
 *   loginShellWhich: () => string|null|Promise — login-shell command -v (slow)
 * }
 */
export function candidateSources(io) {
  const abs = (p) => (typeof p === "string" && p && isAbsolute(p) ? p : null);
  const sources = [
    { source: "persisted", paths: () => [abs(io.persisted?.())] },
    // test/development only — never documented for end users
    { source: "env", paths: () => [abs(io.env?.OAS_DESKTOP_OAS_BIN)] },
    { source: "path", paths: () => String(io.env?.PATH || "").split(delimiter).filter(Boolean).map((dir) => abs(join(dir, "oas"))) },
    { source: "npm-global", paths: async () => { const bin = await io.npmGlobalBin?.(); return [abs(bin && join(bin, "oas"))]; } },
    { source: "login-shell", paths: async () => [abs(await io.loginShellWhich?.())] },
  ];
  return sources;
}

/** Eager candidate list — for tests/diagnostics only (evaluates everything). */
export async function candidates(io) {
  const out = [];
  for (const s of candidateSources(io)) {
    for (const p of await s.paths()) if (p) out.push({ path: p, source: s.source });
  }
  return out;
}

/**
 * Discover the first acceptable CLI. `probe(path)` runs `<path> version
 * --json` (execFile, absolute binary, no shell) and resolves { stdout } on
 * CLEAN exit — it must REJECT on nonzero exit or timeout even when stdout
 * looks valid (review 53a20c7: a binary that prints a plausible probe and
 * then fails/hangs must never become the mutation binary). Sources are
 * evaluated lazily: expensive helpers never run once a candidate wins.
 * Returns:
 *   { ok:true,  bin, source, version }
 *   { ok:false, tried: [{path, source, reason}] }   — stable diagnostics
 */
export async function discover(io, probe) {
  const tried = [];
  const seen = new Set();
  for (const src of candidateSources(io)) {
    let paths = [];
    try { paths = (await src.paths()).filter(Boolean); }
    catch { continue; /* source itself failed — e.g. npm missing */ }
    for (const raw of paths) {
      let path = raw;
      try { path = io.canonicalize ? io.canonicalize(path) : path; } catch { /* keep as-is */ }
      if (seen.has(path)) continue;
      seen.add(path);
      if (!io.isExecutableFile(path)) { tried.push({ path, source: src.source, reason: "not an executable file" }); continue; }
      let payload = null;
      try {
        const r = await probe(path);
        payload = parseProbeStdout(r.stdout);
      } catch (e) {
        // Probe REJECTED (nonzero exit, timeout, spawn failure) — the
        // candidate is out even if it printed a plausible payload first.
        tried.push({ path, source: src.source, reason: `probe failed: ${String(e.message || e).slice(0, 120)}` });
        continue;
      }
      const a = acceptProbe(payload);
      if (a.ok) return { ok: true, bin: path, source: src.source, version: payload.version };
      tried.push({ path, source: src.source, reason: a.reason, version: payload?.version });
    }
  }
  return { ok: false, tried };
}
