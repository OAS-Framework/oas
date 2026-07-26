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
  packageIntegrity, packageDepsIntegrity, installedPackagesDir,
  resolveOasConfig, resolveWorkMode, composeInstanceAgentsMd, parseYamlNested, packagedInject, teamAgentRoots,
  findTeamAgent, findTeamInstance, findCapabilityAgent, findInstanceHome, listCapabilityAgents, workspaceOf,
  ensureRoot, findRoot, findAgent, listAgents, listInstances, listAgentDefs, createAgent as coreCreateAgent,
  spawnInstance, retireInstance, upsertLocalAgent, defaultRepo, RELATIONS,
} from "../lib/core.mjs";

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
    if (json) { console.log(JSON.stringify({ context: ctx, error: e.message, retired: [retiredId] }, null, 2)); process.exit(1); }
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
function doctorJson(dir) {
  const ctx = resolve(dir || process.cwd());
  const soulName = flag("soul");
  const r = resolveForDoctor(ctx, soulName, { json: true });
  const mans = capabilityManifests(ctx);
  const composition = doctorComposition(ctx, soulName);
  console.log(JSON.stringify({
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
    ...(() => {
      // Doctor JSON catches the typed fail-closed error and diagnoses (finding 3).
      try {
        const legacy = readPackageLocks(ctx).legacy;
        return {
          migrationResidue: legacy.filter((l) => l.lockfileVersion === 2).flatMap((l) =>
            Object.entries(l.capabilities).map(([id, lock]) => {
              const violation = residueEntryViolation(lock);
              return violation
                ? { id, file: l.file, level: l.level, source: lock?.source || null, status: "invalid-lock", violation, action: `fix or remove the entry in ${l.file} (never auto-repaired)` }
                : { id, file: l.file, level: l.level, source: lock.source, status: "pending-migration", action: `oas migrate --dir ${l.level}` };
            })),
          // Empty/nonempty v1 files: pending LOCK-FORMAT migration (maintainer
          // ruling — distinct from capability residue).
          legacyLockFiles: legacy.filter((l) => l.lockfileVersion !== 2).map((l) => ({ file: l.file, level: l.level, lockfileVersion: l.lockfileVersion ?? 1, empty: !Object.keys(l.capabilities || {}).length, status: "pending-format-migration", action: `oas migrate --dir ${l.level}` })),
          lockError: null,
        };
      } catch (e) {
        return { migrationResidue: [], legacyLockFiles: [], lockError: { code: e.code || "invalid-lock", message: e.message, provenance: e.provenance || null } };
      }
    })(),
    retiredArtifacts: Object.entries(mans)
      .filter(([id]) => RETIRED_CAPABILITIES[id])
      .map(([id, m]) => ({ id, dir: m._dir, origin: m._origin, reason: RETIRED_CAPABILITIES[id] })),
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

  // Distribution packages: package failures are distinguished from capability failures.
  // Doctor is the DIAGNOSIS surface: it catches the typed invalid-lock error the
  // fail-closed read/list paths raise and renders it actionably (finding 3).
  console.log("\nInstalled packages:");
  let pkgLocks = { packages: {}, legacy: [] };
  let pkgs = [];
  let lockBroken;
  try { pkgLocks = readPackageLocks(ctx); pkgs = listInstalledPackages(ctx); }
  catch (e) {
    lockBroken = e;
    const prov = Array.isArray(e.provenance) ? e.provenance[0] : undefined;
    console.log(`  ERROR: ${e.message} [${e.code || "invalid-lock"}]`);
    if (prov?.file) console.log(`         fix or remove the offending entry in ${shortPath(prov.file)} — the lock is never auto-repaired; package operations fail closed until it is valid`);
  }
  if (!lockBroken && !pkgs.length && !Object.keys(pkgLocks.packages).length && !pkgLocks.legacy.length) console.log("  (none)");
  for (const p of pkgs) {
    const lock = pkgLocks.packages[p.package];
    console.log(`  ${p.package}@${p.version}  [${levelOf(p.level)} ${shortPath(p.level)}]`);
    if (!lock) { console.log(`             ERROR: installed but not locked — reacquire it [manifest graph error]`); continue; }
    const integ = packageIntegrity(p.dir);
    if (integ !== lock.integrity) console.log(`             ERROR: integrity drift — installed ${integ}, locked ${lock.integrity}; all capability approvals are invalid [integrity-drift]`);
    // Runtime closure presence/staleness (runtime API addendum §2): node_modules
    // is derived; deviation from the locked digest is repairable via bare `oas install`.
    const depsNow = packageDepsIntegrity(p.dir);
    if ((lock.depsIntegrity || undefined) !== depsNow) console.log(`             ERROR: materialized runtime closure ${depsNow ? "differs from" : "missing vs"} the locked depsIntegrity — run \`oas install\` to re-materialize [integrity-drift]`);
    const have = new Set(p.capabilities.map((c) => c.id));
    for (const c of lock.capabilities || []) if (!have.has(c)) console.log(`             ERROR: locked capability "${c}" is missing from the package manifest [capability-list-mismatch]`);
    for (const c of p.capabilities) {
      const executable = Object.keys(c.manifest.commands || {}).length || Object.keys(c.manifest.hooks || {}).length;
      if (executable && !(lock.trustedCapabilities || []).includes(c.id) && integ === lock.integrity) console.log(`             capability ${c.id}: executable surface UNTRUSTED — \`oas trust ${c.id}\``);
    }
  }
  for (const [id, lock] of Object.entries(pkgLocks.packages)) {
    if (!pkgs.some((p) => p.package === id)) console.log(`  ERROR: package ${id} is locked in ${shortPath(lock._file)} but not installed — run \`oas install\` [missing locked package]`);
  }
  for (const l of pkgLocks.legacy) {
    if (l.lockfileVersion !== 2) {
      // Empty v1 = pending LOCK-FORMAT migration (never capability residue).
      if (!Object.keys(l.capabilities || {}).length) console.log(`  WARNING: ${shortPath(l.file)} is an empty lockfileVersion ${l.lockfileVersion ?? 1} file — pending lock-format migration: run \`oas migrate --dir ${shortPath(l.level)}\` (converts to canonical v2, no residue)`);
      else console.log(`  WARNING: ${shortPath(l.file)} is lockfileVersion ${l.lockfileVersion ?? 1} — \`oas migrate\` maps its capability locks to packages`);
    }
    else if (Object.keys(l.capabilities).length) {
      for (const [rid, rlock] of Object.entries(l.capabilities)) {
        const violation = residueEntryViolation(rlock);
        if (violation) console.log(`  ERROR: residue entry ${rid} in ${shortPath(l.file)} is malformed (${violation}) — never auto-repaired; fix or remove the entry [invalid-lock]`);
        else console.log(`  NOTE: ${rid} in ${shortPath(l.file)} is legacy migration residue (${rlock.source}) — pending migration: re-run \`oas migrate --dir ${shortPath(l.level)}\` when its official package publishes, or remove the entry if the capability is abandoned`);
      }
    }
  }
  // Capability provenance mismatch: a config from: installed capability that no visible package or store provides is already reported above.

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
  if (!src || src.startsWith("--")) { restore(dir); return; }
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

/** Bare `oas install`: exact restore of the current chain — locked packages
 * (lock v2) plus legacy locked capabilities (v1). NO team-boundary recursion. */
function restore(dir) {
  let pkgReport, report;
  try { pkgReport = restorePackages(dir); report = restoreCapabilities(dir); }
  catch (e) { JSON_MODE ? jsonFail(e.code || "invalid-lock", e.message || e) : die(e.message || e); return; }
  // EVERY unsuccessful status is a failure (reviewer-6f0a3bd: "unrestorable"
  // and "retired" must not report ok); each carries an appropriate frozen code.
  const UNSUCCESSFUL = { failed: undefined, unrestorable: "invalid-source", retired: "retired-capability" };
  const failures = [...pkgReport, ...report]
    .filter((r) => Object.hasOwn(UNSUCCESSFUL, r.status))
    .map((r) => ({ ...r, code: r.code || UNSUCCESSFUL[r.status] || "integrity-drift" }));
  if (JSON_MODE) {
    if (failures.length) {
      // Frozen failure envelope shape EXACTLY { schemaVersion, ok:false, error };
      // propagate the first failure's taxonomy code (per-artifact detail in message).
      const first = failures[0];
      jsonFail(first.code, failures.map((f) => `${f.package || f.id || "(lock)"}: ${f.reason}`).join("; "));
      return;
    }
    jsonOk({ packages: pkgReport, capabilities: report });
    return;
  }
  if (!pkgReport.length && !report.length) { console.log("Nothing to restore — no locked packages or capabilities in the config chain."); return; }
  let failed = 0;
  for (const r of pkgReport) {
    if (r.status === "ok") console.log(`ok        package ${r.package}  (${shortPath(r.dir)})`);
    else if (r.status === "restored") console.log(`restored  package ${r.package} → ${shortPath(r.dir)}`);
    else if (r.status === "legacy") console.log(`LEGACY    ${shortPath(join(r.level, OAS_LOCK_FILE))}: ${r.reason}`);
    else { failed++; console.log(`FAILED    package ${r.package ?? "(lock)"}  ${r.reason}`); }
  }
  for (const r of report) {
    if (r.status === "present") console.log(`ok        ${r.id}  (${shortPath(r.dir)})`);
    else if (r.status === "restored") console.log(`restored  ${r.id} → ${shortPath(r.dir)}  (${r.integrity})`);
    else if (r.status === "retired") console.log(`RETIRED   ${r.id}  ${r.reason}`);
    else { failed++; console.log(`FAILED    ${r.id}  ${r.reason}`); }
  }
  if (failed) die(`${failed} artifact${failed > 1 ? "s" : ""} could not be restored`);
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
  if (existsSync(file)) die(`${shortPath(file)} already exists — edit it or use \`oas use\``);

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
                                            marketplace capability; bare \`oas install\`
                                            exactly restores this chain's locked
                                            packages + capabilities; never activates
  oas list [--dir <d>] [--json]             installed packages, exported capabilities,
                                            scopes, trust state
  oas update <package> [--dir <d>]          transactional package update: temp fetch,
                                            closure validation, diff, lock replace,
                                            all capability approvals invalidated
  oas remove <package> [--dir <d>]          remove a package (refuses while config or
                                            dependent packages reference it)
  oas migrate [--dry-run] [--dir <d>]       map this scope's v1 capability locks to
                                            package locks (preserves config activation)
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
      [--template <name|path|git-url>]      seed from a template config (named via
      [--knowledge <id|none>]               outer templates: map, a local file, or a
      [--messaging <id|none>]               git repo's default-branch oas-config.yaml);
      [--tasks <id|none>]                   or per-layer overrides of the defaults;
      [--tmux-mouse|--no-tmux-mouse]        prompts to enable normal tmux scrolling
  oas root                                  print this package's install root
                                            (adapters resolve the kernel from it)
  oas <namespace> <command> [args…]         run an operational command only when its
                                            capability is active (e.g. oas okf harvest)

Layers: ${LAYERS.join(", ")}. Level detection: ~ → laptop, .git → repo, else workspace.`);
  process.exit(cmd && !["help", "--help", "-h"].includes(cmd) ? 1 : 0);
}
