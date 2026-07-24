#!/usr/bin/env node
/**
 * oas — the OAS command line.
 *
 *   oas pane                               open the live Control Pane TUI
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { enableTmuxMouse, tmuxConfigPath, tmuxMouseEnabled } from "../lib/tmux-config.mjs";
import {
  LAYERS, LEGACY_HOME_CAPABILITIES_DIR, OAS_LOCK_FILE, OAS_VERSION, configChain,
  acquireCapability, restoreCapabilities, marketplaceCapabilities,
  capabilityManifests, capabilityManifest, capabilityMissingRequires, capabilityIntegrity, capabilityTrust, capabilityExecutablePath,
  readCapabilityLocks, writeCapabilityLock,
  resolveOasConfig, resolveWorkMode, composeInstanceAgentsMd, parseYamlNested, packagedInject, teamAgentRoots,
  findTeamAgent, findTeamInstance, findCapabilityAgent, findInstanceHome, listCapabilityAgents, workspaceOf,
  ensureRoot, findRoot, findAgent, listAgents, listInstances, listAgentDefs, createAgent as coreCreateAgent,
  spawnInstance, retireInstance, upsertTmpAgent, defaultRepo,
} from "../lib/core.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : undefined;
};
const die = (msg) => { console.error(`oas: ${msg}`); process.exit(1); };

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
function doctorComposition(ctx, soulName) {
  if (!soulName) return undefined;
  const root = findRoot(ctx);
  const agent = root && findAgent(root, soulName);
  if (!agent) throw new Error(`unknown soul "${soulName}" for doctor composition`);
  return composeInstanceAgentsMd(join(agent._dir, "soul"), ctx, agent.name, agent.work || "checkout");
}
function doctorJson(dir) {
  const ctx = resolve(dir || process.cwd());
  const soulName = flag("soul");
  const r = resolveOasConfig(ctx, soulName);
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
    composedInstructions: composition?.text,
    instructionBlocks: composition?.blocks,
  }, null, 2));
}

function doctor(dir) {
  const ctx = resolve(dir || process.cwd());
  const soulName = flag("soul");
  const chain = configChain(ctx);
  const r = resolveOasConfig(ctx, soulName);
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
  }
  const locks = readCapabilityLocks(ctx);
  const mans = capabilityManifests(ctx);
  for (const [id, lock] of Object.entries(locks)) {
    if (!mans[id]) console.log(`  WARNING: ${id} is locked in ${shortPath(lock._file)} but not acquired — run \`oas install\``);
  }
  for (const [id, m] of Object.entries(mans)) {
    if (String(m._origin).startsWith("installed:") && !locks[id]) console.log(`  WARNING: ${id} at ${shortPath(m._dir)} is in installed/ but has no lock entry — reacquire it or move it to owned/`);
  }
  if (existsSync(LEGACY_HOME_CAPABILITIES_DIR)) console.log(`  WARNING: legacy ~/.oas/capabilities exists and is no longer discovered — reinstall its packages at a config scope and remove it`);
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
  const dir = resolve(flag("dir") || process.cwd());
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

// ---------- install / trust ----------
function install() {
  const src = args[1];
  const dir = resolve(flag("dir") || process.cwd());
  if (!src || src.startsWith("--")) { restore(dir); return; }
  const known = capabilityManifest(src, dir);
  if (known) {
    console.log(`Already acquired capability ${known.capability} (${known.version || "unversioned"}); not activated or updated.`);
    return;
  }
  let r;
  try { r = acquireCapability(dir, src); } catch (e) { die(e.message); }
  const lock = {
    source: r.source,
    version: r.manifest.version || null,
    ...(r.commit ? { commit: r.commit } : {}), integrity: r.integrity,
    // Marketplace packages ship with the kernel you already installed — they are
    // trusted at acquisition; third-party git/path installs need explicit `oas trust`.
    trustedExecutables: !!r.marketplace,
  };
  const lockFile = writeCapabilityLock(dir, r.manifest.capability, lock);
  console.log(`Acquired ${r.manifest.capability} → ${shortPath(r.dest)}`);
  console.log(`Locked ${r.manifest.version || r.commit || "exact artifact"} (${r.integrity}) in ${shortPath(lockFile)}; not activated.`);
  if (r.marketplace) console.log("Marketplace package: executables trusted at acquisition.");
  else if (r.manifest.commands || r.manifest.hooks) console.log(`Executable surface is blocked until: oas trust ${r.manifest.capability} --dir ${shortPath(dir)}`);
}

/** Bare `oas install`: restore every locked-but-missing capability in the config chain. */
function restore(dir) {
  const report = restoreCapabilities(dir);
  if (!report.length) { console.log("Nothing to restore — no locked capabilities in the config chain."); return; }
  let failed = 0;
  for (const r of report) {
    if (r.status === "present") console.log(`ok        ${r.id}  (${shortPath(r.dir)})`);
    else if (r.status === "restored") console.log(`restored  ${r.id} → ${shortPath(r.dir)}  (${r.integrity})`);
    else { failed++; console.log(`FAILED    ${r.id}  ${r.reason}`); }
  }
  if (failed) die(`${failed} capabilit${failed > 1 ? "ies" : "y"} could not be restored`);
}

function trust() {
  const id = args[1];
  if (!id || id.startsWith("--")) die("usage: oas trust <capability> [--dir <dir>]");
  const dir = resolve(flag("dir") || process.cwd());
  const manifest = capabilityManifest(id, dir);
  if (!manifest) die(`unknown capability "${id}"`);
  const lock = readCapabilityLocks(dir)[manifest.capability];
  if (!lock) die(`${manifest.capability} is not locked in ${OAS_LOCK_FILE}`);
  const integrity = capabilityIntegrity(manifest._dir);
  if (integrity !== lock.integrity) die(`integrity changed (${lock.integrity} → ${integrity}); reacquire explicitly before trusting`);
  const { _file, ...clean } = lock;
  writeCapabilityLock(dirname(_file), manifest.capability, { ...clean, trustedExecutables: true });
  console.log(`Trusted executable commands/hooks for ${manifest.capability} at ${integrity}.`);
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
  const dir = resolve(flag("dir") || process.cwd());
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
        writeCapabilityLock(dir, r.manifest.capability, {
          source: r.source, version: r.manifest.version || null, integrity: r.integrity, trustedExecutables: true,
        });
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
    console.log(`  ${a.name}${a.kind === "tmp" ? " (local)" : ""}  [work: ${a.work || "checkout"}, repo: ${a.repo || "?"}]`);
    if (a.description) console.log(`      ${a.description}`);
    for (const i of a.instances) {
      console.log(`      • ${i.instance}  ${i.running ? "RUNNING" : "idle"}  (branch ${i.branch || "?"}, ${i.work || "?"})`);
    }
  }
  const defs = listAgentDefs(process.cwd());
  if (defs.length) console.log(`\n  importable defs: ${defs.map((d) => d.name).join(", ")}`);
}

function statusTeam() {
  const ctx = resolve(flag("dir") || process.cwd());
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
      console.log(`    ${a.name}${a.kind === "tmp" ? " (local)" : ""}${a.description ? `  — ${a.description}` : ""}`);
      for (const i of a.instances) console.log(`      • ${i.instance}  ${i.running ? "RUNNING" : "idle"}`);
    }
  }
}

function spawnCmd() {
  const name = args[1];
  if (!name || name.startsWith("--")) die("usage: oas spawn <agent> [--task <text>|--task-file <f>] [--purpose <slug>] [--parent <instance>] [--repo <r>] [--work worktree|checkout|attached|workspace] [--work-dir <owner-work>] [--runtime pi|claude] [--model <m>] [--branch <b>] [--instructions-file <f>|--def-file <f>] [--no-launch] [--json]");
  let root = ensureRoot(flag("dir") || process.cwd());
  let agent = findAgent(root, name);
  const instrFile = flag("instructions-file");
  const defFile = flag("def-file");
  if (!agent && !instrFile && !defFile) {
    // Capability-defined agent: a package's `agents:` soul, active in this context.
    const capAgent = findCapabilityAgent(flag("dir") || process.cwd(), root, name);
    if (capAgent) {
      agent = capAgent;
      console.log(`(capability agent: "${name}" from ${capAgent.capability} — fresh soul, instances home locally)`);
    }
  }
  if (!agent && !instrFile && !defFile) {
    // Cross-repo lookup: the soul may live in a sibling repo of the team scope.
    // Unique match wins; the instance homes with its owning repo's agents root.
    const teamHit = findTeamAgent(flag("dir") || process.cwd(), name);
    const remote = (teamHit?.matches || []).filter((m) => resolve(m.root) !== resolve(root));
    if (remote.length > 1) die(`soul "${name}" found in multiple team repos: ${remote.map((m) => shortPath(m.root)).join(", ")} — re-run with --dir <that repo>`);
    if (remote.length === 1) {
      root = remote[0].root;
      agent = remote[0].agent;
      console.log(`(cross-repo: soul "${name}" found at ${shortPath(root)} — instance homes there)`);
    }
  }
  // tmp agents: create/update from raw instructions or a single-file def
  if (instrFile || defFile || !agent) {
    if (!agent && !instrFile && !defFile) {
      const def = listAgentDefs(process.cwd()).find((d) => d.name === name);
      if (!def) die(`unknown agent "${name}" (known: ${listAgents(root).map((a) => a.name).join(", ") || "none"}; importable defs: ${listAgentDefs(process.cwd()).map((d) => d.name).join(", ") || "none"}) — pass --instructions-file or --def-file to create a local agent`);
      agent = upsertTmpAgent(root, { name: def.name, file: def.path, repo: flag("repo"), work: flag("work"), runtime: flag("runtime"), model: flag("model") });
    } else if (!agent || agent.kind === "tmp") {
      agent = upsertTmpAgent(root, {
        name, file: defFile, instructions: instrFile ? readFileSync(instrFile, "utf8") : undefined,
        repo: flag("repo"), work: flag("work"), runtime: flag("runtime"), model: flag("model"),
      });
    } else {
      die(`"${name}" is a persistent agent — spawn it without --instructions-file/--def-file`);
    }
  }
  // Lineage is explicit: --parent names the parent instance (agents spawning
  // sub-agents pass their own name, e.g. --parent "$OAS_INSTANCE"). Without it,
  // the spawn is operator-origin and lands top-level — ambient env vars in the
  // shell are never treated as parentage.
  const parent = flag("parent");
  if (parent !== undefined && (parent === true || !String(parent).trim())) die("--parent needs an instance name");
  if (parent) {
    // findInstanceHome also sees capability-defined agents' instance homes
    // (local-agents/<name>/ without a local soul) — e.g. a reviewer passing
    // --parent "$OAS_INSTANCE" from a capability agent.
    if (!findInstanceHome(root, parent) && !findTeamInstance(flag("dir") || process.cwd(), parent)) die(`--parent "${parent}" does not match any known instance`);
  }
  const taskText = flag("task");
  if (taskText === true) die("--task needs a value (use --task-file for long tasks)");
  const taskFileFlag = flag("task-file");
  if (taskFileFlag === true) die("--task-file needs a path");
  if (taskFileFlag && !existsSync(taskFileFlag)) die(`--task-file not found: ${taskFileFlag}`);
  const r = spawnInstance(root, agent, {
    purpose: flag("purpose"), task: taskText, taskFile: taskFileFlag, parent,
    repo: flag("repo") || agent.repo || defaultRepo(workspaceOf(root)) || defaultRepo(process.cwd()),
    work: flag("work"), workDir: flag("work-dir"), runtime: flag("runtime"), model: flag("model"), branch: flag("branch"),
    launch: !args.includes("--no-launch"),
  });
  if (args.includes("--json")) { console.log(JSON.stringify(r, null, 2)); return; }
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
  const root = ensureRoot(flag("dir") || process.cwd());
  const { startControlPane } = await import("../lib/control-pane/tui.mjs");
  try { await startControlPane(root, { theme: flag("theme") }); }
  catch (error) { die(error.message || String(error)); }
}

function createCmd() {
  const name = args[1];
  if (!name || name.startsWith("--")) die("usage: oas create <name> [--description <d>] [--type <agent-type>] [--repo <r>] [--work worktree|checkout|attached|workspace] [--runtime pi|claude] [--model <m>] [--instructions-file <f>]");
  const root = ensureRoot(flag("dir") || process.cwd());
  const instrFile = flag("instructions-file");
  const r = coreCreateAgent(root, {
    name, description: flag("description"), type: flag("type"), repo: flag("repo") || defaultRepo(process.cwd()),
    work: flag("work"), runtime: flag("runtime"), model: flag("model"),
    instructions: instrFile ? readFileSync(instrFile, "utf8") : undefined,
  });
  if (args.includes("--json")) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`Created agent "${r.agent}" — soul at ${shortPath(r.soul)}`);
  console.log(`Edit ${shortPath(join(r.soul, "AGENTS.md"))} to define its role, then: oas spawn ${r.agent} --task "..."`);
}

// ---------- capability command dispatch ----------
/**
 * oas <namespace> <command> [args…] — run a command an active capability
 * declares in its manifest (`commands: { name: "script args" }`).
 * Kernel subcommands take precedence over capability namespaces.
 */
function capabilityCommand() {
  let activeIds;
  let context = process.cwd();
  let teamCtx;
  const instanceHome = process.env.PI_AGENT_HOME || process.env.OAS_HOME;
  const metaFile = instanceHome && join(instanceHome, "instance.json");
  if (metaFile && existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, "utf8"));
    activeIds = (meta.capabilities || []).map((c) => c.id);
    context = meta.repo || context;
    // Team: the spawn-time snapshot, but fall back to live config — instances
    // spawned before a team: block was declared have no snapshot.
    teamCtx = meta.team || resolveOasConfig(context).team;
  } else {
    const resolved = resolveOasConfig(context, flag("soul"));
    activeIds = resolved.capabilities.map((c) => c.id);
    teamCtx = resolved.team;
  }
  const mans = Object.values(capabilityManifests(context)).filter((m) => m.command === cmd && m.commands);
  if (!mans.length) return false;
  if (mans.length > 1) die(`duplicate operational command namespace "${cmd}": ${mans.map((m) => m.capability).join(", ")}`);
  const m = mans[0];
  if (!activeIds.includes(m.capability)) die(`${m.capability} command namespace is not active in the current context/instance`);
  const trust = capabilityTrust(m, context);
  if (!trust.trusted) die(`${m.capability} executable command is blocked: ${trust.reason}`);
  const sub = args[1];
  const cmds = Object.keys(m.commands);
  if (!sub || !m.commands[sub]) {
    console.error(`oas ${cmd} — commands: ${cmds.join(", ") || "(none)"}`);
    process.exit(sub ? 1 : 0);
  }
  const [script, ...rest] = m.commands[sub].split(/\s+/);
  let abs;
  try { abs = capabilityExecutablePath(m, script); }
  catch (e) { die(e.message); }
  if (!abs) die(`${cmd} ${sub}: script not found (${join(m._dir, script)})`);
  const r = spawnSync("node", [abs, ...rest, ...args.slice(2)], { stdio: "inherit", env: {
    ...process.env, OAS_CAPABILITY: m.capability,
    OAS_TEAM_NAME: teamCtx?.name || "", OAS_TEAM_ID: teamCtx?.id || "", OAS_TEAM_SCOPE: teamCtx?.scope || "",
  } });
  process.exit(r.status ?? 1);
}

// ---------- agent types ----------
function typeCmd() {
  const sub = args[1];
  const dir = resolve(flag("dir") || process.cwd());
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
  const dir = resolve(flag("dir") || process.cwd());
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

// ---------- main ----------
if (cmd === "doctor") {
  const doctorDir = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  args.includes("--json") ? doctorJson(doctorDir) : doctor(doctorDir);
}
else if (cmd === "use") use();
else if (cmd === "update") updateCmd();
else if (cmd === "type") typeCmd();
else if (cmd === "inject") injectCmd();
else if (cmd === "install") install();
else if (cmd === "trust") trust();
else if (cmd === "root") console.log(resolve(new URL("..", import.meta.url).pathname));
else if (cmd === "init") init();
else if (cmd === "status") status();
else if (cmd === "pane") await paneCmd();
else if (cmd === "spawn") spawnCmd();
else if (cmd === "retire") retireCmd();
else if (cmd === "create") createCmd();
else if (cmd && !cmd.startsWith("--") && capabilityCommand()) { /* dispatched */ }
else {
  console.log(`oas — Open Agent Specialization

Usage:
  oas status [--json]                       agents, souls, running instances
  oas status --team [--json]                whole-team roster across the team scope's repos
  oas pane [--dir <dir>] [--theme dark|solarized]  open Control Pane, the live agent TUI
  oas create <name> [--description <d>]     create a persistent agent soul
      [--repo <r>] [--work <mode>] [--runtime pi|claude] [--model <m>]
      [--instructions-file <f>]
  oas spawn <agent> [--task <text>]         spawn an instance (tmux; --no-launch
      [--purpose <slug>] [--repo <r>]       = scaffold only); --instructions-file/
      [--parent <instance>]                 --def-file creates a local (tmp) agent;
      [--work worktree|checkout|attached|workspace]  --parent nests under an existing
      [--work-dir <owner-work>] [--runtime pi|claude] [--model <m>] [--branch <b>]  instance (default: top-level)
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
  oas install [<id|git-url|path>] [--dir <d>] acquire + lock into <level>/.agents/
                                            capabilities/installed/; bare \`oas install\`
                                            restores locked-but-missing artifacts;
                                            acquisition never activates
  oas trust <capability> [--dir <dir>]      approve executable commands/hooks for
                                            the currently locked integrity
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
