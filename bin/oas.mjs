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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { enableTmuxMouse, tmuxConfigPath, tmuxMouseEnabled } from "../lib/tmux-config.mjs";
import {
  LAYERS, LEGACY_HOME_CAPABILITIES_DIR, OAS_LOCK_FILE, OAS_VERSION, RETIRED_CAPABILITIES, retiredCapabilityReason, configChain,
  acquireCapability, restoreCapabilities, marketplaceCapabilities,
  capabilityManifests, capabilityManifest, capabilityMissingRequires, capabilityIntegrity, capabilityTrust, capabilityExecutablePath,
  readCapabilityLocks, writeCapabilityLock,
  parsePackageSource, inspectGitSourceRoot, acquirePackage, restorePackages, listInstalledPackages, readPackageLocks, readLockedConfigTemplates, residueEntryViolation,
  officialCapabilityPackage, officialPackageCatalog,
  approveCapability, updatePackage, removePackage, migrateLegacyLock, applyLegacyLockMigration,
  packageIntegrity, capabilityArtifactIntegrity, verifyCapabilityInstallation, installedCapabilityDir, installedCapabilitiesDir, ownedCapabilitiesDir, loadPackageManifestAt,
  resolveOasConfig, resolveWorkMode, composeInstanceAgentsMd, parseYamlNested, packagedInject, teamAgentRoots,
  findTeamAgent, findTeamInstance, findCapabilityAgent, findInstanceHome, listCapabilityAgents, workspaceOf,
  ensureRoot, findRoot, findAgent, listAgents, listInstances, listAgentDefs, createAgent as coreCreateAgent,
  spawnInstance, retireInstance, upsertLocalAgent, defaultRepo, RELATIONS,
} from "../lib/core.mjs";
import {
  aggregateMissingRequirements, beginRunJournal, discoverMigrationScopes, discoverWorkspaceScopes,
  adoptedTemplateDir, applyConfigMerge, lockedPackageCapabilities, planConfigMerge, readAdoptedTemplate, requirementInstallPlan,
  writeFileAtomic,
  runRequirementInstall, selectConfigTemplate, validateConfigTemplate, writeAdoptedTemplate,
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
/** Guided-upgrade readiness for the legacy official capabilities visible from a
 * scope (release contract §4): which legacy `marketplace:` locks exist, which
 * official package supplies each one, and whether this release's catalog can
 * map them all yet. `null` when there is no legacy official state at all. */
function officialMigrationState(legacyLocks, { teamScope, ctx }) {
  const capabilities = [];
  for (const l of legacyLocks) {
    for (const [id, entry] of Object.entries(l.capabilities || {})) {
      if (typeof entry?.source !== "string" || !entry.source.startsWith("marketplace:")) continue;
      let m;
      try { m = officialCapabilityPackage(id); }
      catch (e) { return { status: "unavailable", capabilities: [], command: null, reason: `the official package catalog is unreadable: ${e.message}` }; }
      capabilities.push({ capability: id, package: m.package, via: m.via, available: m.available, file: l.file, level: l.level });
    }
  }
  if (!capabilities.length) return null;
  const boundary = teamScope || ctx;
  const command = `oas migrate --official --recursive --dir ${shellQuote(boundary)}`;
  const missing = capabilities.filter((c) => !c.available);
  return missing.length
    ? { status: "unavailable", capabilities, command: null, reason: `no official package mapping yet for ${missing.map((c) => c.capability).join(", ")} — this release keeps the legacy capabilities working; migration becomes available when the catalog publishes them` }
    : { status: "ready", capabilities, command, reason: null };
}

/** The health of ONE materialized capability, against the rows it was projected
 * from. Shared by doctor and list so both name the same states with the same
 * codes — and so the `.oas-installation.json` provenance is checked in BOTH,
 * not only deep inside trust resolution where it surfaces as a bare "untrusted".
 *
 * Order matters: a missing artifact cannot be hashed, drifted bytes make an
 * approval meaningless (so trust is not ALSO reported), and provenance is only
 * worth reading once the bytes are the locked ones. */
function capabilityHealth(level, cap, capRow, pkgRow) {
  const dir = installedCapabilityDir(level, cap.id);
  if (!cap.installed) return { status: "missing", code: "missing-capability-artifact", dir, detail: `capability ${cap.id} is locked but not materialized — run \`oas install\` to re-materialize it` };
  let integrity;
  try { integrity = capabilityArtifactIntegrity(dir); }
  catch (e) { return { status: "broken", code: e.code || "invalid-capability-artifact", dir, detail: `capability ${cap.id}: ${e.message}` }; }
  if (integrity !== cap.integrity) {
    return { status: "drifted", code: "integrity-drift", dir, integrity, detail: `capability ${cap.id}: artifact integrity drift — installed ${integrity}, locked ${cap.integrity}; its executable approval is invalid` };
  }
  // The artifact's own provenance and the lock must tell the SAME story before
  // either is believed. Neither silently wins; the disagreement is the finding.
  if (capRow && pkgRow) {
    try { verifyCapabilityInstallation(dir, cap.id, capRow, pkgRow); }
    catch (e) { return { status: "provenance-mismatch", code: e.code || "invalid-lock", dir, integrity, detail: `capability ${cap.id}: ${e.message}` }; }
  }
  const executable = Object.keys(cap.manifest?.commands || {}).length || Object.keys(cap.manifest?.hooks || {}).length;
  if (executable && !cap.trusted) return { status: "untrusted", code: "untrusted-surface", dir, integrity, detail: `capability ${cap.id}: executable surface UNTRUSTED — \`oas trust ${cap.id}\`` };
  return { status: "ok", code: null, dir, integrity, detail: null };
}

function doctorPackagesData(ctx, chain, { teamScope } = {}) {
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
      // There is no persistent package root to hash: the package row exact-locks
      // a remote payload, and the only bytes on disk are the flat capability
      // artifacts. So every health check is per capability, against the artifact
      // integrity the engine recorded for it.
      for (const c of p.capabilities) {
        const h = capabilityHealth(p.level, c, pkgLocks.capabilities[c.id], lock);
        if (h.status !== "ok") problems.push({ code: h.code, detail: h.detail });
      }
    }
    packages.push({
      id: p.package, version: p.version || null, level: p.level, source: lock?.source || null,
      path: lock?.path || null, commit: lock?.commit || null, capabilities: p.capabilities.map((c) => c.id),
      dependencies: lock?.dependencies || [],
      status: problems.length ? "broken" : "ok", problems,
    });
  }
  for (const [id, lock] of Object.entries(pkgLocks.packages)) {
    if (!installedPkgs.some((p) => p.package === id)) {
      // Capability rows carry the provider back-reference — the package row has
      // no capability list to read any more.
      const provided = Object.entries(pkgLocks.capabilities).filter(([, c]) => c.package === id).map(([capId]) => capId);
      packages.push({ id, version: lock.version || null, level: lock._level, source: lock.source || null, path: lock.path || null, commit: lock.commit || null, capabilities: provided, dependencies: lock.dependencies || [], status: "broken", problems: [{ code: "missing-locked-package", detail: `locked in ${lock._file} but not installed — run oas install` }] });
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
  // Adoption provenance now comes from the visible, commit-safe adopted base —
  // not from a provenance comment the local config could lose to an edit.
  const adoptedTemplates = [];
  for (const cfg of chain) {
    const level = dirname(cfg._file);
    let adopted;
    try { adopted = readAdoptedTemplate(level); }
    catch (e) { adoptedTemplates.push({ level, file: cfg._file, status: "broken", code: e.code || "E_ADOPTION_INVALID", detail: e.message }); continue; }
    if (!adopted) continue;
    let localChanges = null;
    try { localChanges = readFileSync(cfg._file, "utf8") !== adopted.baseText; } catch { /* unreadable config is reported elsewhere */ }
    adoptedTemplates.push({
      level, file: cfg._file, package: adopted.package, template: adopted.template,
      base: adopted.baseFile, source: adopted.metadata?.source || null,
      version: adopted.metadata?.version || null, commit: adopted.metadata?.commit || null,
      hash: adopted.metadata?.hash || null, localChanges, status: "ok",
    });
  }
  // NOTE: doctor deliberately does NOT enumerate templates a package exports but
  // nobody adopted. In the materialized model there is no package root on disk,
  // so that list only exists behind a network fetch of the locked source — and
  // a diagnostic command must never go to the network to render a hint.
  const missingHostRequirements = aggregateMissingRequirements([ctx]).map((req) => ({
    command: req.command, why: req.why || null, docs: req.docs || null,
    requestedBy: req.requestedBy,
    plan: req.plan && !req.plan.unavailable
      ? { manager: req.plan.manager, argv: req.plan.argv, steps: req.plan.steps || [req.plan.argv], source: req.plan.source, version: req.plan.version || null, scope: req.plan.scope }
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
  return { lockError: lockBroken, packages, legacyLockFiles, migrationResidue, adoptedTemplates, missingHostRequirements, officialMigration: officialMigrationState(pkgLocks.legacy, { teamScope, ctx }) };
}

function doctorJson(dir) {
  const ctx = resolve(dir || process.cwd());
  const soulName = flag("soul");
  const r = resolveForDoctor(ctx, soulName, { json: true });
  const mans = capabilityManifests(ctx);
  const composition = doctorComposition(ctx, soulName);
  const chain = configChain(ctx);
  const pkg = doctorPackagesData(ctx, chain, { teamScope: r.team?.scope });
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
retiredLocks: (() => { try { return Object.entries(readCapabilityLocks(ctx)); } catch { return []; } })()
      .filter(([id]) => retiredCapabilityReason(id))
      .map(([id, lock]) => ({ id, file: lock._file, reason: retiredCapabilityReason(id) })),
    retiredArtifacts: Object.entries(mans)
      .filter(([id]) => retiredCapabilityReason(id))
      .map(([id, m]) => ({ id, dir: m._dir, origin: m._origin, reason: retiredCapabilityReason(id) })),
    // Shared WS2+engine package payload (fix 4: human and JSON doctor derive
    // from ONE computation; fail-closed reads are diagnosed via lockError —
    // doctorPackagesData carries the engine's residue/legacy-lock shapes).
    packages: pkg.packages,
    lockError: pkg.lockError,
    legacyLockFiles: pkg.legacyLockFiles,
    migrationResidue: pkg.migrationResidue,
    officialMigration: pkg.officialMigration,
    adoptedTemplates: pkg.adoptedTemplates,
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
    const retiredReason = retiredCapabilityReason(name);
    if (retiredReason) {
      const installed = String(m._origin).startsWith("installed:");
      console.log(`             WARNING: artifact of a retired capability — ${retiredReason}${installed ? `; also delete ${shortPath(m._dir)}` : ` (origin ${m._origin}: remove its declaration; the source tree at ${shortPath(m._dir)} is yours to keep or drop)`}`);
    }
  }
  // readCapabilityLocks fails closed on invalid legacy entries — doctor is the
  // diagnosis surface, so catch the typed error and render it (never using the data).
  let locks = {};
  try { locks = readCapabilityLocks(ctx); }
  catch (e) {
    if (e.code !== "invalid-lock") throw e;
    const prov = Array.isArray(e.provenance) ? e.provenance[0] : undefined;
    console.log(`  ERROR: ${e.message} [invalid-lock]`);
    if (prov?.file) console.log(`         fix or remove the entry in ${shortPath(prov.file)} — never auto-repaired; legacy trust/restore fail closed until it is valid`);
  }
  const mans = capabilityManifests(ctx);
  for (const [id, lock] of Object.entries(locks)) {
    const retiredReason = retiredCapabilityReason(id);
    if (retiredReason) { console.log(`  WARNING: ${id} is locked in ${shortPath(lock._file)} but ${retiredReason}`); continue; }
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
  const pkg = doctorPackagesData(ctx, chain, { teamScope: r.team?.scope });
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
  if (pkg.officialMigration) {
    const om = pkg.officialMigration;
    console.log(`\nOfficial capability migration (0.18 bundled capabilities → official packages):`);
    for (const c of om.capabilities) {
      console.log(`  ${c.capability} → package ${c.package}${c.via === "alias" ? " (catalog alias)" : ""}  ${c.available ? "[mapped]" : "[no catalog mapping yet]"}  [${shortPath(c.level)}]`);
    }
    if (om.status === "ready") console.log(`  READY: migrate with \`${om.command}\` (plan it first with --dry-run; approvals are re-earned afterwards)`);
    else console.log(`  NOT YET AVAILABLE: ${om.reason}`);
  }
  for (const a of pkg.adoptedTemplates) {
    if (a.status === "broken") {
      console.log(`\nAdopted config template: BROKEN at ${shortPath(a.level)} — ${a.detail}`);
      continue;
    }
    const drift = a.localChanges === null ? "" : a.localChanges ? " — local edits present (`oas config diff`)" : " — no local edits yet";
    console.log(`\nAdopted config template: ${shortPath(a.file)} adopted ${a.package}:${a.template}${a.version ? `@${a.version}` : ""}${drift}`);
    console.log(`  recorded base ${shortPath(a.base)} (commit it — \`oas config sync\` compares against it; package updates never rewrite your config)`);
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
  const retiredReason = retiredCapabilityReason(src);
  if (retiredReason) cmdFail("retired-capability", retiredReason);
  // Package source? (git/path with an oas-package.json, or a catalog id) — otherwise legacy capability acquisition.
  let parsedSrc;
  try { parsedSrc = parsePackageSource(src); } catch { parsedSrc = undefined; }
  const catalogId = parsedSrc?.kind === "catalog" ? parsedSrc.id : undefined;
  const hasOfficialPackage = !!catalogId && Object.hasOwn(officialPackageCatalog(), catalogId);
  // Once an official package catalog entry exists it becomes the default
  // acquisition route for that short id. Existing v1 installs keep working,
  // but a deliberate `oas install oas.okf` now acquires the package rather than
  // creating another legacy capability lock.
  const isMarketplaceCap = parsedSrc?.kind === "catalog" && !!marketplaceCapabilities()[catalogId] && !hasOfficialPackage;
  const isLocalPackage = parsedSrc?.kind === "path" && existsSync(join(parsedSrc.path, "oas-package.json"));
  const isCatalogPackage = parsedSrc?.kind === "catalog" && !isMarketplaceCap;
  let gitInspection;
  if (parsedSrc && (parsedSrc.kind === "git" || isLocalPackage || isCatalogPackage)) {
    // Remote Git may be either a distribution package or the documented
    // legacy standalone-capability repository. Inspect the fetched ROOT before
    // any scope lock preflight; never infer root layout from closure errors.
    if (parsedSrc.kind === "git") {
      try { gitInspection = inspectGitSourceRoot(src); }
      catch (e) { cmdFail(e.code || "invalid-source", e.message || e); return; }
      if (gitInspection.payloadPackage) {
        try { installPackage(dir, src, { rootSnapshot: gitInspection }); }
        finally { gitInspection.cleanup(); }
        return;
      }
      // Legacy standalone-capability repositories predate contained package
      // roots, so the fallback only applies to a REPOSITORY-ROOT capability
      // that was not asked for a specific path. A repo whose root carries
      // oas-package.json must never silently downgrade to capability
      // acquisition just because the selected path holds no package.
      if (gitInspection.explicitPath || gitInspection.package || !gitInspection.capability) {
        const where = `package path "${gitInspection.path}"`;
        const reason = gitInspection.package
          ? `Git source ${src} has an oas-package.json at the repository ROOT but no package at ${where}${gitInspection.explicitPath ? "" : " (the default)"} — select the root explicitly with \`${src}#.\``
          : gitInspection.explicitPath
            ? `Git source ${src} has no oas-package.json at ${where}`
            : `Git source ${src} has no oas-package.json at ${where} (the default package path) and no oas.json at its root`;
        gitInspection.cleanup();
        cmdFail("invalid-package-manifest", reason); return;
      }
      // Standalone capability: hand the SAME fetched snapshot to legacy
      // acquisition (which re-verifies that exact root layout before copying).
    } else { installPackage(dir, src); return; }
  }
  let known;
  try { known = gitInspection ? undefined : capabilityManifest(src, dir); }
  catch (e) { gitInspection?.cleanup(); cmdFail(e.code || "invalid-lock", e.message || e); return; }
  if (known) {
    if (JSON_MODE) { jsonOk({ alreadyAcquired: known.capability, version: known.version || null }); return; }
    console.log(`Already acquired capability ${known.capability} (${known.version || "unversioned"}); not activated or updated.`);
    return;
  }
  let r;
  try { r = acquireCapability(dir, src, { rootSnapshot: gitInspection }); }
  catch (e) { cmdFail(e.code || "invalid-source", e.message); return; }
  finally { gitInspection?.cleanup(); }
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
  const add = (level, row) => {
    const key = resolve(level);
    if (!byLevel.has(key)) byLevel.set(key, []);
    byLevel.get(key).push(row);
  };
  for (const r of restorePackages(deepestDir)) add(r.level, pkgRow(r));
  // EMPTY v1 lock files surface too (maintainer ruling): the engine's restore
  // report only rows NON-empty v1 files. Walk the raw lock chain (a lock-only
  // scope has no config, so configChain-based reads cannot see it) and emit a
  // LEGACY row for each empty v1 file so reconciliation shows the pending
  // lock-format migration.
  for (const level of lockLevelsUp(deepestDir)) {
    try {
      const parsed = JSON.parse(readFileSync(join(level, OAS_LOCK_FILE), "utf8"));
      if (parsed.lockfileVersion !== 2 && !Object.keys(parsed.capabilities || {}).length) {
        add(level, { id: null, level, package: true, status: "legacy", reason: `empty lockfileVersion ${parsed.lockfileVersion ?? 1} file — pending lock-format migration: oas migrate --dir ${level}` });
      }
    } catch { /* malformed locks raise via restorePackages above */ }
  }
  return byLevel;
}

function installPackage(dir, src, opts = {}) {
  const bail = (e) => (JSON_MODE ? jsonFail(e.code || "invalid-source", e.message || e) : die(e.message || e));
  let r;
  try { r = acquirePackage(dir, src, opts); }
  catch (e) { bail(e); return true; }
  // Packages are transport; capabilities are what lands on disk. Report both,
  // and let the CAPABILITY rows carry the provenance an operator acts on.
  if (JSON_MODE) { jsonOk({ root: r.root, installed: r.installed, capabilities: r.capabilities, lockFile: r.lockFile, depWarnings: r.depWarnings || [] }); return true; }
  for (const p of r.installed) {
    console.log(`${p.kept ? "ok       " : "Acquired "}${p.package}@${p.version}`);
    console.log(`  locked ${p.commit === "local" ? "local tree" : p.commit} at path ${p.path} (${p.integrity})`);
    for (const c of r.capabilities.filter((x) => x.package === p.package)) {
      console.log(`  capability ${c.capability}@${c.version}${c.layer ? `  layer: ${c.layer}` : ""} → ${shortPath(c.dir)}  (${c.integrity})`);
    }
    if (!r.capabilities.some((x) => x.package === p.package)) console.log("  capabilities: (none)");
  }
  for (const w of r.depWarnings || []) console.log(`WARNING: ${w}`);
  console.log(`Locked in ${shortPath(r.lockFile)}; nothing activated.`);
  // Read the executable surface off the ENGINE's projection, not a config-chain
  // manifest lookup: at a scope with no config yet, that lookup sees nothing.
  const executables = r.capabilities
    .filter((c) => c.executableSurface?.commands?.length || c.executableSurface?.hooks?.length)
    .map((c) => c.capability);
  if (executables.length) console.log(`Executable surfaces blocked until trusted: ${executables.map((c) => `oas trust ${c}`).join("; ")}`);
  return true;
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
  // Explicitly named requirements bypass runtime scoping, so the remediation
  // command a failed spawn prints actually installs something.
  const missing = aggregateMissingRequirements(scopes, { accepted });
  if (!missing.length) return [];
  const note = (msg) => (JSON_MODE ? console.error(msg) : console.log(msg));
  const entryOf = (req, outcome, extra = {}) => ({
    command: req.command, kind: req.kind || "host-command",
    runtime: req.runtime || null, package: req.package || null, why: req.why || null,
    // `steps` is the ORDERED sequence runRequirementInstall actually executes;
    // `argv` is only its last command. Serializing argv alone hid a
    // `claude plugin marketplace add <source>` — a lower-trust source
    // registration — from every client consenting through the JSON API
    // (reviewer-final0130bc8). Always present, exactly as doctor renders it, so
    // single- and multi-step plans have one shape.
    plan: req.plan && !req.plan.unavailable
      ? { manager: req.plan.manager, argv: req.plan.argv, steps: req.plan.steps || [req.plan.argv], source: req.plan.source, version: req.plan.version || null, scope: req.plan.scope }
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
      // Show the FULL sequence: two capabilities can agree on the final install
      // command while registering different third-party sources before it.
      for (const p of req.conflict.plans) {
        const shown = p.steps?.length ? p.steps.map((a) => a.join(" ")).join("  &&  ") : (p.argv ? p.argv.join(" ") : p.unavailable || "no plan");
        note(`      ${p.capability} [${shortPath(p.scope)}]: ${shown}`);
      }
      policyEntries.push(entryOf(req, "failed", { reason: "conflicting install plans for the same command", code: "E_REQUIREMENT_POLICY", conflict: req.conflict }));
    }
  }
  const consentable = missing.filter((req) => !req.invalid && !req.conflict);
  if (args.includes("--no-requirements")) return [...policyEntries, ...consentable.map((req) => entryOf(req, "skipped", { reason: "--no-requirements" }))];
  const interactive = !JSON_MODE && process.stdin.isTTY && process.stdout.isTTY;
  const out = [...policyEntries];
  if (consentable.length) note(`\nMissing requirements for active capabilities (${consentable.length}):`);
  for (const req of consentable) {
    const requesters = req.requestedBy.map((r) => `${r.capability} [${shortPath(r.scope)}]`).join(", ");
    note(`  ${req.command} — ${req.why || "required"} (requested by: ${requesters})`);
    const plan = req.plan;
    if (!plan || plan.unavailable) {
      note(`    no safe installer: ${plan?.unavailable || "no recipe"}${req.docs ? ` — install docs: ${req.docs}` : ""}`);
      out.push(entryOf(req, "skipped", { reason: plan?.unavailable || "no safe installer" }));
      continue;
    }
    // Show EVERY step: installing a Claude plugin also registers a third-party
    // marketplace, and consent to that must be visible, not implied.
    const shown = (plan.steps?.length ? plan.steps : [plan.argv]).map((a) => a.join(" ")).join("  &&  ");
    note(`    installer: ${shown}  (source: ${plan.source}${plan.version ? `, version ${plan.version}` : ""}; ${plan.scope})`);
    let consent = accepted.has(req.command);
    if (!consent && interactive) {
      process.stdout.write(`    Run this install now? [y/N] `);
      const buf = Buffer.alloc(64);
      let answer = "";
      try { answer = buf.toString("utf8", 0, readSync(process.stdin.fd, buf, 0, 64)).trim().toLowerCase(); } catch { /* EOF */ }
      consent = answer === "y" || answer === "yes";
    }
    if (!consent) {
      note(`    skipped — ${interactive ? "not consented" : "non-interactive; pass --accept-requirement " + req.command + " to install"}; \`oas doctor\` will keep warning until ${req.command} is ${req.kind === "runtime-package" ? `installed for ${req.runtime}` : "on PATH"}`);
      out.push(entryOf(req, "consent-required"));
      continue;
    }
    try {
      const r = runRequirementInstall(plan, JSON_MODE ? { stdio: ["ignore", 2, 2] } : {});
      // A runtime package is verified in its runtime's package list, never on
      // PATH — saying "on PATH" for one would be false either way it lands.
      const where = req.kind === "runtime-package" ? `installed for ${req.runtime}` : "on PATH";
      if (r.onPath) { note(`    installed — ${req.command} verified ${where}`); out.push(entryOf(req, "installed", { onPath: true })); }
      else { note(`    FAILED: install ran but ${req.command} is still not ${where}${req.kind === "runtime-package" ? "" : " — check your shell PATH/prefix"}`); out.push(entryOf(req, "failed", { onPath: false, reason: `install ran but the requirement is still not ${where}` })); }
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
  let pkgs, locks;
  try { pkgs = listInstalledPackages(dir); locks = readPackageLocks(dir); } catch (e) { cmdFail(e.code || "invalid-lock", e.message || e); return; }
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
    // FAIL CLOSED BEFORE APPROVING. The engine binds approval to the artifact's
    // integrity, but integrity alone cannot see a `.oas-installation.json` that
    // claims a different origin than the lock — and approving a capability whose
    // own provenance is disputed is exactly the thing trust must not do.
    const disputed = backing.capabilities
      .filter((c) => all || c.id === id)
      .map((c) => capabilityHealth(backing.level, c, locks.capabilities[c.id], locks.packages[backing.package]))
      .filter((h) => h.status !== "ok" && h.status !== "untrusted");
    if (disputed.length) { cmdFail(disputed[0].code || "invalid-lock", `refusing to trust: ${disputed.map((h) => h.detail).join("; ")}`); return; }
    let r;
    try { r = approveCapability(dir, id, { allCapabilities: all }); } catch (e) { cmdFail(e.code || "invalid-lock", e.message || e); return; }
    // Approval binds to each capability's exact MATERIALIZED ARTIFACT, so the
    // integrity reported is per capability — there is no package-level digest
    // to approve against and none to print.
    const approvedIntegrity = {};
    for (const c of backing.capabilities) if (r.approved.includes(c.id)) approvedIntegrity[c.id] = c.integrity || null;
    if (JSON_MODE) {
      // The engine's own surface, not a re-derivation: what it approved and what
      // it saw must be the same object.
      jsonOk({ package: r.package, level: r.level, approved: r.approved, skipped: r.skipped, approvedIntegrity, executableSurface: r.executableSurface, file: r.file });
      return;
    }
    for (const c of r.approved) console.log(`Trusted executable commands/hooks for ${c} (from package ${r.package}, artifact ${approvedIntegrity[c] || "?"}).`);
    if (r.skipped.length) console.log(`No executable surface (artifact integrity suffices, no approval needed): ${r.skipped.join(", ")}`);
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

/** Dependency-closure PROVIDER RECORDS for config-template validation.
 *
 * The flat model made this much smaller than its package-root ancestor: the
 * engine's lock reader walks raw lock-owning scopes rather than the config
 * chain, so a configless scope being initialized now sees its OWN lock without
 * the manual merge this used to need, and capability rows carry the provider
 * back-reference directly instead of package rows carrying capability lists.
 *
 * `staged` supplies the capabilities projected by THIS run's acquisition, which
 * are not locked yet when the pre-commit gate validates the template.
 * Returns { capabilities: Map<capabilityId, capabilityManifest|null> } — null
 * means lock-visible but not materialized, so layer agreement is unverifiable.
 */
function dependencyClosureProviders(rootId, dir, staged = []) {
  const capabilities = new Map();
  let locks = { packages: {}, capabilities: {} };
  try { locks = readPackageLocks(dir); } catch { /* invalid lock surfaces at acquire */ }

  const closure = new Set();
  const visit = (pkgId) => {
    if (!pkgId || closure.has(pkgId) || !Object.hasOwn(locks.packages, pkgId)) return;
    closure.add(pkgId);
    for (const dep of locks.packages[pkgId].dependencies || []) visit(dep);
  };
  visit(rootId);

  for (const [capId, row] of Object.entries(locks.capabilities)) {
    if (!closure.has(row.package)) continue;
    let manifest = null;
    try {
      const artifact = installedCapabilityDir(row._level, capId);
      if (existsSync(join(artifact, "oas.json"))) manifest = JSON.parse(readFileSync(join(artifact, "oas.json"), "utf8"));
    } catch { /* unreadable artifact is a doctor problem, not a validation input */ }
    capabilities.set(capId, manifest);
  }
  // Same-run acquisition visibility: the root's own exports exist only in
  // staging while the gate runs, and a template that binds them must validate.
  // Preview rows carry the declared `layer` (null when none) — the minimum the
  // layer-agreement check needs — so a staged capability is represented by that
  // one field rather than a manifest the engine deliberately does not expose.
  for (const c of staged) capabilities.set(c.capability, c.manifest ?? { layer: c.layer ?? null });
  return { capabilities };
}

/** Adopt a template from a package ALREADY locked at this scope: read its exact
 * locked templates, validate, then write config + base + metadata under the run
 * journal. Nothing is fetched beyond the locked source, and nothing is
 * re-acquired — the lock is already the truth about what is installed here. */
function initPackageFromLock(packageId, dir, file, lockedRoot, configFlag, bail, note) {
  let locked, chosen;
  try { locked = readLockedConfigTemplates(dir, packageId); }
  catch (e) { bail(e.code || "E_TEMPLATE_READ_FAILED", e.message); return; }
  try { chosen = selectConfigTemplate(locked.templates, configFlag, packageId); }
  catch (e) { bail(e.code || "E_TEMPLATE_AMBIGUOUS", e.message); return; }

  const errors = validateConfigTemplate(chosen, packageId, {
    dependencyProviders: dependencyClosureProviders(packageId, dir).capabilities,
  });
  if (errors.length) bail("E_TEMPLATE_INVALID", `config template "${chosen.template}" of package ${packageId} failed validation:\n  - ${errors.join("\n  - ")}`);

  note(`Package ${packageId}${locked.version ? `@${locked.version}` : ""} is already locked here — adopting its config template "${chosen.template}" without re-acquiring.`);

  let journal;
  try { journal = beginRunJournal(dir); }
  catch (e) { bail(e.code || "E_JOURNAL_FAILED", e.message); return; }
  let adoption;
  try {
    adoption = writeAdoptedTemplate(dir, file, {
      package: packageId, template: chosen,
      root: { source: locked.source, version: locked.version, commit: locked.commit, path: locked.path },
    });
    journal.finalize();
  } catch (e) {
    const report = journal.rollback();
    bail("E_ADOPT_FAILED", report.complete ? e.message : `${e.message} — ${report.summary}`);
    return;
  }

  const locks = readPackageLocks(dir);
  const capabilities = Object.entries(locks.capabilities).filter(([, c]) => c.package === packageId).map(([id]) => id);
  note(`Created ${shortPath(file)} (${levelOf(dir)} level) from config template ${packageId}:${chosen.template}`);
  if (JSON_MODE) {
    jsonOk({
      package: packageId, version: locked.version || null, commit: locked.commit || null,
      template: chosen.template, adopted: true, file, capabilities,
      adoptedBase: adoption.baseFile, adoptionMetadata: adoption.metadataFile,
      contentIntegrity: chosen.contentIntegrity,
      lockFile: lockedRoot._file || join(dir, OAS_LOCK_FILE), lockedPackages: Object.keys(locks.packages),
    });
    return;
  }
  offerTmuxMouseScrolling();
}

/** oas init --package <source> [--config <name>]: acquire a package AND adopt
 * one of its config templates as this scope's local config.
 *
 * This command is adoption, not an install alias: `oas install <package>`
 * installs capabilities and applies no template, while this one always adopts
 * exactly one — the named template, else the single marked default, else the
 * only one. Several unmarked templates are E_TEMPLATE_AMBIGUOUS and a package
 * with none is E_NO_TEMPLATES; both refuse inside the pre-commit gate, so the
 * scope is never touched.
 *
 * Transaction shape: the outer journal opens BEFORE acquisition, so its
 * snapshot is the pre-command state. A gate refusal or acquire failure rolls it
 * back (the engine is zero-mutation there, so this mainly closes the backup); a
 * failure while writing the adoption files rolls back the lock, the capability
 * store, the ignore file, the config and the adopted base together — the
 * newly acquired state disappears and every pre-existing byte returns.
 * finalize() runs only after every adoption write has succeeded.
 *
 * JSON mode: one compact envelope. CLI codes E_TEMPLATE_INVALID /
 * E_TEMPLATE_AMBIGUOUS / E_TEMPLATE_NOT_FOUND / E_NO_TEMPLATES; engine codes
 * pass through verbatim. Fully noninteractive. */
function initPackage(src, dir, file) {
  const bail = (code, msg) => (JSON_MODE ? jsonFail(code, msg) : die(msg));
  const note = (msg) => (JSON_MODE ? console.error(msg) : console.log(msg));
  const configFlag = flag("config");
  if (configFlag === true) bail("E_USAGE", "--config needs a template name");

  let chosen = null;      // the selected+validated template descriptor
  let rootRecord = null;  // the acquired root package row
  let projected = [];     // projected capability rows

  /** The pre-commit gate. Everything that can refuse refuses HERE, while the
   * scope is still untouched. It THROWS rather than exiting: the process-exit
   * path would strand the journal's backup, and the engine propagates a gate
   * throw unchanged with nothing mutated. */
  const assertCommittable = (preview) => {
    rootRecord = preview.packages.find((p) => p.package === preview.root) || null;
    projected = preview.capabilities || [];
    const templates = (preview.configTemplates || []).filter((t) => t.package === preview.root);

    note(`Package ${preview.root}${rootRecord?.version ? `@${rootRecord.version}` : ""} — installs ${projected.length} capability(ies): ${projected.map((c) => c.capability).join(", ") || "(none)"}`);
    const executable = projected.filter((c) => c.executableSurface?.commands?.length || c.executableSurface?.hooks?.length);
    if (executable.length) note(`  executable surfaces needing separate approval: ${executable.map((c) => c.capability).join(", ")} (\`oas trust <id>\`)`);

    chosen = selectConfigTemplate(templates, configFlag, preview.root); // throws typed codes
    // Every check now refuses PRE-COMMIT, layer agreement included: preview
    // capability rows carry the declared layer, so a template binding a slot to
    // one of the package's own staged capabilities is validated here, with the
    // scope untouched and no rollback needed.
    const errors = validateConfigTemplate(chosen, preview.root, {
      dependencyProviders: dependencyClosureProviders(preview.root, dir, projected).capabilities,
    });
    if (errors.length) {
      const e = new Error(`config template "${chosen.template}" of package ${preview.root} failed validation:\n  - ${errors.join("\n  - ")}`);
      e.code = "E_TEMPLATE_INVALID";
      throw e;
    }
    note(`Config template "${chosen.template}"${chosen.description ? `: ${chosen.description}` : ""} — validated (${chosen.contentIntegrity})`);
    note(`  it becomes YOUR local ${shortPath(file)}: every copied setting is editable, and package updates never rewrite it.`);
  };

  // Opened BEFORE acquisition: a snapshot taken afterwards would record the new
  // lock, artifacts and ignore bytes as the "pre-existing" state and could
  // never undo them.
  // An id already locked at this scope is adopted from the LOCK, not
  // re-acquired: its exact source/commit is already pinned, the capabilities are
  // already materialized, and going to the network (or the catalog) to re-fetch
  // what the lock already names would be a different package than the one
  // installed here. This is the `oas init --package <id>` half of the documented
  // <id|path|git-url> form.
  let lockedRoot = null;
  try { lockedRoot = readPackageLocks(dir).packages[src] || null; }
  catch { /* an invalid lock surfaces with its own typed code below */ }
  if (lockedRoot) { initPackageFromLock(src, dir, file, lockedRoot, configFlag, bail, note); return; }

  // Constructed inside its own guard: a journal that cannot be built (a symlink
  // component, an unreadable snapshot, a backup that would land inside the
  // scope) must still leave the command with exactly one JSON envelope. There
  // is nothing to roll back yet, so its typed code goes straight to bail.
  let journal;
  try { journal = beginRunJournal(dir); }
  catch (e) { bail(e.code || "E_JOURNAL_FAILED", e.message); return; }

  /** Undo the run, then report. `code` is the engine's verbatim code for
   * acquisition failures and a stable CLI code for our own write failures — a
   * raw errno like ENOTDIR is not a contract automation can branch on. */
  const abort = (e, code) => {
    const report = journal.rollback();
    const detail = code === "E_ADOPT_FAILED" ? `adopting the config template failed after the package was installed: ${e.message}` : e.message;
    bail(code || e.code || "E_INIT_FAILED", report.complete ? detail : `${detail} — ${report.summary}`);
  };

  let acq;
  try { acq = acquirePackage(dir, src, { assertCommittable }); }
  catch (e) { abort(e); return; }

  note(`Acquired + locked: ${acq.installed.map((p) => `${p.package}@${p.version}`).join(", ")} → ${shortPath(acq.lockFile)}`);
  const capabilities = acq.capabilities.map((c) => c.capability);

  // DEFENCE IN DEPTH, not the primary check. The gate above already validated
  // every binding against the preview's declared layers; this re-checks them
  // against the manifests actually written to disk, so a projection that
  // disagreed with its own preview cannot leave a broken config behind. It
  // should never fire — and if it does, the journal restores the scope
  // completely, so nothing of the run survives.
  const materialized = new Map();
  for (const c of acq.capabilities) {
    let manifest = null;
    try { manifest = JSON.parse(readFileSync(join(installedCapabilityDir(dir, c.capability), "oas.json"), "utf8")); }
    catch { /* unreadable artifact is reported by doctor; leave it unverifiable */ }
    materialized.set(c.capability, manifest);
  }
  for (const [id, m] of dependencyClosureProviders(acq.root, dir).capabilities) if (!materialized.has(id)) materialized.set(id, m);
  const lateErrors = validateConfigTemplate(chosen, acq.root, { dependencyProviders: materialized });
  if (lateErrors.length) {
    const e = new Error(`config template "${chosen.template}" of package ${acq.root} failed validation:\n  - ${lateErrors.join("\n  - ")}`);
    e.code = "E_TEMPLATE_INVALID";
    abort(e);
    return;
  }

  let adoption;
  try {
    adoption = writeAdoptedTemplate(dir, file, { package: acq.root, template: chosen, root: rootRecord });
    journal.finalize();
  } catch (e) { abort(e, "E_ADOPT_FAILED"); return; }

  note(`Created ${shortPath(file)} (${levelOf(dir)} level) from config template ${acq.root}:${chosen.template}`);
  note(`Recorded the adopted base at ${shortPath(adoption.baseFile)} — commit it; \`oas config diff\` and \`oas config sync\` compare against it.`);
  if (JSON_MODE) {
    jsonOk({
      package: acq.root, version: rootRecord?.version || null, commit: rootRecord?.commit || null,
      template: chosen.template, adopted: true, file, capabilities,
      adoptedBase: adoption.baseFile, adoptionMetadata: adoption.metadataFile,
      contentIntegrity: chosen.contentIntegrity,
      lockFile: acq.lockFile, lockedPackages: acq.installed.map((p) => p.package),
    });
    return;
  }
  offerTmuxMouseScrolling();
}

/** `oas config <diff|sync|adopt>` — the guided three-way template lane.
 *
 * All three share one comparison: the recorded adopted base, the current local
 * oas-config.yaml, and the selected template read from the CURRENT EXACT LOCK.
 * Only `sync` and `adopt` mutate, and both present the complete plan first.
 */
function configCmd() {
  const bail = (code, msg) => (JSON_MODE ? jsonFail(code, msg) : die(msg));
  const sub = args[1];
  if (!["diff", "sync", "adopt"].includes(sub)) {
    bail("E_USAGE", "usage: oas config <diff|sync|adopt> [--config <template>] [--dir <dir>] [--json]");
  }
  const dir = resolve(flag("dir") || process.cwd());
  const file = join(dir, "oas-config.yaml");
  if (!existsSync(file)) bail("E_NO_CONFIG", `no oas-config.yaml at ${shortPath(dir)} — adopt one with \`oas init --package <source> --config <name>\``);
  const localText = readFileSync(file, "utf8");

  let adopted;
  try { adopted = readAdoptedTemplate(dir); }
  catch (e) { bail(e.code || "E_ADOPTION_INVALID", e.message); }

  // `adopt` switches base; the others need an existing one.
  const adoptTarget = sub === "adopt" ? args[2] : undefined;
  if (sub === "adopt" && (!adoptTarget || adoptTarget.startsWith("--"))) {
    bail("E_USAGE", "usage: oas config adopt <package> [--config <template>] — the package must already be installed at this scope");
  }
  if (sub !== "adopt" && !adopted) {
    bail("E_NO_ADOPTED_BASE", `${shortPath(file)} was not adopted from a config template, so there is no recorded base to compare against — adopt one with \`oas config adopt <package> --config <name>\``);
  }

  const packageId = sub === "adopt" ? adoptTarget : adopted.package;
  const templateFlag = flag("config");
  if (templateFlag === true) bail("E_USAGE", "--config needs a template name");
  const wanted = templateFlag || (sub === "adopt" ? undefined : adopted.template);

  // Exact locked read — never the network-free guess, never a package root.
  let locked;
  try { locked = readLockedConfigTemplates(dir, packageId); }
  catch (e) { bail(e.code || "E_TEMPLATE_READ_FAILED", e.message); }
  let chosen;
  try { chosen = selectConfigTemplate(locked.templates, wanted, packageId); }
  catch (e) { bail(e.code || "E_TEMPLATE_AMBIGUOUS", e.message); }

  // Switching base rebases the ONE local config against the new template; the
  // base for comparison is then the currently adopted one when there is one, or
  // the local file itself on first adoption (everything reads as a local edit).
  const baseText = adopted ? adopted.baseText : localText;
  const plan = planConfigMerge(baseText, localText, chosen.content);

  const describe = (r) => ({
    id: r.id, kind: r.kind, recommended: r.recommended, digest: r.digest,
    startLine: r.local.start + 1, lines: r.local.end - r.local.start,
    base: r.base.text, local: r.local.text, package: r.template.text,
  });

  if (sub === "diff") {
    if (JSON_MODE) {
      jsonOk({
        package: packageId, template: chosen.template, version: locked.version || null, commit: locked.commit || null,
        file, adoptedBase: adopted?.baseFile || null, contentIntegrity: chosen.contentIntegrity,
        clean: plan.clean, counts: plan.counts, conflicts: plan.conflicts,
        regions: plan.regions.map(describe), planDigest: plan.planDigest,
      });
      return;
    }
    console.log(`oas config diff — ${shortPath(file)} vs ${packageId}:${chosen.template}${locked.version ? `@${locked.version}` : ""} (report only; nothing is written)\n`);
    if (!plan.regions.length) { console.log("No differences: your config, the adopted base, and the package template agree."); return; }
    for (const r of plan.regions) renderMergeRegion(r);
    console.log(`\n${plan.counts.upstream} upstream-only, ${plan.counts.local} local-only, ${plan.counts.conflict} conflict(s), ${plan.counts.agreed} already agreed.`);
    console.log(plan.clean
      ? "Apply the upstream changes with `oas config sync` (local-only edits are kept)."
      : "`oas config sync` needs an explicit choice for each conflict — it will never pick one for you.");
    return;
  }

  // ---- sync / reset / adopt: everything below MUTATES, so plan first ----

  const decisions = {};
  for (const spec of flagAll("accept")) {
    const m = /^([^=]+)=(local|package)$/.exec(spec);
    if (!m) bail("E_USAGE", `--accept takes <regionId>=<local|package>, got "${spec}"`);
    decisions[m[1]] = m[2];
  }
  const assumeYes = args.includes("--yes");
  const isReset = args.includes("--reset");

  // The recoverable backup survives a SUCCESSFUL run: the run journal is for
  // undoing failures, this is for the adopter who changes their mind.
  const backupFile = `${file}.bak`;

  if (isReset) {
    // Reset previews everything it will destroy, then demands explicit consent.
    const lost = plan.regions.filter((r) => r.kind === "local" || r.kind === "conflict");
    if (JSON_MODE || !process.stdin.isTTY) {
      if (!assumeYes) {
        bail("E_RESET_NOT_CONFIRMED", `oas config sync --reset would discard ${lost.length} local change region(s) in ${shortPath(file)} and replace it with ${packageId}:${chosen.template} verbatim — pass --yes to accept that noninteractively`);
      }
    } else if (!assumeYes) {
      console.log(`This DISCARDS ${lost.length} local change region(s) in ${shortPath(file)}:\n`);
      for (const r of lost) renderMergeRegion(r);
      const answer = promptLine(`Type the word "discard" to replace it with ${packageId}:${chosen.template}: `);
      if (answer.trim() !== "discard") bail("E_RESET_NOT_CONFIRMED", "reset cancelled — nothing was changed");
    }
    const journal = openJournal(dir, bail);
    try {
      if (existsSync(file)) copyFileSync(file, backupFile);
      writeFileAtomic(file, chosen.content);
      recordAdoption(dir, file, packageId, chosen, locked, adopted);
      journal.finalize();
    } catch (e) { abortRun(journal, e, bail); return; }
    if (JSON_MODE) { jsonOk({ action: "reset", package: packageId, template: chosen.template, file, backup: backupFile, discardedRegions: lost.length, contentIntegrity: chosen.contentIntegrity }); return; }
    console.log(`Reset ${shortPath(file)} to ${packageId}:${chosen.template} verbatim. Previous contents saved at ${shortPath(backupFile)}.`);
    return;
  }

  // sync / adopt share the three-way apply.
  const unresolved = plan.conflicts.filter((id) => !Object.hasOwn(decisions, id));
  if (unresolved.length) {
    if (JSON_MODE || !process.stdin.isTTY) {
      bail("E_SYNC_AMBIGUOUS", `${unresolved.length} conflict(s) need an explicit choice (${unresolved.join(", ")}) — pass --accept <id>=<local|package> for each; this command will never choose for you`);
    }
    for (const id of unresolved) {
      const region = plan.regions.find((r) => r.id === id);
      renderMergeRegion(region);
      const answer = promptLine(`[${id}] keep (l)ocal or take (p)ackage? `).trim().toLowerCase();
      if (answer === "l" || answer === "local") decisions[id] = "local";
      else if (answer === "p" || answer === "package") decisions[id] = "package";
      else bail("E_SYNC_AMBIGUOUS", `no choice made for ${id} — nothing was changed`);
    }
  }

  let merged;
  try { merged = applyConfigMerge(localText, plan, decisions); }
  catch (e) { bail(e.code || "E_SYNC_FAILED", e.message); return; }

  // Advancing the recorded base is the POINT of a sync, not a side effect of
  // changing bytes. Deciding "keep local" on every conflict changes nothing on
  // disk, but the decision must still be recorded — otherwise the base stays
  // behind and the identical conflict is re-presented on every future sync,
  // forever. So "nothing to do" means nothing applied AND the base already at
  // this exact template.
  const baseIsCurrent = adopted?.package === packageId
    && adopted?.template === chosen.template
    && adopted?.baseText === chosen.content;
  if (!merged.applied.length && baseIsCurrent) {
    if (JSON_MODE) { jsonOk({ action: sub, package: packageId, template: chosen.template, file, changed: false, baseAdvanced: false, applied: [], backup: null }); return; }
    console.log(`Nothing to do: ${shortPath(file)} and the recorded base are already at ${packageId}:${chosen.template}.`);
    return;
  }

  if (!JSON_MODE) {
    console.log(`Plan for ${shortPath(file)} vs ${packageId}:${chosen.template}:`);
    for (const a of merged.applied) console.log(`  [${a.id}] ${a.kind} → ${a.choice}`);
    console.log("");
  }

  const changed = merged.text !== localText;
  const journal = openJournal(dir, bail);
  try {
    // Back up only when bytes actually change — a backup identical to the file
    // it shadows is noise the adopter has to reason about later.
    if (changed) copyFileSync(file, backupFile);
    if (changed) writeFileAtomic(file, merged.text);
    recordAdoption(dir, file, packageId, chosen, locked, adopted);
    journal.finalize();
  } catch (e) { abortRun(journal, e, bail); return; }

  if (JSON_MODE) {
    jsonOk({
      action: sub, package: packageId, template: chosen.template, file, changed,
      baseAdvanced: true, applied: merged.applied, backup: changed ? backupFile : null,
      adoptedBase: join(adoptedTemplateDir(dir, packageId, chosen.template), "oas-config.yaml"),
      contentIntegrity: chosen.contentIntegrity,
    });
    return;
  }
  if (changed) console.log(`Applied ${merged.applied.length} change region(s) to ${shortPath(file)}; previous contents saved at ${shortPath(backupFile)}.`);
  else console.log(`No bytes changed in ${shortPath(file)} — you kept every local choice.`);
  console.log(`Adopted base advanced to ${packageId}:${chosen.template}, so these decisions will not be asked again. Local edits outside the applied regions are untouched.`);
}

/** Open the run journal with the command's one-envelope guarantee intact. */
function openJournal(dir, bail) {
  try { return beginRunJournal(dir); }
  catch (e) { bail(e.code || "E_JOURNAL_FAILED", e.message); throw e; }
}

/** Undo a failed config mutation and report truthfully. */
function abortRun(journal, e, bail) {
  const report = journal.rollback();
  bail(e.code || "E_CONFIG_WRITE_FAILED", report.complete ? e.message : `${e.message} — ${report.summary}`);
}

/** Write the adopted base + metadata for the template just synced against, and
 * retire any previously adopted base so exactly one survives. */
function recordAdoption(dir, file, packageId, chosen, locked, previous) {
  const written = writeAdoptedTemplate(dir, file, {
    package: packageId, template: chosen,
    root: { source: locked.source, version: locked.version, commit: locked.commit, path: locked.path },
  }, { writeConfig: false });
  if (previous && (previous.package !== packageId || previous.template !== chosen.template)) {
    rmSync(previous.dir, { recursive: true, force: true });
    const parent = dirname(previous.dir);
    try { if (!readdirSync(parent).length) rmSync(parent, { recursive: true, force: true }); } catch { /* sibling templates remain */ }
  }
  return written;
}

/** Read one line from the terminal (human confirmation paths only). */
function promptLine(question) {
  process.stdout.write(question);
  const buf = Buffer.alloc(1024);
  let read = 0;
  try { read = readSync(0, buf, 0, buf.length, null); } catch { return ""; }
  return buf.subarray(0, read).toString("utf8").replace(/\n.*$/s, "");
}

/** One merge region, rendered for a human deciding what to do about it. */
function renderMergeRegion(r) {
  const label = {
    upstream: "UPSTREAM ONLY  — the package template changed this; your config did not",
    local: "LOCAL ONLY     — you changed this; the package template did not (it stays)",
    conflict: "CONFLICT       — both changed this; an explicit choice is required",
    agreed: "ALREADY AGREED — you and the package made the same change",
  }[r.kind];
  console.log(`[${r.id}] line ${r.local.start + 1}: ${label}`);
  const block = (title, text) => {
    if (!text) { console.log(`    ${title}: (nothing)`); return; }
    for (const line of text.replace(/\n$/, "").split("\n")) console.log(`    ${title}: ${line}`);
  };
  if (r.kind !== "local") block("package", r.template.text);
  if (r.kind !== "upstream") block("yours  ", r.local.text);
  console.log("");
}

/** oas list — installed packages, exported capabilities, scopes. */
function listCmd() {
  const dir = dirFlag();
  // FAIL-CLOSED (maintainer finding 3): list RAISES on invalid locks — an
  // invalid lock must never render as usable/absent data.
  let pkgs, locks;
  try { pkgs = listInstalledPackages(dir); locks = readPackageLocks(dir); }
  catch (e) { JSON_MODE ? jsonFail(e.code || "invalid-lock", e.message || e) : die(e.message); return; }
  // Packages are TRANSPORT; capabilities are what is installed. So the listing
  // is capability-first: every row names its own provider, artifact, integrity,
  // trust and health, and the package rows keep only what the transport itself
  // pins. Trust is per capability — there is no package-level approval to list.
  const capabilities = [];
  for (const p of pkgs) {
    for (const c of p.capabilities) {
      const h = capabilityHealth(p.level, c, locks.capabilities[c.id], locks.packages[p.package]);
      capabilities.push({
        capability: c.id, version: c.version || null, package: p.package, level: p.level,
        path: c.path || null, dir: h.dir, integrity: c.integrity || null,
        installedIntegrity: h.integrity ?? null,
        layer: c.manifest?.layer || null, trusted: c.trusted === true, installed: c.installed,
        executableSurface: {
          commands: Object.keys(c.manifest?.commands || {}),
          hooks: Object.keys(c.manifest?.hooks || {}),
        },
        status: h.status, code: h.code, detail: h.detail,
      });
    }
  }
  if (JSON_MODE) {
    jsonOk({
      packages: pkgs.map((p) => ({ package: p.package, version: p.version, level: p.level, source: p.source || null, path: p.path || null, commit: p.commit || null, integrity: p.integrity || null, locked: p.locked, dependencies: p.dependencies, capabilities: p.capabilities.map((c) => c.id) })),
      capabilities,
      legacy: locks.legacy.map((l) => ({ file: l.file, level: l.level, lockfileVersion: l.lockfileVersion, capabilities: Object.keys(l.capabilities) })),
    });
    return;
  }
  if (!pkgs.length) console.log("No installed packages in this config chain.");
  const byPackage = new Map();
  for (const c of capabilities) {
    if (!byPackage.has(c.package)) byPackage.set(c.package, []);
    byPackage.get(c.package).push(c);
  }
  for (const p of pkgs) {
    console.log(`${p.package}@${p.version}  [${levelOf(p.level)} ${shortPath(p.level)}]${p.locked ? "" : "  UNLOCKED (no lock entry — reacquire)"}`);
    if (p.source) console.log(`  source: ${p.source}  path: ${p.path || "?"}  commit: ${p.commit || "?"}`);
    for (const c of byPackage.get(p.package) || []) {
      const executable = c.executableSurface.commands.length || c.executableSurface.hooks.length;
      const trust = executable ? (c.trusted ? "  [trusted]" : "  [executable — needs oas trust]") : "";
      console.log(`  capability ${c.capability}${c.layer ? `  layer: ${c.layer}` : ""}${trust}`);
      // A capability whose bytes or provenance disagree with the lock is named
      // as broken HERE — never rendered as an ordinary usable row.
      if (c.status !== "ok" && c.status !== "untrusted") console.log(`    ${c.status.toUpperCase()}: ${c.detail}`);
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

/** The team boundary a guided migration walks, when the scope declares one.
 * A config the kernel refuses to resolve is not a reason to abort a migration
 * that only reads locks — discovery falls back to the explicit scope and says so. */
function migrationTeamScope(dir, warnings) {
  try { return resolveOasConfig(dir)?.team?.scope || undefined; }
  catch (e) { warnings.push(`team boundary not resolved from ${shortPath(dir)} (${e.message}) — discovery covers this scope and its lock-owning ancestors only`); return undefined; }
}

const migratePlanRow = (s) => ({
  capability: s.capabilityId, action: s.action,
  package: s.package?.id || null, spec: s.package?.spec || null, via: s.package?.via || null,
  source: s.v1?.source || null, reason: s.reason || null, note: s.note || null,
});

/** `oas migrate --official` / `--recursive` — the guided existing-user upgrade.
 *
 * Plans EVERY visible lock-owning scope first (deterministic, side-effect
 * free), prints the complete per-scope plan, then applies scope by scope. Each
 * scope keeps the engine's transactional guarantee on its own: one scope's
 * failure leaves that scope byte-identical, never stops the others from being
 * reported truthfully, and makes the aggregate result nonzero. */
function guidedMigrateCmd({ dir, dryRun, official, recursive }) {
  const out = (msg) => (JSON_MODE ? console.error(msg) : console.log(msg));
  const opts = official ? { official: true } : {};
  const warnings = [];
  let scopes;
  try {
    scopes = recursive
      ? discoverMigrationScopes(dir, { teamScope: migrationTeamScope(dir, warnings) })
      : (existsSync(join(dir, OAS_LOCK_FILE)) ? [resolve(dir)] : []);
  } catch (e) { cmdFail(e.code || "invalid-lock", e.message || e); return; }

  // ---- plan every scope BEFORE touching any of them ----
  const planned = [];
  for (const scope of scopes) {
    const file = join(scope, OAS_LOCK_FILE);
    try {
      const { plan, warnings: w } = migrateLegacyLock(scope, opts);
      const held = plan.filter((s) => s.action === "hold");
      const acquire = plan.filter((s) => s.action === "acquire");
      const formatOnly = plan.some((s) => s.action === "convert-format");
      const keep = plan.filter((s) => s.action === "retain" || s.action === "manual");
      // Generic (non-official) mode keeps `oas migrate`'s semantics even when
      // nothing maps: converting a v1 file to v2 with residue IS the operation.
      // Official mode never rewrites a scope it has no official work in.
      const status = held.length ? "held"
        : (acquire.length || formatOnly || (!official && plan.length)) ? "ready"
        : "nothing";
      planned.push({ scope, file, status, plan, acquire, keep, held, warnings: w });
    } catch (e) {
      planned.push({ scope, file, status: "failed", plan: [], acquire: [], keep: [], held: [], warnings: [], error: { code: e.code || "invalid-lock", message: String(e.message || e) } });
    }
  }
  const planRows = planned.map((p) => ({
    level: p.scope, levelKind: levelOf(p.scope), file: p.file, status: p.status,
    plan: p.plan.map(migratePlanRow), warnings: p.warnings, error: p.error || null,
  }));

  const actionable = planned.filter((p) => p.status === "ready" || p.status === "format-only");
  out(`oas migrate${official ? " --official" : ""}${recursive ? " --recursive" : ""} — ${scopes.length} lock-owning scope${scopes.length === 1 ? "" : "s"} from ${shortPath(dir)}`);
  for (const w of warnings) out(`WARNING: ${w}`);
  if (!scopes.length) out("  (no oas-lock.json found — nothing to migrate)");
  for (const p of planned) {
    out(`\n  ${shortPath(p.scope)}  [${levelOf(p.scope)}]  ${shortPath(p.file)}`);
    if (p.status === "failed") { out(`    ERROR      ${p.error.message} [${p.error.code}]`); continue; }
    for (const s of p.plan) {
      if (s.action === "convert-format") out(`    format     ${s.note}`);
      else if (s.action === "acquire") out(`    migrate    ${s.capabilityId} → package ${s.package.id || s.package.spec}${s.package.via === "alias" ? `  (catalog alias: package ${s.package.id} exports ${s.capabilityId})` : s.package.via === "identity" ? "  (official catalog)" : ""}`);
      else if (s.action === "hold") out(`    HELD       ${s.capabilityId} — ${s.reason}`);
      else out(`    keep       ${s.capabilityId}${s.v1?.source ? `  (${s.v1.source})` : ""} — not converted, entry kept unchanged`);
    }
    if (p.status === "nothing") out("    (nothing to migrate at this scope)");
    if (p.status === "ready") {
      out(`    config     ${shortPath(join(p.scope, "oas-config.yaml"))} is NOT rewritten — capability ids, layers, targets, settings, exclusions and overrides stay valid (packages export the same ids)`);
      out("    trust      executable approvals are NOT carried over — they are re-earned after migrating (exact commands below)");
    }
    for (const w of p.warnings) out(`    WARNING: ${w}`);
  }

  const result = {
    mode: official ? "official" : "generic", recursive, dryRun,
    boundary: resolve(dir), scopes: planRows, trust: [], requirements: [], nextCommands: [], warnings,
  };
  if (dryRun) {
    const failed = planned.filter((p) => p.status === "failed");
    const held = planned.filter((p) => p.status === "held");
    result.nextCommands = actionable.length ? [`oas migrate${official ? " --official" : ""}${recursive ? " --recursive" : ""} --dir ${shellQuote(dir)}`] : [];
    // A held or unplannable scope is NOT a ready migration: the dry run says so
    // with a nonzero result in both modes, so automation can never read
    // "planned successfully" as "this deployment can migrate now"
    // (reviewer-90dbb36). The complete plan travels under error.details.
    const blocked = [
      ...(held.length ? [`${held.length} scope${held.length > 1 ? "s" : ""} held (no official package mapping yet)`] : []),
      ...(failed.length ? [`${failed.length} scope${failed.length > 1 ? "s" : ""} could not be planned`] : []),
    ];
    if (JSON_MODE) {
      if (blocked.length) { console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_MIGRATE_FAILED", message: `${blocked.join("; ")} (${actionable.length} ready)`, details: result } })); process.exit(1); }
      jsonOk(result);
      return;
    }
    out(`\nDry run — nothing was changed. ${actionable.length} scope${actionable.length === 1 ? "" : "s"} ready${held.length ? `, ${held.length} held` : ""}${failed.length ? `, ${failed.length} failed` : ""}.`);
    if (actionable.length) out(`Apply with: oas migrate${official ? " --official" : ""}${recursive ? " --recursive" : ""} --dir ${shellQuote(dir)}`);
    if (held.length) out("Held scopes stay on their v1 locks and their legacy capabilities keep working — re-run when the catalog publishes their packages.");
    if (blocked.length) die(`${blocked.join("; ")} (${actionable.length} ready)`);
    return;
  }

  // ---- apply, scope by scope (each independently transactional) ----
  const failures = [];
  for (const [i, p] of planned.entries()) {
    const row = planRows[i]; // planRows is built from planned, in order
    if (p.status === "failed") { row.status = "failed"; failures.push({ scope: p.scope, code: p.error.code, message: p.error.message }); continue; }
    if (p.status === "held") {
      row.status = "held";
      failures.push({ scope: p.scope, code: "official-mapping-unavailable", message: `held: ${p.held.map((s) => `${s.capabilityId} (${s.reason})`).join("; ")}` });
      out(`\nHELD      ${shortPath(p.scope)} — left unchanged; its legacy capabilities keep working`);
      continue;
    }
    if (p.status === "nothing") { row.status = "skipped"; continue; }
    let r;
    try { r = applyLegacyLockMigration(p.scope, opts); }
    catch (e) {
      row.status = "failed";
      row.error = { code: e.code || "legacy-lock", message: String(e.message || e) };
      failures.push({ scope: p.scope, code: row.error.code, message: row.error.message });
      out(`\nFAILED    ${shortPath(p.scope)} — ${row.error.message}`);
      continue;
    }
    row.status = r.skipped ? "skipped" : r.formatConverted ? "format-converted" : "migrated";
    row.migrated = r.migrated;
    row.residue = r.residue;
    row.warnings = r.warnings;
    for (const t of r.trust || []) result.trust.push({ ...t, command: `oas trust ${t.capability} --dir ${shellQuote(p.scope)}` });
    out(`\n  ${shortPath(p.scope)}:`);
    for (const m of r.migrated) out(`    migrated   ${m.capability} → package ${m.package}@${m.version}`);
    for (const c of r.residue) out(`    kept       ${c}  (unchanged legacy entry)`);
    for (const w of r.warnings) out(`    WARNING: ${w}`);
    if (r.formatConverted) out(`    format     empty lockfileVersion 1 file → canonical v2 (no residue)`);
    else if (!r.skipped) out(`    ${shortPath(r.file)} is now lockfileVersion 2 — config activation (from: installed) is unchanged`);
  }

  // ---- exact next commands: trust first, then the requirement/install pass ----
  const migratedScopes = planRows.filter((r) => r.status === "migrated").map((r) => r.level);
  let requirements = [];
  try { requirements = migratedScopes.length ? aggregateMissingRequirements(migratedScopes) : []; }
  catch (e) { result.warnings.push(`host requirements not aggregated: ${e.message}`); }
  result.requirements = requirements.map((req) => ({
    command: req.command, requestedBy: req.requestedBy,
    consentCommand: req.plan && !req.plan.unavailable && !req.invalid && !req.conflict
      ? `oas install --accept-requirement ${req.command} --dir ${shellQuote(dir)}` : null,
  }));
  result.nextCommands = [
    ...result.trust.map((t) => t.command),
    ...result.requirements.filter((q) => q.consentCommand).map((q) => q.consentCommand),
    `oas install --dir ${shellQuote(dir)}`,
  ];

  if (JSON_MODE) {
    if (failures.length) { console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_MIGRATE_FAILED", message: `${failures.length} scope${failures.length > 1 ? "s" : ""} not migrated (${planRows.filter((r) => r.status === "migrated").length} migrated)`, details: result } })); process.exit(1); }
    jsonOk(result);
    return;
  }
  out("\nNext steps:");
  if (result.trust.length) {
    out("  1. Review and approve the executable surfaces (approvals are never carried over):");
    for (const t of result.trust) out(`       ${t.command}`);
  } else out("  1. No executable surfaces to approve.");
  for (const q of result.requirements) {
    if (q.consentCommand) out(`  *  Missing host command ${q.command}: ${q.consentCommand}`);
  }
  out(`  2. Verify the runtime closure and host requirements (already-installed requirements are not reinstalled):`);
  out(`       oas install --dir ${shellQuote(dir)}`);
  if (failures.length) {
    out("\nFailures by scope:");
    for (const f of failures) out(`  ${shortPath(f.scope)}: ${f.message} [${f.code}]`);
    die(`${failures.length} scope${failures.length > 1 ? "s" : ""} not migrated (${planRows.filter((r) => r.status === "migrated").length} migrated)`);
  }
}

/** oas migrate — map this scope's v1 marketplace capability locks to package locks. */
function migrateCmd() {
  const dir = dirFlag();
  const dryRun = args.includes("--dry-run");
  if (args.includes("--official") || args.includes("--recursive")) {
    guidedMigrateCmd({ dir, dryRun, official: args.includes("--official"), recursive: args.includes("--recursive") });
    return;
  }
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
  // A moved package root is reported even when the bytes are identical: the
  // lock now points somewhere else in the repository, and that is exactly the
  // change an operator must see (contract §7).
  const pathLine = () => console.log(`  package path ${r.before.path} → ${r.after.path} (the selected package root MOVED in the source)`);
  if (!r.changed) {
    console.log(`${r.package} is already up to date (${r.after.version}, ${r.after.integrity}).`);
    if (r.pathChanged) pathLine();
    return;
  }
  console.log(`Updated ${r.package}: ${r.before.version} (${r.before.commit}) → ${r.after.version} (${r.after.commit})`);
  console.log(`  integrity ${r.before.integrity} → ${r.after.integrity}`);
  if (r.pathChanged) pathLine();
  if (r.addedCapabilities.length) console.log(`  + capabilities: ${r.addedCapabilities.join(", ")}`);
  if (r.removedCapabilities.length) console.log(`  - capabilities: ${r.removedCapabilities.join(", ")}`);
  for (const w of r.depWarnings || []) console.log(`WARNING: ${w}`);
  if (r.invalidatedApprovals.length) console.log(`  APPROVALS INVALIDATED (integrity changed): ${r.invalidatedApprovals.join(", ")} — re-approve with \`oas trust\` after review.`);
}

// ---------- init ----------
/**
 * oas init [--raw] [--dir <dir>] [--knowledge <id>] [--messaging <id>] [--tasks <id>]
 *
 * Per-layer flags name a canonical capability ID or "none". A layer is filled by
 * a capability already at this scope (own store first — no config exists yet, so
 * the config-chain walk cannot see it), otherwise by acquiring the official
 * PACKAGE that supplies it through the materialization engine. Acquisition is
 * not activation, not executable trust and not requirement consent, and the
 * whole run is one transaction that rolls back on any failure.
 */
/** Resolve a template (name via outer-config `templates:` maps, local path, or git URL's
 * main-branch oas-config.yaml) into snapshot text with a provenance comment. */
function loadTemplateConfig(spec, dir) {
  // THROWS typed errors rather than exiting: `oas init --template` reports
  // through the same single JSON envelope as every other init form.
  const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
  let source = spec;
  const isDirect = /^(https?:\/\/|git@|ssh:\/\/)/.test(spec) || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("~");
  if (!isDirect) {
    let named;
    for (const cfg of configChain(dir)) {
      if (cfg.templates?.[spec]) { named = { value: cfg.templates[spec], level: cfg._level }; break; }
    }
    if (!named) fail("E_UNKNOWN_TEMPLATE", `unknown template "${spec}" — declare it under templates: in an outer oas-config.yaml, or pass a path/git URL`);
    source = /^(https?:\/\/|git@|ssh:\/\/)/.test(named.value) || named.value.startsWith("/") || named.value.startsWith("~")
      ? named.value : resolve(named.level, named.value);
  }
  let body, provenance;
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(source)) {
    const tmp = mkdtempSync(join(tmpdir(), "oas-template-"));
    try {
      execFileSync("git", ["clone", "-q", "--depth", "1", source, tmp], { stdio: "inherit" });
      const cfgFile = join(tmp, "oas-config.yaml");
      if (!existsSync(cfgFile)) fail("E_TEMPLATE_SOURCE", `template repo has no oas-config.yaml on its default branch: ${source}`);
      body = readFileSync(cfgFile, "utf8");
      const commit = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      provenance = `${source}@${commit.slice(0, 12)}`;
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  } else {
    const path = resolve(source.replace(/^~\//, `${homedir()}/`));
    if (!existsSync(path)) fail("E_TEMPLATE_SOURCE", `template config not found: ${path}`);
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
  // Every init form — classic, --template and --package — reports through the
  // SAME one-envelope JSON boundary; nothing here may print two documents.
  const bail = (code, msg) => (JSON_MODE ? jsonFail(code, msg) : die(msg));
  const note = (msg) => (JSON_MODE ? console.error(msg) : console.log(msg));
  if (existsSync(file)) bail("E_CONFIG_EXISTS", `${shortPath(file)} already exists — edit it or use \`oas use\``);

  if (pkgSrc && pkgSrc !== true) { initPackage(pkgSrc, dir, file); return; }
  if (pkgSrc === true) { bail("E_USAGE", "--package needs a package id, local path, or git URL"); return; }

  const template = flag("template");
  if (template && template !== true) {
    let text;
    try { text = loadTemplateConfig(template, dir); }
    catch (e) { bail(e.code || "E_TEMPLATE_SOURCE", e.message); return; }
    writeFileSync(file, text);
    note(`Created ${shortPath(file)} (${levelOf(dir)} level) from template ${template}`);
    restore(dir);
    if (JSON_MODE) {
      // A seeded config that cannot resolve is reported through the envelope,
      // never as an uncaught stack: it is the one thing a JSON caller must see.
      let activated;
      try { activated = resolveOasConfig(dir).capabilities.map((c) => ({ capability: c.id, layer: c.layer || null })); }
      catch (e) { bail(e.code || "E_CONFIG_UNRESOLVABLE", `${shortPath(file)} was created from template ${template} but does not resolve: ${e.message}`); return; }
      jsonOk({ file, level: levelOf(dir), raw, adopted: false, template, acquired: [], activated, requirements: [] });
      return;
    }
    offerTmuxMouseScrolling();
    return;
  }
  if (template === true) { bail("E_USAGE", "--template needs a name, local config path, or git URL"); return; }

  // Per-layer overrides: --knowledge oas.okf, --messaging none, --tasks oas.jira …
  const overrides = {};
  const market = marketplaceCapabilities();
  // Own-scope manifests are read DIRECTLY: no oas-config.yaml exists here yet,
  // so the config-chain walk cannot see this scope's own store, and a
  // capability already installed here would look unknown.
  const mans = { ...market, ...capabilityManifests(dir), ...ownScopeCapabilityManifests(dir) };
  for (const layer of LAYERS) {
    const v = flag(layer);
    if (v === undefined) continue;
    if (v === true || String(v).startsWith("--")) bail("E_USAGE", `--${layer} needs a canonical capability ID or "none"`);
    if (v !== "none") {
      // Known locally: its declared layer is checkable right now, before any
      // mutation. Otherwise the official catalog may still supply it, and the
      // layer is verified against the MATERIALIZED manifest after acquisition —
      // inside the run transaction, so a disagreement rolls the whole run back.
      if (mans[v]) {
        if (mans[v].layer !== layer) bail("E_LAYER_MISMATCH", `capability "${v}" declares layer "${mans[v].layer || "none"}", not "${layer}"`);
      } else if (!officialCapabilityPackage(v).available) {
        bail("E_UNKNOWN_CAPABILITY", `unknown capability "${v}" for --${layer} — it is not acquired at ${shortPath(dir)}, not in the marketplace (${Object.keys(market).join(", ") || "empty"}), and no official package supplies it (catalog: ${Object.keys(officialPackageCatalog()).join(", ") || "empty"})`);
      }
    }
    overrides[layer] = v;
  }

  const defaults = raw
    ? { knowledge: "none", messaging: "none", tasks: "none" }
    : { knowledge: "oas.okf", messaging: "oas.aweb", tasks: undefined };
  let layers = { ...defaults, ...overrides };

  // Interactive TTY with no explicit layer flags: present each default and ask.
  // Non-interactive contexts (agents, CI) keep flags-or-silent-defaults — never hang.
  if (!raw && !JSON_MODE && process.stdin.isTTY && process.stdout.isTTY && !Object.keys(overrides).length) {
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
  // ---- Everything below MUTATES. It is ONE run-level transaction: the config
  // file, the lock, the flat capability artifacts, the capability .gitignore
  // and any `.agents` anchor this run creates roll back together. A capability
  // that was already installed at this scope before the run is restored
  // byte-identically — this run only ever undoes its own changes. ----
  let journal;
  try { journal = beginRunJournal(dir); }
  catch (e) { bail(e.code || "E_JOURNAL_FAILED", e.message); return; }
  const abort = (e, code) => {
    const report = journal.rollback();
    bail(code || e.code || "E_INIT_FAILED", report.complete ? e.message : `${e.message} — ${report.summary}`);
  };

  const acquisitions = [];
  let resolved;
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
  try {
    for (const layer of LAYERS) {
      const selected = layers[layer];
      if (!selected) { lines.push(`    # ${layer}: (unset — inherits from outer config scopes; set an entry or "none")`); continue; }
      if (selected === "none") { lines.push(`    ${layer}: none`); continue; }
      // Already here (own scope first — see above), or acquired now.
      const manifest = ownScopeCapabilityManifest(dir, selected)
        || capabilityManifest(selected, dir)
        || acquireLayerCapability(dir, selected, layer, acquisitions, note);
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
    // Resolve INSIDE the transaction: a config this run wrote that cannot
    // resolve is a broken scope, so it fails the init and rolls back rather
    // than being left behind for the next command to trip over.
    resolved = resolveOasConfig(dir);
    journal.finalize();
  } catch (e) { abort(e); return; }

  note(`Created ${shortPath(file)} (${levelOf(dir)} level${raw ? ", raw" : ""})`);
  // Acquisition is not activation, not executable trust, and not requirement
  // consent — say so per acquisition rather than implying the layer is ready.
  for (const a of acquisitions) {
    if (!a.executableSurface.length) continue;
    note(`Executable surfaces from ${a.package || "the marketplace"} are blocked until trusted: ${a.executableSurface.map((c) => `oas trust ${c}`).join("; ")}`);
  }

  const r = resolved;
  const activated = [];
  for (const cap of r.capabilities) {
    activated.push({ capability: cap.id, layer: cap.layer || null });
    note(`Activated: ${cap.id}${cap.layer ? ` → ${cap.layer}` : ""}`);
    for (const miss of cap.missingRequires) note(`WARNING: required command "${miss.command}" not on PATH — ${miss.why || ""}${miss.install ? ` (install: ${miss.install})` : ""}`);
  }
  if (JSON_MODE) {
    jsonOk({
      file, level: levelOf(dir), raw, adopted: false,
      layers: Object.fromEntries(LAYERS.map((l) => [l, layers[l] ?? null])),
      acquired: acquisitions, activated,
      requirements: r.capabilities.flatMap((c) => c.missingRequires.map((m) => ({ capability: c.id, command: m.command, install: m.install || null }))),
    });
    return;
  }
  offerTmuxMouseScrolling();
}

/** Acquire the capability backing one fundamental layer at classic-init time.
 *
 * Catalog-first: when an official package supplies the capability it comes
 * through the package engine — flat materialization, a capability-materialization
 * lock, and NO implicit executable trust. The legacy standalone-capability route
 * survives only for marketplace capabilities the official catalog cannot supply
 * today, and it is the only branch that still writes a v1 lock.
 *
 * Throws on every failure: the caller holds the run journal, and exiting here
 * would strand its backup. */
function acquireLayerCapability(dir, capId, layer, acquired, note) {
  const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
  const official = officialCapabilityPackage(capId);
  if (official.available) {
    const acq = acquirePackage(dir, official.package);
    if (!acq.capabilities.some((c) => c.capability === capId)) {
      fail("E_LAYER_NOT_EXPORTED", `package ${official.package} does not export capability "${capId}" — it exports ${acq.capabilities.map((c) => c.capability).join(", ") || "nothing"}`);
    }
    // The layer is verified against the manifest actually WRITTEN TO DISK, never
    // against the marketplace copy or the catalog's word for it.
    const manifest = ownScopeCapabilityManifest(dir, capId);
    if (!manifest) fail("E_LAYER_UNREADABLE", `capability "${capId}" was materialized but its manifest under ${shortPath(installedCapabilityDir(dir, capId))} is unreadable`);
    if (manifest.layer !== layer) fail("E_LAYER_MISMATCH", `capability "${capId}" declares layer "${manifest.layer || "none"}", not "${layer}"`);
    const executableSurface = acq.capabilities
      .filter((c) => c.executableSurface?.commands?.length || c.executableSurface?.hooks?.length)
      .map((c) => c.capability);
    acquired.push({
      layer, capability: capId, route: "package", package: official.package, via: official.via,
      packages: acq.installed.map((p) => ({ package: p.package, version: p.version || null, commit: p.commit || null })),
      lockFile: acq.lockFile, trusted: false, executableSurface,
    });
    note(`Acquired package ${official.package} for the ${layer} layer → ${capId} (${acq.installed.map((p) => `${p.package}@${p.version}`).join(", ")}) → ${shortPath(acq.lockFile)}`);
    return { ...manifest, _origin: `installed:${dir}` };
  }
  const market = marketplaceCapabilities();
  if (!market[capId]) {
    fail("E_UNKNOWN_CAPABILITY", `capability "${capId}" is not acquired at ${shortPath(dir)}, is not in the marketplace (${Object.keys(market).join(", ") || "empty"}), and no official package supplies it`);
  }
  // Legacy route: kernel-bundled marketplace capabilities predate the official
  // packages, ship with the kernel already installed, and keep their v1 lock and
  // acquisition-time trust until the catalog covers them.
  const r = acquireCapability(dir, capId);
  try {
    writeCapabilityLock(dir, r.manifest.capability, {
      source: r.source, version: r.manifest.version || null, integrity: r.integrity, trustedExecutables: true,
    });
  } catch (e) { rmSync(r.dest, { recursive: true, force: true }); throw e; }
  if (r.manifest.layer !== layer) fail("E_LAYER_MISMATCH", `capability "${capId}" declares layer "${r.manifest.layer || "none"}", not "${layer}"`);
  acquired.push({ layer, capability: capId, route: "marketplace", package: null, via: "marketplace", packages: [], lockFile: join(dir, OAS_LOCK_FILE), trusted: true, executableSurface: [] });
  note(`Acquired ${r.manifest.capability}@${r.manifest.version} from the marketplace → ${shortPath(r.dest)}`);
  return { ...r.manifest, _origin: `installed:${dir}` };
}

/** Capability manifests physically present at THIS scope's own store.
 *
 * `capabilityManifests` walks the config chain, so during `oas init` — when no
 * oas-config.yaml exists at the target scope yet — this scope is not a level and
 * its own installed/ and owned/ capabilities are invisible. Init reads them
 * directly instead, which is also what makes a same-run acquisition visible to
 * the rest of the run. */
function ownScopeCapabilityManifests(dir) {
  const out = {};
  for (const [sub, origin] of [[installedCapabilitiesDir(dir), "installed"], [ownedCapabilitiesDir(dir), "owned"]]) {
    if (!existsSync(sub)) continue;
    let entries;
    try { entries = readdirSync(sub, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      // Dot-prefixed entries are transaction staging, never installed content.
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      let m;
      try { m = JSON.parse(readFileSync(join(sub, e.name, "oas.json"), "utf8")); } catch { continue; }
      if (m && typeof m.capability === "string") out[m.capability] = { ...m, _dir: join(sub, e.name), _origin: `${origin}:${dir}` };
    }
  }
  return out;
}
const ownScopeCapabilityManifest = (dir, capId) => ownScopeCapabilityManifests(dir)[capId];

// ---------- roster: status / spawn / retire / create ----------
function status() {
  if (args.includes("--team")) return statusTeam();
  const root = ensureRoot(dirFlag());
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
  // Retired boundary flags (maintainer transport ruling): fail LOUDLY before
  // ANY side effect — including root discovery and local-agent upsert (an
  // --instructions-file spawn must not scaffold/overwrite a local soul before
  // this rejection; reviewer-b671de0).
  if (args.includes("--instance")) bail("E_BAD_ARGS", "--instance was removed by the runtime-boundary ruling — use --purpose <slug> (deterministic <agent>-<purpose> naming)");
  if (args.includes("--ephemeral")) bail("E_BAD_ARGS", "--ephemeral was removed by the runtime-boundary ruling — declare the agent in a capability manifest (agents:) for automatic ephemeral semantics");
  let root;
  try { root = ensureRoot(dirFlag()); }
  catch (e) { bail("E_NO_DEPLOYMENT", e.message || e); throw e; }
  let agent = findAgent(root, name);
  const instrFile = flag("instructions-file");
  const defFile = flag("def-file");
  if (!agent && !instrFile && !defFile) {
    // Capability-defined agent: a package's `agents:` soul, active in this context.
    const capAgent = findCapabilityAgent(dirFlag(), root, name);
    if (capAgent) {
      agent = capAgent;
      note(`(capability agent: "${name}" from ${capAgent.capability} — fresh soul, instances home locally)`);
    }
  }
  if (!agent && !instrFile && !defFile) {
    // Cross-repo lookup: the soul may live in a sibling repo of the team scope.
    // Unique match wins; the instance homes with its owning repo's agents root.
    const teamHit = findTeamAgent(dirFlag(), name);
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
    if (!findInstanceHome(root, relativeTo) && !findTeamInstance(dirFlag(), relativeTo)) bail(parent ? "E_PARENT_NOT_FOUND" : "E_RELATIVE_NOT_FOUND", `${parent ? "--parent" : "--relative-to"} "${relativeTo}" does not match any known instance`);
  }
  const taskText = flag("task");
  if (taskText === true) bail("E_BAD_ARGS", "--task needs a value (use --task-file for long tasks)");
  const taskFileFlag = flag("task-file");
  if (taskFileFlag === true) bail("E_BAD_ARGS", "--task-file needs a path");
  if (taskFileFlag && !existsSync(taskFileFlag)) bail("E_BAD_ARGS", `--task-file not found: ${taskFileFlag}`);
  const relativeRoot = flag("relative-root");
  if (relativeRoot !== undefined && (relativeRoot === true || !String(relativeRoot).trim())) bail("E_BAD_ARGS", "--relative-root needs an agents-root path");
  if (relativeRoot && !relativeTo) bail("E_BAD_ARGS", "--relative-root only qualifies --relative-to/--parent");
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
  if (!name || name.startsWith("--")) die("usage: oas retire <instance> [--self] [--delete-branch] [--keep-dir] [--force] [--json]");
  const isSelf = process.env.PI_AGENT_INSTANCE === name || process.env.OAS_INSTANCE === name;
  if (isSelf && !args.includes("--self")) die(`"${name}" is the calling instance — self-retire is irreversible; if your task is complete and you were told to retire, re-run with --self (finish your memory files FIRST; your session dies ~8s after)`);
  if (!isSelf && args.includes("--self")) die(`--self given but "${name}" is not the calling instance`);
  let root = ensureRoot(dirFlag());
  // Cross-repo: the instance may home in a sibling repo of the team scope.
  if (!listAgents(root).some((a) => existsSync(join(a._dir, "instances", name)))) {
    const hit = findTeamInstance(dirFlag(), name);
    if (hit && resolve(hit.root) !== resolve(root)) { root = hit.root; console.log(`(cross-repo: instance homes at ${shortPath(root)})`); }
  }
  const r = retireInstance(root, name, { self: isSelf, deleteBranch: args.includes("--delete-branch"), keepDir: args.includes("--keep-dir"), force: args.includes("--force") });
  // Forced removal past an incomplete cleanup: the home is gone because the
  // operator said so, but the external state it owed is still out there and
  // nobody else will mention it again.
  if (r.forcedIncomplete) {
    console.error(`Removed ${r.retired} under --force with cleanup INCOMPLETE — this external state was NOT cleaned up and is now yours to remove by hand:`);
    for (const f of r.forcedIncomplete) console.error(`  ${f}`);
  }
  if (args.includes("--json")) { console.log(JSON.stringify(r, null, 2)); if (r.rollbackIncomplete) process.exit(1); return; }
  // An unsuccessful cleanup retry must NOT read as a completed retirement: the
  // home and its external state are still there, and a zero exit would tell
  // both a human and any script that the work is done.
  if (r.rollbackIncomplete) {
    console.error(`Cleanup for ${r.retired} is INCOMPLETE — the instance home is retained at ${r.retainedHome} because external state may still exist:`);
    for (const f of r.rollbackIncomplete) console.error(`  ${f}`);
    console.error(`Fix the cause and re-run \`oas retire ${r.retired}\`; the home holds the state that cleanup needs.`);
    process.exit(1);
  }
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
  const startDir = dirFlag();
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
else if (cmd === "config") configCmd();
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
  oas retire <instance> [--force]           retire an instance (window, hooks,
      [--self] [--delete-branch]            worktree, home); --self = retire the
      [--keep-dir] [--json]                 CALLING instance (delayed window kill)
  oas doctor [dir] [--soul <name>] [--json] resolved targets, trust, requirements;
                                            --soul shows final composed AGENTS.md
  oas update [--check] [--yes]              check npm for a newer kernel+pi bridge and
                                            optionally run the update; then run oas doctor
  oas install [<source>] [--dir <d>]        acquire + exact-lock a package closure
                                            (git:host/org/repo@ref[#<path>], git URL,
                                            local path, official catalog id) or a legacy
                                            marketplace capability; never activates
                                            #<path> selects the contained package root
                                            (default oas-package; #. = repository root;
                                            local paths are always exact directories)
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
  oas migrate --official [--recursive]      guided upgrade of 0.18 bundled official
      [--dry-run] [--dir <d>] [--json]      capabilities to official packages: plans every
                                            visible lock-owning scope first, applies each
                                            transactionally, keeps custom/owned entries
                                            untouched, and prints the exact trust/install
                                            follow-up (held when the catalog cannot map yet)
  oas config diff [--config <template>]     three-way report: your config vs the recorded
      [--dir <d>] [--json]                  adopted base vs the template in the current exact
                                            lock — reports only, never writes; the adopted
                                            base supplies the package/template defaults
  oas config sync [--accept <r>=local|package] apply the template's changes to your config,
      [--dir <d>] [--json]                  region by region, preserving every untouched local
                                            byte, comment and ordering; local-only edits stay;
                                            conflicts need an explicit --accept and are never
                                            chosen for you; advances the recorded base
  oas config sync --reset --yes             replace your config with the template verbatim;
      [--config <template>] [--dir <d>]     previews every local change it discards, refuses
      [--json]                              without --yes, and keeps a recoverable .bak
  oas config adopt <package>                switch to another installed package's template,
      [--config <template>] [--accept ...]  rebasing your one local config; exactly one adopted
      [--dir <d>] [--json]                  base survives, and a failed switch changes nothing
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
  oas init [--raw] [--dir <dir>] [--json]   create an oas-config.yaml here. Fundamental
      [--knowledge <id|none>]               layers are filled from what is already at this
      [--messaging <id|none>]               scope, else acquired from the official package
      [--tasks <id|none>]                   that supplies them — capabilities materialize
      [--tmux-mouse|--no-tmux-mouse]        flat, executable surfaces stay untrusted, and
                                            the whole run rolls back on any failure.
      [--package <id|path|git-url>]         instead: adopt one config TEMPLATE from a package
      [--config <template>]                 as your own local config and record the exact
                                            adopted base (named template, else the marked
                                            default, else the only one).
      [--template <name|path|git-url>]      instead: seed from a template config (named via an
                                            outer templates: map, a local file, or a git repo's
                                            default-branch oas-config.yaml).
                                            Every form refuses to overwrite an existing config;
                                            --json = exactly one result envelope, noninteractive.
  oas root                                  print this package's install root
                                            (adapters resolve the kernel from it)
  oas <namespace> <command> [args…]         run an operational command only when its
                                            capability is active (e.g. oas okf harvest)

Layers: ${LAYERS.join(", ")}. Level detection: ~ → laptop, .git → repo, else workspace.`);
  process.exit(cmd && !["help", "--help", "-h"].includes(cmd) ? 1 : 0);
}
