/**
 * OAS distribution packages — WS2 policy layer (config bootstrap and workspace
 * reconciliation) over the package ENGINE in lib/core.mjs.
 *
 * The engine owns source parsing, manifests, the store, lock v2, acquisition,
 * exact restore, capability indexing, and trust (docs/design/
 * package-engine-contract.md + package-runtime-api.md). This module carries
 * ONLY what the Decision assigns to workstream 2:
 *   - config profile selection/validation/provenance and the report-only diff;
 *   - team-boundary workspace scope discovery (pruned, deterministic);
 *   - host-requirement consent policy (identity/conflict fail-closed, plans).
 *
 * Runtime-neutral and dependency-free, like lib/core.mjs.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  OAS_LOCK_FILE, findRoot, listAgents, listInstalledPackages, loadPackageManifestAt, packageSpecIdentity,
  parseYamlNested, readPackageLocks, resolveOasConfig, RUNTIME_PACKAGE_MANAGERS,
  runtimePackageInstalled, runtimePackageIdentity, runtimePackageStatus, safeRuntimePackageSpec,
  safeRuntimeSourceRef, validateConfigShape,
} from "./core.mjs";

// Runtime-package primitives live in the ENGINE (core.mjs) so spawn can use them
// without this policy module being imported from there. Re-exported here because
// the consent policy is this module's public surface.
export { packageSpecIdentity, RUNTIME_PACKAGE_MANAGERS, runtimePackageIdentity, runtimePackageInstalled, runtimePackageStatus, safeRuntimePackageSpec };

/** Throw an Error carrying a stable contract error code (engine taxonomy §4 + WS2 codes). */
function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  throw e;
}

// ---------- config profiles ----------

/** Choose a profile: explicit name, else the single marked default, else the only profile.
 * Multiple unmarked profiles require an explicit choice. Thrown errors carry
 * typed WS2 codes: E_NO_PROFILES, E_PROFILE_NOT_FOUND, E_PROFILE_AMBIGUOUS. */
export function selectProfile(manifest, name) {
  const configs = manifest.configs || {};
  const names = Object.keys(configs);
  if (!names.length) fail("E_NO_PROFILES", `package ${manifest.package} exports no config profiles`);
  if (name) {
    if (!configs[name]) fail("E_PROFILE_NOT_FOUND", `package ${manifest.package} has no config profile "${name}" (profiles: ${names.join(", ")})`);
    return { name, ...configs[name] };
  }
  const marked = names.filter((n) => configs[n].default);
  if (marked.length === 1) return { name: marked[0], ...configs[marked[0]] };
  if (names.length === 1) return { name: names[0], ...configs[names[0]] };
  fail("E_PROFILE_AMBIGUOUS", `package ${manifest.package} has multiple config profiles and none marked default (${names.join(", ")}) — pass --config <name>`);
}

/** Read a profile's config text from a loaded package manifest (engine
 * loadPackageManifestAt output — profile paths are already containment-checked
 * by the engine's manifest validation). */
export function readProfileText(manifest, profile) {
  const abs = join(manifest._dir, profile.path);
  if (!existsSync(abs)) fail("invalid-package-manifest", `package ${manifest.package}: config profile "${profile.name}" file missing: ${profile.path}`);
  return readFileSync(abs, "utf8");
}

const AGENT_TYPE_RE = /^[a-z][a-z0-9-]*$/;

/** Validate one package config profile before adoption. Returns a list of error strings (empty = valid).
 * Checks (per the Decision §3): config schema validity; every referenced
 * installed capability supplied by the package or its dependency closure;
 * referenced layers agree with the ACTUAL PROVIDER's capability manifest
 * (root or dependency — reviewer-455ba15 fix 3); agent types syntactically
 * valid; no paths escaping the eventual target scope.
 * dependencyProviders: Map<capabilityId, capabilityManifest|null> — null means
 * the capability is lock-visible but its manifest is not (layer agreement is
 * then unverifiable and reported as such for layer bindings). */
export function validateProfile(manifest, profile, { dependencyProviders = new Map() } = {}) {
  const errors = [];
  const where = `profile "${profile.name}" of package ${manifest.package}`;
  let cfg;
  try {
    cfg = parseYamlNested(readProfileText(manifest, profile));
    validateConfigShape(cfg, `${where} (${profile.path})`);
  } catch (e) { return [e.message]; }

  const ownCaps = (manifest._capabilities || []).map((c) => c.id);
  const supplied = new Set([...ownCaps, ...dependencyProviders.keys()]);
  const capManifestOf = (id) => (manifest._capabilities || []).find((c) => c.id === id)?.manifest
    ?? dependencyProviders.get(id) ?? null;
  const entries = [];
  const caps = cfg.capabilities || {};
  for (const [layer, entry] of Object.entries(caps.layers || {})) {
    if (entry && typeof entry === "object") entries.push({ id: entry.capability, entry, slot: layer });
  }
  for (const [id, entry] of Object.entries(caps.additive || {})) entries.push({ id, entry: entry && typeof entry === "object" ? entry : {}, slot: undefined });

  for (const { id, entry, slot } of entries) {
    const from = String(entry.from || "installed");
    if (from.startsWith("path:")) { errors.push(`${where}: capability ${id} uses "from: ${from}" — profiles must reference installed capabilities, not host paths`); continue; }
    if (from === "installed" && !supplied.has(id)) {
      errors.push(`${where}: capability ${id} is not supplied by the package or its dependency closure (supplied: ${[...supplied].join(", ") || "none"})`);
      continue;
    }
    if (slot) {
      // Layer agreement validates against the ACTUAL provider manifest — a
      // dependency-supplied capability bound to the wrong exclusive layer must
      // not snapshot (config resolution would fail on the adopted config).
      const capMan = capManifestOf(id);
      if (capMan && capMan.layer !== slot) errors.push(`${where}: layer ${slot} binds ${id}, but its manifest declares layer "${capMan.layer || "none"}"`);
      else if (capMan === null && supplied.has(id) && !ownCaps.includes(id)) {
        errors.push(`${where}: layer ${slot} binds dependency-supplied capability ${id}, but its provider manifest is not available to verify the layer — install the dependency first`);
      }
    }
    const override = entry["injection-override"];
    if (typeof override === "string" && (isAbsolute(override) || override.split(/[\\/]/).includes(".."))) {
      errors.push(`${where}: capability ${id} injection-override escapes the target scope: ${override}`);
    }
  }
  for (const [name] of Object.entries(cfg["agent-types"] || {})) {
    if (!AGENT_TYPE_RE.test(name)) errors.push(`${where}: agent type "${name}" must be lowercase alphanumeric/hyphens`);
  }
  for (const [mode, wm] of Object.entries(cfg["work-modes"] || {})) {
    const setup = wm && typeof wm === "object" ? wm.setup : undefined;
    if (typeof setup === "string" && (isAbsolute(setup) || setup.split(/[\\/]/).includes(".."))) {
      errors.push(`${where}: work-modes.${mode}.setup escapes the target scope: ${setup}`);
    }
  }
  const oasOverride = cfg.oas && typeof cfg.oas === "object" ? cfg.oas["injection-override"] : undefined;
  if (typeof oasOverride === "string" && (isAbsolute(oasOverride) || oasOverride.split(/[\\/]/).includes(".."))) {
    errors.push(`${where}: oas.injection-override escapes the target scope: ${oasOverride}`);
  }
  return errors;
}

/** Snapshot provenance header written into an adopted profile config. */
export function profileProvenanceHeader({ pkg, version, profile, commit }) {
  const at = commit ? `@${String(commit).slice(0, 12)}` : version ? `@${version}` : "";
  return `# package: ${pkg}${at} profile: ${profile} (snapshot — package updates never rewrite this file; compare with \`oas config diff --package ${pkg} --config ${profile}\`)`;
}

/** Parse the snapshot provenance from adopted config text, or undefined. */
export function parseProfileProvenance(text) {
  const m = String(text).match(/^# package: (\S+?)(?:@(\S+))? profile: (\S+) /m);
  if (!m) return undefined;
  return { package: m[1], ref: m[2], profile: m[3] };
}

/** Line-level diff (report-only) between the local snapshot and the package's current profile text. */
export function diffConfigTexts(localText, packageText) {
  const a = String(localText).replace(/\n*$/, "").split("\n");
  const b = String(packageText).replace(/\n*$/, "").split("\n");
  // LCS-based minimal line diff — small configs, O(n*m) is fine.
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: "same", line: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ kind: "local", line: a[i] }); i++; }
    else { out.push({ kind: "package", line: b[j] }); j++; }
  }
  while (i < n) out.push({ kind: "local", line: a[i++] });
  while (j < m) out.push({ kind: "package", line: b[j++] });
  return out;
}

/** Capability ids supplied by the visible locked packages of a scope (lock v2 metadata). */
export function lockedPackageCapabilities(startDir) {
  const out = new Map(); // capability id → [package ids]
  for (const [pkgId, lock] of Object.entries(readPackageLocks(startDir).packages)) {
    for (const cap of lock.capabilities || []) {
      if (!out.has(cap)) out.set(cap, []);
      out.get(cap).push(pkgId);
    }
  }
  return out;
}

/** Resolve a package id/path to its ENGINE-loaded manifest for profile
 * adoption/diff. Installed ids resolve through listInstalledPackages (the
 * engine's indexed store); local paths load directly. Git URLs are cloned by
 * the caller (adoption acquires; diff uses a temp clone). */
export function resolveProfilePackage(src, dir, { clone } = {}) {
  const isUrl = /^(https?:\/\/|git@|ssh:\/\/)/.test(src);
  const isPath = !isUrl && (src.startsWith(".") || src.startsWith("/") || src.startsWith("~") || src.startsWith("path:"));
  if (isPath) {
    const p = src.startsWith("path:") ? src.slice(5) : src;
    const abs = p.startsWith("~/") ? join(process.env.HOME || "", p.slice(2)) : p;
    const manifest = loadPackageManifestAt(abs); // throws invalid-package-manifest with the engine code
    return { manifest, commit: "local", source: `path:${abs}` };
  }
  if (isUrl) {
    if (!clone) fail("invalid-source", "git package sources need a clone directory (internal)");
    execFileSync("git", ["clone", "-q", "--depth", "1", src, clone], { stdio: ["ignore", "pipe", "pipe"] });
    const manifest = loadPackageManifestAt(clone);
    const commit = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    return { manifest, commit, source: `git:${src}` };
  }
  // Installed/locked package id visible from dir (engine indexing).
  const pkg = listInstalledPackages(dir).find((p) => p.package === src);
  if (!pkg) fail("invalid-source", `"${src}" is not an installed package id, local path, or git URL at ${dir} — acquire it first with \`oas install <source>\``);
  return { manifest: pkg.manifest, commit: pkg.commit || "local", source: pkg.source };
}

// ---------- team-boundary workspace scope discovery ----------

/** Directory names pruned during descendant scope discovery (dependency/vendor trees). */
export const PRUNED_DIR_NAMES = new Set([".git", "node_modules", "vendor", ".venv", "venv", "bower_components", ".direnv"]);

const isScopeDir = (dir) => existsSync(join(dir, "oas-config.yaml")) || existsSync(join(dir, OAS_LOCK_FILE));
const declaresTeam = (dir) => {
  const file = join(dir, "oas-config.yaml");
  if (!existsSync(file)) return false;
  try { return !!parseYamlNested(readFileSync(file, "utf8")).team; } catch { return false; }
};

/** Deterministic path-order discovery of descendant scopes inside a team boundary.
 * Prunes .git, generated stores (.agents), dependency/vendor dirs, agent
 * instance homes/worktrees, local-agents, and nested team boundaries. The
 * boundary itself is NOT included. Returns sorted absolute paths. */
export function discoverWorkspaceScopes(boundary) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const names = entries.filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name).sort((x, y) => x.localeCompare(y));
    for (const name of names) {
      if (PRUNED_DIR_NAMES.has(name)) continue;
      const child = join(dir, name);
      // Generated stores (.agents: capability/package stores, injections) never
      // contain deployment scopes; agent instance homes/worktrees and local
      // souls are runtime state, not workspace repositories.
      if (name === ".agents") continue;
      if (name === "local-agents") continue;
      if (name === "instances" && existsSync(join(dir, "soul"))) continue;
      // Nested team boundary: a descendant scope declaring its own team: is its own reconciliation unit.
      if (declaresTeam(child)) continue;
      if (isScopeDir(child)) out.push(child);
      walk(child);
    }
  };
  walk(boundary);
  return out;
}

// ---------- host requirements (structured, consented) ----------

/** Allowlisted install methods. Recipes are data; commands are argv arrays (no shell, no sudo, no auth). */
export const REQUIREMENT_MANAGERS = {
  "npm-global": {
    scope: "user-level (npm global prefix)",
    plan: (method) => {
      const pkg = String(method.package || "");
      if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~><=-]+)?$/i.test(pkg)) throw new Error(`npm-global package spec is not a plain package name: "${pkg}"`);
      return { argv: ["npm", "install", "-g", pkg], source: `npm registry (${pkg})` };
    },
  },
  brew: {
    scope: "user-level (Homebrew prefix)",
    plan: (method) => {
      const formula = String(method.formula || method.package || "");
      if (!/^[a-z0-9][\w.@/-]*$/i.test(formula)) throw new Error(`brew formula is not a plain formula name: "${formula}"`);
      return { argv: ["brew", "install", formula], source: `Homebrew (${formula})` };
    },
  },
  "download-checksum": {
    scope: "user-level",
    plan: () => { throw new Error("download-with-checksum installs are not implemented yet — use the documented install URL"); },
  },
};

/** Which runtimes would actually RUN a capability in this scope?
 *
 * A runtime-package requirement must never mutate a host that does not use that
 * runtime: a Claude-only deployment with oas.aweb active is not asked to install
 * a pi package. Capability targeting is per-soul (global/type/soul), so the
 * answer comes from resolving the capability against each known soul and
 * collecting the runtimes of the souls it is actually active for.
 *
 * POLICY when a scope has no souls, or none that the capability targets: the
 * requirement is NOT raised. A fresh deployment cannot know which runtimes its
 * future souls will use, and prompting every host for every runtime is exactly
 * the mutation this exists to avoid. Spawn performs the final, authoritative
 * check against the instance's ACTUAL runtime — which `--runtime` can override
 * after any reconciliation — so a genuinely needed package is still caught
 * there, with a pointed, separately consentable remedy. */
export function capabilityRuntimeTargets(scope, capId) {
  const requesters = [];
  const runtimes = new Set();
  let souls = 0;
  let root;
  try { root = findRoot(scope); } catch { root = undefined; }
  if (!root) return { runtimes, souls, requesters };
  let list = [];
  try { list = listAgents(root); } catch { list = []; }
  for (const soul of list) {
    souls++;
    try {
      const resolved = resolveOasConfig(scope, soul.name);
      if (!(resolved.capabilities || []).some((c) => c.id === capId)) continue;
      const runtime = soul.runtime || "pi";   // soul default; spawn may override
      runtimes.add(runtime);
      requesters.push({ soul: soul.name, runtime });
    } catch { /* unresolvable souls are reported by the reconciler */ }
  }
  return { runtimes, souls, requesters };
}

/** Normalize a manifest `requires` entry to the structured form.
 * Legacy shape: { command, why, install: "https://…" }.
 * A present-but-invalid command (empty, null, non-string) returns a typed
 * invalid record so the fail-closed policy sees it — only a fully ABSENT
 * command key is dropped as "not a requirement". */
export function normalizeRequirement(req) {
  if (!req || typeof req !== "object") return undefined;
  // Runtime-package requirement: satisfied by the RUNTIME's package manager, not
  // by a command on PATH. `runtime` scopes it — a Claude-only deployment is never
  // asked to install a pi package. The identity used for dedup, consent and
  // conflict detection is "<runtime>:<package identity>", version selector
  // stripped, so @latest and a pinned version are one requirement.
  if ("runtime" in req && req.runtime !== undefined) {
    const runtime = typeof req.runtime === "string" ? req.runtime : JSON.stringify(req.runtime);
    const pkg = typeof req.package === "string" ? req.package : req.package === undefined ? "" : JSON.stringify(req.package);
    return {
      kind: "runtime-package", runtime, package: pkg, why: req.why,
      marketplace: req.marketplace,
      command: `${runtime}:${runtimePackageIdentity(runtime, pkg)}`,   // identity/consent key
      install: { docs: typeof req.install === "string" ? req.install : req.install?.docs, methods: [] },
      _invalid: !RUNTIME_PACKAGE_MANAGERS[runtime]
        ? `unknown runtime "${runtime}" (known: ${Object.keys(RUNTIME_PACKAGE_MANAGERS).join(", ")})`
        : !safeRuntimePackageSpec(pkg, runtime)
          ? `runtime package spec is not a plain source token for ${runtime}: ${JSON.stringify(pkg)}`
          : req.marketplace !== undefined && !safeRuntimeSourceRef(req.marketplace)
            ? `marketplace is not a plain source reference: ${JSON.stringify(req.marketplace)}`
            : undefined,
    };
  }
  // JSON manifests cannot carry undefined; a programmatic undefined counts as absent.
  if (!("command" in req) || req.command === undefined) return undefined;
  const nonString = typeof req.command !== "string";
  const command = nonString ? JSON.stringify(req.command) : req.command;
  const install = req.install;
  const base = { command, why: req.why, ...(nonString ? { _nonStringCommand: true } : {}) };
  if (typeof install === "string" || install === undefined) {
    return { ...base, install: { docs: typeof install === "string" ? install : undefined, methods: [] } };
  }
  if (typeof install !== "object") return { ...base, install: { methods: [] } };
  const methods = Array.isArray(install.methods) ? install.methods.filter((m) => m && typeof m === "object") : [];
  return { ...base, install: { docs: install.docs, methods } };
}

/** Is a command on PATH? (dependency-free `which`). */
export function commandOnPath(cmd, env = process.env) {
  if (!cmd || /[\\/]/.test(cmd)) return false;
  for (const dir of String(env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    try { const st = statSync(join(dir, cmd)); if (st.isFile() && (st.mode & 0o111)) return true; } catch { /* keep looking */ }
  }
  return false;
}

/** Build the informed-consent install plan for one requirement on this host, or an explanation why none applies.
 * Never uses sudo, shell strings, or authentication. */
export function requirementInstallPlan(req, { platform = process.platform } = {}) {
  const r = normalizeRequirement(req);
  if (!r) return undefined;
  if (r.kind === "runtime-package") {
    // Never build an executable plan for an invalid entry — the fail-closed
    // policy must see it as unconsentable, not as an install recipe.
    if (r._invalid) return { command: r.command, why: r.why, docs: r.install.docs, unavailable: r._invalid };
    const mgr = RUNTIME_PACKAGE_MANAGERS[r.runtime];
    // Some runtimes need more than one command (Claude registers a marketplace
    // before installing). `steps` is the truth; `argv` stays the final command
    // so existing consumers keep working.
    const steps = mgr.steps ? mgr.steps(r.package, req) : [mgr.argv(r.package)];
    return {
      command: r.command, why: r.why, docs: r.install.docs,
      manager: r.runtime, steps, argv: steps[steps.length - 1], source: `${r.runtime} package (${r.package})`,
      scope: mgr.scope, runtime: r.runtime, package: r.package, marketplace: r.marketplace,
      version: r.runtime === "pi" ? (String(r.package).slice(packageSpecIdentity(r.package).length).match(/^@(.+)$/) || [])[1] : undefined,
    };
  }
  const applicable = (r.install.methods || []).filter((m) => !m.platform || m.platform === platform);
  for (const method of applicable) {
    const manager = REQUIREMENT_MANAGERS[method.manager];
    if (!manager) continue; // non-allowlisted methods are ignored, never executed
    try {
      const { argv, source } = manager.plan(method);
      return {
        command: r.command, why: r.why, docs: r.install.docs,
        manager: method.manager, argv, source, scope: manager.scope,
        version: (String(method.package || method.formula || "").match(/.@([^@]+)$/) || [])[1],
      };
    } catch (e) {
      return { command: r.command, why: r.why, docs: r.install.docs, unavailable: e.message };
    }
  }
  return { command: r.command, why: r.why, docs: r.install.docs, unavailable: applicable.length ? "no allowlisted install method for this host" : "no install method matches this platform" };
}

/** Gate: a requirement's command must be a safe executable basename/CLI token —
 * no path separators, whitespace, leading dash, or shell syntax. Fail closed. */
export function safeRequirementCommand(cmd) {
  return typeof cmd === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(cmd);
}

/** Aggregate missing host requirements across reconciled scopes, only for
 * capabilities activated somewhere in those scopes, deduplicated by command.
 * Returns [{ command, why, docs, plan, requestedBy: [{ capability, scope }],
 *            invalid?, conflict? }].
 * Fail-closed identity rules:
 * - a command that is not a safe executable token is flagged { invalid } with
 *   NO install plan — it can never be consented or executed;
 * - two active capabilities requesting the SAME command with NON-identical
 *   plans produce one deterministic conflict entry ({ conflict: { plans } },
 *   provenance-rich, no plan, no consent) — identical plans merge requestedBy. */
export function aggregateMissingRequirements(scopes, { platform = process.platform, env = process.env, accepted = new Set() } = {}) {
  const byCommand = new Map();
  for (const scope of scopes) {
    // Capabilities targeted by agent-type or soul are INVISIBLE to a
    // soul-less scope resolution, so resolving the scope alone silently skipped
    // their requirements entirely — for host commands as much as for runtime
    // packages. Union the scope-level set with every soul's set, keeping one
    // entry per capability id.
    const active = new Map();
    try { for (const cap of resolveOasConfig(scope).capabilities || []) active.set(cap.id, cap); }
    catch { continue; /* scope failures are reported by the reconciler */ }
    let root;
    try { root = findRoot(scope); } catch { root = undefined; }
    for (const soul of root ? listAgents(root) : []) {
      try { for (const cap of resolveOasConfig(scope, soul.name).capabilities || []) if (!active.has(cap.id)) active.set(cap.id, cap); }
      catch { /* unresolvable souls are reported by the reconciler */ }
    }
    for (const cap of active.values()) {
      for (const raw of cap.manifest?.requires || []) {
        const r = normalizeRequirement(raw);
        if (!r) continue;
        if (r.kind === "runtime-package") {
          if (r._invalid) {
            const key = `\u0000invalid:${r.command}`;
            if (!byCommand.has(key)) byCommand.set(key, { kind: "runtime-package", command: r.command, why: r.why, docs: r.install.docs, plan: null, invalid: r._invalid, requestedBy: [] });
            const bad = byCommand.get(key);
            if (!bad.requestedBy.some((x) => x.capability === cap.id && x.scope === scope)) bad.requestedBy.push({ capability: cap.id, scope });
            continue;
          }
          // RUNTIME SCOPING: raise this only for a deployment that actually runs
          // the named runtime, or a Claude-only host with oas.aweb active gets
          // prompted for a pi package — the provider-agnostic contract must not
          // mutate a host for an adapter it never uses.
          const targets = capabilityRuntimeTargets(scope, cap.id);
          // EXPLICIT CONSENT OVERRIDES SCOPING. Spawn can be given `--runtime pi`
          // for a soul whose default is claude, and it then emits
          // `oas install --accept-requirement pi:<pkg>`. If scoping also filtered
          // that named requirement out, the remedy we printed would install
          // nothing and the retry would fail identically (reviewer-ad1b9f0).
          // Naming a requirement IS the statement that this host needs it.
          if (!targets.runtimes.has(r.runtime) && !accepted.has(r.command)) continue;
          // Satisfied by the runtime's own package list, not by PATH.
          if (runtimePackageInstalled(r.runtime, r.package, env)) continue;
          const plan = requirementInstallPlan(raw, { platform });
          if (!byCommand.has(r.command)) byCommand.set(r.command, { kind: "runtime-package", command: r.command, runtime: r.runtime, package: r.package, why: r.why, docs: r.install.docs, plan, requestedBy: [], _plans: [] });
          const agg = byCommand.get(r.command);
          agg._plans.push({ plan, capability: cap.id, scope });
          if (!agg.requestedBy.some((x) => x.capability === cap.id && x.scope === scope)) {
            // Provenance names the souls that pulled it in, so a mixed pi+claude
            // deployment shows ONE deduped requirement explaining why it applies.
            agg.requestedBy.push({ capability: cap.id, scope, souls: targets.requesters.filter((t) => t.runtime === r.runtime).map((t) => t.soul) });
          }
          continue;
        }
        if (r._nonStringCommand || !safeRequirementCommand(r.command)) {
          const key = `\u0000invalid:${r.command}`;
          if (!byCommand.has(key)) byCommand.set(key, { command: r.command, why: r.why, docs: r.install.docs, plan: null, invalid: "requirement command is not a safe executable name (no paths, whitespace, dashes-first, or shell syntax)", requestedBy: [] });
          const bad = byCommand.get(key);
          if (!bad.requestedBy.some((x) => x.capability === cap.id && x.scope === scope)) bad.requestedBy.push({ capability: cap.id, scope });
          continue;
        }
        if (commandOnPath(r.command, env)) continue;
        const plan = requirementInstallPlan(raw, { platform });
        if (!byCommand.has(r.command)) {
          byCommand.set(r.command, { command: r.command, why: r.why, docs: r.install.docs, plan, requestedBy: [], _plans: [{ plan, capability: cap.id, scope }] });
        } else {
          const agg = byCommand.get(r.command);
          // Retain EVERY requester's plan so conflict provenance is complete for 3+
          // requesters; the conflict itself derives from the collected set below.
          agg._plans.push({ plan, capability: cap.id, scope });
        }
        const agg = byCommand.get(r.command);
        if (!agg.requestedBy.some((x) => x.capability === cap.id && x.scope === scope)) agg.requestedBy.push({ capability: cap.id, scope });
      }
    }
  }
  // Derive conflicts AFTER collection so provenance covers every requester
  // (3+ capabilities included). Plan identity = the executable argv (or
  // unavailability); non-identical plans for one command are never
  // installable or consentable.
  const planKey = (p) => JSON.stringify(p?.argv || p?.unavailable || null);
  for (const agg of byCommand.values()) {
    if (!agg._plans) continue;
    const keys = new Set(agg._plans.map((x) => planKey(x.plan)));
    if (keys.size > 1) {
      agg.conflict = { plans: agg._plans.map((x) => ({ capability: x.capability, scope: x.scope, argv: x.plan?.argv || null, unavailable: x.plan?.unavailable || null })) };
      agg.plan = null;
    }
  }
  // Canonical string sort key: commands may be JSON.stringify'd non-strings.
  return [...byCommand.values()].map(({ _plans, ...rest }) => rest).sort((a, b) => String(a.command).localeCompare(String(b.command)));
}

/** Execute one consented install plan (argv, no shell) and verify the command lands on PATH. */
export function runRequirementInstall(plan, { env = process.env, stdio = "inherit" } = {}) {
  if (!plan || !plan.argv) throw new Error(`no executable install plan for "${plan?.command}"`);
  for (const step of plan.steps?.length ? plan.steps : [plan.argv]) {
    if (step?.length) execFileSync(step[0], step.slice(1), { stdio, env });
  }
  // Verify what the requirement actually promised. A runtime package never
  // lands on PATH, so verifying it there would report every successful install
  // as a failure.
  const onPath = plan.runtime
    ? runtimePackageInstalled(plan.runtime, plan.package, env)
    : commandOnPath(plan.command, env);
  return { command: plan.command, installed: true, onPath };
}
