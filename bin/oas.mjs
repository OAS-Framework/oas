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
  LAYERS, LEGACY_HOME_CAPABILITIES_DIR, OAS_LOCK_FILE, configChain,
  acquireCapability, restoreCapabilities,
  capabilityManifests, capabilityManifest, capabilityMissingRequires, capabilityIntegrity, capabilityTrust, capabilityExecutablePath,
  readCapabilityLocks, writeCapabilityLock,
  resolveOasConfig, resolveWorkMode, composeInstanceAgentsMd,
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

  console.log("Config chain (closest first):");
  if (chain.length === 0) console.log("  (none — no oas-config.yaml found walking up)");
  for (const c of chain) {
    console.log(`  ${shortPath(c._file)}  [${levelOf(c._level)}]`);
  }

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

  for (const mode of ["worktree", "checkout", "attached"]) {
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

// ---------- config editing (textual, minimal, idempotent) ----------
function upsertLayerLine(text, layer, value) {
  const layerLine = `  ${layer}: ${value}`;
  if (/^layers:\s*$/m.test(text)) {
    const re = new RegExp(`^(layers:\\s*\\n(?:  [^\\n]*\\n)*?)  ${layer}:[^\\n]*\\n`, "m");
    if (re.test(text)) return text.replace(re, `$1${layerLine}\n`);
    return text.replace(/^(layers:\s*\n)/m, `$1${layerLine}\n`);
  }
  return text.replace(/\n*$/, "\n\n") + `layers:\n${layerLine}\n`;
}
function removeLayerLine(text, layer) {
  return text.replace(new RegExp(`^  ${layer}:[ \\t]*none[ \\t]*(?:#.*)?\\n?`, "m"), "");
}
function upsertCapabilityBinding(text, id, targetKind, targetName, enabled, source) {
  const lines = text.replace(/\n*$/, "").split("\n");
  let root = lines.findIndex((line) => /^capabilities:\s*$/.test(line));
  if (root < 0) { lines.push("", "capabilities:"); root = lines.length - 1; }
  let rootEnd = lines.length;
  for (let i = root + 1; i < lines.length; i++) if (/^[^ ]/.test(lines[i]) && lines[i].trim()) { rootEnd = i; break; }
  let start = -1;
  for (let i = root + 1; i < rootEnd; i++) if (lines[i] === `  ${id}:`) { start = i; break; }
  if (start < 0) {
    const block = [`  ${id}:`, ...(source ? [`    source: ${source}`] : []), ...(targetKind === "global" ? [`    global: ${enabled}`] : [`    ${targetKind}:`, `      ${targetName}: ${enabled}`])];
    lines.splice(root + 1, 0, ...block); return lines.join("\n") + "\n";
  }
  let end = rootEnd;
  for (let i = start + 1; i < rootEnd; i++) if (/^  [^ ]/.test(lines[i])) { end = i; break; }
  if (source && !lines.slice(start + 1, end).some((line) => /^    source:/.test(line))) { lines.splice(start + 1, 0, `    source: ${source}`); end++; }
  if (targetKind === "global") {
    const at = lines.slice(start + 1, end).findIndex((line) => /^    global:/.test(line));
    if (at >= 0) lines[start + 1 + at] = `    global: ${enabled}`;
    else lines.splice(end, 0, `    global: ${enabled}`);
    return lines.join("\n") + "\n";
  }
  let section = -1;
  for (let i = start + 1; i < end; i++) if (lines[i] === `    ${targetKind}:`) { section = i; break; }
  if (section < 0) lines.splice(end, 0, `    ${targetKind}:`, `      ${targetName}: ${enabled}`);
  else {
    let sectionEnd = end;
    for (let i = section + 1; i < end; i++) if (/^    [^ ]/.test(lines[i])) { sectionEnd = i; break; }
    const at = lines.slice(section + 1, sectionEnd).findIndex((line) => line.startsWith(`      ${targetName}:`));
    if (at >= 0) lines[section + 1 + at] = `      ${targetName}: ${enabled}`;
    else lines.splice(sectionEnd, 0, `      ${targetName}: ${enabled}`);
  }
  return lines.join("\n") + "\n";
}

// ---------- use / activation ----------
function use() {
  const requested = args[1];
  if (!requested || requested.startsWith("--")) die("usage: oas use <capability|none> [--global|--group <name>|--soul <name>] [--disable] [--layer <name>] [--dir <dir>]");
  const dir = resolve(flag("dir") || process.cwd());
  const level = levelOf(dir);
  const file = join(dir, "oas-config.yaml");
  const layer = flag("layer");
  if (layer && !LAYERS.includes(layer)) die(`--layer must be one of: ${LAYERS.join(", ")}`);
  if (requested === "none") {
    if (!layer) die("oas use none requires --layer <name>");
    let text = existsSync(file) ? readFileSync(file, "utf8") : `name: ${basename(dir)}\n`;
    writeFileSync(file, upsertLayerLine(text, layer, "none"));
    console.log(`Disabled fundamental layer ${layer} at ${level} level (${shortPath(file)})`);
    return;
  }
  const manifest = capabilityManifest(requested, dir);
  if (!manifest) die(`unknown capability "${requested}" (acquired: ${Object.keys(capabilityManifests(dir)).join(", ") || "none"}) — acquire it with oas install`);
  if (layer) die("--layer is only valid with `oas use none`; integrations declare their layer in oas.json");
  const targets = [["groups", flag("group")], ["souls", flag("soul")]].filter(([, value]) => value);
  if (args.includes("--global")) targets.push(["global", undefined]);
  if (targets.length > 1) die("choose exactly one of --global, --group, or --soul");
  const [targetKind, targetName] = targets[0] || ["global", undefined];
  const enabled = !args.includes("--disable");
  let text = existsSync(file) ? readFileSync(file, "utf8") : `name: ${basename(dir)}\n`;
  if (enabled && manifest.layer) text = removeLayerLine(text, manifest.layer);
  text = upsertCapabilityBinding(text, manifest.capability, targetKind, targetName, enabled, manifest._origin === "bundled" ? "bundled" : undefined);
  writeFileSync(file, text.replace(/\n*$/, "\n"));
  console.log(`${enabled ? "Activated" : "Excluded"} ${manifest.capability} for ${targetKind === "global" ? "global" : `${targetKind.slice(0, -1)} ${targetName}`} at ${level} level (${shortPath(file)})`);
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
    console.log(`${known._origin === "bundled" ? "Acquired bundled" : "Already acquired"} capability ${known.capability} (${known.version || "unversioned"}); not activated or updated.`);
    return;
  }
  let r;
  try { r = acquireCapability(dir, src); } catch (e) { die(e.message); }
  const lock = {
    source: r.source,
    version: r.manifest.version || null,
    ...(r.commit ? { commit: r.commit } : {}), integrity: r.integrity,
    trustedExecutables: false,
  };
  const lockFile = writeCapabilityLock(dir, r.manifest.capability, lock);
  console.log(`Acquired ${r.manifest.capability} → ${shortPath(r.dest)}`);
  console.log(`Locked ${r.manifest.version || r.commit || "exact artifact"} (${r.integrity}) in ${shortPath(lockFile)}; not activated.`);
  if (r.manifest.commands || r.manifest.hooks) console.log(`Executable surface is blocked until: oas trust ${r.manifest.capability} --dir ${shortPath(dir)}`);
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
  if (manifest._origin === "bundled") { console.log(`${manifest.capability} is bundled and already trusted.`); return; }
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
  const mans = capabilityManifests(dir);
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
  const layers = { ...defaults, ...overrides };
  let text = `name: ${basename(dir)}\n# Acquisition and activation are separate: only explicit global bindings below are active.\n`;
  const disabled = [];
  for (const layer of LAYERS) {
    const selected = layers[layer];
    if (!selected) continue;
    if (selected === "none") { disabled.push(layer); continue; }
    const manifest = capabilityManifest(selected, dir);
    text = upsertCapabilityBinding(text, manifest.capability, "global", undefined, true, manifest._origin === "bundled" ? "bundled" : undefined);
  }
  if (disabled.length) text += `\nlayers:\n${disabled.map((l) => `  ${l}: none`).join("\n")}\n`;
  writeFileSync(file, text.replace(/\n*$/, "\n"));
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

function spawnCmd() {
  const name = args[1];
  if (!name || name.startsWith("--")) die("usage: oas spawn <agent> [--task <text>|--task-file <f>] [--purpose <slug>] [--repo <r>] [--work worktree|checkout|attached] [--work-dir <owner-work>] [--model <m>] [--branch <b>] [--instructions-file <f>|--def-file <f>] [--no-launch] [--json]");
  const root = ensureRoot(flag("dir") || process.cwd());
  let agent = findAgent(root, name);
  // tmp agents: create/update from raw instructions or a single-file def
  const instrFile = flag("instructions-file");
  const defFile = flag("def-file");
  if (instrFile || defFile || !agent) {
    if (!agent && !instrFile && !defFile) {
      const def = listAgentDefs(process.cwd()).find((d) => d.name === name);
      if (!def) die(`unknown agent "${name}" (known: ${listAgents(root).map((a) => a.name).join(", ") || "none"}; importable defs: ${listAgentDefs(process.cwd()).map((d) => d.name).join(", ") || "none"}) — pass --instructions-file or --def-file to create a local agent`);
      agent = upsertTmpAgent(root, { name: def.name, file: def.path, repo: flag("repo"), work: flag("work"), model: flag("model") });
    } else if (!agent || agent.kind === "tmp") {
      agent = upsertTmpAgent(root, {
        name, file: defFile, instructions: instrFile ? readFileSync(instrFile, "utf8") : undefined,
        repo: flag("repo"), work: flag("work"), model: flag("model"),
      });
    } else {
      die(`"${name}" is a persistent agent — spawn it without --instructions-file/--def-file`);
    }
  }
  const r = spawnInstance(root, agent, {
    purpose: flag("purpose"), task: flag("task"), taskFile: flag("task-file"),
    repo: flag("repo") || agent.repo || defaultRepo(process.cwd()),
    work: flag("work"), workDir: flag("work-dir"), model: flag("model"), branch: flag("branch"),
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
  const root = ensureRoot(flag("dir") || process.cwd());
  const r = retireInstance(root, name, { self: isSelf, deleteBranch: args.includes("--delete-branch"), keepDir: args.includes("--keep-dir") });
  if (args.includes("--json")) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`Retired ${r.retired} (agent ${r.agent})${r.worktreeRemoved ? ", worktree removed" : ""}${r.branchDeleted ? ", branch deleted" : ""}${r.harvested?.length ? `, harvested: ${r.harvested.join(", ")}` : ""}`);
  if (isSelf) console.log("This window dies in ~8s — say any goodbyes now.");
}

async function paneCmd() {
  const root = ensureRoot(flag("dir") || process.cwd());
  const { startControlPane } = await import("../lib/control-pane/tui.mjs");
  try { await startControlPane(root); }
  catch (error) { die(error.message || String(error)); }
}

function createCmd() {
  const name = args[1];
  if (!name || name.startsWith("--")) die("usage: oas create <name> [--description <d>] [--repo <r>] [--work worktree|checkout|attached] [--runtime pi|claude] [--model <m>] [--instructions-file <f>]");
  const root = ensureRoot(flag("dir") || process.cwd());
  const instrFile = flag("instructions-file");
  const r = coreCreateAgent(root, {
    name, description: flag("description"), repo: flag("repo") || defaultRepo(process.cwd()),
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
  const instanceHome = process.env.PI_AGENT_HOME || process.env.OAS_HOME;
  const metaFile = instanceHome && join(instanceHome, "instance.json");
  if (metaFile && existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, "utf8"));
    activeIds = (meta.capabilities || []).map((c) => c.id);
    context = meta.repo || context;
  } else activeIds = resolveOasConfig(context, flag("soul")).capabilities.map((c) => c.id);
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
  const r = spawnSync("node", [abs, ...rest, ...args.slice(2)], { stdio: "inherit", env: { ...process.env, OAS_CAPABILITY: m.capability } });
  process.exit(r.status ?? 1);
}

// ---------- main ----------
if (cmd === "doctor") {
  const doctorDir = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  args.includes("--json") ? doctorJson(doctorDir) : doctor(doctorDir);
}
else if (cmd === "use") use();
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
  oas pane [--dir <dir>]                    open Control Pane, the live agent TUI
  oas create <name> [--description <d>]     create a persistent agent soul
      [--repo <r>] [--work <mode>] [--runtime pi|claude] [--model <m>]
      [--instructions-file <f>]
  oas spawn <agent> [--task <text>]         spawn an instance (tmux; --no-launch
      [--purpose <slug>] [--repo <r>]       = scaffold only); --instructions-file/
      [--work worktree|checkout|attached]   --def-file create a local (tmp) agent
      [--work-dir <owner-work>] [--model <m>] [--branch <b>]
      [--instructions-file <f>|--def-file <f>] [--no-launch] [--json]
  oas retire <instance>                     retire an instance (window, hooks,
      [--self] [--delete-branch]            worktree, home); --self = retire the
      [--keep-dir] [--json]                 CALLING instance (delayed window kill)
  oas doctor [dir] [--soul <name>] [--json] resolved targets, trust, requirements;
                                            --soul shows final composed AGENTS.md
  oas install [<id|git-url|path>] [--dir <d>] acquire + lock into <level>/.agents/
                                            capabilities/installed/; bare \`oas install\`
                                            restores locked-but-missing artifacts;
                                            acquisition never activates
  oas trust <capability> [--dir <dir>]      approve executable commands/hooks for
                                            the currently locked integrity
  oas use <capability>                      activate for one config-owned target
      [--global|--group <g>|--soul <s>]     (--global is default); --disable excludes
      [--disable] [--dir <d>]
  oas use none --layer <layer>              explicitly disable a fundamental layer
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
