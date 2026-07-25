#!/usr/bin/env node
// Warm Rosetta's AOT cache for the EXACT packaged x64 Electron Mach-O.
//
// Installing Rosetta is not a warm-up: Rosetta translates/caches each
// specific binary on its FIRST execution. The subsequent timed node-pty ABI
// probe must measure warm execution (normal 30s budget), otherwise a cold
// translation narrowly over 30s is indistinguishable from a native hang.
//
// Run only on the mac x64 cross-build leg, AFTER `npm run dist -- --x64` and
// BEFORE `npm run dist:smoke`. No GUI: ELECTRON_RUN_AS_NODE=1 and a trivial
// process.exit(0). Bounded group-tracked execution; any failure is honest red.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReaper } from "./proc-reaper.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");
const fail = (m) => { console.error(`warm-rosetta FAIL — ${m}`); process.exit(1); };

if (process.platform !== "darwin") fail("macOS only");
let appExe = null;
for (const d of readdirSync(DIST)) {
  if (!d.startsWith("mac")) continue;
  const candidate = join(DIST, d, "OAS Desktop.app", "Contents", "MacOS", "OAS Desktop");
  if (existsSync(candidate)) { appExe = candidate; break; }
}
if (!appExe) fail("packaged x64 OAS Desktop.app not found in dist/mac*");

const reaper = createReaper({ spawn });
process.on("exit", reaper.reapAll);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { reaper.reapAll(); process.exit(1); });

const started = Date.now();
const r = await reaper.runTracked("/usr/bin/arch", ["-x86_64", appExe, "-e", "process.exit(0)"], {
  timeout: 120_000, // cold first translation is allowed, but remains bounded
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
if (r.timedOut) fail("exact packaged x64 Electron warm-up timed out");
if (r.code !== 0) fail(`exact packaged x64 Electron warm-up exited ${r.code}: ${(r.stderr || r.stdout || "").trim().slice(-500)}`);
console.log(`warm-rosetta ok — exact packaged x64 Electron executed under Rosetta in ${((Date.now() - started) / 1000).toFixed(1)}s`);
