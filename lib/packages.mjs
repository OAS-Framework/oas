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
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  DEFAULT_PACKAGE_PATH, OAS_LOCK_FILE, findRoot, listAgents, listInstalledPackages, loadPackageManifestAt, packageSpecIdentity,
  gitCheckoutExactRef, parsePackageSource, resolveClaudeBinary, resolvePackageRoot,
  OAS_VERSION, parseYamlNested, readPackageLocks, resolveOasConfig, RUNTIME_PACKAGE_MANAGERS,
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

// ---------- config templates (selection, validation, adoption) ----------
//
// Both engine readers — acquisition's staged `configTemplates` and
// `readLockedConfigTemplates` — produce the SAME descriptor, so everything here
// takes descriptors and never cares which reader produced them.

/** Scope-relative home of adopted template bases. Visible and commit-safe by
 * design: sync's three-way comparison needs the original base under review. */
export const ADOPTED_TEMPLATES_DIRNAME = join(".agents", "config-templates", "adopted");
export const ADOPTION_METADATA_FILE = "adoption.json";

export const adoptedTemplateDir = (levelDir, packageId, templateName) =>
  join(levelDir, ADOPTED_TEMPLATES_DIRNAME, packageId, templateName);

/** Choose a template: explicit name, else the single marked default, else the
 * only one. Several unmarked templates need an explicit choice — guessing would
 * silently adopt a policy nobody picked. */
export function selectConfigTemplate(templates, name, packageId, bail) {
  const refuse = (code, msg) => (bail ? bail(code, msg) : fail(code, msg));
  const list = templates || [];
  if (!list.length) return refuse("E_NO_TEMPLATES", `package ${packageId} exports no config templates`);
  if (name) {
    const hit = list.find((t) => t.template === name);
    if (!hit) return refuse("E_TEMPLATE_NOT_FOUND", `package ${packageId} has no config template "${name}" (templates: ${list.map((t) => t.template).join(", ")})`);
    return hit;
  }
  const marked = list.filter((t) => t.default);
  if (marked.length === 1) return marked[0];
  if (list.length === 1) return list[0];
  return refuse("E_TEMPLATE_AMBIGUOUS", `package ${packageId} exports several config templates and none is marked default (${list.map((t) => t.template).join(", ")}) — pass --config <name>`);
}

/** Validate one config template's CONTENT before adoption. Same policy checks
 * the profile validator carried, now reading a descriptor's bytes rather than a
 * package directory: config schema; every referenced installed capability
 * supplied by the closure; layer agreement against the real provider manifest;
 * agent-type syntax; no scope-escaping paths.
 * Returns a list of error strings (empty = valid). */
export function validateConfigTemplate(descriptor, packageId, { dependencyProviders = new Map() } = {}) {
  const where = `config template "${descriptor.template}" of package ${packageId}`;
  let cfg;
  try {
    cfg = parseYamlNested(String(descriptor.content));
    validateConfigShape(cfg, `${where} (${descriptor.path})`);
  } catch (e) { return [e.message]; }
  return validateAdoptableConfig(cfg, where, dependencyProviders);
}

/** The shared config-policy checks, over an already-parsed config. */
function validateAdoptableConfig(cfg, where, dependencyProviders) {
  const errors = [];
  const supplied = new Set(dependencyProviders.keys());
  const entries = [];
  const caps = cfg.capabilities || {};
  for (const [layer, entry] of Object.entries(caps.layers || {})) {
    if (entry && typeof entry === "object") entries.push({ id: entry.capability, entry, slot: layer });
  }
  for (const [id, entry] of Object.entries(caps.additive || {})) entries.push({ id, entry: entry && typeof entry === "object" ? entry : {}, slot: undefined });

  for (const { id, entry, slot } of entries) {
    const from = String(entry.from || "installed");
    if (from.startsWith("path:")) { errors.push(`${where}: capability ${id} uses "from: ${from}" — templates must reference installed capabilities, not host paths`); continue; }
    if (from === "installed" && !supplied.has(id)) {
      errors.push(`${where}: capability ${id} is not supplied by the package or its dependency closure (supplied: ${[...supplied].join(", ") || "none"})`);
      continue;
    }
    if (slot) {
      const capMan = dependencyProviders.get(id) ?? null;
      if (capMan && capMan.layer !== slot) errors.push(`${where}: layer ${slot} binds ${id}, but its manifest declares layer "${capMan.layer || "none"}"`);
      else if (capMan === null && supplied.has(id)) {
        errors.push(`${where}: layer ${slot} binds ${id}, but its provider manifest is not available to verify the layer — install the provider first`);
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

/** Atomically replace one file, never writing THROUGH it: a protected path may
 * be a symlink, and opening it for write would follow the link and clobber
 * whatever it points at. Sibling temp + rename replaces the entry itself. */
export function writeFileAtomic(file, contents) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.oas-tmp-${process.pid}`);
  try {
    writeFileSync(tmp, contents);
    renameSync(tmp, file);
  } finally { rmSync(tmp, { force: true }); }
}

/** Write the active config plus the exact adopted base and its metadata.
 *
 * The base is the template's EXACT bytes — not the local config — because the
 * three-way sync compares against it; a base that drifted toward local would
 * silently turn upstream changes into conflicts. The metadata copies the
 * engine's `contentIntegrity` verbatim rather than inventing a second digest,
 * and carries nothing machine-local: no absolute path, no host, no secret. */
export function writeAdoptedTemplate(levelDir, configFile, { package: packageId, template, root }) {
  const baseDir = adoptedTemplateDir(levelDir, packageId, template.template);
  const baseFile = join(baseDir, "oas-config.yaml");
  const metadataFile = join(baseDir, ADOPTION_METADATA_FILE);
  // A `path:` source is one developer's filesystem layout. This file is meant to
  // be COMMITTED, so recording it would leak a machine path into the repository
  // and mean nothing on any other checkout — record that the adoption was local
  // instead of where it happened. Git and catalog sources are portable and are
  // recorded verbatim.
  const rawSource = root?.source ?? null;
  const localSource = typeof rawSource === "string" && rawSource.startsWith("path:");
  const metadata = {
    package: packageId,
    template: template.template,
    templatePath: template.path,
    source: localSource ? null : rawSource,
    ...(localSource ? { localSource: true } : {}),
    version: root?.version ?? null,
    commit: root?.commit ?? null,
    packagePath: root?.path ?? null,
    hash: template.contentIntegrity,
    ...(template.legacySpelling ? { legacySpelling: true } : {}),
    adoptedWith: `oas ${OAS_VERSION}`,
  };
  writeFileAtomic(configFile, template.content);
  writeFileAtomic(baseFile, template.content);
  writeFileAtomic(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
  return { baseDir, baseFile, metadataFile, metadata };
}

/** Read this scope's adopted base + metadata, or null when nothing is adopted.
 * At most one adopted base may exist; more than one is a typed failure rather
 * than a guess about which is current. */
export function readAdoptedTemplate(levelDir) {
  const root = join(levelDir, ADOPTED_TEMPLATES_DIRNAME);
  if (!existsSync(root)) return null;
  const found = [];
  for (const pkg of readdirSync(root, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    for (const tpl of readdirSync(join(root, pkg.name), { withFileTypes: true })) {
      if (!tpl.isDirectory()) continue;
      const dir = join(root, pkg.name, tpl.name);
      if (existsSync(join(dir, ADOPTION_METADATA_FILE))) found.push({ package: pkg.name, template: tpl.name, dir });
    }
  }
  if (!found.length) return null;
  if (found.length > 1) {
    fail("E_MULTIPLE_ADOPTED_BASES", `scope ${levelDir} records ${found.length} adopted config templates (${found.map((f) => `${f.package}:${f.template}`).join(", ")}) — exactly one may be current; remove the stale ones under ${ADOPTED_TEMPLATES_DIRNAME}`);
  }
  const hit = found[0];
  let metadata;
  try { metadata = JSON.parse(readFileSync(join(hit.dir, ADOPTION_METADATA_FILE), "utf8")); }
  catch (e) { fail("E_ADOPTION_METADATA_INVALID", `adopted template metadata at ${join(hit.dir, ADOPTION_METADATA_FILE)} is unreadable: ${e.message}`); }
  const baseFile = join(hit.dir, "oas-config.yaml");
  if (!existsSync(baseFile)) fail("E_ADOPTION_BASE_MISSING", `adopted template ${hit.package}:${hit.template} has metadata but no recorded base at ${baseFile}`);
  return { ...hit, metadata, baseFile, baseText: readFileSync(baseFile, "utf8") };
}

// ---------- config template three-way merge (byte-preserving) ----------
//
// `oas config sync` compares three texts: the recorded ADOPTED BASE, the
// current LOCAL oas-config.yaml, and the TEMPLATE from the currently locked
// package. The Decision's binding rule is that untouched local bytes stay
// byte-identical — comments, key ordering, blank lines, indentation style and
// the presence or absence of a trailing newline all survive. That forbids the
// obvious implementation (parse YAML, merge objects, reserialize): a round trip
// through the kernel's YAML subset would rewrite the whole file even when one
// key changed. So the merge is a line-level three-way diff whose output is
// built by splicing ONLY the selected regions into the original local line
// array; every other byte is copied verbatim from the local file.
//
// This half is deliberately engine-independent: pure text in, text out, no lock
// reads, no filesystem, no package identity. The CLI supplies the three texts.

/** Guard for the O(n*m) LCS tables below. Configs are tens to hundreds of lines;
 * anything past this is not a config being synchronized and must fail closed
 * rather than allocate gigabytes. */
const MERGE_MAX_LINE_PRODUCT = 4_000_000;

/** Split text into lines that RETAIN their exact terminators, so that
 * splitConfigLines(t).join("") === t for any t — including CRLF files and a
 * final line with no newline. Line identity is therefore byte identity: a line
 * that differs only in its terminator is a real difference, not a match. */
export function splitConfigLines(text) {
  const s = String(text);
  const lines = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n") { lines.push(s.slice(start, i + 1)); start = i + 1; }
  }
  if (start < s.length) lines.push(s.slice(start));
  return lines;
}

/** Regions where `b` differs from `a`, as {aStart,aEnd,bStart,bEnd} half-open
 * line ranges. A pure insertion is a zero-width `a` range; a pure deletion a
 * zero-width `b` range. */
function changeRegions(a, b) {
  const n = a.length, m = b.length;
  if (n * m > MERGE_MAX_LINE_PRODUCT) {
    fail("E_SYNC_TOO_LARGE", `config texts are too large to merge line-by-line (${n} x ${m} lines)`);
  }
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const regions = [];
  let cur = null;
  const flush = () => { if (cur) { regions.push(cur); cur = null; } };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { flush(); i++; j++; continue; }
    if (!cur) cur = { aStart: i, aEnd: i, bStart: j, bEnd: j };
    if (lcs[i + 1][j] >= lcs[i][j + 1]) cur.aEnd = ++i;
    else cur.bEnd = ++j;
  }
  if (i < n || j < m) {
    if (!cur) cur = { aStart: i, aEnd: i, bStart: j, bEnd: j };
    cur.aEnd = n; cur.bEnd = m;
  }
  flush();
  return regions;
}

/** Line-count delta a region introduces on the non-base side. */
const regionDelta = (r) => (r.bEnd - r.bStart) - (r.aEnd - r.aStart);

function digestOf(...parts) {
  const hash = createHash("sha256");
  for (const part of parts) { hash.update(String(part)); hash.update("\0"); }
  return `sha256-${hash.digest("hex")}`;
}

/** Three-way merge PLAN for one config: what changed where, and what a caller
 * may decide about it. Nothing is written and nothing is chosen here.
 *
 * Each returned region carries the exact text of all three sides plus:
 *   kind      "upstream" — only the template moved away from the base; may be offered
 *             "local"    — only the local file moved; it always stays (never offered away)
 *             "conflict" — both moved, differently; needs an explicit local/package/edit choice
 *             "agreed"   — both moved to the same text; already in sync, nothing to do
 *   recommended  the decision applyConfigMerge uses when the caller passes none —
 *                null for conflicts, which therefore cannot be resolved silently
 *   digest       binds the decision to the exact three texts the plan was built
 *                from, so a stored automation answer cannot be replayed onto
 *                shifted content
 *
 * Region `local` ranges are indices into splitConfigLines(localText); they are
 * what applyConfigMerge splices, which is why round-tripping a plan with no
 * upstream application returns the local bytes unchanged. */
export function planConfigMerge(baseText, localText, templateText) {
  const base = splitConfigLines(baseText);
  const local = splitConfigLines(localText);
  const template = splitConfigLines(templateText);

  const localRegions = changeRegions(base, local);
  const templateRegions = changeRegions(base, template);

  // Group by overlapping-or-touching BASE range. Touching counts: an insertion
  // at line p (zero-width base range) and a replacement starting at p are the
  // same disputed spot, and treating them as independent would interleave two
  // sides' edits at one point without either side ever agreeing to it.
  const marked = [
    ...localRegions.map((r) => ({ side: "local", r })),
    ...templateRegions.map((r) => ({ side: "template", r })),
  ].sort((x, y) => x.r.aStart - y.r.aStart || x.r.aEnd - y.r.aEnd);

  const groups = [];
  for (const item of marked) {
    const last = groups[groups.length - 1];
    if (last && item.r.aStart <= last.aEnd) {
      last.aEnd = Math.max(last.aEnd, item.r.aEnd);
      last.items.push(item);
    } else {
      groups.push({ aStart: item.r.aStart, aEnd: item.r.aEnd, items: [item] });
    }
  }

  // Offsets of each side relative to the base, accumulated across groups: every
  // line outside a group is common to base and that side, so the mapping is
  // exact rather than approximate.
  let localOffset = 0, templateOffset = 0;
  const regions = [];
  for (const [index, group] of groups.entries()) {
    const span = group.aEnd - group.aStart;
    const localItems = group.items.filter((it) => it.side === "local").map((it) => it.r);
    const templateItems = group.items.filter((it) => it.side === "template").map((it) => it.r);
    const localStart = group.aStart + localOffset;
    const templateStart = group.aStart + templateOffset;
    const localLen = span + localItems.reduce((sum, r) => sum + regionDelta(r), 0);
    const templateLen = span + templateItems.reduce((sum, r) => sum + regionDelta(r), 0);
    localOffset += localLen - span;
    templateOffset += templateLen - span;

    const baseSlice = base.slice(group.aStart, group.aEnd).join("");
    const localSlice = local.slice(localStart, localStart + localLen).join("");
    const templateSlice = template.slice(templateStart, templateStart + templateLen).join("");

    const localChanged = localItems.length > 0;
    const templateChanged = templateItems.length > 0;
    let kind;
    if (localChanged && templateChanged) kind = localSlice === templateSlice ? "agreed" : "conflict";
    else if (templateChanged) kind = "upstream";
    else kind = "local";

    regions.push({
      id: `h${index + 1}`,
      kind,
      recommended: kind === "conflict" ? null : kind === "upstream" ? "package" : "local",
      digest: digestOf(baseSlice, localSlice, templateSlice),
      base: { start: group.aStart, end: group.aEnd, text: baseSlice },
      local: { start: localStart, end: localStart + localLen, text: localSlice },
      template: { start: templateStart, end: templateStart + templateLen, text: templateSlice },
    });
  }

  const counts = { upstream: 0, local: 0, conflict: 0, agreed: 0 };
  for (const r of regions) counts[r.kind]++;
  return {
    regions,
    counts,
    conflicts: regions.filter((r) => r.kind === "conflict").map((r) => r.id),
    // "clean" means a caller can apply the recommendations without asking anyone.
    clean: counts.conflict === 0,
    localDigest: digestOf(localText),
    planDigest: digestOf(baseText, localText, templateText),
  };
}

/** Apply a plan's decisions to the LOCAL text, byte-preservingly.
 *
 * decisions: { [regionId]: "local" | "package" | { edit: "<replacement text>" } }
 * Regions with no decision fall back to `recommended`; a conflict has none, so
 * an unresolved conflict is a typed failure (E_SYNC_AMBIGUOUS) rather than a
 * silent pick — that is the noninteractive fail-closed rule.
 *
 * Returns { text, applied }. `applied` lists the regions that actually changed
 * bytes. With no decisions and no upstream regions, text === localText exactly,
 * byte for byte. */
export function applyConfigMerge(localText, plan, decisions = {}) {
  const local = splitConfigLines(localText);
  // A plan carries the digest of the local text it was computed against. Line
  // indices are meaningless against any other text, so applying a plan the user
  // reviewed before the file changed under them must fail, not splice at the
  // old offsets.
  if (plan.localDigest && plan.localDigest !== digestOf(localText)) {
    fail("E_SYNC_STALE_PLAN", "the local oas-config.yaml changed after this merge plan was computed — re-run the diff and review the plan again");
  }

  const byId = new Map(plan.regions.map((r) => [r.id, r]));
  for (const id of Object.keys(decisions)) {
    if (!byId.has(id)) fail("E_SYNC_UNKNOWN_REGION", `no such change region "${id}" in this plan (regions: ${[...byId.keys()].join(", ") || "none"})`);
  }

  const chosen = [];
  for (const region of plan.regions) {
    const raw = Object.hasOwn(decisions, region.id) ? decisions[region.id] : region.recommended;
    if (raw === null || raw === undefined) {
      fail("E_SYNC_AMBIGUOUS", `change region ${region.id} is a conflict — the local file and the package template both changed it, so it needs an explicit local/package/edit choice`);
    }
    if (typeof raw === "object") {
      if (typeof raw.edit !== "string") fail("E_SYNC_BAD_DECISION", `change region ${region.id}: an edit decision needs { edit: "<text>" }`);
      chosen.push({ region, choice: "edit", text: raw.edit });
      continue;
    }
    if (raw !== "local" && raw !== "package") fail("E_SYNC_BAD_DECISION", `change region ${region.id}: decision must be "local", "package", or { edit }, not ${JSON.stringify(raw)}`);
    chosen.push({ region, choice: raw, text: raw === "local" ? region.local.text : region.template.text });
  }

  const out = [];
  const applied = [];
  let cursor = 0;
  for (const { region, choice, text } of chosen) {
    out.push(local.slice(cursor, region.local.start).join(""));
    let replacement = text;
    const isTail = region.local.end >= local.length;
    // A replacement that does not end in a newline while local content follows
    // would glue two YAML lines together. Terminate it instead of emitting a
    // corrupt config; the tail region legitimately may end without a newline.
    if (replacement && !replacement.endsWith("\n") && !isTail) replacement += "\n";
    out.push(replacement);
    if (replacement !== region.local.text) applied.push({ id: region.id, kind: region.kind, choice });
    cursor = region.local.end;
  }
  out.push(local.slice(cursor).join(""));
  return { text: out.join(""), applied };
}

// ---------- run-level rollback journal (CLI-private) ----------
//
// A multi-step init or template adoption touches several artifacts that no
// single engine call spans: the active config, the lock, the flat installed
// capability store, the capability .gitignore, and the adopted template base
// plus its metadata. Engine operations are individually atomic and expose no
// transaction handle, so the RUN-level guarantee — "a later failure rolls back
// only this run's changes and preserves pre-existing bytes/artifacts" — is the
// CLI's to keep. This journal is that mechanism, deliberately private to this
// lane rather than a public kernel API.
//
// It is engine-independent by construction: paths in, bytes out. It knows the
// scope layout and nothing about locks, packages, or capabilities.

/** Scope-relative artifacts a run-level transaction must be able to undo. */
export const RUN_JOURNAL_PATHS = Object.freeze([
  "oas-config.yaml",
  "oas-lock.json",
  ".agents/capabilities/installed",
  ".agents/capabilities/.gitignore",
  ".agents/config-templates/adopted",
]);

/** The anchor whose creation is itself part of the run's changes. */
const AGENTS_ANCHOR = ".agents";

const isInside = (base, p) => p === base || p.startsWith(base.endsWith(sep) ? base : base + sep);

/** Record what a path IS without following it: absent, symlink (+target), dir, or file (+mode). */
function classifyPath(p) {
  let st;
  try { st = lstatSync(p); } catch { return { kind: "absent" }; }
  if (st.isSymbolicLink()) return { kind: "symlink", target: readlinkSync(p), mode: st.mode & 0o7777 };
  if (st.isDirectory()) return { kind: "dir", mode: st.mode & 0o7777 };
  return { kind: "file", mode: st.mode & 0o7777 };
}

/** Reject ANY symlink in an INTERMEDIATE component of a protected path.
 *
 * One escaping out of the scope is the obvious danger: restoring through it
 * would delete or rewrite outer-scope state this run never owned. But a
 * CONTAINED alias is refused too, because it makes two protected paths address
 * the same bytes — restoring one entry then silently deletes or overwrites
 * another entry's artifact, and the outcome depends on entry order. A journal
 * whose entries can overlap cannot promise byte-exact restoration, so the only
 * safe posture is to refuse the layout rather than guess an ordering.
 *
 * A symlink AT the protected path itself is fine: it is captured and restored
 * verbatim and never written through. */
function assertJournalContainment(scopeReal, rel) {
  const parts = rel.split("/").filter(Boolean);
  let cur = scopeReal;
  for (const part of parts.slice(0, -1)) {
    cur = join(cur, part);
    let st;
    try { st = lstatSync(cur); } catch { return; } // absent from here down: nothing to alias or escape through
    if (!st.isSymbolicLink()) continue;
    if (!isInside(scopeReal, realpathSync(cur))) {
      fail("E_JOURNAL_PATH_ESCAPE", `refusing to journal ${rel}: "${part}" is a symlink leaving ${scopeReal}`);
    }
    fail("E_JOURNAL_SYMLINK_COMPONENT", `refusing to journal ${rel}: "${part}" is a symlink aliasing another directory inside ${scopeReal} — two journal entries could then address the same bytes`);
  }
}

/** Normalize one journalled relative path and reject anything ambiguous.
 * Fail-closed on purpose: this is a private API whose callers are in this
 * repository, so a malformed path is a bug to surface, never to interpret. */
function canonicalJournalRel(rel, seen) {
  if (typeof rel !== "string") fail("E_JOURNAL_BAD_PATH", `journalled path must be a string, got ${typeof rel}`);
  const trimmed = rel.trim();
  if (!trimmed) fail("E_JOURNAL_BAD_PATH", "journalled path must be a nonempty relative path");
  if (trimmed.includes("\\")) fail("E_JOURNAL_BAD_PATH", `journalled path must use "/" separators: ${rel}`);
  if (isAbsolute(trimmed)) fail("E_JOURNAL_PATH_ESCAPE", `journalled path must stay inside the scope: ${rel}`);
  const parts = trimmed.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) fail("E_JOURNAL_PATH_ESCAPE", `journalled path must stay inside the scope: ${rel}`);
  if (!parts.length) fail("E_JOURNAL_BAD_PATH", `journalled path resolves to the scope itself: ${rel}`);
  const canonical = parts.join("/");
  if (seen.has(canonical)) fail("E_JOURNAL_DUPLICATE_PATH", `journalled path listed more than once: ${canonical}`);
  seen.add(canonical);
  return canonical;
}

/** Copy preserving type, symlink targets, modes, and timestamps.
 *
 * Hand-walked rather than fs.cpSync: cpSync's native recursion ABORTS THE
 * PROCESS with an uncatchable C++ filesystem_error when it meets an unreadable
 * directory (measured on node 22). A capability store with one bad-permission
 * directory would then kill the whole command with a libc++ message and no
 * cleanup, instead of a typed failure this journal can compensate. readdirSync
 * raises an ordinary catchable EACCES, which is what the constructor's cleanup
 * needs to work at all. */
function copyExact(from, to) {
  const st = lstatSync(from);
  mkdirSync(dirname(to), { recursive: true });
  if (st.isSymbolicLink()) { symlinkSync(readlinkSync(from), to); return; }
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) copyExact(join(from, name), join(to, name));
    // Mode and times go on AFTER the children: a read-only directory set first
    // would reject its own contents.
    chmodSync(to, st.mode & 0o7777);
    utimesSync(to, st.atime, st.mtime);
    return;
  }
  if (!st.isFile()) fail("E_JOURNAL_UNSUPPORTED_ENTRY", `cannot journal ${from}: not a regular file, directory, or symlink`);
  copyFileSync(from, to);
  chmodSync(to, st.mode & 0o7777);
  utimesSync(to, st.atime, st.mtime);
}

/** Open a run-level rollback journal over one scope.
 *
 * Snapshots every artifact in RUN_JOURNAL_PATHS (plus any `extraPaths`) exactly
 * as it is right now — bytes, file type, symlink targets, and mode bits — into a
 * backup directory OUTSIDE the protected tree, and records which ancestor
 * directories (including the `.agents` anchor) this run would be creating.
 *
 * Then exactly one of:
 *   rollback()  restore every snapshot, remove everything the run created, and
 *               report truthfully — including partial failure.
 *   finalize()  the run succeeded: discard the backup. Call it only after every
 *               command-owned write has finished, because it is the point of no
 *               return.
 * Both are idempotent; rollback after finalize is a caller bug and throws. */
export function beginRunJournal(scopeDir, { backupRoot = tmpdir(), extraPaths = [] } = {}) {
  const scope = resolve(scopeDir);
  if (!existsSync(scope)) fail("E_JOURNAL_NO_SCOPE", `cannot journal a run at ${scope}: the scope directory does not exist`);
  const scopeReal = realpathSync(scope);

  // Validate and canonicalize BEFORE staging anything, so a malformed call
  // never creates a backup directory it then has to clean up.
  const seen = new Set();
  const rels = [...RUN_JOURNAL_PATHS, ...extraPaths].map((rel) => canonicalJournalRel(rel, seen));

  // Directories that already existed. Anything NOT here that exists at rollback
  // time was created by this run and must be pruned once it is empty — which is
  // also what makes "remove a run-created .agents anchor only when empty" fall
  // out rather than being a special case.
  const preexistingDirs = new Set();
  const noteAncestors = (rel) => {
    const parts = rel.split("/").filter(Boolean);
    let cur = scope;
    for (const part of parts.slice(0, -1)) {
      cur = join(cur, part);
      if (existsSync(cur)) preexistingDirs.add(cur);
    }
  };

  const backupDir = mkdtempSync(join(backupRoot, "oas-run-journal-"));
  const entries = [];
  let anchorExisted;
  try {
    // The backup must not live inside the tree it protects: restoring a
    // directory means deleting it first, which would delete the backup with it.
    if (isInside(scopeReal, realpathSync(backupDir))) {
      fail("E_JOURNAL_BACKUP_INSIDE_SCOPE", `run-journal backup ${backupDir} would live inside the protected scope ${scopeReal}`);
    }
    for (const [index, rel] of rels.entries()) {
      assertJournalContainment(scopeReal, rel);
      noteAncestors(rel);
      const path = join(scope, rel);
      const state = classifyPath(path);
      // Keyed by INDEX, never by a flattened path: "a/b" and "a__b" are
      // different artifacts and any separator-substitution scheme collides them,
      // which would restore one entry's bytes over the other's.
      const backup = state.kind === "absent" ? null : join(backupDir, String(index));
      if (backup) copyExact(path, backup);
      entries.push({ rel, path, backup, ...state });
    }
    const anchorPath = join(scope, AGENTS_ANCHOR);
    anchorExisted = preexistingDirs.has(anchorPath) || existsSync(anchorPath);
    if (anchorExisted) preexistingDirs.add(anchorPath);
  } catch (e) {
    // A half-built journal protects nothing, so it must not outlive the
    // failure: leaving the partial backup behind would strand a copy of the
    // scope's bytes in the temp tree with no owner to clean it up.
    rmSync(backupDir, { recursive: true, force: true });
    throw e;
  }

  const anchorPath = join(scope, AGENTS_ANCHOR);

  let state = "open";

  /** Restore one entry to exactly what it was; absence is itself a state to restore. */
  const restoreEntry = (entry, report) => {
    // Absent then, absent now: nothing to undo. Every other case is restored
    // unconditionally — comparing first would only save work, and a comparison
    // that is subtly wrong silently skips a restore the run depended on.
    if (entry.kind === "absent" && classifyPath(entry.path).kind === "absent") return;
    try {
      // Remove whatever is there now. On a symlink this unlinks the link
      // itself, so a hostile link target is never written through.
      rmSync(entry.path, { recursive: true, force: true });
      if (entry.kind === "absent") { report.removed.push(entry.rel); return; }
      copyExact(entry.backup, entry.path);
      if (entry.kind !== "symlink") chmodSync(entry.path, entry.mode);
      report.restored.push(entry.rel);
    } catch (e) {
      report.failures.push({ path: entry.rel, error: e.message });
    }
  };

  /** Remove directories this run created, deepest first, and only while empty. */
  const pruneCreatedDirs = (report) => {
    const candidates = new Set();
    for (const { rel } of entries) {
      const parts = rel.split("/").filter(Boolean);
      let cur = scope;
      for (const part of parts.slice(0, -1)) { cur = join(cur, part); candidates.add(cur); }
    }
    candidates.add(anchorPath);
    for (const dir of [...candidates].sort((a, b) => b.length - a.length)) {
      if (preexistingDirs.has(dir) || !existsSync(dir)) continue;
      try {
        if (readdirSync(dir).length) continue; // not ours to empty — owned/ or a stranger's file lives here
        rmdirSync(dir);
        report.removed.push(dir.slice(scope.length + 1) || AGENTS_ANCHOR);
      } catch (e) {
        report.failures.push({ path: dir.slice(scope.length + 1) || AGENTS_ANCHOR, error: e.message });
      }
    }
  };

  return {
    scope,
    backupDir,
    anchorCreatedByRun: !anchorExisted,
    /** What the journal is protecting, for previews and diagnostics. */
    protected: entries.map(({ rel, kind }) => ({ path: rel, was: kind })),
    get state() { return state; },

    /** Undo this run. Attempts EVERY step even after one fails, so a partial
     * failure is reported in full rather than hidden behind the first error. */
    rollback() {
      if (state === "finalized") fail("E_JOURNAL_FINALIZED", "this run was already finalized — its backup is gone and it cannot be rolled back");
      const report = { restored: [], removed: [], failures: [], complete: true, summary: "" };
      if (state === "rolled-back") { report.summary = "nothing to roll back (already rolled back)"; return report; }
      for (const entry of entries) restoreEntry(entry, report);
      pruneCreatedDirs(report);
      report.complete = report.failures.length === 0;
      report.summary = report.complete
        ? `rolled back ${report.restored.length} restored, ${report.removed.length} removed`
        : `ROLLBACK INCOMPLETE — ${report.failures.length} of ${entries.length} artifact(s) could not be restored: ${report.failures.map((f) => `${f.path} (${f.error})`).join("; ")}`;
      // The backup survives an incomplete rollback: it is the only remaining
      // copy of the pre-run bytes, so destroying it would turn a recoverable
      // failure into permanent loss.
      if (report.complete) { rmSync(backupDir, { recursive: true, force: true }); state = "rolled-back"; }
      return report;
    },

    /** The run succeeded — drop the backup. Point of no return. */
    finalize() {
      if (state === "rolled-back") fail("E_JOURNAL_ROLLED_BACK", "this run was already rolled back and cannot be finalized");
      rmSync(backupDir, { recursive: true, force: true });
      state = "finalized";
    },
  };
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
  // Classify through the ENGINE's parser, never a local regex: a diff that
  // disagreed with acquisition about what a source spells (which git
  // spellings count, which contained root is selected) would compare the
  // adopted snapshot against a profile the install never used.
  // A malformed source is a typed failure, never a fall-through to the
  // installed-id lookup: "#../escape" must report path-escape, not "not an
  // installed package id".
  const parsedSrc = parsePackageSource(src);
  if (parsedSrc.kind === "path") {
    const abs = parsedSrc.path; // absolute, tilde already expanded
    const manifest = loadPackageManifestAt(abs); // throws invalid-package-manifest with the engine code
    return { manifest, commit: "local", source: `path:${abs}` };
  }
  const isUrl = parsedSrc.kind === "git";
  if (isUrl) {
    if (!clone) fail("invalid-source", "git package sources need a clone directory (internal)");
    // Select the CONTAINED package root exactly the way acquisition does — the
    // profile a diff compares against must come from the same directory the
    // install would lock, not from whatever sits at the repository root.
    // The REF matters for the same reason: reading HEAD's profile while the
    // returned provenance claims "@v1" compares the snapshot against a version
    // the install never used. A shallow clone cannot check out an arbitrary
    // ref, so only the unpinned case stays shallow.
    // The ref is resolved and verified by the ENGINE before checkout: a
    // caller-supplied ref must never reach git as an option-capable argument
    // (see gitCheckoutExactRef).
    const ref = parsedSrc.ref;
    execFileSync("git", ["clone", "-q", ...(ref ? [] : ["--depth", "1"]), parsedSrc.url, clone], { stdio: ["ignore", "pipe", "pipe"] });
    const commit = ref
      ? gitCheckoutExactRef(clone, ref, src)
      : execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const manifest = loadPackageManifestAt(resolvePackageRoot(clone, parsedSrc.packagePath ?? DEFAULT_PACKAGE_PATH, src));
    return { manifest, commit, source: parsedSrc.normalized };
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

/** Every VISIBLE lock-owning scope a guided migration must consider, in
 * deterministic path order (ancestors sort before their descendants):
 *   - the explicit scope's ancestor chain, so an outer repo/laptop lock that
 *     the deployment actually reads is migrated too, not silently left on v1;
 *   - the team boundary when the scope declares one;
 *   - descendant config/lock scopes under that boundary, using the same pruned
 *     discovery reconciliation uses (nested team boundaries stay self-owned).
 * Only directories that actually own an oas-lock.json are returned — a scope
 * with no lock has nothing to migrate. */
export function discoverMigrationScopes(startDir, { teamScope } = {}) {
  const ownsLock = (dir) => existsSync(join(dir, OAS_LOCK_FILE));
  const out = new Set();
  for (let d = resolve(startDir); ; d = dirname(d)) {
    if (ownsLock(d)) out.add(d);
    if (dirname(d) === d) break;
  }
  const boundary = resolve(teamScope || startDir);
  if (ownsLock(boundary)) out.add(boundary);
  for (const s of discoverWorkspaceScopes(boundary)) if (ownsLock(s)) out.add(resolve(s));
  // Plain code-unit sort: deterministic, and a parent path is a prefix of its
  // children so ancestors are always planned and applied first.
  return [...out].sort();
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
export function requirementInstallPlan(req, { platform = process.platform, context } = {}) {
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
    // Same executable the session will launch with — see verifyRuntimePackages.
    const opts = { context, ...(r.runtime === "claude" && context ? { bin: resolveClaudeBinary(context) } : {}) };
    const steps = mgr.steps ? mgr.steps(r.package, req, opts) : [mgr.argv(r.package, req, opts)];
    return {
      command: r.command, why: r.why, docs: r.install.docs,
      manager: r.runtime, steps, argv: steps[steps.length - 1], source: `${r.runtime} package (${r.package})`,
      // Carried so POST-INSTALL verification probes the same executable and
      // context the install ran through. Without it, an install performed via
      // `claude-personal` is verified against the literal `claude` and reported
      // failed (or falsely successful) purely by which account holds the plugin
      // (reviewer-165d668).
      probe: opts,
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
          const probeOpts = { context: scope, ...(r.runtime === "claude" ? { bin: resolveClaudeBinary(scope) } : {}) };
          if (runtimePackageInstalled(r.runtime, r.package, env, probeOpts)) continue;
          const plan = requirementInstallPlan(raw, { platform, context: scope });
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
  // steps is authoritative: two capabilities can require the same plugin while
  // registering its marketplace from DIFFERENT sources, which collapses to one
  // requirement if only the final argv is compared (reviewer-6f1bb9c).
  const planKey = (p) => JSON.stringify(p?.steps || (p?.argv ? [p.argv] : null) || p?.unavailable || null);
  for (const agg of byCommand.values()) {
    if (!agg._plans) continue;
    const keys = new Set(agg._plans.map((x) => planKey(x.plan)));
    if (keys.size > 1) {
      agg.conflict = { plans: agg._plans.map((x) => ({ capability: x.capability, scope: x.scope, argv: x.plan?.argv || null, steps: x.plan?.steps || null, unavailable: x.plan?.unavailable || null })) };
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
    ? runtimePackageInstalled(plan.runtime, plan.package, env, plan.probe || {})
    : commandOnPath(plan.command, env);
  return { command: plan.command, installed: true, onPath };
}
