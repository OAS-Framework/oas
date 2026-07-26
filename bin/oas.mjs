#!/usr/bin/env node
/**
 * oas — the OAS command line.
 *
 *   oas doctor [dir] [--json]              show the resolved config with origins
 *   oas install <name|url|path> [...]      acquire + exact-lock a capability
 *   oas trust <capability>                approve locked executable surfaces
 *   oas use <capability> [...]            activate/exclude for global/group/soul
 *   oas init [--raw]                      create an oas-config.yaml here
 *
 * `use` and `init` edit the oas-config.yaml at the detected level root:
 * cwd is your home dir → laptop; cwd has .git → repo; otherwise → workspace.
 * The kernel resolves per-key closest-wins from wherever agents actually run,
 * so binding at a level scopes the capability to everything under it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { enableTmuxMouse, tmuxConfigPath, tmuxMouseEnabled } from "../lib/tmux-config.mjs";
import {
  LAYERS, LEGACY_HOME_CAPABILITIES_DIR, OAS_LOCK_FILE, OAS_VERSION, RETIRED_CAPABILITIES, configChain,
  acquireCapability, restoreCapabilities, marketplaceCapabilities,
  capabilityManifests, capabilityManifest, capabilityMissingRequires, capabilityIntegrity, capabilityTrust, capabilityExecutablePath,
  readCapabilityLocks, writeCapabilityLock,
  parsePackageSource, acquirePackage, restorePackages, listInstalledPackages, readPackageLocks, residueEntryViolation,
  approveCapability, updatePackage, removePackage, migrateLegacyLock, applyLegacyLockMigration,
  packageIntegrity, packageDepsIntegrity, installedPackagesDir, loadPackageManifestAt,
  resolveOasConfig, resolveWorkMode, composeInstanceAgentsMd, parseYamlNested, packagedInject, teamAgentRoots,
  findTeamAgent, findTeamInstance, findCapabilityAgent, findInstanceHome, listCapabilityAgents, workspaceOf,
  ensureRoot, findRoot, findAgent, listAgents, listInstances, listAgentDefs, createAgent as coreCreateAgent,
  spawnInstance, retireInstance, upsertLocalAgent, defaultRepo, RELATIONS,
} from "../lib/core.mjs";
import {
  aggregateMissingRequirements, diffConfigTexts, discoverWorkspaceScopes,
  lockedPackageCapabilities, parseProfileProvenance, profileProvenanceHeader,
  readProfileText, requirementInstallPlan, resolveProfilePackage,
  runRequirementInstall, selectProfile, validateProfile,
} from "../lib/packages.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : undefined;
};
const die = (msg) => { console.error(`oas: ${msg}`); process.exit(1); };
/** Resolve the --dir flag with central validation: a value-taking flag given
 * no value (flag() → true) is E_BAD_ARGS inside the JSON boundary, never an
 * uncaught resolve(true) TypeError (reviewer-6f0a3bd). */
function dirFlag() {
  const v = flag("dir");
  if (v === undefined) return resolve(process.cwd());
  if (v === true || !String(v).trim()) {
    const msg = "--dir needs a directory path";
    if (JSON_MODE) { console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_BAD_ARGS", message: msg } })); process.exit(1); }
    die(msg);
  }
  return resolve(String(v));
}
// Desktop CLI API v1 (JSON mode): every `--json` failure is EXACTLY ONE JSON
// object on stdout — { schemaVersion: 1, ok: false, error: { code, message } } —
// with a nonzero exit; progress prose goes to stderr, never stdout.
const JSON_MODE = args.includes("--json");
// Canonical absolute path of this CLI executable — the versioned OAS_CLI_BIN
// env contract for dispatched package commands (never resolved via PATH).
const CLI_BIN = realpathSync(fileURLToPath(import.meta.url));
const jsonFail = (code, message) => { console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code, message: String(message) } })); process.exit(1); };
const jsonOk = (result) => { console.log(JSON.stringify({ schemaVersion: 1, ok: true, result })); };

/** Level of a directory: laptop (home), repo (.git), else workspace. */
function levelOf(dir) {
  const d = resolve(dir);
  if (d === homedir()) return "laptop";
  if (existsSync(join(d, ".git"))) return "repo";
  return "workspace";
}

function shortPath(p) {
  if (!p) return p;
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/** Shell-safe single-quoting for copyable human commands (paths may contain spaces/metacharacters). */
function shellQuote(s) {
  return /^[A-Za-z0-9._/~-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function offerTmuxMouseScrolling() {
  if (args.includes("--no-tmux-mouse")) return;
  const configPath = tmuxConfigPath();
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  if (tmuxMouseEnabled(current)) return;

  let accepted = args.includes("--tmux-mouse");
  if (!accepted) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;
    process.stdout.write("Enable normal mouse/trackpad scrolling in tmux agent windows? [Y/n] ");
    const buffer = Buffer.alloc(256);
    const length = readSync(process.stdin.fd, buffer, 0, buffer.length);
    accepted = !buffer.subarray(0, length).toString("utf8").trim().toLowerCase().startsWith("n");
  }
  if (!accepted) return;

  const result = enableTmuxMouse(configPath);
  console.log(`Enabled tmux mouse scrolling in ${shortPath(result.configPath)}${result.reloaded ? " (reloaded)" : ""}`);
}

// ---------- doctor ----------
/** Doctor must diagnose, not crash: a stale activation of a retired
 * capability fails config resolution — surface the cleanup instruction
 * cleanly (text or JSON) instead of an uncaught stack trace. */
function resolveForDoctor(ctx, soulName, { json } = {}) {
  try { return resolveOasConfig(ctx, soulName); }
  catch (e) {
    // Doctor is THE diagnosis surface: it alone catches the typed fail-closed
    // invalid-lock error and continues to render actionable state.
    if (e.code === "invalid-lock") {
      const prov = Array.isArray(e.provenance) ? e.provenance[0] : undefined;
      if (json) { console.log(JSON.stringify({ context: ctx, error: { code: "invalid-lock", message: e.message, provenance: e.provenance || null } }, null, 2)); process.exit(1); }
      console.log(`oas doctor — resolved from ${shortPath(ctx)}\n`);
      console.log(`ERROR: ${e.message} [invalid-lock]`);
      if (prov?.file) console.log(`  fix or remove the offending entry in ${shortPath(prov.file)} — the lock is never auto-repaired; all package operations fail closed until it is valid`);
      process.exit(0); // doctor DIAGNOSED successfully; the lock is the problem
    }
    const retiredId = Object.keys(RETIRED_CAPABILITIES).find((id) => String(e.message).includes(`"${id}"`) && String(e.message).includes("retired"));
    if (!retiredId) throw e;
    if (json) { console.log(JSON.stringify({ schemaVersion: 1, context: ctx, error: e.message, retired: [retiredId] }, null, 2)); process.exit(1); }
    die(`${e.message}`);
  }
}
function doctorComposition(ctx, soulName) {
  if (!soulName) return undefined;
  const root = findRoot(ctx);
  const agent = root && findAgent(root, soulName);
  if (!agent) throw new Error(`unknown soul "${soulName}" for doctor composition`);
  return composeInstanceAgentsMd(join(agent._dir, "soul"), ctx, agent.name, agent.work || "checkout", agent.kind);
}
/** WS2 package-layer doctor data — the ONE source for both human and --json
 * doctor output: lock v2 packages, adopted-profile provenance, available-but-
 * unapplied profiles, and missing host requirements with structured plans. */
function doctorPackagesData(ctx, chain) {
  // reviewer-455ba15 fix 4: the ENGINE diagnostics the human doctor renders
  // (invalid locks, missing artifacts, integrity/runtime-closure drift,
  // capability-list mismatches, untrusted surfaces, legacy/residue states)
  // are computed HERE so doctor --json exposes them structurally — machine
  // consumers see every state the human report calls broken. Fail-closed
  // reads are diagnosed, never consumed as data and never swallowed.
  let pkgLocks = { packages: {}, legacy: [] };
  let installedPkgs = [];
  let lockBroken = null;
  try { pkgLocks = readPackageLocks(ctx); installedPkgs = listInstalledPackages(ctx); }
  catch (e) {
    const prov = Array.isArray(e.provenance) ? e.provenance[0] : undefined;
    lockBroken = { code: e.code || "invalid-lock", message: String(e.message || e), file: prov?.file || null, provenance: e.provenance || null };
  }
  const packages = [];
  for (const p of installedPkgs) {
    const lock = pkgLocks.packages[p.package];
    const problems = [];
    if (!lock) problems.push({ code: "invalid-lock", detail: "installed but not locked — reacquire it" });
    else {
      const integ = packageIntegrity(p.dir);
      if (integ !== lock.integrity) problems.push({ code: "integrity-drift", detail: `integrity drift — installed ${integ}, locked ${lock.integrity}; all capability approvals are invalid` });
      const depsNow = packageDepsIntegrity(p.dir);
      if ((lock.depsIntegrity || undefined) !== depsNow) problems.push({ code: "integrity-drift", detail: `materialized runtime closure ${depsNow ? "differs from" : "missing vs"} the locked depsIntegrity — run oas install to re-materialize` });
      const have = new Set(p.capabilities.map((c) => c.id));
      for (const c of lock.capabilities || []) if (!have.has(c)) problems.push({ code: "capability-list-mismatch", detail: `locked capability "${c}" is missing from the package manifest` });
      for (const c of p.capabilities) {
        const executable = Object.keys(c.manifest.commands || {}).length || Object.keys(c.manifest.hooks || {}).length;
        if (executable && !(lock.trustedCapabilities || []).includes(c.id) && packageIntegrity(p.dir) === lock.integrity) problems.push({ code: "untrusted-surface", detail: `capability ${c.id}: executable surface UNTRUSTED — \`oas trust ${c.id}\`` });
      }
    }
    packages.push({
      id: p.package, version: p.version || null, level: p.level, source: lock?.source || null,
      commit: lock?.commit || null, capabilities: p.capabilities.map((c) => c.id),
      status: problems.length ? "broken" : "ok", problems,
    });
  }
  for (const [id, lock] of Object.entries(pkgLocks.packages)) {
    if (!installedPkgs.some((p) => p.package === id)) {
      packages.push({ id, version: lock.version || null, level: lock._level, source: lock.source || null, commit: lock.commit || null, capabilities: lock.capabilities || [], status: "broken", problems: [{ code: "missing-locked-package", detail: `locked in ${lock._file} but not installed — run oas install` }] });
    }
  }
  // Legacy v1 files and v2 residue — the ENGINE's doctor shapes (its tests pin
  // status/action fields): empty/nonempty v1 = pending LOCK-FORMAT migration
  // (maintainer ruling — distinct from capability residue); v2 residue entries
  // carry pending-migration or invalid-lock with the retry/fix action.
  const legacyLockFiles = pkgLocks.legacy
    .filter((l) => l.lockfileVersion !== 2)
    .map((l) => ({ file: l.file, level: l.level, lockfileVersion: l.lockfileVersion ?? 1, empty: !Object.keys(l.capabilities || {}).length, status: "pending-format-migration", action: `oas migrate --dir ${l.level}` }));
  const migrationResidue = pkgLocks.legacy
    .filter((l) => l.lockfileVersion === 2)
    .flatMap((l) => Object.entries(l.capabilities || {}).map(([id, lock]) => {
      const violation = residueEntryViolation(lock);
      return violation
        ? { id, file: l.file, level: l.level, source: lock?.source || null, status: "invalid-lock", violation, action: `fix or remove the entry in ${l.file} (never auto-repaired)` }
        : { id, file: l.file, level: l.level, source: lock.source, status: "pending-migration", action: `oas migrate --dir ${l.level}` };
    }));
  const profileProvenance = [];
  const adoptedPackages = new Set();
  for (const cfg of chain) {
    const prov = parseProfileProvenance(readFileSync(cfg._file, "utf8"));
    if (!prov) continue;
    profileProvenance.push({ file: cfg._file, package: prov.package, ref: prov.ref || null, profile: prov.profile });
    adoptedPackages.add(prov.package);
  }
  const unappliedProfiles = [];
  for (const p of installedPkgs) {
    if (adoptedPackages.has(p.package)) continue;
    const profiles = Object.keys(p.manifest?.configs || {});
    if (profiles.length) unappliedProfiles.push({ package: p.package, profiles });
  }
  const missingHostRequirements = aggregateMissingRequirements([ctx]).map((req) => ({
    command: req.command, why: req.why || null, docs: req.docs || null,
    requestedBy: req.requestedBy,
    plan: req.plan && !req.plan.unavailable
      ? { manager: req.plan.manager, argv: req.plan.argv, source: req.plan.source, version: req.plan.version || null, scope: req.plan.scope }
      : null,
    invalid: req.invalid || null,
    conflict: req.conflict || null,
    unavailable: req.plan?.unavailable || null,
    // Context-complete + shell-safe: the copyable command pins the resolved
    // scope with --dir so it cannot target another deployment from a
    // different cwd. Command and ctx are validated/quoted for safe copying.
    consentCommand: req.plan && !req.plan.unavailable && !req.invalid && !req.conflict
      ? `oas install --accept-requirement ${req.command} --dir ${shellQuote(ctx)}`
      : null,
  }));
  return { lockError: lockBroken, packages, legacyLockFiles, migrationResidue, profileProvenance, unappliedProfiles, missingHostRequirements };
}

function doctorJson(dir) {
  const ctx = resolve(dir || process.cwd());
  const soulName = flag("soul");
  const r = resolveForDoctor(ctx, soulName, { json: true });
  const mans = capabilityManifests(ctx);
  const composition = doctorComposition(ctx, soulName);
  const chain = configChain(ctx);
  const pkg = doctorPackagesData(ctx, chain);
  console.log(JSON.stringify({
    schemaVersion: 1,
    context: ctx,
    team: r.team || null,
    chain: r.chain.map((c) => ({ file: c._file, level: c._level, levelKind: levelOf(c._level) })),
    layers: Object.fromEntries(LAYERS.map((l) => [l, r.layers[l] ? {
      integration: r.layers[l].id, level: r.layers[l].level, inject: r.layers[l].inject,
      skills: [...(Array.isArray(r.layers[l].skills) ? r.layers[l].skills : (r.layers[l].skills ? [r.layers[l].skills] : []))],
      hooks: Object.keys(r.layers[l].hooks || {}), missingRequires: r.layers[l].missingRequires,
      provenance: r.provenance[l],
    } : { provenance: r.provenance[l] || null }])),
    kernelInjection: r.kernelInjection,
    injects: r.injects,
    capabilities: r.capabilities.map((c) => ({ id: c.id, layer: c.layer, command: c.command, origin: c.origin, provenance: c.provenance, settings: c.settings, skills: c.skills, inject: c.inject, hooks: Object.keys(c.hooks || {}), trust: c.trust })),
    acquired: Object.fromEntries(Object.entries(mans).map(([n, m]) => [n, { layer: m.layer, command: m.command, version: m.version, dir: m._dir, origin: m._origin, description: m.description }])),
    retiredLocks: Object.entries(readCapabilityLocks(ctx))
      .filter(([id]) => RETIRED_CAPABILITIES[id])
      .map(([id, lock]) => ({ id, file: lock._file, reason: RETIRED_CAPABILITIES[id] })),
    // Shared WS2+engine package payload (fix 4: human and JSON doctor derive
    // from ONE computation; fail-closed reads are diagnosed via lockError).
    migrationResidue: pkg.migrationResidue,
    legacyLockFiles: pkg.legacyLockFiles,
    lockError: pkg.lockError,
    retiredArtifacts: Object.entries(mans)
      .filter(([id]) => RETIRED_CAPABILITIES[id])
      .map(([id, m]) => ({ id, dir: m._dir, origin: m._origin, reason: RETIRED_CAPABILITIES[id] })),
    packages: pkg.packages,
    legacyLockFiles: pkg.legacyLockFiles,
    migrationResidue: pkg.migrationResidue,
    profileProvenance: pkg.profileProvenance,
    unappliedProfiles: pkg.unappliedProfiles,
    missingHostRequirements: pkg.missingHostRequirements,
    composedInstructions: composition?.text,
    instructionBlocks: composition?.blocks,
  }, null, 2));
}

function doctor(dir) {
  const ctx = resolve(dir || process.cwd());
  const soulName = flag("soul");
  const chain = configChain(ctx);
  const r = resolveForDoctor(ctx, soulName);
  console.log(`oas doctor — resolved from ${shortPath(ctx)}\n`);

  // Kernel/bridge version skew (published in lockstep from one tag).
  const piPkgFile = join(homedir(), ".pi", "agent", "npm", "node_modules", "@oas-framework", "pi", "package.json");
  if (existsSync(piPkgFile)) {
    const bridge = JSON.parse(readFileSync(piPkgFile, "utf8")).version;
    if (bridge !== OAS_VERSION) console.log(`WARNING: version skew — kernel ${OAS_VERSION}, pi bridge ${bridge}; run \`oas update\` (they publish in lockstep)\n`);
  }

  console.log("Config chain (closest first):");
  if (chain.length === 0) console.log("  (none — no oas-config.yaml found walking up)");
  for (const c of chain) {
    console.log(`  ${shortPath(c._file)}  [${levelOf(c._level)}]`);
  }

  if (r.team) console.log(`\nTeam: ${r.team.name}${r.team.id ? `  (id: ${r.team.id})` : ""}  [scope: ${shortPath(r.team.scope)}]`);

  console.log("\nLayers:");
  for (const layer of LAYERS) {
    const l = r.layers[layer];
    const prov = r.provenance[layer];
    if (!prov) { console.log(`  ${layer.padEnd(10)} (unresolved — no declaration in chain)`); continue; }
    if (!l) { console.log(`  ${layer.padEnd(10)} none  [${prov}]`); continue; }
    console.log(`  ${layer.padEnd(10)} ${l.id}  [${prov}]`);
    if (l.inject) console.log(`             inject: ${shortPath(l.inject)}`);
    const skills = Array.isArray(l.skills) ? l.skills : (l.skills ? [l.skills] : []);
    if (skills.length) console.log(`             skills: ${skills.map(shortPath).join(", ")}`);
    const hooks = Object.keys(l.hooks || {});
    if (hooks.length) console.log(`             hooks:  ${hooks.join(", ")}`);
    for (const miss of l.missingRequires || []) {
      console.log(`             MISSING REQUIREMENT: ${miss.command} — ${miss.why || ""}${miss.install ? ` (install: ${miss.install})` : ""}`);
    }
  }

  console.log("\nKernel injection:");
  console.log(`  oas: ${r.kernelInjection?.inject ? shortPath(r.kernelInjection.inject) : "none"}  [${r.kernelInjection?.provenance || "default"}]`);

  console.log("\nUnconditional injections (outermost→innermost):");
  if (r.injects.length === 0) console.log("  (none)");
  for (const inj of r.injects) console.log(`  ${inj.source}: ${shortPath(inj.file)}`);

  for (const mode of ["worktree", "checkout", "attached", "workspace"]) {
    const wm = resolveWorkMode(ctx, mode);
    console.log(`\nWork mode ${mode}: inject ${wm.inject ? shortPath(wm.inject) : "none"}${wm.setup ? `, setup ${shortPath(wm.setup)}` : ""}`);
  }

  console.log("\nActive capabilities:");
  if (!r.capabilities.length) console.log("  (none)");
  for (const cap of r.capabilities) {
    console.log(`  ${cap.id}${cap.layer ? `  layer: ${cap.layer}` : ""}  [${cap.provenance.join(" + ")}]`);
    console.log(`             trust: ${cap.trust.trusted ? "approved" : `BLOCKED (${cap.trust.reason})`}`);
    if (cap.inject) console.log(`             inject: ${shortPath(cap.inject)}`);
    if (cap.skills.length) console.log(`             skills: ${cap.skills.map(shortPath).join(", ")}`);
  }
  console.log("\nAcquired capability packages:");
  for (const [name, m] of Object.entries(capabilityManifests(ctx))) {
    const missing = capabilityMissingRequires(name, ctx);
    console.log(`  ${name.padEnd(16)} layer: ${(m.layer || "additive").padEnd(10)} origin: ${m._origin}${missing.length ? `  (missing: ${missing.map((x) => x.command).join(", ")})` : ""}`);
    if (RETIRED_CAPABILITIES[name]) {
      const installed = String(m._origin).startsWith("installed:");
      console.log(`             WARNING: artifact of a retired capability — ${RETIRED_CAPABILITIES[name]}${installed ? `; also delete ${shortPath(m._dir)}` : ` (origin ${m._origin}: remove its declaration; the source tree at ${shortPath(m._dir)} is yours to keep or drop)`}`);
    }
  }
  const locks = readCapabilityLocks(ctx);
  const mans = capabilityManifests(ctx);
  for (const [id, lock] of Object.entries(locks)) {
    if (RETIRED_CAPABILITIES[id]) { console.log(`  WARNING: ${id} is locked in ${shortPath(lock._file)} but ${RETIRED_CAPABILITIES[id]}`); continue; }
    if (!mans[id]) console.log(`  WARNING: ${id} is locked in ${shortPath(lock._file)} but not acquired — run \`oas install\``);
  }
  for (const [id, m] of Object.entries(mans)) {
    if (String(m._origin).startsWith("installed:") && !locks[id]) console.log(`  WARNING: ${id} at ${shortPath(m._dir)} is in installed/ but has no lock entry — reacquire it or move it to owned/`);
  }
  if (existsSync(LEGACY_HOME_CAPABILITIES_DIR)) console.log(`  WARNING: legacy ~/.oas/capabilities exists and is no longer discovered — reinstall its packages at a config scope and remove it`);

  // Distribution packages: package failures are distinguished from capability
  // failures. Doctor is the DIAGNOSIS surface — human and JSON render the SAME
  // doctorPackagesData computation (reviewer-455ba15 fix 4); fail-closed
  // invalid-lock raises are diagnosed here, never consumed as data.
  console.log("\nInstalled packages:");
  const pkg = doctorPackagesData(ctx, chain);
  if (pkg.lockError) {
    console.log(`  ERROR: ${pkg.lockError.message} [${pkg.lockError.code}]`);
    if (pkg.lockError.file) console.log(`         fix or remove the offending entry in ${shortPath(pkg.lockError.file)} — the lock is never auto-repaired; package operations fail closed until it is valid`);
  }
  if (!pkg.lockError && !pkg.packages.length && !pkg.legacyLockFiles.length && !pkg.migrationResidue.length) console.log("  (none)");
  for (const p of pkg.packages) {
    console.log(`  ${p.id}@${p.version}  [${levelOf(p.level)} ${shortPath(p.level)}]`);
    for (const prob of p.problems) {
      if (prob.code === "untrusted-surface") console.log(`             ${prob.detail}`);
      else console.log(`             ERROR: ${prob.detail} [${prob.code}]`);
    }
  }
  for (const l of pkg.legacyLockFiles) {
    if (l.empty) console.log(`  WARNING: ${shortPath(l.file)} is an empty lockfileVersion ${l.lockfileVersion} file — pending lock-format migration: run \`oas migrate --dir ${shortPath(l.level)}\` (converts to canonical v2, no residue)`);
    else console.log(`  WARNING: ${shortPath(l.file)} is lockfileVersion ${l.lockfileVersion} — \`oas migrate\` maps its capability locks to packages`);
  }
  for (const res of pkg.migrationResidue) {
    if (res.status === "invalid-lock") console.log(`  ERROR: residue entry ${res.id} in ${shortPath(res.file)} is malformed (${res.violation}) — never auto-repaired; fix or remove the entry [invalid-lock]`);
    else console.log(`  NOTE: ${res.id} in ${shortPath(res.file)} is legacy migration residue (${res.source}) — pending migration: re-run \`oas migrate --dir ${shortPath(res.level)}\` when its official package publishes, or remove the entry if the capability is abandoned`);
  }
  for (const prov of pkg.profileProvenance) {
    console.log(`\nConfig profile provenance: ${shortPath(prov.file)} adopted ${prov.package}${prov.ref ? `@${prov.ref}` : ""} profile "${prov.profile}" (snapshot — compare with \`oas config diff\`)`);
  }
  for (const u of pkg.unappliedProfiles) {
    console.log(`\nNOTE: package ${u.package} exports config profile${u.profiles.length > 1 ? "s" : ""} (${u.profiles.join(", ")}) not applied at any scope — adopt one with \`oas init --package ${u.package}${u.profiles.length > 1 ? " --config <name>" : ""}\` at a fresh scope`);
  }
  if (pkg.missingHostRequirements.length) {
    console.log("\nMissing host commands (active capabilities):");
    for (const req of pkg.missingHostRequirements) {
      console.log(`  ${req.command} — ${req.why || "required"} (requested by: ${req.requestedBy.map((r) => r.capability).join(", ")})`);
      if (req.plan) console.log(`             install with consent: ${req.consentCommand}  (runs: ${req.plan.argv.join(" ")})`);
      else if (req.docs) console.log(`             install docs: ${req.docs}`);
    }
  }

  if (soulName) {
    const composition = doctorComposition(ctx, soulName);
    console.log(`\nFinal composed AGENTS.md for ${soulName}:\n\n${composition.text}`);
  } else console.log("\nPass --soul <name> to inspect final composed AGENTS.md.");
}

// ---------- config editing (structural: parse → mutate → re-serialize the capabilities block) ----------
function originToFrom(origin) {
  const o = String(origin || "");
  if (o.startsWith("installed:")) return "installed";
  if (o.startsWith("owned:")) return "owned";
  if (o.startsWith("path:")) return undefined; // path declarations stay hand-authored
  return undefined;
}

function serializeBinding(value, indent) {
  if (value === true || value === false) return ` ${value}`;
  const lines = [""];
  if (value.enabled !== undefined) lines.push(`${indent}enabled: ${value.enabled}`);
  if (value.settings && Object.keys(value.settings).length) {
    lines.push(`${indent}settings:`);
    for (const [k, v] of Object.entries(value.settings)) lines.push(`${indent}  ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
  }
  return lines.join("\n");
}

/** Serialize one capability entry map at the given base indent, with the conventional injection comment. */
function serializeCapabilityEntry(id, entry, baseIndent) {
  const i = baseIndent;
  const lines = [];
  if (entry.capability) lines.push(`${i}capability: ${entry.capability}`);
  if (entry.from) lines.push(`${i}from: ${entry.from}`);
  if (entry.global !== undefined) lines.push(`${i}global:${serializeBinding(entry.global, i + "  ")}`);
  const types = entry["agent-types"];
  if (types && Object.keys(types).length) {
    lines.push(`${i}agent-types:`);
    for (const [t, v] of Object.entries(types)) lines.push(`${i}  ${t}:${serializeBinding(v, i + "    ")}`);
  }
  if (entry.souls && Object.keys(entry.souls).length) {
    lines.push(`${i}souls:`);
    for (const [s, v] of Object.entries(entry.souls)) lines.push(`${i}  ${s}:${serializeBinding(v, i + "    ")}`);
  }
  if (entry.settings && Object.keys(entry.settings).length) {
    lines.push(`${i}settings:`);
    for (const [k, v] of Object.entries(entry.settings)) lines.push(`${i}  ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
  }
  if (entry["injection-override"] !== undefined) lines.push(`${i}injection-override: ${entry["injection-override"]}`);
  else if (entry.from === "owned" || String(entry.from || "").startsWith("path:"))
    lines.push(`${i}# injection edited at source: .agents/capabilities/owned/${id}/injects/`);
  else lines.push(`${i}# injection-override: .agents/injections/capabilities/${id}.md`);
  return lines;
}

/** Re-serialize the whole `capabilities:` block from its parsed model. */
function serializeCapabilities(caps) {
  const lines = ["capabilities:", "  # Fundamental layers — exclusive slots; a capability entry or an explicit none.", "  layers:"];
  for (const layer of LAYERS) {
    const entry = caps.layers?.[layer];
    if (entry === undefined) continue;
    if (entry === "none") { lines.push(`    ${layer}: none`); continue; }
    lines.push(`    ${layer}:`);
    lines.push(...serializeCapabilityEntry(entry.capability, entry, "      "));
  }
  const additive = Object.entries(caps.additive || {});
  if (additive.length) {
    lines.push("  additive:");
    for (const [id, entry] of additive) {
      lines.push(`    ${id}:`);
      lines.push(...serializeCapabilityEntry(id, entry, "      "));
    }
  }
  return lines.join("\n") + "\n";
}

/** Replace (or append) the top-level capabilities: block in config text. */
function replaceCapabilitiesBlock(text, caps) {
  const serialized = serializeCapabilities(caps);
  const lines = text.replace(/\n*$/, "\n").split("\n");
  const start = lines.findIndex((l) => /^capabilities:\s*(#.*)?$/.test(l));
  if (start < 0) return text.replace(/\n*$/, "\n\n") + serialized;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[^\s#]/.test(lines[i])) { end = i; break; }
    if (/^#/.test(lines[i]) && i + 1 < lines.length && /^[^\s]/.test(lines[i + 1] || "")) { end = i; break; }
  }
  return [...lines.slice(0, start), ...serialized.replace(/\n$/, "").split("\n"), "", ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n");
}

/** Load the parsed capabilities model of a config file ({layers:{}, additive:{}}). */
function readCapabilitiesModel(file) {
  if (!existsSync(file)) return { layers: {}, additive: {} };
  const cfg = parseYamlNested(readFileSync(file, "utf8"));
  const caps = cfg.capabilities || {};
  return { layers: { ...(caps.layers || {}) }, additive: { ...(caps.additive || {}) } };
}

// ---------- use / activation ----------
function use() {
  const requested = args[1];
  if (!requested || requested.startsWith("--")) die("usage: oas use <capability|none> [--global|--type <agent-type>|--soul <name>] [--disable] [--layer <name>] [--settings k=v [k2=v2 ...]] [--dir <dir>]");
  const dir = dirFlag();
  const level = levelOf(dir);
  const file = join(dir, "oas-config.yaml");
  const layer = flag("layer");
  if (layer && !LAYERS.includes(layer)) die(`--layer must be one of: ${LAYERS.join(", ")}`);
  let text = existsSync(file) ? readFileSync(file, "utf8") : `name: ${basename(dir)}\n`;
  const caps = readCapabilitiesModel(file);
  if (requested === "none") {
    if (!layer) die("oas use none requires --layer <name>");
    caps.layers[layer] = "none";
    writeFileSync(file, replaceCapabilitiesBlock(text, caps));
    console.log(`Disabled fundamental layer ${layer} at ${level} level (${shortPath(file)})`);
    return;
  }
  const manifest = capabilityManifest(requested, dir);
  if (!manifest) die(`unknown capability "${requested}" (acquired: ${Object.keys(capabilityManifests(dir)).join(", ") || "none"}) — acquire it with \`oas install ${requested}\` (marketplace: ${Object.keys(marketplaceCapabilities()).join(", ")})`);
  if (layer && manifest.layer !== layer) die(`capability "${manifest.capability}" declares layer "${manifest.layer || "none"}", not "${layer}"`);
  const targets = [["agent-types", flag("type")], ["souls", flag("soul")]].filter(([, value]) => value);
  if (args.includes("--global")) targets.push(["global", undefined]);
  if (targets.length > 1) die("choose exactly one of --global, --type, or --soul");
  const [targetKind, targetName] = targets[0] || ["global", undefined];
  const enabled = !args.includes("--disable");
  // Locate or create the entry in the right subtree.
  let entry;
  if (manifest.layer) {
    const existing = caps.layers[manifest.layer];
    entry = existing && existing !== "none" && existing.capability === manifest.capability ? existing : { capability: manifest.capability };
    if (existing && existing !== "none" && existing.capability !== manifest.capability && enabled) {
      die(`fundamental layer ${manifest.layer} already binds ${existing.capability} at this level — disable it first`);
    }
    caps.layers[manifest.layer] = entry;
  } else {
    entry = caps.additive[manifest.capability] || {};
    caps.additive[manifest.capability] = entry;
  }
  const from = originToFrom(manifest._origin);
  if (from && !entry.from) entry.from = from;
  const settingsArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--settings") continue;
    let consumed = 0;
    for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++, consumed++) settingsArgs.push(args[j]);
    if (!consumed) die("--settings expects one or more key=value pairs");
    i += consumed;
  }
  if (settingsArgs.length) {
    entry.settings = entry.settings && typeof entry.settings === "object" ? entry.settings : {};
    for (const kv of settingsArgs) {
      const eq = kv.indexOf("=");
      if (eq <= 0) die(`--settings expects key=value, got "${kv}"`);
      entry.settings[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
  }
  if (targetKind === "global") entry.global = enabled;
  else {
    // A layer entry with no explicit targets is implicitly global — materialize that
    // before narrowing, so adding a soul/type binding doesn't silently drop everyone else.
    if (manifest.layer && entry.global === undefined && !entry["agent-types"] && !entry.souls) entry.global = true;
    entry[targetKind] = entry[targetKind] && typeof entry[targetKind] === "object" ? entry[targetKind] : {};
    entry[targetKind][targetName] = enabled;
  }
  writeFileSync(file, replaceCapabilitiesBlock(text, caps));
  console.log(`${enabled ? "Activated" : "Excluded"} ${manifest.capability} for ${targetKind === "global" ? "global" : `${targetKind === "agent-types" ? "type" : "soul"} ${targetName}`} at ${level} level (${shortPath(file)})`);
  for (const miss of capabilityMissingRequires(manifest.capability, dir)) console.log(`WARNING: required command "${miss.command}" not on PATH — ${miss.why || ""}${miss.install ? ` (install: ${miss.install})` : ""}`);
  console.log("New instances receive the resolved capability; committed souls are unchanged.");
}

// ---------- install / trust / list / remove / migrate ----------
const cmdFail = (code, msg) => (JSON_MODE ? jsonFail(code, msg) : die(msg));
/** `oas install <source>`: distribution-package acquisition (exact-lock closure,
 * activates nothing). Marketplace capability ids keep the legacy capability path
 * until workstream 3 publishes the official packages. */
function install() {
  const src = args[1];
  const dir = dirFlag();
  if (!src || src.startsWith("--")) {
    // Usage errors surface BEFORE any restore/network side effect: a malformed
    // --accept-requirement must not mutate the deployment and then report E_USAGE.
    flagAll("accept-requirement");
    reconcile(dir);
    return;
  }
  if (RETIRED_CAPABILITIES[src]) cmdFail("retired-capability", `${RETIRED_CAPABILITIES[src]}`);
  // Package source? (git/path with an oas-package.json, or a catalog id) — otherwise legacy capability acquisition.
  let parsedSrc;
  try { parsedSrc = parsePackageSource(src); } catch { parsedSrc = undefined; }
  const isMarketplaceCap = parsedSrc?.kind === "catalog" && !!marketplaceCapabilities()[src.replace(/@.*$/, "")];
  const isLocalPackage = parsedSrc?.kind === "path" && existsSync(join(parsedSrc.path, "oas-package.json"));
  const isCatalogPackage = parsedSrc?.kind === "catalog" && !isMarketplaceCap;
  if (parsedSrc && (parsedSrc.kind === "git" || isLocalPackage || isCatalogPackage)) { installPackage(dir, src); return; }
  const known = capabilityManifest(src, dir);
  if (known) {
    if (JSON_MODE) { jsonOk({ alreadyAcquired: known.capability, version: known.version || null }); return; }
    console.log(`Already acquired capability ${known.capability} (${known.version || "unversioned"}); not activated or updated.`);
    return;
  }
  let r;
  try { r = acquireCapability(dir, src); } catch (e) { cmdFail(e.code || "invalid-source", e.message); return; }
  const lock = {
    source: r.source,
    version: r.manifest.version || null,
    ...(r.commit ? { commit: r.commit } : {}), integrity: r.integrity,
    // Marketplace packages ship with the kernel you already installed — they are
    // trusted at acquisition; third-party git/path installs need explicit `oas trust`.
    trustedExecutables: !!r.marketplace,
  };
  let lockFile;
  try { lockFile = writeCapabilityLock(dir, r.manifest.capability, lock); }
  catch (e) {
    // Refused lock write (e.g. legacy-lock: v2 scope rejects NEW residue) must
    // not strand the acquired artifact — compensate before failing.
    rmSync(r.dest, { recursive: true, force: true });
    cmdFail(e.code || "legacy-lock", e.message); return;
  }
  if (JSON_MODE) { jsonOk({ capability: r.manifest.capability, version: r.manifest.version || null, integrity: r.integrity, source: r.source, dir: r.dest, lockFile, marketplace: !!r.marketplace, trustedExecutables: !!r.marketplace }); return; }
  console.log(`Acquired ${r.manifest.capability} → ${shortPath(r.dest)}`);
  console.log(`Locked ${r.manifest.version || r.commit || "exact artifact"} (${r.integrity}) in ${shortPath(lockFile)}; not activated.`);
  if (r.marketplace) console.log("Marketplace package: executables trusted at acquisition.");
  else if (r.manifest.commands || r.manifest.hooks) console.log(`Executable surface is blocked until: oas trust ${r.manifest.capability} --dir ${shortPath(dir)}`);
}

/** Lock-file levels from dir upward (closest last — outermost first), like restoreCapabilities' walk. */
function lockLevelsUp(dir) {
  const levels = [];
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, OAS_LOCK_FILE))) levels.push(d);
    if (dirname(d) === d) break;
  }
  return levels.reverse();
}

/** Check/restore one level's v2 package locks via the ENGINE's restorePackages
 * (exact restore, no ref advancement, staging + integrity/capability/deps
 * verification inside). The engine walks the lock chain from the given dir;
 * reconciliation calls it per deduplicated level and keeps that level's rows. */
/** Map engine restore rows to WS2 report items (kind package). */
const pkgRow = (r) => ({
  id: r.package, level: r.level, package: true, dir: r.dir,
  status: r.status === "ok" ? "present" : r.status, reason: r.reason, code: r.code,
});

/** Restore-and-partition for reconciliation (reviewer-455ba15 fix 1): the
 * engine's restorePackages walks the WHOLE lock chain from a directory and has
 * no exact-level option, so invoke it ONCE per deepest scope and PARTITION the
 * report rows by lock level — never re-invoke per level (each re-invocation
 * re-runs restore side effects for every ancestor lock). Returns a Map
 * level(resolved) → rows. */
function partitionedPackageRestore(deepestDir) {
  const byLevel = new Map();
  for (const r of restorePackages(deepestDir)) {
    const key = resolve(r.level);
    if (!byLevel.has(key)) byLevel.set(key, []);
    byLevel.get(key).push(pkgRow(r));
  }
  return byLevel;
}

function installPackage(dir, src) {
  const bail = (e) => (JSON_MODE ? jsonFail(e.code || "invalid-source", e.message || e) : die(e.message || e));
  let r;
  try { r = acquirePackage(dir, src); } catch (e) { bail(e); return; }
  if (JSON_MODE) { jsonOk({ root: r.root, installed: r.installed, lockFile: r.lockFile, depWarnings: r.depWarnings || [] }); return; }
  for (const p of r.installed) {
    console.log(`${p.kept ? "ok       " : "Acquired "}${p.package}@${p.version} → ${shortPath(p.dir)}`);
    console.log(`  locked ${p.commit === "local" ? "local tree" : p.commit} (${p.integrity}); capabilities: ${p.capabilities.join(", ") || "(none)"}`);
  }
  for (const w of r.depWarnings || []) console.log(`WARNING: ${w}`);
  console.log(`Locked in ${shortPath(r.lockFile)}; nothing activated.`);
  const executables = r.installed.flatMap((p) => p.capabilities).filter((c) => {
    const m = capabilityManifest(c, dir);
    return m && (Object.keys(m.commands || {}).length || Object.keys(m.hooks || {}).length);
  });
  if (executables.length) console.log(`Executable surfaces blocked until trusted: ${executables.map((c) => `oas trust ${c}`).join("; ")}`);
}

/** Bare `oas install` chain restore: engine packages (lock v2) + legacy locked
 * capabilities (v1). Returns { report, failed }; output goes to stdout (human)
 * or stderr (JSON mode) — the reconcile envelope owns stdout in JSON mode. */
function restore(dir) {
  const note = (msg) => (JSON_MODE ? console.error(msg) : console.log(msg));
  // Fail-closed locks: restorePackages/restoreCapabilities RAISE typed
  // invalid-lock — let the reconcile boundary surface the code verbatim
  // (never softened to empty); this throw is caught by reconcile().
  const pkgReport = restorePackages(dir).map((r) => ({
    id: r.package, level: r.level, package: true, dir: r.dir,
    status: r.status === "ok" ? "present" : r.status, reason: r.reason, code: r.code,
  }));
  const report = [...restoreCapabilities(dir), ...pkgReport];
  if (!report.length) note("Nothing to restore — no locked capabilities in the config chain.");
  let failed = 0;
  for (const r of report) {
    const what = r.package ? `package ${r.id ?? "(lock)"}` : r.id;
    if (r.status === "present") note(`ok        ${what}  (${shortPath(r.dir)})`);
    else if (r.status === "restored") note(`restored  ${what} → ${shortPath(r.dir)}${r.integrity ? `  (${r.integrity})` : ""}`);
    else if (r.status === "legacy") note(`LEGACY    ${shortPath(join(r.level, OAS_LOCK_FILE))}: ${r.reason}`);
    else if (r.status === "retired") { failed++; note(`RETIRED   ${what}  ${r.reason}`); }
    else { failed++; note(`FAILED    ${what}  ${r.reason}`); }
  }
  return { report, failed };
}

/** Unsuccessful restore statuses and their frozen taxonomy codes (reviewer-6f0a3bd:
 * "unrestorable" and "retired" must not report ok). */
const UNSUCCESSFUL_RESTORE = { failed: undefined, unrestorable: "invalid-source", retired: "retired-capability" };

/** One artifact report item → the machine shape (kind capability|package). */
const artifactJson = (r) => ({
  id: r.id, kind: r.package ? "package" : "capability", level: r.level,
  status: r.status, ...(r.dir ? { dir: r.dir } : {}), ...(r.reason ? { reason: r.reason } : {}),
  ...(Object.hasOwn(UNSUCCESSFUL_RESTORE, r.status) ? { code: r.code || UNSUCCESSFUL_RESTORE[r.status] || "integrity-drift" } : {}),
});

/** Emit the reconcile/restore result: human exit or the single-envelope JSON contract.
 * Full success → { ok: true, result }. ANY artifact or consented-install failure →
 * nonzero with error.code E_RECONCILE_FAILED and the SAME complete report under
 * error.details — partial outcomes are never lost. */
function emitReconcileResult({ boundary, boundaryKind, scopes, requirements, failures }) {
  const result = { boundary, boundaryKind, scopes, requirements, failures };
  if (JSON_MODE) {
    if (failures.length) {
      console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_RECONCILE_FAILED", message: `${failures.length} failure${failures.length > 1 ? "s" : ""} during restore/reconciliation`, details: result } }));
      process.exit(1);
    }
    jsonOk(result);
    return;
  }
  if (failures.length) {
    console.log("\nFailures by scope:");
    for (const f of failures) console.log(`  ${shortPath(f.scope)}: ${f.id} — ${f.reason}`);
    die(`${failures.length} failure${failures.length > 1 ? "s" : ""} during restore/reconciliation`);
  }
}

/** Bare `oas install` at a team boundary: reconcile the whole workspace — restore the
 * boundary scope's graph (its ancestor chain), then every descendant scope's own
 * lock graph EXACTLY ONCE, in deterministic path order, with pruned discovery;
 * verify v2 package locks against the installed package store; validate
 * config-referenced capabilities against visible locked packages; aggregate
 * missing requirements and failures by scope.
 * Non-team scopes keep current-chain behavior unless --recursive names a boundary. */
/** Bare `oas install` (no source): current-chain restore or team-boundary
 * reconciliation. JSON-mode boundary: ANY throw before emitReconcileResult
 * (malformed lock/config, discovery failures) must still yield the single
 * envelope — never empty stdout with a stack trace. */
function reconcile(dir) {
  try { reconcileInner(dir); }
  catch (e) {
    if (JSON_MODE) {
      console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: e.code || "E_RECONCILE_FAILED", message: String(e.message || e) } }));
      process.exit(1);
    }
    die(e.message || e);
  }
}

function reconcileInner(dir) {
  const cfgFile = join(dir, "oas-config.yaml");
  const declaresTeamHere = existsSync(cfgFile) && !!parseYamlNested(readFileSync(cfgFile, "utf8")).team;
  const recursive = args.includes("--recursive");
  if (!declaresTeamHere && !recursive) {
    // Current-chain behavior, plus the requirements gate for this chain's active capabilities.
    const { report, failed } = restore(dir);
    const requirements = requirementsGate([dir]);
    const failures = [
      // "legacy" is informational (v1 locks restore via the capability path);
      // every other unsuccessful status is a failure (incl. retired/unrestorable
      // per reviewer-6f0a3bd — they must not report ok).
      ...report.filter((r) => Object.hasOwn(UNSUCCESSFUL_RESTORE, r.status)).map((r) => ({ scope: r.level, id: r.package ? `package ${r.id}` : r.id, reason: r.reason, code: r.code || UNSUCCESSFUL_RESTORE[r.status] })),
      ...requirements.filter((q) => q.outcome === "failed").map((q) => ({ scope: dir, id: `requirement ${q.command}`, reason: q.reason || "consented install failed" })),
    ];
    void failed;
    emitReconcileResult({
      boundary: dir, boundaryKind: "chain",
      scopes: [{ scope: dir, artifacts: report.map(artifactJson) }],
      requirements, failures,
    });
    return;
  }
  const boundary = dir;
  const note = (msg) => (JSON_MODE ? console.error(msg) : console.log(msg));
  // The chosen boundary is printed BEFORE any network or host work — always.
  note(`Workspace reconciliation boundary: ${shortPath(boundary)}${declaresTeamHere ? " (team scope)" : " (--recursive)"}`);
  const scopes = [boundary, ...discoverWorkspaceScopes(boundary)];
  const failures = [];
  const scopeReports = [];
  let reportedAny = false;
  const restoredLevels = new Set(); // each lock level's graph restores exactly once
  const packageCheckedLevels = new Set(); // each level's package-lock rows consumed exactly once
  // reviewer-455ba15 fix 1 — partition-not-rerun: run the engine's chain-walking
  // package restore as FEW times as the API allows and hand out each level's
  // rows exactly once. One invocation covers a scope's entire ancestor chain;
  // rows are stashed so no level is ever REPORTED twice and no already-walked
  // level triggers a re-invocation. RESIDUAL (pending WS1's exact-levels API,
  // relayed as a want): a descendant owning its own lock necessarily re-walks
  // its ancestors inside the engine — present/valid ancestor artifacts re-verify
  // with local reads only, but a FAILED ancestor fetch may retry once per
  // lock-owning descendant. The exact-once reporting contract holds.
  const pendingPkgRows = new Map(); // level(resolved) → rows not yet consumed
  const packageRowsFor = (scope, levels) => {
    const wanted = levels.map((l) => resolve(l)).filter((l) => !packageCheckedLevels.has(l));
    if (!wanted.length) return [];
    if (wanted.some((l) => !pendingPkgRows.has(l))) {
      // One restore invocation covers scope's whole chain; stash every level's
      // rows so later scopes never re-invoke for already-walked levels.
      for (const [lvl, rows] of partitionedPackageRestore(scope)) {
        if (!pendingPkgRows.has(lvl)) pendingPkgRows.set(lvl, rows);
      }
    }
    const out = [];
    for (const l of wanted) {
      packageCheckedLevels.add(l);
      out.push(...(pendingPkgRows.get(l) || []));
    }
    return out;
  };
  for (const scope of scopes) {
    // Boundary: full ancestor chain (current-chain semantics). Descendants: their
    // own level only — every level between boundary and descendant is either the
    // boundary chain or an earlier discovered scope, so no level repeats and no
    // failed ancestor restore is retried (or hidden) per descendant.
    const chainLevels = scope === boundary ? undefined : [scope];
    const report = restoreCapabilities(scope, chainLevels ? { levels: chainLevels.filter((l) => !restoredLevels.has(resolve(l))) } : undefined)
      .filter((r) => !restoredLevels.has(resolve(r.level)));
    // v2 package locks: every lock level this scope covers (the boundary covers
    // its whole ancestor chain), each restored/verified exactly once.
    report.push(...packageRowsFor(scope, scope === boundary ? lockLevelsUp(boundary) : [scope]));
    for (const r of report) {
      reportedAny = true;
      const what = r.package ? `package ${r.id ?? "(lock)"}` : r.id;
      if (r.status === "present") note(`ok        ${what}  [${shortPath(r.level)}]`);
      else if (r.status === "restored") note(`restored  ${what} → ${shortPath(r.dir)}  [${shortPath(r.level)}]`);
      else if (r.status === "legacy") note(`LEGACY    ${shortPath(join(r.level, OAS_LOCK_FILE))}: ${r.reason}`);
      else if (r.status === "retired") { failures.push({ scope: r.level, id: what, reason: r.reason, code: "retired-capability" }); note(`RETIRED   ${what}  ${r.reason}  [${shortPath(r.level)}]`); }
      else { failures.push({ scope: r.level, id: what, reason: r.reason, code: r.code }); note(`FAILED    ${what}  ${r.reason}  [${shortPath(r.level)}]`); }
    }
    if (scope === boundary) for (const cfg of configChain(boundary)) restoredLevels.add(resolve(cfg._level));
    for (const r of report) restoredLevels.add(resolve(r.level));
    restoredLevels.add(resolve(scope));
    // Validate: every config-referenced installed capability supplied by a visible locked package/capability lock.
    if (existsSync(join(scope, "oas-config.yaml"))) {
      try {
        const supplied = lockedPackageCapabilities(scope);
        const capLocks = readCapabilityLocks(scope);
        for (const cfg of configChain(scope)) {
          if (resolve(cfg._level) !== resolve(scope)) continue;
          for (const [slot, entry] of Object.entries(cfg.capabilities?.layers || {})) {
            if (entry && typeof entry === "object" && entry.from === "installed" && !supplied.has(entry.capability) && !capLocks[entry.capability]) {
              failures.push({ scope, id: entry.capability, reason: `referenced by capabilities.layers.${slot} but supplied by no visible locked package` });
            }
          }
          for (const [id, entry] of Object.entries(cfg.capabilities?.additive || {})) {
            if (entry && typeof entry === "object" && entry.from === "installed" && !supplied.has(id) && !capLocks[id]) {
              failures.push({ scope, id, reason: "referenced in config but supplied by no visible locked package" });
            }
          }
        }
      } catch (e) { failures.push({ scope, id: "(config)", reason: e.message }); }
    }
    scopeReports.push({ scope, artifacts: report.map(artifactJson) });
  }
  if (!reportedAny && scopes.length === 1) note("Nothing to restore — no locked capabilities or packages found in the boundary.");
  const requirements = requirementsGate(scopes);
  for (const q of requirements) {
    if (q.outcome === "failed") failures.push({ scope: boundary, id: `requirement ${q.command}`, reason: q.reason || "consented install failed" });
  }
  emitReconcileResult({
    boundary, boundaryKind: declaresTeamHere ? "team" : "recursive",
    scopes: scopeReports, requirements, failures,
  });
}

/** Host-requirement consent gate. Requirements are considered only for capabilities
 * activated somewhere in the reconciled scopes, deduplicated by command. Interactive
 * runs prompt per requirement with the exact command/source/version and state scope;
 * non-interactive runs NEVER install by default — automation names each accepted
 * requirement via --accept-requirement <command>; --no-requirements skips entirely.
 * Skipping leaves an actionable doctor warning (doctor recomputes missing commands).
 * Returns structured entries with a stable outcome enum:
 *   "installed"        consented install ran and the command verified on PATH
 *   "failed"           consented install errored or PATH verification missed (→ reconcile failure)
 *   "consent-required" not explicitly accepted — nothing installed
 *   "skipped"          --no-requirements, or no safe installer for this host
 * JSON plan data equals the human prompt plan (argv/source/version/scope/requestedBy;
 * never shell text). In JSON mode all prose goes to stderr. */
function requirementsGate(scopes) {
  // Malformed repeatable flags are usage errors regardless of which branch
  // runs — validate up front so --no-requirements cannot mask them.
  const accepted = new Set(flagAll("accept-requirement"));
  const missing = aggregateMissingRequirements(scopes);
  if (!missing.length) return [];
  const note = (msg) => (JSON_MODE ? console.error(msg) : console.log(msg));
  const entryOf = (req, outcome, extra = {}) => ({
    command: req.command, why: req.why || null,
    plan: req.plan && !req.plan.unavailable
      ? { manager: req.plan.manager, argv: req.plan.argv, source: req.plan.source, version: req.plan.version || null, scope: req.plan.scope }
      : null,
    requestedBy: req.requestedBy, docs: req.docs || null, outcome, ...extra,
  });
  // Fail-closed identity/conflict policy (E_REQUIREMENT_POLICY): invalid command
  // tokens and same-command conflicting plans are NEVER consentable or installable
  // — they fail reconciliation deterministically with provenance, even under
  // --no-requirements (skipping consent does not skip safety validation).
  const policyEntries = [];
  for (const req of missing) {
    if (req.invalid) {
      note(`  INVALID requirement command ${JSON.stringify(req.command)} — ${req.invalid} (requested by: ${req.requestedBy.map((r) => `${r.capability} [${shortPath(r.scope)}]`).join(", ")})`);
      policyEntries.push(entryOf(req, "failed", { reason: req.invalid, code: "E_REQUIREMENT_POLICY" }));
    } else if (req.conflict) {
      note(`  CONFLICT for command "${req.command}": capabilities request non-identical install plans — no install is offered`);
      for (const p of req.conflict.plans) note(`      ${p.capability} [${shortPath(p.scope)}]: ${p.argv ? p.argv.join(" ") : p.unavailable || "no plan"}`);
      policyEntries.push(entryOf(req, "failed", { reason: "conflicting install plans for the same command", code: "E_REQUIREMENT_POLICY", conflict: req.conflict }));
    }
  }
  const consentable = missing.filter((req) => !req.invalid && !req.conflict);
  if (args.includes("--no-requirements")) return [...policyEntries, ...consentable.map((req) => entryOf(req, "skipped", { reason: "--no-requirements" }))];
  const interactive = !JSON_MODE && process.stdin.isTTY && process.stdout.isTTY;
  const out = [...policyEntries];
  if (consentable.length) note(`\nMissing host commands for active capabilities (${consentable.length}):`);
  for (const req of consentable) {
    const requesters = req.requestedBy.map((r) => `${r.capability} [${shortPath(r.scope)}]`).join(", ");
    note(`  ${req.command} — ${req.why || "required"} (requested by: ${requesters})`);
    const plan = req.plan;
    if (!plan || plan.unavailable) {
      note(`    no safe installer: ${plan?.unavailable || "no recipe"}${req.docs ? ` — install docs: ${req.docs}` : ""}`);
      out.push(entryOf(req, "skipped", { reason: plan?.unavailable || "no safe installer" }));
      continue;
    }
    note(`    installer: ${plan.argv.join(" ")}  (source: ${plan.source}${plan.version ? `, version ${plan.version}` : ""}; ${plan.scope})`);
    let consent = accepted.has(req.command);
    if (!consent && interactive) {
      process.stdout.write(`    Run this install now? [y/N] `);
      const buf = Buffer.alloc(64);
      let answer = "";
      try { answer = buf.toString("utf8", 0, readSync(process.stdin.fd, buf, 0, 64)).trim().toLowerCase(); } catch { /* EOF */ }
      consent = answer === "y" || answer === "yes";
    }
    if (!consent) {
      note(`    skipped — ${interactive ? "not consented" : "non-interactive; pass --accept-requirement " + req.command + " to install"}; \`oas doctor\` will keep warning until ${req.command} is on PATH`);
      out.push(entryOf(req, "consent-required"));
      continue;
    }
    try {
      const r = runRequirementInstall(plan, JSON_MODE ? { stdio: ["ignore", 2, 2] } : {});
      if (r.onPath) { note(`    installed — ${req.command} verified on PATH`); out.push(entryOf(req, "installed", { onPath: true })); }
      else { note(`    FAILED: install ran but ${req.command} is still not on PATH — check your shell PATH/prefix`); out.push(entryOf(req, "failed", { onPath: false, reason: "install ran but the command is not on PATH" })); }
    } catch (e) {
      note(`    FAILED: ${e.message}`);
      out.push(entryOf(req, "failed", { onPath: false, reason: e.message }));
    }
  }
  note("Requirement consent is separate from capability trust — installing a binary does not activate or approve any capability.");
  return out;
}

/** oas trust <capability> | oas trust <package> --all-capabilities */
function trust() {
  const id = args[1];
  if (!id || id.startsWith("--")) { cmdFail("E_USAGE", "usage: oas trust <capability> [--dir <dir>] | oas trust <package> --all-capabilities [--dir <dir>]"); return; }
  const dir = dirFlag();
  const all = args.includes("--all-capabilities");
  // Package-backed approval path (per-capability, or explicit bulk on a package id).
  let pkgs;
  try { pkgs = listInstalledPackages(dir); } catch (e) { cmdFail(e.code || "invalid-lock", e.message || e); return; }
  const backing = all ? pkgs.find((p) => p.package === id) : pkgs.find((p) => p.capabilities.some((c) => c.id === id));
  if (backing) {
    if (all) {
      // Contract-required pre-approval review of the FULL executable surface:
      // stdout in human mode; stderr in JSON mode (stdout stays one object).
      const out = JSON_MODE ? console.error : console.log;
      out(`Package ${backing.package}@${backing.version} full executable surface:`);
      for (const c of backing.capabilities) {
        const cmds = Object.keys(c.manifest.commands || {});
        const hooks = Object.keys(c.manifest.hooks || {});
        out(`  ${c.id}: commands [${cmds.join(", ") || "none"}], hooks [${hooks.join(", ") || "none"}]`);
      }
    }
    let r;
    try { r = approveCapability(dir, id, { allCapabilities: all }); } catch (e) { cmdFail(e.code || "invalid-lock", e.message || e); return; }
    if (JSON_MODE) {
      const surface = {};
      for (const c of backing.capabilities) surface[c.id] = { commands: Object.keys(c.manifest.commands || {}), hooks: Object.keys(c.manifest.hooks || {}) };
      jsonOk({ package: r.package, integrity: r.integrity, approved: r.approved, skipped: r.skipped, executableSurface: surface, file: r.file });
      return;
    }
    if (r.approved.length) console.log(`Trusted executable commands/hooks for ${r.approved.join(", ")} (package ${r.package} at ${r.integrity}).`);
    if (r.skipped.length) console.log(`No executable surface (lock integrity suffices, no approval needed): ${r.skipped.join(", ")}`);
    return;
  }
  if (all) { cmdFail("unknown-capability", `no installed package "${id}" — --all-capabilities takes a package identity`); return; }
  // Legacy standalone capability path.
  const manifest = capabilityManifest(id, dir);
  if (!manifest) { cmdFail("unknown-capability", `unknown capability "${id}"`); return; }
  const lock = readCapabilityLocks(dir)[manifest.capability];
  if (!lock) { cmdFail("invalid-lock", `${manifest.capability} is not locked in ${OAS_LOCK_FILE}`); return; }
  const integrity = capabilityIntegrity(manifest._dir);
  if (integrity !== lock.integrity) { cmdFail("integrity-drift", `integrity changed (${lock.integrity} → ${integrity}); reacquire explicitly before trusting`); return; }
  const { _file, ...clean } = lock;
  try { writeCapabilityLock(dirname(_file), manifest.capability, { ...clean, trustedExecutables: true }); }
  catch (e) { cmdFail(e.code || "invalid-lock", e.message || e); return; }
  if (JSON_MODE) { jsonOk({ capability: manifest.capability, integrity, legacy: true }); return; }
  console.log(`Trusted executable commands/hooks for ${manifest.capability} at ${integrity}.`);
}

// ---------- package config profiles (oas init --package / oas config diff) ----------
/** Collect every value of a repeatable flag (e.g. --accept-requirement a --accept-requirement b).
 * A missing or flag-shaped value is a usage error — one E_USAGE envelope in JSON mode. */
function flagAll(name) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== `--${name}`) continue;
    if (args[i + 1] && !args[i + 1].startsWith("--")) out.push(args[i + 1]);
    else (JSON_MODE ? jsonFail("E_USAGE", `--${name} needs a value`) : die(`--${name} needs a value`));
  }
  return out;
}

/** Capability ids supplied by a package's dependency closure, read from visible locks (phase 1).
 * The scope's own lock is merged in directly: during init no oas-config.yaml exists
 * there yet, so configChain-based reading cannot see same-lock dependencies. */
/** Capability ids supplied by a package's dependency closure, resolved through
 * the ENGINE's lock graph (dependencies recorded by identity) plus the indexed
 * installed store. During init the scope may have a lock without a config;
 * readPackageLocks walks the chain and the scope itself. */
/** Dependency-closure PROVIDER RECORDS for profile validation, resolved from
 * the acquired root's LOCK entry (identity-valued dependencies) and the
 * engine-indexed store — reviewer-455ba15 fixes 2+3: no source-string
 * reverse-engineering (a dependency's source need not encode its identity),
 * and each provider carries its capability MANIFESTS so layer agreement
 * validates against the real provider, not just an ID match.
 * Returns { capabilities: Map<capabilityId, capManifest|null> }. */
function dependencyClosureProviders(rootId, dir) {
  // The scope's own lock is read directly: during init no oas-config.yaml
  // exists there yet, so configChain-based reads cannot see that level.
  const locks = { ...readPackageLocks(dir).packages };
  try {
    const parsed = JSON.parse(readFileSync(join(dir, OAS_LOCK_FILE), "utf8"));
    if (parsed.lockfileVersion === 2) for (const [id, e] of Object.entries(parsed.packages || {})) locks[id] ||= e;
  } catch { /* no own lock (or fail-closed raise — init surfaces it at acquire) */ }
  const byId = new Map(listInstalledPackages(dir).map((p) => [p.package, p]));
  // Own-scope store read directly too (configChain cannot index a level with
  // no oas-config.yaml yet — the closure was just acquired there).
  for (const id of Object.keys(locks)) {
    if (byId.has(id)) continue;
    const d = join(installedPackagesDir(dir), id);
    if (!existsSync(join(d, "oas-package.json"))) continue;
    try {
      const m = loadPackageManifestAt(d);
      byId.set(id, { package: id, capabilities: (m._capabilities || []).map((c) => ({ id: c.id, manifest: c.manifest })) });
    } catch { /* invalid installed manifest surfaces via doctor */ }
  }
  const capabilities = new Map(); // capability id → capability manifest (or null when only lock metadata is visible)
  const seen = new Set();
  const visit = (pkgId) => {
    if (!pkgId || seen.has(pkgId)) return;
    seen.add(pkgId);
    const entry = locks[pkgId];
    const pkg = byId.get(pkgId);
    if (pkg) for (const c of pkg.capabilities) capabilities.set(c.id, c.manifest || null);
    else if (entry) for (const c of entry.capabilities || []) { if (!capabilities.has(c)) capabilities.set(c, null); }
    // Lock-graph dependencies are package identities (engine contract).
    for (const dep of entry?.dependencies || []) visit(dep);
  };
  for (const dep of locks[rootId]?.dependencies || []) visit(dep);
  return { capabilities };
}

/** oas init --package <source> [--config <name>]: preview, validate, and snapshot one package config profile.
 * JSON mode: one compact envelope; WS2 codes E_PROFILE_INVALID / E_PROFILE_AMBIGUOUS /
 * E_PROFILE_NOT_FOUND (E_CONFIG_EXISTS is raised by init() before this); engine
 * error codes (invalid-package-manifest, path-escape, invalid-source, …) pass
 * through verbatim; fully noninteractive (no tmux prompt). */
function initPackage(src, dir, file) {
  const bail = (code, msg) => (JSON_MODE ? jsonFail(code, msg) : die(msg));
  const note = (msg) => (JSON_MODE ? console.error(msg) : console.log(msg));
  const configFlag = flag("config");
  if (configFlag === true) bail("E_USAGE", "--config needs a profile name");
  // During init the target scope may carry a lock/store WITHOUT an
  // oas-config.yaml — configChain-based engine reads cannot see that level
  // (init-acquires-before-config-exists), so read the scope's own lock v2
  // directly for the id checks.
  const ownLockV2 = (() => {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, OAS_LOCK_FILE), "utf8"));
      return parsed.lockfileVersion === 2 ? parsed.packages || {} : {};
    } catch { return {}; }
  })();
  const installedAt = (id) => {
    const d = join(installedPackagesDir(dir), id);
    return ownLockV2[id] && existsSync(join(d, "oas-package.json")) ? d : undefined;
  };
  const isUrlOrCatalog = /^(https?:\/\/|git@|ssh:\/\/|git:)/.test(src) || (!src.startsWith(".") && !src.startsWith("/") && !src.startsWith("~") && !src.startsWith("path:") && !ownLockV2[src] && !readPackageLocks(dir).packages[src] && !listInstalledPackages(dir).some((p) => p.package === src));
  try {
    // Gate 1: adoption leaves the root + dependency closure exact-locked via
    // the ENGINE's acquirePackage — which now supports git, catalog, AND local
    // sources. Acquisition runs BEFORE the config snapshot is published (a
    // failed acquire/lock must not leave a config behind), and its exact-
    // integrity reuse rejects same-ID/different-source drift. Already-installed
    // ids are resolved from the store without re-fetching.
    let manifest, commit;
    const installedDir = !isUrlOrCatalog && (installedAt(src) || listInstalledPackages(dir).find((p) => p.package === src)?.dir);
    if (installedDir) {
      manifest = loadPackageManifestAt(installedDir);
      commit = (ownLockV2[src] || readPackageLocks(dir).packages[src])?.commit || "local";
    } else {
      let acq;
      try { acq = acquirePackage(dir, src); }
      catch (e) { bail(e.code || "E_ACQUIRE_FAILED", e.message); }
      note(`Acquired + locked package closure: ${acq.installed.map((p) => `${p.package}@${p.version}`).join(", ")} → ${shortPath(acq.lockFile)}`);
      const rootRec = acq.installed.find((p) => p.package === acq.root);
      manifest = loadPackageManifestAt(rootRec.dir);
      commit = rootRec.commit;
    }
    let profile;
    try { profile = selectProfile(manifest, configFlag); }
    catch (e) { bail(e.code || "E_PROFILE_AMBIGUOUS", e.message); }
    let errors;
    try { errors = validateProfile(manifest, profile, { dependencyProviders: dependencyClosureProviders(manifest.package, dir).capabilities }); }
    catch (e) { bail(e.code || "E_PROFILE_INVALID", e.message); }
    if (errors.length) bail("E_PROFILE_INVALID", `profile "${profile.name}" of package ${manifest.package} failed validation:\n  - ${errors.join("\n  - ")}`);
    let body;
    try { body = readProfileText(manifest, profile); }
    catch (e) { bail(e.code || "E_PROFILE_INVALID", e.message); }
    const capabilities = (manifest._capabilities || []).map((c) => c.id);
    // Preview before writing: package, profile, exported capabilities.
    note(`Package ${manifest.package}@${manifest.version} — profile "${profile.name}"${profile.description ? `: ${profile.description}` : ""}`);
    note(`  exports capabilities: ${capabilities.join(", ") || "(none)"}`);
    const text = `${profileProvenanceHeader({ pkg: manifest.package, version: manifest.version, profile: profile.name, commit })}\n` +
      body.replace(/^name:.*$/m, `name: ${basename(dir)}`).replace(/\n*$/, "\n");
    writeFileSync(file, text);
    note(`Created ${shortPath(file)} (${levelOf(dir)} level) from package profile ${manifest.package}:${profile.name}`);
    note("The snapshot is an ordinary scoped config — edit it, retarget or disable any capability; package updates never rewrite it.");
    // After the snapshot exists, the scope IS a config level — but merge the own
    // lock read too for the paranoid path (lock written moments ago).
    const locks = { ...readPackageLocks(dir).packages };
    try {
      const parsed = JSON.parse(readFileSync(join(dir, OAS_LOCK_FILE), "utf8"));
      if (parsed.lockfileVersion === 2) for (const [id, e] of Object.entries(parsed.packages || {})) locks[id] = { ...e, _file: join(dir, OAS_LOCK_FILE) };
    } catch { /* no own lock */ }
    if (!locks[manifest.package]) note(`NOTE: package ${manifest.package} is not locked at this scope yet — acquire it with \`oas install ${src}\` so its capabilities restore.`);
    if (JSON_MODE) {
      const lockEntry = locks[manifest.package];
      jsonOk({
        package: manifest.package, version: manifest.version, commit: commit || null,
        profile: profile.name, file, capabilities,
        lockFile: lockEntry?._file || null,
        lockedPackages: Object.keys(locks),
      });
      return;
    }
  } finally { /* engine acquisition stages its own temp dirs */ }
  offerTmuxMouseScrolling();
}

/** oas config diff --package <id> --config <name>: report-only diff of the local snapshot vs the package's current profile.
 * The snapshot's provenance header supplies --package/--config defaults.
 * JSON mode: one envelope; zero differences = exit 0 with differingLines 0. */
function configDiffCmd() {
  const bail = (code, msg) => (JSON_MODE ? jsonFail(code, msg) : die(msg));
  if (args[1] !== "diff") bail("E_USAGE", "usage: oas config diff --package <id> --config <name> [--dir <dir>] [--json]");
  const dir = resolve(flag("dir") || process.cwd());
  const file = join(dir, "oas-config.yaml");
  if (!existsSync(file)) bail("E_NO_CONFIG", `no oas-config.yaml at ${shortPath(dir)} — nothing to diff`);
  const localText = readFileSync(file, "utf8");
  const provenance = parseProfileProvenance(localText);
  const pkgId = flag("package") || provenance?.package;
  if (!pkgId || pkgId === true) bail("E_USAGE", "usage: oas config diff --package <id> --config <name> (the snapshot's provenance header supplies defaults when present)");
  const configFlag = flag("config");
  if (configFlag === true) bail("E_USAGE", "--config needs a profile name");
  const profileName = configFlag || provenance?.profile;
  const tmp = /^(https?:\/\/|git@|ssh:\/\/)/.test(pkgId) ? mkdtempSync(join(tmpdir(), "oas-package-")) : undefined;
  try {
    let resolved;
    try { resolved = resolveProfilePackage(pkgId, dir, { clone: tmp }); }
    catch (e) { bail(e.code || "E_PACKAGE_UNRESOLVED", e.message); }
    let profile;
    try { profile = selectProfile(resolved.manifest, profileName); }
    catch (e) { bail(e.code || "E_PROFILE_AMBIGUOUS", e.message); }
    let packageText;
    try { packageText = readProfileText(resolved.manifest, profile); }
    catch (e) { bail(e.code || "E_PROFILE_INVALID", e.message); }
    // Strip the local provenance header for a meaningful comparison.
    const localBody = localText.replace(/^# package: .*\n/, "");
    const diff = diffConfigTexts(localBody, packageText);
    const changed = diff.filter((d) => d.kind !== "same");
    if (JSON_MODE) {
      jsonOk({
        package: resolved.manifest.package, profile: profile.name,
        version: resolved.manifest.version, file,
        differingLines: changed.length, diff,
      });
      return;
    }
    console.log(`oas config diff — local ${shortPath(file)} vs ${resolved.manifest.package}@${resolved.manifest.version} profile "${profile.name}" (report only; nothing is merged or overwritten)\n`);
    if (!changed.length) { console.log("No differences."); return; }
    for (const d of diff) {
      if (d.kind === "local") console.log(`+ ${d.line}`);
      else if (d.kind === "package") console.log(`- ${d.line}`);
      else console.log(`  ${d.line}`);
    }
    console.log(`\n${changed.length} differing line${changed.length > 1 ? "s" : ""} (+ local only, - package profile only). Snapshots deliberately drift; adopt package changes by hand if wanted.`);
  } finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
}

/** oas list — installed packages, exported capabilities, scopes. */
function listCmd() {
  const dir = dirFlag();
  // FAIL-CLOSED (maintainer finding 3): list RAISES on invalid locks — an
  // invalid lock must never render as usable/absent data.
  let pkgs, locks;
  try { pkgs = listInstalledPackages(dir); locks = readPackageLocks(dir); }
  catch (e) { JSON_MODE ? jsonFail(e.code || "invalid-lock", e.message || e) : die(e.message); return; }
  if (JSON_MODE) {
    jsonOk({
      packages: pkgs.map((p) => ({ package: p.package, version: p.version, level: p.level, source: p.source || null, commit: p.commit || null, integrity: p.integrity || null, locked: p.locked, dependencies: p.dependencies, trustedCapabilities: p.trustedCapabilities, capabilities: p.capabilities.map((c) => c.id) })),
      legacy: locks.legacy.map((l) => ({ file: l.file, level: l.level, lockfileVersion: l.lockfileVersion, capabilities: Object.keys(l.capabilities) })),
    });
    return;
  }
  if (!pkgs.length) console.log("No installed packages in this config chain.");
  for (const p of pkgs) {
    console.log(`${p.package}@${p.version}  [${levelOf(p.level)} ${shortPath(p.level)}]${p.locked ? "" : "  UNLOCKED (no lock entry — reacquire)"}`);
    if (p.source) console.log(`  source: ${p.source}  commit: ${p.commit || "?"}`);
    for (const c of p.capabilities) {
      const executable = Object.keys(c.manifest.commands || {}).length || Object.keys(c.manifest.hooks || {}).length;
      const trusted = p.trustedCapabilities.includes(c.id);
      console.log(`  capability ${c.id}${c.manifest.layer ? `  layer: ${c.manifest.layer}` : ""}${executable ? (trusted ? "  [trusted]" : "  [executable — needs oas trust]") : ""}`);
    }
    if (p.dependencies.length) console.log(`  depends on: ${p.dependencies.join(", ")}`);
  }
  for (const l of locks.legacy) console.log(`Legacy capability locks (lockfileVersion ${l.lockfileVersion ?? 1}) in ${shortPath(l.file)}: ${Object.keys(l.capabilities).join(", ")} — \`oas migrate\` maps them to packages`);
}

/** oas remove <package> — refuses while config or dependent packages reference it. */
function removeCmd() {
  const id = args[1];
  if (!id || id.startsWith("--")) JSON_MODE ? jsonFail("E_USAGE", "usage: oas remove <package> [--dir <dir>]") : die("usage: oas remove <package> [--dir <dir>]");
  const dir = dirFlag();
  let r;
  try { r = removePackage(dir, id); } catch (e) { cmdFail(e.code || "remove-blocked", e.message || e); return; }
  if (JSON_MODE) { jsonOk(r); return; }
  console.log(`Removed package ${r.package} (${shortPath(r.dir)}) and its entry in ${shortPath(r.lockFile)}.`);
}

/** oas migrate — map this scope's v1 marketplace capability locks to package locks. */
function migrateCmd() {
  const dir = dirFlag();
  const dryRun = args.includes("--dry-run");
  if (dryRun) {
    let plan, warnings;
    try { ({ plan, warnings } = migrateLegacyLock(dir)); }
    catch (e) { cmdFail(e.code || "invalid-lock", e.message || e); return; }
    if (JSON_MODE) { jsonOk({ dryRun: true, plan, warnings }); return; }
    if (!plan.length) { console.log("Nothing to migrate at this scope."); return; }
    for (const s of plan) console.log(s.action === "convert-format" ? `${s.action.padEnd(14)} ${s.note}` : `${s.action.padEnd(10)} ${s.capabilityId}${s.package ? `  → ${s.package.spec}` : ""}`);
    for (const w of warnings) console.log(`WARNING: ${w}`);
    return;
  }
  let r;
  try { r = applyLegacyLockMigration(dir); } catch (e) { cmdFail(e.code || "legacy-lock", e.message || e); return; }
  if (JSON_MODE) { jsonOk(r); return; }
  for (const m of r.migrated) console.log(`migrated  ${m.capability} → package ${m.package}@${m.version}`);
  for (const c of r.residue) console.log(`residue   ${c}  (kept as a legacy capability lock)`);
  for (const w of r.warnings) console.log(`WARNING: ${w}`);
  if (r.formatConverted) { console.log(`${shortPath(r.file)} was an empty lockfileVersion 1 file — converted to canonical v2 (no residue).`); return; }
  if (r.file) console.log(`${shortPath(r.file)} is now lockfileVersion 2. Config activation (from: installed) is unchanged; re-run \`oas trust\` for executable capabilities — package integrity approvals are not carried over.`);
}

/** oas update <package> — transactional package update with diff + trust reset. */
function updatePackageCmd(id) {
  const dir = dirFlag();
  let r;
  try { r = updatePackage(dir, id); } catch (e) { cmdFail(e.code || "invalid-lock", e.message || e); return; }
  if (JSON_MODE) { jsonOk(r); return; }
  if (!r.changed) { console.log(`${r.package} is already up to date (${r.after.version}, ${r.after.integrity}).`); return; }
  console.log(`Updated ${r.package}: ${r.before.version} (${r.before.commit}) → ${r.after.version} (${r.after.commit})`);
  console.log(`  integrity ${r.before.integrity} → ${r.after.integrity}`);
  if (r.addedCapabilities.length) console.log(`  + capabilities: ${r.addedCapabilities.join(", ")}`);
  if (r.removedCapabilities.length) console.log(`  - capabilities: ${r.removedCapabilities.join(", ")}`);
  for (const w of r.depWarnings || []) console.log(`WARNING: ${w}`);
  if (r.invalidatedApprovals.length) console.log(`  APPROVALS INVALIDATED (integrity changed): ${r.invalidatedApprovals.join(", ")} — re-approve with \`oas trust\` after review.`);
}

// ---------- init ----------
/**
 * oas init [--raw] [--dir <dir>] [--knowledge <id>] [--messaging <id>] [--tasks <id>]
 *
 * Per-layer flags override template defaults (canonical capability ID or "none").
 * Values are validated against known manifests and requires are checked.
 */
/** Resolve a template (name via outer-config `templates:` maps, local path, or git URL's
 * main-branch oas-config.yaml) into snapshot text with a provenance comment. */
function loadTemplateConfig(spec, dir) {
  let source = spec;
  const isDirect = /^(https?:\/\/|git@|ssh:\/\/)/.test(spec) || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("~");
  if (!isDirect) {
    let named;
    for (const cfg of configChain(dir)) {
      if (cfg.templates?.[spec]) { named = { value: cfg.templates[spec], level: cfg._level }; break; }
    }
    if (!named) die(`unknown template "${spec}" — declare it under templates: in an outer oas-config.yaml, or pass a path/git URL`);
    source = /^(https?:\/\/|git@|ssh:\/\/)/.test(named.value) || named.value.startsWith("/") || named.value.startsWith("~")
      ? named.value : resolve(named.level, named.value);
  }
  let body, provenance;
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(source)) {
    const tmp = mkdtempSync(join(tmpdir(), "oas-template-"));
    try {
      execFileSync("git", ["clone", "-q", "--depth", "1", source, tmp], { stdio: "inherit" });
      const cfgFile = join(tmp, "oas-config.yaml");
      if (!existsSync(cfgFile)) die(`template repo has no oas-config.yaml on its default branch: ${source}`);
      body = readFileSync(cfgFile, "utf8");
      const commit = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      provenance = `${source}@${commit.slice(0, 12)}`;
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  } else {
    const path = resolve(source.replace(/^~\//, `${homedir()}/`));
    if (!existsSync(path)) die(`template config not found: ${path}`);
    body = readFileSync(path, "utf8");
    provenance = path;
  }
  // Snapshot: strip template-registry keys that make no sense in the seeded config.
  const lines = body.replace(/\n*$/, "\n").split("\n");
  const out = []; let skipping = false;
  for (const line of lines) {
    if (/^templates:\s*$/.test(line)) { skipping = true; continue; }
    if (skipping) { if (/^\S/.test(line) && line.trim()) skipping = false; else continue; }
    out.push(line.replace(/^name:.*$/, `name: ${basename(dir)}`));
  }
  return `# template: ${provenance} (snapshot — later template edits do not propagate)\n${out.join("\n").replace(/\n*$/, "\n")}`;
}

function init() {
  const raw = args.includes("--raw");
  const dir = dirFlag();
  const file = join(dir, "oas-config.yaml");
  const pkgSrc = flag("package");
  if (existsSync(file)) {
    const msg = `${shortPath(file)} already exists — edit it or use \`oas use\``;
    if (JSON_MODE && pkgSrc) jsonFail("E_CONFIG_EXISTS", msg);
    die(msg);
  }

  if (pkgSrc && pkgSrc !== true) { initPackage(pkgSrc, dir, file); return; }
  if (pkgSrc === true) (JSON_MODE ? jsonFail("E_USAGE", "--package needs a package id, local path, or git URL") : die("--package needs a package id, local path, or git URL"));

  const template = flag("template");
  if (template && template !== true) {
    const text = loadTemplateConfig(template, dir);
    writeFileSync(file, text);
    console.log(`Created ${shortPath(file)} (${levelOf(dir)} level) from template ${template}`);
    restore(dir);
    offerTmuxMouseScrolling();
    return;
  }
  if (template === true) die("--template needs a name, local config path, or git URL");

  // Per-layer overrides: --knowledge oas.okf, --messaging none, --tasks oas.jira …
  const overrides = {};
  const market = marketplaceCapabilities();
  const mans = { ...market, ...capabilityManifests(dir) };
  for (const layer of LAYERS) {
    const v = flag(layer);
    if (v === undefined) continue;
    if (v === true || String(v).startsWith("--")) die(`--${layer} needs a canonical capability ID or "none"`);
    if (v !== "none") {
      if (!mans[v]) die(`unknown capability "${v}" for --${layer} (known: ${Object.keys(mans).join(", ") || "none"})`);
      if (mans[v].layer !== layer) die(`capability "${v}" declares layer "${mans[v].layer || "none"}", not "${layer}"`);
    }
    overrides[layer] = v;
  }

  const defaults = raw
    ? { knowledge: "none", messaging: "none", tasks: "none" }
    : { knowledge: "oas.okf", messaging: "oas.aweb", tasks: undefined };
  let layers = { ...defaults, ...overrides };

  // Interactive TTY with no explicit layer flags: present each default and ask.
  // Non-interactive contexts (agents, CI) keep flags-or-silent-defaults — never hang.
  if (!raw && process.stdin.isTTY && process.stdout.isTTY && !Object.keys(overrides).length) {
    const byLayer = (l) => Object.values(mans).filter((m) => m.layer === l).map((m) => m.capability);
    console.log("Fundamental layers for this scope — Enter keeps the default, or type a capability id / \"none\":");
    const ask = (prompt) => {
      process.stdout.write(prompt);
      const buffer = Buffer.alloc(256);
      let length = 0;
      try { length = readSync(process.stdin.fd, buffer, 0, buffer.length); } catch { /* EOF */ }
      return buffer.subarray(0, length).toString("utf8").trim();
    };
    for (const layer of LAYERS) {
      const options = byLayer(layer);
      const def = layers[layer] || "none";
      while (true) {
        const answer = ask(`  ${layer.padEnd(10)} [${def}]  (options: ${[...options, "none"].join(", ")}): `);
        if (!answer) break;
        if (answer === "none" || options.includes(answer)) { layers[layer] = answer; break; }
        console.log(`    unknown "${answer}" — pick one of: ${[...options, "none"].join(", ")}`);
      }
    }
    if ((layers.messaging || "none") !== "none") console.log("  (messaging via aweb: after init, run `oas aweb setup` for guided onboarding)");
  }
  const lines = [
    `name: ${basename(dir)}`,
    "",
    "# ── Agent types (families) — declared here by name (or via `oas type add`);",
    "# each soul opts in via `type: <name>` in its soul.yaml. Capability entries can target them.",
    "# agent-types:",
    "#   reviewers:",
    "#     description: Agents that review changes",
    "",
    "capabilities:",
    "  # Fundamental layers — exclusive slots; a capability entry or an explicit none.",
    "  layers:",
  ];
  for (const layer of LAYERS) {
    const selected = layers[layer];
    if (!selected) { lines.push(`    # ${layer}: (unset — inherits from outer config scopes; set an entry or "none")`); continue; }
    if (selected === "none") { lines.push(`    ${layer}: none`); continue; }
    let manifest = capabilityManifest(selected, dir);
    // Marketplace capabilities are acquired into this scope's installed/ store first.
    if (!manifest && market[selected]) {
      try {
        const r = acquireCapability(dir, selected);
        try {
          writeCapabilityLock(dir, r.manifest.capability, {
            source: r.source, version: r.manifest.version || null, integrity: r.integrity, trustedExecutables: true,
          });
        } catch (e) { rmSync(r.dest, { recursive: true, force: true }); throw e; }
        console.log(`Acquired ${r.manifest.capability}@${r.manifest.version} from the marketplace → ${shortPath(r.dest)}`);
        // Discovery needs the config file (written below); trust the acquisition result here.
        manifest = { ...r.manifest, _origin: `installed:${dir}` };
      } catch (e) { die(`could not acquire ${selected}: ${e.message}`); }
    }
    if (!manifest) die(`capability "${selected}" is not acquired at ${shortPath(dir)} and is not in the marketplace (${Object.keys(market).join(", ") || "empty"})`);
    lines.push(`    ${layer}:`);
    lines.push(`      capability: ${manifest.capability}`);
    if (String(manifest._origin).startsWith("installed:")) { lines.push("      from: installed"); lines.push(`      # injection-override: .agents/injections/capabilities/${manifest.capability}.md`); }
    else if (String(manifest._origin).startsWith("owned:")) { lines.push("      from: owned"); lines.push(`      # injection edited at source: .agents/capabilities/owned/${manifest.capability}/injects/`); }
  }
  lines.push(
    "  # Additive capabilities — non-exclusive; target global, agent-types, or souls.",
    "  # additive:",
    "  #   <capability-id>:",
    "  #     from: installed",
    "  #     global: true",
    "  #     # injection-override: .agents/injections/capabilities/<capability-id>.md",
    "",
    "# ── Work modes — optional per-mode env bootstrap.",
    "# `setup:` runs inside each NEW worktree right after `git worktree add` — use it",
    "# for env setup scripts (installs, .env copying, direnv, mise, etc.).",
    "# The path is relative to this config's directory.",
    "work-modes:",
    "  worktree:",
    "    # setup: scripts/setup-worktree.sh",
    "",
    "# ── OAS defaults — the framework's baseline instruction block.",
    "oas:",
    "  # injection-override: .agents/injections/oas-defaults/oas.md",
  );
  writeFileSync(file, lines.join("\n") + "\n");
  console.log(`Created ${shortPath(file)} (${levelOf(dir)} level${raw ? ", raw" : ""})`);

  const r = resolveOasConfig(dir);
  for (const cap of r.capabilities) {
    console.log(`Activated: ${cap.id}${cap.layer ? ` → ${cap.layer}` : ""}`);
    for (const miss of cap.missingRequires) console.log(`WARNING: required command "${miss.command}" not on PATH — ${miss.why || ""}${miss.install ? ` (install: ${miss.install})` : ""}`);
  }
  offerTmuxMouseScrolling();
}

// ---------- roster: status / spawn / retire / create ----------
function status() {
  if (args.includes("--team")) return statusTeam();
  const root = ensureRoot(flag("dir") || process.cwd());
  const data = listInstances(root);
  if (args.includes("--json")) { console.log(JSON.stringify({ root, agents: data }, null, 2)); return; }
  console.log(`oas status — agents root ${shortPath(root)}\n`);
  if (data.length === 0) { console.log("  (no agents — create one with `oas create <name>`)"); return; }
  for (const a of data) {
    console.log(`  ${a.name}${a.kind === "local" ? " (local)" : ""}  [work: ${a.work || "checkout"}, repo: ${a.repo || "?"}]`);
    if (a.description) console.log(`      ${a.description}`);
    for (const i of a.instances) {
      console.log(`      • ${i.instance}  ${i.running ? "RUNNING" : "idle"}  (branch ${i.branch || "?"}, ${i.work || "?"})`);
    }
  }
  const defs = listAgentDefs(process.cwd());
  if (defs.length) console.log(`\n  importable defs: ${defs.map((d) => d.name).join(", ")}`);
}

function statusTeam() {
  const ctx = dirFlag();
  const r = resolveOasConfig(ctx);
  if (!r.team) die(`no team declared in the config chain from ${shortPath(ctx)} — add a "team:" block (name, optional id) at the deployment scope`);
  const roots = teamAgentRoots(r.team.scope);
  const payload = { team: r.team, roots: [] };
  for (const root of roots) payload.roots.push({ root, agents: listInstances(root) });
  if (args.includes("--json")) { console.log(JSON.stringify(payload, null, 2)); return; }
  console.log(`oas status — team ${r.team.name}${r.team.id ? ` (${r.team.id})` : ""}  [scope: ${shortPath(r.team.scope)}]\n`);
  if (!roots.length) { console.log("  (no agents/ directories in the team scope)"); return; }
  for (const { root, agents } of payload.roots) {
    console.log(`  ${shortPath(root)}`);
    if (!agents.length) { console.log("    (no agents)"); continue; }
    for (const a of agents) {
      console.log(`    ${a.name}${a.kind === "local" ? " (local)" : ""}${a.description ? `  — ${a.description}` : ""}`);
      for (const i of a.instances) console.log(`      • ${i.instance}  ${i.running ? "RUNNING" : "idle"}`);
    }
  }
}

function spawnCmd() {
  // JSON mode: contract envelope, stable error codes, stderr-only progress.
  const bail = (code, msg) => (JSON_MODE ? jsonFail(code, msg) : die(msg));
  const note = (msg) => (JSON_MODE ? console.error(msg) : console.log(msg));
  const name = args[1];
  if (!name || name.startsWith("--")) bail("E_USAGE", "usage: oas spawn <agent> [--task <text>|--task-file <f>] [--purpose <slug>] [--relation child|sibling|parent|unrelated --relative-to <instance> [--relative-root <agents-root>]] [--parent <instance>] [--repo <r>] [--work worktree|checkout|attached|workspace] [--work-dir <owner-work>] [--runtime pi|claude] [--model <m>] [--branch <b>] [--instructions-file <f>|--def-file <f>] [--no-launch] [--json]");
  let root;
  try { root = ensureRoot(flag("dir") || process.cwd()); }
  catch (e) { bail("E_NO_DEPLOYMENT", e.message || e); throw e; }
  let agent = findAgent(root, name);
  const instrFile = flag("instructions-file");
  const defFile = flag("def-file");
  if (!agent && !instrFile && !defFile) {
    // Capability-defined agent: a package's `agents:` soul, active in this context.
    const capAgent = findCapabilityAgent(flag("dir") || process.cwd(), root, name);
    if (capAgent) {
      agent = capAgent;
      note(`(capability agent: "${name}" from ${capAgent.capability} — fresh soul, instances home locally)`);
    }
  }
  if (!agent && !instrFile && !defFile) {
    // Cross-repo lookup: the soul may live in a sibling repo of the team scope.
    // Unique match wins; the instance homes with its owning repo's agents root.
    const teamHit = findTeamAgent(flag("dir") || process.cwd(), name);
    const remote = (teamHit?.matches || []).filter((m) => resolve(m.root) !== resolve(root));
    if (remote.length > 1) bail("E_AMBIGUOUS_SOUL", `soul "${name}" found in multiple team repos: ${remote.map((m) => shortPath(m.root)).join(", ")} — re-run with --dir <that repo>`);
    if (remote.length === 1) {
      root = remote[0].root;
      agent = remote[0].agent;
      note(`(cross-repo: soul "${name}" found at ${shortPath(root)} — instance homes there)`);
    }
  }
  // local agents: create/update from raw instructions or a single-file def
  if (instrFile || defFile || !agent) {
    if (!agent && !instrFile && !defFile) {
      const def = listAgentDefs(process.cwd()).find((d) => d.name === name);
      if (!def) bail("E_UNKNOWN_AGENT", `unknown agent "${name}" (known: ${listAgents(root).map((a) => a.name).join(", ") || "none"}; importable defs: ${listAgentDefs(process.cwd()).map((d) => d.name).join(", ") || "none"}) — pass --instructions-file or --def-file to create a local agent`);
      agent = upsertLocalAgent(root, { name: def.name, file: def.path, repo: flag("repo"), work: flag("work"), runtime: flag("runtime"), model: flag("model") });
    } else if (!agent || agent.kind === "local") {
      agent = upsertLocalAgent(root, {
        name, file: defFile, instructions: instrFile ? readFileSync(instrFile, "utf8") : undefined,
        repo: flag("repo"), work: flag("work"), runtime: flag("runtime"), model: flag("model"),
      });
    } else {
      bail("E_BAD_ARGS", `"${name}" is a persistent agent — spawn it without --instructions-file/--def-file`);
    }
  }
  // Lineage is explicit: --relation child|sibling|parent|unrelated anchors the new
  // instance to --relative-to <instance>. --parent X is sugar for
  // --relative-to X --relation child (agents spawning sub-agents pass their own
  // name, e.g. --parent "$OAS_INSTANCE"). Without a relation, the spawn is
  // operator-origin and lands top-level — ambient env vars in the shell are
  // never treated as parentage.
  const parent = flag("parent");
  if (parent !== undefined && (parent === true || !String(parent).trim())) bail("E_BAD_ARGS", "--parent needs an instance name");
  let relation = flag("relation");
  if (relation !== undefined && (relation === true || !String(relation).trim())) bail("E_BAD_ARGS", "--relation needs a value: child|sibling|parent|unrelated");
  if (relation && !RELATIONS.includes(relation)) bail("E_BAD_ARGS", `unknown --relation "${relation}" (child|sibling|parent|unrelated)`);
  let relativeTo = flag("relative-to");
  if (relativeTo !== undefined && (relativeTo === true || !String(relativeTo).trim())) bail("E_BAD_ARGS", "--relative-to needs an instance name");
  if (relation && relation !== "unrelated" && !relativeTo) bail("E_BAD_ARGS", `--relation ${relation} requires --relative-to <instance>`);
  if (relativeTo && !relation) bail("E_BAD_ARGS", "--relative-to requires --relation child|sibling|parent");
  if (relation === "unrelated" && relativeTo) bail("E_BAD_ARGS", "--relation unrelated takes no --relative-to");
  if (parent && (relation || relativeTo)) bail("E_BAD_ARGS", "--parent is sugar for --relative-to <instance> --relation child — use one form, not both");
  if (parent) { relation = "child"; relativeTo = parent; }
  // Attached agents are ALWAYS children (design decision): the only relation
  // flags allowed are the child form — required when the workDir is not an
  // instance's own <home>/work (integration worktrees). The kernel verifies
  // ownership canonically (including soul-default attached mode).
  if ((flag("work") === "attached") && relation && relation !== "child") bail("E_BAD_ARGS", "attached agents are always children of the work-tree owner — only --parent <instance> (or --relation child) is valid with --work attached");
  // NOTE: explicit "unrelated" is passed through to the kernel.
  if (relativeTo && relation !== "unrelated") {
    // findInstanceHome also sees capability-defined agents' instance homes
    // (local-agents/<name>/ without a local soul) — e.g. a reviewer passing
    // --parent "$OAS_INSTANCE" from a capability agent.
    if (!findInstanceHome(root, relativeTo) && !findTeamInstance(flag("dir") || process.cwd(), relativeTo)) bail(parent ? "E_PARENT_NOT_FOUND" : "E_RELATIVE_NOT_FOUND", `${parent ? "--parent" : "--relative-to"} "${relativeTo}" does not match any known instance`);
  }
  const taskText = flag("task");
  if (taskText === true) bail("E_BAD_ARGS", "--task needs a value (use --task-file for long tasks)");
  const taskFileFlag = flag("task-file");
  if (taskFileFlag === true) bail("E_BAD_ARGS", "--task-file needs a path");
  if (taskFileFlag && !existsSync(taskFileFlag)) bail("E_BAD_ARGS", `--task-file not found: ${taskFileFlag}`);
  const relativeRoot = flag("relative-root");
  if (relativeRoot !== undefined && (relativeRoot === true || !String(relativeRoot).trim())) bail("E_BAD_ARGS", "--relative-root needs an agents-root path");
  if (relativeRoot && !relativeTo) bail("E_BAD_ARGS", "--relative-root only qualifies --relative-to/--parent");
  // Retired boundary flags (maintainer transport ruling): fail LOUDLY before
  // any side effect — an old consumer must not appear to succeed with
  // different semantics (silent name/ephemerality divergence).
  if (args.includes("--instance")) bail("E_BAD_ARGS", "--instance was removed by the runtime-boundary ruling — use --purpose <slug> (deterministic <agent>-<purpose> naming)");
  if (args.includes("--ephemeral")) bail("E_BAD_ARGS", "--ephemeral was removed by the runtime-boundary ruling — declare the agent in a capability manifest (agents:) for automatic ephemeral semantics");
  let r;
  try {
    r = spawnInstance(root, agent, {
      purpose: flag("purpose"), task: taskText, taskFile: taskFileFlag, relation, relativeTo, relativeRoot,
      repo: flag("repo") || agent.repo || defaultRepo(workspaceOf(root)) || defaultRepo(process.cwd()),
      work: flag("work"), workDir: flag("work-dir"), runtime: flag("runtime"), model: flag("model"), branch: flag("branch"),
      launch: !args.includes("--no-launch"),
    });
  } catch (e) { bail(e.code === "E_RELATIVE_AMBIGUOUS" ? "E_RELATIVE_AMBIGUOUS" : "E_SPAWN_FAILED", e.message || e); throw e; }
  if (JSON_MODE) {
    // Desktop CLI API v1 spawn result — a FIXED shape (see docs/desktop-cli-api.md).
    jsonOk({
      instance: r.instance, agent: r.agent, home: r.home, work: r.work,
      branch: r.branch || null, launched: r.launched, warnings: r.warnings || [],
      tmux: r.tmux || null, repo: r.repo || null, runtime: r.runtime || null,
      model: r.model || null, parent: r.parentInstance || null,
      sibling: r.siblingInstance || null, relation: r.relation || null,
      spawnOrigin: r.spawnOrigin, attach: r.attach,
    });
    return;
  }
  console.log(`Spawned ${r.instance} (${r.work}${r.branch ? `, branch ${r.branch}` : ""})${r.launched ? ` — tmux window "${r.tmux.window}"` : " — not launched"}`);
  console.log(`  home:   ${shortPath(r.home)}`);
  if (!r.launched) console.log(`  launch: (cd ${shortPath(r.home)} && ${r.command})`);
  for (const w of r.warnings || []) console.log(`  WARNING: ${w}`);
  console.log(`  attach: ${r.attach}`);
}

function retireCmd() {
  const name = args[1];
  if (!name || name.startsWith("--")) die("usage: oas retire <instance> [--self] [--delete-branch] [--keep-dir] [--json]");
  const isSelf = process.env.PI_AGENT_INSTANCE === name || process.env.OAS_INSTANCE === name;
  if (isSelf && !args.includes("--self")) die(`"${name}" is the calling instance — self-retire is irreversible; if your task is complete and you were told to retire, re-run with --self (finish your memory files FIRST; your session dies ~8s after)`);
  if (!isSelf && args.includes("--self")) die(`--self given but "${name}" is not the calling instance`);
  let root = ensureRoot(flag("dir") || process.cwd());
  // Cross-repo: the instance may home in a sibling repo of the team scope.
  if (!listAgents(root).some((a) => existsSync(join(a._dir, "instances", name)))) {
    const hit = findTeamInstance(flag("dir") || process.cwd(), name);
    if (hit && resolve(hit.root) !== resolve(root)) { root = hit.root; console.log(`(cross-repo: instance homes at ${shortPath(root)})`); }
  }
  const r = retireInstance(root, name, { self: isSelf, deleteBranch: args.includes("--delete-branch"), keepDir: args.includes("--keep-dir") });
  if (args.includes("--json")) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`Retired ${r.retired} (agent ${r.agent})${r.worktreeRemoved ? ", worktree removed" : ""}${r.branchDeleted ? ", branch deleted" : ""}${r.harvested?.length ? `, harvested: ${r.harvested.join(", ")}` : ""}`);
  if (isSelf) console.log("This window dies in ~8s — say any goodbyes now.");
}

async function paneCmd() {
  die("`oas pane` has been retired — the OAS Desktop app (packages/desktop) is the control panel now.");
}

function createCmd() {
  const name = args[1];
  if (!name || name.startsWith("--")) die("usage: oas create <name> [--local] [--description <d>] [--type <agent-type>] [--repo <r>] [--work worktree|checkout|attached|workspace] [--runtime pi|claude] [--model <m>] [--instructions-file <f>]");
  const local = args.includes("--local");
  const startDir = flag("dir") || process.cwd();
  // --local can BOOTSTRAP a deployment: with no agents/ or local-agents/ yet,
  // anchor at the enclosing git repo (else the start dir) — people can use OAS
  // with local agents alone.
  let root = findRoot(startDir);
  if (!root) {
    if (!local) root = ensureRoot(startDir); // keeps the pointed error for committed souls
    else root = join(defaultRepo(startDir) || resolve(startDir), "agents");
  }
  const instrFile = flag("instructions-file");
  const r = coreCreateAgent(root, {
    name, local, description: flag("description"), type: flag("type"), repo: flag("repo") || defaultRepo(process.cwd()),
    work: flag("work"), runtime: flag("runtime"), model: flag("model"),
    instructions: instrFile ? readFileSync(instrFile, "utf8") : undefined,
  });
  if (args.includes("--json")) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`Created ${r.kind === "local" ? "LOCAL agent (uncommitted — soul lives in local-agents/, gitignored)" : "agent"} "${r.agent}" — soul at ${shortPath(r.soul)}`);
  console.log(`Edit ${shortPath(join(r.soul, "AGENTS.md"))} to define its role, then: oas spawn ${r.agent} --task "..."`);
}

// ---------- capability command dispatch ----------
/**
 * oas <namespace> <command> [args…] — run a command an active capability
 * declares in its manifest (`commands: { name: "script args" }`).
 * Kernel subcommands take precedence over capability namespaces.
 */
function capabilityCommand() {
  // JSON-aware boundary: in --json mode every dispatch failure — inactive or
  // untrusted capability, duplicate namespace, unknown subcommand, broken
  // metadata/manifests, malformed command values — must still emit exactly
  // one envelope object on stdout. The WHOLE dispatcher runs inside the
  // boundary; only "no namespace matched" escapes (returns false to the help
  // fallthrough).
  const bail = (code, msg) => (JSON_MODE ? jsonFail(code, msg) : die(msg));
  const NOT_DISPATCHED = Symbol("not-dispatched");
  let outcome;
  try { outcome = dispatch(); }
  catch (e) {
    // Unexpected throw from discovery/trust/decoding: keep the envelope contract.
    bail("E_CAPABILITY_BROKEN", e.message || e);
    throw e;
  }
  return outcome !== NOT_DISPATCHED;

  function dispatch() {
    let activeIds;
    let context = process.cwd();
    let teamCtx;
    const instanceHome = process.env.PI_AGENT_HOME || process.env.OAS_HOME;
    const metaFile = instanceHome && join(instanceHome, "instance.json");
    let capSettings = {};
    try {
      if (metaFile && existsSync(metaFile)) {
        const meta = JSON.parse(readFileSync(metaFile, "utf8"));
        activeIds = (meta.capabilities || []).map((c) => c.id);
        for (const c of meta.capabilities || []) capSettings[c.id] = c.settings || {};
        context = meta.repo || context;
        // Team: the spawn-time snapshot, but fall back to live config — instances
        // spawned before a team: block was declared have no snapshot.
        teamCtx = meta.team || resolveOasConfig(context).team;
      } else {
        const resolved = resolveOasConfig(context, flag("soul"));
        activeIds = resolved.capabilities.map((c) => c.id);
        for (const c of resolved.capabilities) capSettings[c.id] = c.settings || {};
        teamCtx = resolved.team;
      }
    } catch (e) { bail("E_CONFIG_BROKEN", e.message || e); throw e; }
    const mans = Object.values(capabilityManifests(context)).filter((m) => m.command === cmd && m.commands);
    if (!mans.length) return NOT_DISPATCHED;
    if (mans.length > 1) bail("E_DUPLICATE_NAMESPACE", `duplicate operational command namespace "${cmd}": ${mans.map((m) => m.capability).join(", ")}`);
    const m = mans[0];
    if (!activeIds.includes(m.capability)) bail("E_CAPABILITY_INACTIVE", `${m.capability} command namespace is not active in the current context/instance`);
    const trust = capabilityTrust(m, context);
    if (!trust.trusted) bail("E_CAPABILITY_BLOCKED", `${m.capability} executable command is blocked: ${trust.reason}`);
    const sub = args[1];
    const cmds = Object.keys(m.commands);
    // Distinguish an ABSENT key from a declared-but-invalid value: a manifest
    // entry of "" / 0 / false / null is a broken capability, not an unknown
    // command (it is listed in cmds).
    if (!sub || !Object.prototype.hasOwnProperty.call(m.commands, sub)) {
      if (JSON_MODE) jsonFail("E_UNKNOWN_COMMAND", `oas ${cmd}: ${sub ? `unknown command "${sub}"` : "missing command"} — commands: ${cmds.join(", ") || "(none)"}`);
      console.error(`oas ${cmd} — commands: ${cmds.join(", ") || "(none)"}`);
      process.exit(sub ? 1 : 0);
    }
    // Command values come from third-party manifests — validate before decoding.
    const spec = m.commands[sub];
    if (typeof spec !== "string" || !spec.trim()) bail("E_CAPABILITY_BROKEN", `oas ${cmd} ${sub}: manifest command must be a non-empty string (got ${JSON.stringify(spec)})`);
    const [script, ...rest] = spec.trim().split(/\s+/);
    let abs;
    try { abs = capabilityExecutablePath(m, script); }
    catch (e) { bail("E_CAPABILITY_BROKEN", e.message); }
    if (!abs) bail("E_CAPABILITY_BROKEN", `${cmd} ${sub}: script not found (${join(m._dir, script)})`);
    const r = spawnSync("node", [abs, ...rest, ...args.slice(2)], { stdio: "inherit", env: {
      ...process.env, OAS_CAPABILITY: m.capability,
      // Package-runtime boundary: dispatched commands receive the active
      // capability's EFFECTIVE settings (instance snapshot or resolved context),
      // same contract as lifecycle hooks — capabilities read their settings
      // here instead of importing the kernel resolver.
      OAS_SETTINGS: JSON.stringify(capSettings[m.capability] || {}),
      // PATH is not a trusted runtime boundary (maintainer finding 1): pass the
      // canonical absolute executable of THIS CLI; official consumers execFile
      // it directly and never resolve `oas` from PATH or a shell.
      OAS_CLI_BIN: CLI_BIN,
      OAS_TEAM_NAME: teamCtx?.name || "", OAS_TEAM_ID: teamCtx?.id || "", OAS_TEAM_SCOPE: teamCtx?.scope || "",
    } });
    // Child never ran (spawn error): nothing reached stdout — keep the envelope contract.
    if (r.error) bail("E_CAPABILITY_BROKEN", `oas ${cmd} ${sub}: ${r.error.message || r.error}`);
    process.exit(r.status ?? 1);
  }
}

// ---------- agent types ----------
function typeCmd() {
  const sub = args[1];
  const dir = dirFlag();
  const file = join(dir, "oas-config.yaml");
  if (sub === "list") {
    const seen = new Map();
    for (const cfg of configChain(dir)) for (const [name, spec] of Object.entries(cfg["agent-types"] || {})) if (!seen.has(name)) seen.set(name, { desc: spec?.description, level: cfg._level });
    if (!seen.size) { console.log("No agent types declared in the config chain."); return; }
    for (const [name, { desc, level }] of seen) console.log(`${name}  ${desc ? `— ${desc}  ` : ""}[${shortPath(level)}]`);
    return;
  }
  if (sub !== "add" || !args[2] || args[2].startsWith("--")) die("usage: oas type add <name> [--description <d>] [--dir <dir>] | oas type list [--dir <dir>]");
  const name = args[2];
  if (!/^[a-z][a-z0-9-]*$/.test(name)) die(`agent type "${name}" must be lowercase alphanumeric/hyphens`);
  const description = flag("description");
  let text = existsSync(file) ? readFileSync(file, "utf8") : `name: ${basename(dir)}\n`;
  const cfg = existsSync(file) ? parseYamlNested(text) : {};
  if (cfg["agent-types"]?.[name]) die(`agent type "${name}" already declared in ${shortPath(file)}`);
  const block = [`  ${name}:`, ...(description ? [`    description: ${description}`] : [])];
  const lines = text.replace(/\n*$/, "\n").split("\n");
  // Drop the scaffold comment block once a real agent-types block exists.
  const scaffold = lines.findIndex((l) => /^# ── Agent types/.test(l));
  if (scaffold >= 0) {
    let e = scaffold;
    while (e < lines.length && (/^#/.test(lines[e]) || lines[e] === "")) { if (lines[e] === "" && !/^#/.test(lines[e + 1] || "x")) break; e++; }
    lines.splice(scaffold, e - scaffold);
  }
  const start = lines.findIndex((l) => /^agent-types:\s*(#.*)?$/.test(l));
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && (/^\s/.test(lines[end]) || lines[end] === "")) { if (lines[end] === "" && !/^\s/.test(lines[end + 1] || "x")) break; end++; }
    lines.splice(end, 0, ...block);
  } else {
    lines.splice(1, 0, "", "agent-types:", ...block);
  }
  writeFileSync(file, lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n"));
  console.log(`Declared agent type "${name}" at ${levelOf(dir)} level (${shortPath(file)})`);
  console.log(`Souls join it with: oas create <agent> --type ${name} (or type: ${name} in soul.yaml)`);
}

// ---------- injection eject ----------
function injectCmd() {
  const sub = args[1];
  const target = args[2];
  if (sub !== "eject" || !target || target.startsWith("--")) die("usage: oas inject eject <capability-id|oas> [--dir <dir>]");
  const dir = dirFlag();
  const file = join(dir, "oas-config.yaml");
  if (!existsSync(file)) die(`no oas-config.yaml at ${shortPath(dir)} — run oas init first`);
  if (["checkout", "worktree", "attached", "workspace"].includes(target)) die("work-mode injection overrides were removed — the packaged briefings are the contract; work modes support only setup: (env bootstrap script)");
  const isWorkMode = false;
  const isKernel = target === "oas";
  const src = isKernel ? packagedInject("oas", dir) : isWorkMode ? packagedInject(`work-${target}`, dir) : packagedInject(target, dir);
  if (!src) die(`no packaged default injection found for "${target}"`);
  const rel = isKernel ? ".agents/injections/oas-defaults/oas.md" : isWorkMode ? `.agents/injections/workmodes/${target}.md` : `.agents/injections/capabilities/${target}.md`;
  const destAbs = join(dir, rel);
  if (existsSync(destAbs)) die(`${shortPath(destAbs)} already exists — edit it directly (it is already your override)`);
  let text = readFileSync(file, "utf8");
  if (!isWorkMode && !isKernel) {
    const caps = readCapabilitiesModel(file);
    const entry = Object.values(caps.layers).find((e) => e && e !== "none" && e.capability === target) || caps.additive[target];
    if (!entry) die(`capability "${target}" has no entry in ${shortPath(file)} — activate it first (oas use ${target})`);
    const m = capabilityManifest(target, dir);
    const owned = entry.from === "owned" || String(entry.from || "").startsWith("path:") || String(m?._origin || "").startsWith("owned:") || String(m?._origin || "").startsWith("path:");
    if (owned) die(`"${target}" is owned/path-sourced — you own its source; edit its injects/ file directly instead of ejecting`);
    entry["injection-override"] = rel;
    text = replaceCapabilitiesBlock(text, caps);
  } else {
    const lines = text.replace(/\n*$/, "\n").split("\n");
    const headRe = isKernel ? /^oas:\s*(#.*)?$/ : /^work-modes:\s*(#.*)?$/;
    let idx = lines.findIndex((l) => headRe.test(l));
    if (idx < 0) { lines.push("", isKernel ? "oas:" : "work-modes:"); idx = lines.length - 1; }
    if (isKernel) {
      lines.splice(idx + 1, 0, `  injection-override: ${rel}`);
      const c = lines.findIndex((l, i2) => i2 > idx + 1 && l.trim() === `# injection-override: ${rel}`);
      if (c >= 0) lines.splice(c, 1);
    } else {
      let mIdx = lines.findIndex((l, i2) => i2 > idx && new RegExp(`^  ${target}:`).test(l));
      if (mIdx < 0) { lines.splice(idx + 1, 0, `  ${target}:`, `    injection-override: ${rel}`); }
      else {
        lines.splice(mIdx + 1, 0, `    injection-override: ${rel}`);
        const c = lines.findIndex((l, i2) => i2 > mIdx + 1 && l.trim() === `# injection-override: ${rel}`);
        if (c >= 0) lines.splice(c, 1);
      }
    }
    text = lines.join("\n").replace(/\n*$/, "\n");
  }
  mkdirSync(dirname(destAbs), { recursive: true });
  writeFileSync(destAbs, readFileSync(src, "utf8"));
  writeFileSync(file, text);
  console.log(`Ejected packaged injection → ${shortPath(destAbs)}`);
  console.log(`Set injection-override in ${shortPath(file)}. Edit the ejected file; it no longer tracks package updates.`);
}

// ---------- update ----------
function updateCmd() {
  const checkOnly = args.includes("--check");
  let latest;
  try { latest = execFileSync("npm", ["view", "@oas-framework/oas", "version"], { encoding: "utf8", timeout: 30000 }).trim(); }
  catch (e) { die(`cannot check npm for the latest version: ${e.message}`); }
  console.log(`@oas-framework/oas  installed: ${OAS_VERSION}  latest: ${latest}`);
  // pi bridge, if a pi installation carries it.
  let piBridge;
  const piPkg = join(homedir(), ".pi", "agent", "npm", "node_modules", "@oas-framework", "pi", "package.json");
  if (existsSync(piPkg)) piBridge = JSON.parse(readFileSync(piPkg, "utf8")).version;
  if (piBridge) console.log(`@oas-framework/pi   installed: ${piBridge}  latest: ${latest} (published in lockstep)`);
  if (latest === OAS_VERSION && (!piBridge || piBridge === latest)) { console.log("Up to date."); return; }
  const steps = [];
  if (latest !== OAS_VERSION) steps.push(`npm install -g @oas-framework/oas@${latest}`);
  if (piBridge && piBridge !== latest) steps.push(`pi uninstall npm:@oas-framework/pi@${piBridge}`, `pi install npm:@oas-framework/pi@${latest}`);
  console.log("\nUpdate steps:");
  for (const s of steps) console.log(`  ${s}`);
  if (checkOnly) { console.log("\n(--check: not executing)"); return; }
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (interactive) {
    process.stdout.write("\nRun these now? [y/N] ");
    const buf = Buffer.alloc(16);
    let answer = "";
    try { answer = buf.toString("utf8", 0, readSync(0, buf, 0, 16)).trim().toLowerCase(); } catch { /* no input */ }
    if (answer !== "y" && answer !== "yes") { console.log("Not updating."); return; }
  } else if (!args.includes("--yes")) {
    console.log("\nNon-interactive: pass --yes to execute, or run the steps yourself.");
    return;
  }
  for (const s of steps) {
    console.log(`\n$ ${s}`);
    const [bin, ...rest] = s.split(/\s+/);
    const r = spawnSync(bin, rest, { stdio: "inherit" });
    if (r.status !== 0) die(`step failed: ${s}`);
  }
  console.log(`\nUpdated to ${latest}. Now verify each deployment: run \`oas doctor\` at your workspace/repo scopes — it reports config spellings this version rejects, version skew, and missing requirements. Restart running pi sessions to pick up the new bridge.`);
}

// ---------- version (Desktop CLI API v1 probe) ----------
function versionCmd() {
  if (JSON_MODE) {
    // EXACT Desktop API v1 probe payload — one JSON object, nothing else on
    // stdout. Desktop accepts desktopApi === 1 and a compatible semver range.
    console.log(JSON.stringify({ schemaVersion: 1, name: "@oas-framework/oas", version: OAS_VERSION, desktopApi: 1 }));
    return;
  }
  console.log(`@oas-framework/oas ${OAS_VERSION} (desktop API v1)`);
}

// ---------- main ----------
if (cmd === "doctor") {
  const doctorDir = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  args.includes("--json") ? doctorJson(doctorDir) : doctor(doctorDir);
}
else if (cmd === "use") use();
else if (cmd === "update") { const t = args[1] && !args[1].startsWith("--") ? args[1] : undefined; t ? updatePackageCmd(t) : updateCmd(); }
else if (cmd === "type") typeCmd();
else if (cmd === "inject") injectCmd();
else if (cmd === "install") install();
else if (cmd === "config") configDiffCmd();
else if (cmd === "trust") trust();
else if (cmd === "list") listCmd();
else if (cmd === "remove") removeCmd();
else if (cmd === "migrate") migrateCmd();
else if (cmd === "root") console.log(resolve(new URL("..", import.meta.url).pathname));
else if (cmd === "init") init();
else if (cmd === "status") status();
else if (cmd === "pane") await paneCmd();
else if (cmd === "version" || cmd === "--version" || cmd === "-v") versionCmd();
else if (cmd === "spawn") { try { spawnCmd(); } catch (e) { if (JSON_MODE) jsonFail("E_SPAWN_FAILED", e.message || e); throw e; } }
else if (cmd === "retire") retireCmd();
else if (cmd === "create") createCmd();
else if (cmd && !cmd.startsWith("--") && capabilityCommand()) { /* dispatched */ }
// No matching kernel command or capability namespace: in --json mode the help
// text must NOT contaminate stdout — still one envelope object, nonzero exit.
else if (cmd && !cmd.startsWith("--") && JSON_MODE) jsonFail("E_UNKNOWN_COMMAND", `unknown command "${cmd}" — no kernel subcommand or active capability namespace matches`);
else {
  console.log(`oas — Open Agent Specialization

Usage:
  oas version [--json]                      kernel version; --json emits the
                                            Desktop CLI API v1 probe payload
  oas status [--json]                       agents, souls, running instances
  oas status --team [--json]                whole-team roster across the team scope's repos
  oas create <name> [--local]               create an agent soul; --local = full
      [--description <d>] [--repo <r>]      soul under local-agents/ (uncommitted,
      [--work <mode>] [--runtime pi|claude] gitignored; same memory + lifecycle)
      [--model <m>] [--instructions-file <f>]
  oas spawn <agent> [--task <text>]         spawn an instance (tmux; --no-launch
      [--purpose <slug>] [--repo <r>]       = scaffold only); --instructions-file/
      [--parent <instance>]                 --def-file creates a local agent;
      [--relation child|sibling|parent|unrelated]    --relation + --relative-to anchor the
      [--relative-to <instance>]            new instance to an existing one; --parent X
      [--relative-root <agents-root>]       disambiguates same-named team anchors
      [--work worktree|checkout|attached|workspace]  = sugar for --relative-to X --relation
      [--work-dir <owner-work>] [--runtime pi|claude] [--model <m>] [--branch <b>]  child (default: unrelated, top-level)
      [--instructions-file <f>|--def-file <f>] [--no-launch] [--json]
                                            with team: declared, unknown local souls
                                            resolve across the team scope's repos
  oas retire <instance>                     retire an instance (window, hooks,
      [--self] [--delete-branch]            worktree, home); --self = retire the
      [--keep-dir] [--json]                 CALLING instance (delayed window kill)
  oas doctor [dir] [--soul <name>] [--json] resolved targets, trust, requirements;
                                            --soul shows final composed AGENTS.md
  oas update [--check] [--yes]              check npm for a newer kernel+pi bridge and
                                            optionally run the update; then run oas doctor
  oas install [<source>] [--dir <d>]        acquire + exact-lock a package closure
                                            (git:host/org/repo@ref, git URL, local
                                            path, official catalog id) or a legacy
                                            marketplace capability; never activates
      [--recursive] [--no-requirements]     bare \`oas install\` exactly restores this
      [--accept-requirement <cmd> ...]      chain's locked packages + capabilities; at a
      [--json]                              team: scope (or with --recursive) it reconciles
                                            the whole workspace — descendant scopes restore
                                            once in path order (pruned discovery), then the
                                            host-requirement consent gate runs;
                                            --no-requirements = package-only (CI);
                                            non-interactive runs never install host tools
                                            unless each requirement is named explicitly;
                                            --json = one envelope (failures carry the full
                                            report under error.details)
  oas list [--dir <d>] [--json]             installed packages, exported capabilities,
                                            scopes, trust state
  oas update <package> [--dir <d>]          transactional package update: temp fetch,
                                            closure validation, diff, lock replace,
                                            all capability approvals invalidated
  oas remove <package> [--dir <d>]          remove a package (refuses while config or
                                            dependent packages reference it)
  oas migrate [--dry-run] [--dir <d>]       map this scope's v1 capability locks to
                                            package locks (preserves config activation)
  oas config diff [--package <id|url|path>] report how the local snapshot differs from the
      [--config <name>] [--dir <d>] [--json] package's current profile — never merges/overwrites;
                                            an adopted snapshot's provenance header supplies
                                            --package/--config defaults; --json emits one
                                            envelope (differingLines 0 = no drift)
  oas trust <capability> [--dir <dir>]      approve that capability's commands/hooks at
                                            the provider package's exact integrity
  oas trust <package> --all-capabilities    explicit bulk approval with a full
                                            executable-surface summary
  oas use <capability>                      activate for one config-owned target
      [--global|--type <t>|--soul <s>]      (--global is default); --disable excludes
      [--disable] [--settings k=v [k2=v2 ...]] [--dir <d>]
  oas use none --layer <layer>              explicitly disable a fundamental layer
  oas type add <name> [--description <d>]   declare an agent type (family) in config;
  oas type list                             souls join via create --type / soul.yaml
  oas inject eject <cap|work-mode|oas>      copy a packaged injection to the conventional
      [--dir <d>]                           .agents/injections/ path and set injection-override
  oas init [--raw] [--dir <dir>]            create an oas-config.yaml here
      [--package <id|path|git-url>]         adopt a package config profile as a local
      [--config <name>] [--json]            snapshot (default profile unless --config;
      [--template <name|path|git-url>]      refuses to overwrite an existing config;
      [--knowledge <id|none>]               --json = one result envelope, noninteractive);
      [--messaging <id|none>]               or seed from a template config (named via
      [--tasks <id|none>]                   outer templates: map, a local file, or a
      [--tmux-mouse|--no-tmux-mouse]        git repo's default-branch oas-config.yaml)
  oas root                                  print this package's install root
                                            (adapters resolve the kernel from it)
  oas <namespace> <command> [args…]         run an operational command only when its
                                            capability is active (e.g. oas okf harvest)

Layers: ${LAYERS.join(", ")}. Level detection: ~ → laptop, .git → repo, else workspace.`);
  process.exit(cmd && !["help", "--help", "-h"].includes(cmd) ? 1 : 0);
}
