/**
 * core-loader.mjs — locate the globally installed @oas-framework/oas kernel and
 * re-export its lib/core.mjs. The pi package is a thin adapter: it never ships
 * the kernel, skills, injects, or capabilities — those live in the global CLI
 * package (npm i -g @oas-framework/oas), the single source of truth that the
 * future Claude plugin shares.
 *
 * Resolution order:
 *   1. $OAS_PKG_ROOT (explicit override, e.g. a dev clone)
 *   2. the `oas` binary on PATH → realpath → its package root
 *   3. `npm root -g`/@oas-framework/oas (binary not linked but package present)
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const PKG_NAME = "@oas-framework/oas";

function isKernelRoot(dir) {
  const pj = join(dir, "package.json");
  if (!existsSync(pj) || !existsSync(join(dir, "lib", "core.mjs"))) return false;
  try { return JSON.parse(readFileSync(pj, "utf8")).name === PKG_NAME; } catch { return false; }
}

function findKernelRoot() {
  if (process.env.OAS_PKG_ROOT && isKernelRoot(process.env.OAS_PKG_ROOT)) return process.env.OAS_PKG_ROOT;
  try {
    const bin = execSync("command -v oas", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (bin) {
      let d = dirname(realpathSync(bin)); // <pkg>/bin/oas.mjs → <pkg>/bin
      while (d !== dirname(d)) {
        if (isKernelRoot(d)) return d;
        d = dirname(d);
      }
    }
  } catch { /* not on PATH */ }
  try {
    const g = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const cand = join(g, PKG_NAME);
    if (isKernelRoot(cand)) return cand;
  } catch { /* no npm */ }
  return undefined;
}

export const OAS_PKG_ROOT = findKernelRoot();
if (!OAS_PKG_ROOT) {
  throw new Error(
    "OAS kernel not found — the pi adapter needs the oas CLI installed globally.\n" +
    "  Install it:  npm install -g @oas-framework/oas\n" +
    "  (or point OAS_PKG_ROOT at a checkout of the oas-framework repo)",
  );
}

const core = await import(pathToFileURL(join(OAS_PKG_ROOT, "lib", "core.mjs")).href);

export const { appendLogEntry, PACKAGED_SKILLS_DIR } = core;

/** Kernel package version (for skew diagnostics against the adapter). */
export function kernelVersion() {
  try { return JSON.parse(readFileSync(join(OAS_PKG_ROOT, "package.json"), "utf8")).version; } catch { return "unknown"; }
}
