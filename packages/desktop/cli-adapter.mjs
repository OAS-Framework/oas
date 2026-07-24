// OAS desktop — CLI JSON v1 adapter (the ONLY mutation path).
//
// Runs the two Desktop v1 mutations through a discovered absolute `oas`
// binary via execFile/argv — never a shell, never kernel imports:
//
//   1. oas spawn <agent> --dir <workspace> --task-file <0600-temp>
//      [allowlisted purpose/repo/work/runtime/model args] --json
//   2. oas okf harvest --json           (cwd fixed to the instance home)
//
// JSON mode emits exactly one stdout object (progress goes to stderr):
//   success:  {"schemaVersion":1,"ok":true,"result":{...}}
//   failure:  {"schemaVersion":1,"ok":false,"error":{"code","message"}}
//
// SECURITY:
//   * The task text is user input destined for a file the spawned agent
//     reads. It is written to a mkdtemp-owned file created 0600 (mode set at
//     open, not chmod-after) so no other local user can read a task that may
//     contain secrets; the temp dir is removed after the CLI returns.
//   * Spawn argv is an ALLOWLIST — purpose/repo/work/runtime/model only,
//     values passed as separate argv entries (no interpolation). Anything
//     else the renderer sends is dropped, never forwarded.
//   * Harvest cwd is fixed by the privileged backend to the RESOLVED
//     instance home (server-side lookup), never a caller path.
import { execFile } from "node:child_process";
import { mkdtempSync, openSync, writeSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENVELOPE_TIMEOUT_MS = 60_000;

/** Parse the single-JSON-object stdout contract; null when contaminated. */
export function parseEnvelope(stdout) {
  try {
    const doc = JSON.parse(String(stdout));
    if (!doc || typeof doc !== "object" || doc.schemaVersion !== 1) return null;
    if (doc.ok === true && doc.result && typeof doc.result === "object") return doc;
    if (doc.ok === false && doc.error && typeof doc.error === "object") return doc;
    return null;
  } catch { return null; }
}

/** Allowlisted optional spawn args → argv pairs. Unknown keys are DROPPED. */
export function spawnArgv(agent, workspaceDir, taskFile, opts = {}) {
  const argv = ["spawn", String(agent), "--dir", String(workspaceDir), "--task-file", String(taskFile)];
  const allow = { purpose: "--purpose", repo: "--repo", work: "--work", runtime: "--runtime", model: "--model" };
  for (const [key, flag] of Object.entries(allow)) {
    const v = opts[key];
    if (v === undefined || v === null || v === "") continue;
    argv.push(flag, String(v));
  }
  argv.push("--json");
  return argv;
}

/** Write task text to a fresh 0600 file inside a private mkdtemp dir.
 * Returns { file, cleanup } — callers MUST call cleanup() when done. */
export function writeTaskFile(taskText, io = {}) {
  const mkdtemp = io.mkdtempSync || mkdtempSync;
  const open = io.openSync || openSync;
  const write = io.writeSync || writeSync;
  const close = io.closeSync || closeSync;
  const rm = io.rmSync || rmSync;
  const dir = mkdtemp(join(io.tmpdir ? io.tmpdir() : tmpdir(), "oas-desktop-task-"));
  const file = join(dir, "TASK.md");
  const fd = open(file, "wx", 0o600); // create-exclusive, owner-only from birth
  try { write(fd, String(taskText ?? "")); } finally { close(fd); }
  return { file, cleanup: () => { try { rm(dir, { recursive: true, force: true }); } catch { /* best-effort */ } } };
}

function runJson(bin, argv, { cwd, exec = execFile, timeout = ENVELOPE_TIMEOUT_MS } = {}) {
  return new Promise((resolveP) => {
    exec(bin, argv, { cwd, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024, shell: false },
      (err, stdout) => {
        const doc = parseEnvelope(stdout);
        if (doc) return resolveP(doc); // envelope wins — nonzero exit carries ok:false
        if (err && err.killed) {
          return resolveP({ schemaVersion: 1, ok: false, error: { code: "E_CLI_TIMEOUT", message: `oas did not answer within ${timeout / 1000}s` } });
        }
        return resolveP({
          schemaVersion: 1, ok: false,
          error: { code: "E_CLI_PROTOCOL", message: "oas did not print a valid JSON envelope on stdout" },
        });
      });
  });
}

/**
 * Desktop v1 spawn. `bin` is the discovered absolute CLI; `workspaceDir` the
 * validated workspace context (--dir); `opts` allowlisted extras.
 * Domain results RESOLVE (never reject) with the envelope — stable codes.
 */
export async function cliSpawn(bin, { agent, workspaceDir, task, ...opts }, io = {}) {
  const { file, cleanup } = writeTaskFile(task ?? "", io);
  try {
    return await runJson(bin, spawnArgv(agent, workspaceDir, file, opts), { cwd: workspaceDir, exec: io.exec, timeout: io.timeout });
  } finally { cleanup(); }
}

/**
 * Desktop v1 harvest. cwd is FIXED to the resolved instance home by the
 * caller (the privileged backend resolves it — never a renderer path).
 */
export function cliHarvest(bin, instanceHome, io = {}) {
  return runJson(bin, ["okf", "harvest", "--json"], { cwd: instanceHome, exec: io.exec, timeout: io.timeout });
}
