// Guided official-capability migration: existing 0.18.x deployments (ordinary
// oas-config.yaml + v1 oas-lock.json + .agents/capabilities/installed/ official
// artifacts) upgrading to the official OAS packages.
//
// The fixture is a REAL 0.18 shape — a laptop/outer scope, a team boundary and
// a nested scope, each with its own v1 lock and installed capability artifacts,
// plus custom (git/path), owned and from:path capabilities that the guided
// command must never touch.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  OAS_LOCK_FILE, capabilityIntegrity, capabilityManifests, installedCapabilitiesDir, ownedCapabilitiesDir,
  officialCapabilityPackage, resolveOasConfig, writeCapabilityLock,
} from "../lib/core.mjs";
import { discoverMigrationScopes } from "../lib/packages.mjs";

const CLI = resolve(new URL("../bin/oas.mjs", import.meta.url).pathname);
function temp() { return mkdtempSync(join(tmpdir(), "oas-official-mig-")); }
function write(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function gitify(dir) {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.invalid"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "T"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** Hermetic child environment. The suite runs INSIDE an OAS instance in this
 * fleet, so two leaks have to be closed or a case silently reads real state:
 *   - HOME: the config/lock walk climbs to `/` and unions the laptop level, so
 *     a developer's own ~/oas-config.yaml or ~/oas-lock.json would be seen.
 *   - OAS_* / PI_*: `OAS_HOME`/`PI_AGENT_HOME` make the CLI adopt the ambient
 *     instance's `instance.json` and re-point its context at the REAL repo. */
const HERMETIC_HOME = mkdtempSync(join(tmpdir(), "oas-official-migration-home-"));
function hermeticEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(OAS|PI)_/.test(k)) env[k] = v;
  env.HOME = HERMETIC_HOME;
  env.OAS_HOME_DIR = join(HERMETIC_HOME, ".oas");
  return env;
}

/** Run the CLI with a fixture catalog bound through OAS_PACKAGE_CATALOG. */
function cli(cwd, catalogFile, ...argv) {
  const env = hermeticEnv();
  if (catalogFile) env.OAS_PACKAGE_CATALOG = catalogFile;
  else delete env.OAS_PACKAGE_CATALOG;
  return spawnSync(process.execPath, [CLI, ...argv], { cwd, env, encoding: "utf8" });
}
function json(r) {
  const doc = JSON.parse(r.stdout);
  assert.equal(r.stdout.trim(), JSON.stringify(doc), "stdout is exactly one JSON document");
  return doc;
}

/** Content hash of every file under a tree — the side-effect-free / byte-identical oracle. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[relative(dir, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

// ---------- official package sources (what the catalog publishes) ----------

function pkgSource(dir, pkgId, capabilities) {
  const rels = [];
  for (const [rel, cm] of Object.entries(capabilities)) {
    rels.push(rel);
    for (const [file, body] of Object.entries(cm._files || {})) write(join(dir, rel, file), body);
    const { _files, ...manifest } = cm;
    write(join(dir, rel, "oas.json"), JSON.stringify({ version: "2.0.0", description: "official", ...manifest }, null, 2));
  }
  write(join(dir, "oas-package.json"), JSON.stringify({
    package: pkgId, version: "2.0.0", description: `official ${pkgId}`,
    compatibility: { oas: ">=0.1.0" }, capabilities: rels,
  }, null, 2));
  gitify(dir);
  return dir;
}

/** The official packages of the release contract (oas.review ships inside oas.dev). */
function officialSources(base) {
  const p = (n) => join(base, "pkgs", n);
  return {
    "oas.okf": pkgSource(p("okf"), "oas.okf", {
      okf: { capability: "oas.okf", layer: "knowledge", commands: { harvest: "harvest.mjs" }, requires: [{ command: "git", why: "knowledge bundles live in git" }], _files: { "harvest.mjs": "// harvest\n" } },
    }),
    "oas.dev": pkgSource(p("dev"), "oas.dev", {
      review: { capability: "oas.review", commands: { review: "review.mjs" }, _files: { "review.mjs": "// review\n" } },
    }),
    "oas.aweb": pkgSource(p("aweb"), "oas.aweb", {
      aweb: { capability: "oas.aweb", hooks: { spawn: "spawn.mjs" }, _files: { "spawn.mjs": "// spawn\n" } },
    }),
    "oas.authoring": pkgSource(p("authoring"), "oas.authoring", {
      authoring: { capability: "oas.authoring" },
    }),
  };
}

/** Write a fixture catalog. `packages` names which official packages this
 * release publishes; aliases map legacy capability ids onto them. */
function writeCatalog(file, sources, packages, aliases = { "oas.review": "oas.dev" }) {
  const entries = {};
  for (const id of packages) entries[id] = { url: sources[id], path: "." };
  write(file, JSON.stringify({ packages: entries, capabilities: aliases }, null, 2));
  return file;
}

// ---------- the 0.18 deployment ----------

/** Install a 0.18-style capability artifact + its v1 lock entry at a scope. */
function legacyCap(level, capId, { dirName, manifest = {}, source, version = "1.0.0" } = {}) {
  const dir = join(installedCapabilitiesDir(level), dirName || capId.replace(/\./g, "-"));
  write(join(dir, "oas.json"), JSON.stringify({ capability: capId, version, description: "0.18 capability", ...manifest }, null, 2));
  writeCapabilityLock(level, capId, {
    source: source || `marketplace:${capId}@${version}`,
    version, integrity: capabilityIntegrity(dir), trustedExecutables: true,
  });
  return dir;
}

/**
 * base/outer                laptop-ish outer scope: config + v1 lock (oas.authoring)
 * base/outer/team           team boundary: config + v1 lock (oas.okf knowledge layer,
 *                           oas.review, custom.cap via git:, vendored.cap via path:)
 *                           plus an owned capability that is not locked at all
 * base/outer/team/nested    descendant scope: config + v1 lock (oas.aweb)
 */
/** `custom: false` drops the git:/path: capabilities, giving the all-official
 * cutover shape — the only shape a guided upgrade can actually convert, since
 * a mixed scope is refused whole. */
function deploy018(base, { custom = true } = {}) {
  const outer = join(base, "outer");
  write(join(outer, "oas-config.yaml"), "name: outer\ncapabilities:\n  additive:\n    oas.authoring:\n      from: installed\n      global: true\n");
  legacyCap(outer, "oas.authoring");

  const team = join(outer, "team");
  write(join(team, "oas-config.yaml"), [
    "name: team",
    "team:",
    "  name: fixture-team",
    "capabilities:",
    "  layers:",
    "    knowledge:",
    "      capability: oas.okf",
    "      from: installed",
    "      global: true",
    "  additive:",
    "    oas.review:",
    "      from: installed",
    "      global: true",
    "      settings:",
    "        depth: full",
    ...(custom ? [
      "    custom.cap:",
      "      from: installed",
      "      global: true",
    ] : []),
    "    mine.cap:",
    "      from: owned",
    "      global: true",
    ...(custom ? [
      "    vendored.cap:",
      "      from: path:vendor/vendored",
      "      global: true",
    ] : []),
    "",
  ].join("\n"));
  legacyCap(team, "oas.okf", { manifest: { layer: "knowledge" }, version: "1.4.1" });
  legacyCap(team, "oas.review", { version: "1.2.0" });
  if (custom) legacyCap(team, "custom.cap", { dirName: "custom", source: `git:https://host/custom.git`, version: "0.3.0" });
  // Owned capability: authored at this scope, never locked, never migrated.
  write(join(ownedCapabilitiesDir(team), "mine", "oas.json"), JSON.stringify({ capability: "mine.cap", version: "0.1.0", description: "mine" }, null, 2));
  // from: path capability — locked with a path: v1 source, like 0.18 did.
  if (custom) {
    const vendored = join(team, "vendor", "vendored");
    write(join(vendored, "oas.json"), JSON.stringify({ capability: "vendored.cap", version: "0.2.0", description: "vendored" }, null, 2));
    writeCapabilityLock(team, "vendored.cap", { source: `path:${vendored}`, version: "0.2.0", integrity: capabilityIntegrity(vendored), trustedExecutables: true });
  }

  const nested = join(team, "nested");
  write(join(nested, "oas-config.yaml"), "name: nested\ncapabilities:\n  additive:\n    oas.aweb:\n      from: installed\n      global: true\n");
  legacyCap(nested, "oas.aweb", { version: "1.1.0" });

  return { outer, team, nested };
}

// ---------- tests ----------

test("0.18 state still works under the new kernel, and doctor names the exact guided command", () => {
  const base = temp();
  const { outer, team, nested } = deploy018(base);
  const catalog = writeCatalog(join(base, "catalog.json"), officialSources(base), ["oas.okf", "oas.dev", "oas.aweb", "oas.authoring"]);

  // Config activation resolves BEFORE any migration: v1 locks + installed artifacts.
  const r = resolveOasConfig(team);
  assert.equal(r.layers.knowledge.id, "oas.okf");
  assert.deepEqual(r.capabilities.map((c) => c.id).sort(), ["custom.cap", "mine.cap", "oas.authoring", "oas.okf", "oas.review", "vendored.cap"]);
  assert.equal(r.capabilities.find((c) => c.id === "oas.review").settings.depth, "full");
  assert.ok(capabilityManifests(nested)["oas.aweb"]);

  // The alias is what makes oas.review resolvable at all.
  process.env.OAS_PACKAGE_CATALOG = catalog;
  try {
    assert.deepEqual(officialCapabilityPackage("oas.review"), { capability: "oas.review", package: "oas.dev", via: "alias", available: true });
    assert.deepEqual(officialCapabilityPackage("oas.okf"), { capability: "oas.okf", package: "oas.okf", via: "identity", available: true });
  } finally { delete process.env.OAS_PACKAGE_CATALOG; }

  const doc = JSON.parse(cli(team, catalog, "doctor", team, "--json").stdout);
  assert.equal(doc.officialMigration.status, "ready");
  assert.equal(doc.officialMigration.command, `oas migrate --official --recursive --dir ${team}`);
  assert.deepEqual(
    doc.officialMigration.capabilities.filter((c) => c.capability === "oas.review"),
    [{ capability: "oas.review", package: "oas.dev", via: "alias", available: true, file: join(team, OAS_LOCK_FILE), level: team }],
  );
  const human = cli(team, catalog, "doctor", team);
  assert.match(human.stdout, /Official capability migration/);
  assert.match(human.stdout, /oas\.review → package oas\.dev \(catalog alias\)/);
  assert.match(human.stdout, /READY: migrate with `oas migrate --official --recursive --dir /);
  void outer;
  rmSync(base, { recursive: true, force: true });
});

test("no catalog mappings (0.19.0): doctor says not yet available and the guided command holds every scope, changing nothing", () => {
  const base = temp();
  const { outer, team } = deploy018(base);
  const catalog = writeCatalog(join(base, "catalog.json"), officialSources(base), []); // catalog publishes nothing yet
  const before = snapshot(outer);

  const doc = JSON.parse(cli(team, catalog, "doctor", team, "--json").stdout);
  assert.equal(doc.officialMigration.status, "unavailable");
  assert.match(doc.officialMigration.reason, /keeps the legacy capabilities working/);
  assert.equal(doc.officialMigration.command, null);
  assert.match(cli(team, catalog, "doctor", team).stdout, /NOT YET AVAILABLE/);

  const r = cli(team, catalog, "migrate", "--official", "--recursive", "--dir", team, "--json");
  assert.notEqual(r.status, 0, "a guided run that migrated nothing must not report success");
  const env = json(r);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "E_MIGRATE_FAILED");
  assert.deepEqual(env.error.details.scopes.map((s) => s.status), ["held", "held", "held"]);
  // Held is a hold, not a conversion: nothing anywhere was rewritten.
  assert.deepEqual(snapshot(outer), before, "every official v1 state is untouched when mappings are missing");
  rmSync(base, { recursive: true, force: true });
});

test("dry-run across outer + team + nested scopes is deterministic, complete and side-effect-free", () => {
  const base = temp();
  const { outer, team, nested } = deploy018(base);
  const catalog = writeCatalog(join(base, "catalog.json"), officialSources(base), ["oas.okf", "oas.dev", "oas.aweb", "oas.authoring"]);
  const before = snapshot(outer);

  assert.deepEqual(discoverMigrationScopes(team, { teamScope: team }), [outer, team, nested]);

  const first = json(cli(team, catalog, "migrate", "--official", "--recursive", "--dir", team, "--dry-run", "--json"));
  const second = json(cli(nested, catalog, "migrate", "--official", "--recursive", "--dir", team, "--dry-run", "--json"));
  assert.deepEqual(first, second, "the plan does not depend on the cwd and does not drift between runs");
  // The team scope mixes official capabilities with a git: and a path: entry the
  // guided upgrade keeps unchanged. A capability-materialization lock has no
  // place for those, so that scope is BLOCKED, not ready — and a dry run that
  // contains one is nonzero, so automation can never read it as ready.
  assert.equal(first.ok, false);
  const details = first.error.details;
  assert.equal(first.error.code, "E_MIGRATE_FAILED");
  assert.match(first.error.message, /1 scope blocked \(entries that must stay lockfileVersion 1\).*2 ready/);
  assert.equal(details.dryRun, true);
  assert.deepEqual(details.scopes.map((s) => s.level), [outer, team, nested], "ancestors are planned before descendants");
  assert.deepEqual(details.scopes.map((s) => s.status), ["ready", "blocked", "ready"]);
  const teamPlan = details.scopes.find((s) => s.level === team).plan;
  assert.deepEqual(teamPlan.filter((p) => p.action === "acquire").map((p) => [p.capability, p.package, p.spec, p.via]), [
    ["oas.okf", "oas.okf", "oas.okf", "identity"],
    ["oas.review", "oas.dev", "oas.dev", "alias"],
  ]);
  assert.deepEqual(teamPlan.filter((p) => p.action === "retain").map((p) => p.capability).sort(), ["custom.cap", "vendored.cap"]);
  assert.deepEqual(snapshot(outer), before, "a dry run writes nothing");

  const human = cli(team, catalog, "migrate", "--official", "--recursive", "--dir", team, "--dry-run");
  assert.notEqual(human.status, 0, "dry-run and apply agree: a blocked scope is not a ready migration");
  assert.match(human.stdout, /migrate\s+oas\.review → package oas\.dev\s+\(catalog alias: package oas\.dev exports oas\.review\)/);
  assert.match(human.stdout, /keep\s+custom\.cap\s+\(git:https:\/\/host\/custom\.git\) — not converted/);
  assert.match(human.stdout, /is NOT rewritten — capability ids, layers, targets, settings/);
  assert.match(human.stdout, /executable approvals are NOT carried over/);
  assert.match(human.stdout, /BLOCKED\s+this scope mixes convertible work with 2 entries that must stay lockfileVersion 1/);
  assert.match(human.stdout, /Dry run — nothing was changed\. 2 scopes ready, 1 blocked\./);
  assert.match(human.stdout, /Blocked scopes stay on their v1 locks IN FULL and keep working/);
  assert.deepEqual(snapshot(outer), before);
  rmSync(base, { recursive: true, force: true });
});

test("a MIXED scope is refused byte-identically: no official artifact is even partially acquired, and the whole v1 scope keeps working", () => {
  const base = temp();
  const { outer, team, nested } = deploy018(base);
  const catalog = writeCatalog(join(base, "catalog.json"), officialSources(base), ["oas.okf", "oas.dev", "oas.aweb", "oas.authoring"]);
  // The team scope's OWN files: `nested/` is a separate scope that converts on
  // its own, so including it would compare two different verdicts.
  const ownFiles = (d) => Object.fromEntries(Object.entries(snapshot(d)).filter(([k]) => !k.startsWith("nested/")));
  const teamBefore = ownFiles(team);
  const legacyLock = JSON.parse(readFileSync(join(team, OAS_LOCK_FILE), "utf8"));
  const resolvedBefore = resolveOasConfig(team).capabilities.map((c) => c.id).sort();

  const r = cli(team, catalog, "migrate", "--official", "--recursive", "--dir", team, "--json");
  assert.notEqual(r.status, 0, "a run containing a blocked scope is not a success");
  const env = json(r);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "E_MIGRATE_FAILED");
  const byScope = Object.fromEntries(env.error.details.scopes.map((x) => [x.level, x]));
  // Dry run and apply agree: the team scope is refused, its neighbours convert.
  assert.equal(byScope[team].status, "failed");
  assert.equal(byScope[team].error.code, "legacy-lock");
  assert.equal(byScope[outer].status, "migrated");
  assert.equal(byScope[nested].status, "migrated");

  // The refusal NAMES every retained entry — both source kinds — and says the
  // whole v1 scope stays usable.
  for (const [id, src] of [["custom.cap", "git:https://host/custom.git"], ["vendored.cap", "path:"]]) {
    assert.ok(byScope[team].error.message.includes(id), byScope[team].error.message);
    assert.ok(byScope[team].error.message.includes(src), byScope[team].error.message);
  }
  assert.match(byScope[team].error.message, /NOTHING was changed and the whole v1 scope stays usable/);
  // Both retained sources are package-mappable, so the guidance names the exact
  // command that CAN convert this scope completely.
  assert.match(byScope[team].error.message, new RegExp(`\`oas migrate --dir ${team.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}\` \\(without --official\\)`));

  // 1. NOTHING at the refused scope moved: lock bytes, config, artifacts, the
  //    ignore file, trust. Not one official artifact was partially acquired.
  assert.deepEqual(ownFiles(team), teamBefore, "a refused scope is byte-identical");
  assert.deepEqual(JSON.parse(readFileSync(join(team, OAS_LOCK_FILE), "utf8")), legacyLock);
  assert.equal(existsSync(join(installedCapabilitiesDir(team), "oas.okf")), false, "no materialized artifact was created");
  assert.equal(existsSync(join(installedCapabilitiesDir(team), "oas.review")), false);
  assert.ok(existsSync(join(installedCapabilitiesDir(team), "oas-okf")), "the v1 artifact is still there");

  // 2. and the scope still RESOLVES — the whole point of refusing.
  assert.deepEqual(resolveOasConfig(team).capabilities.map((c) => c.id).sort(), resolvedBefore);
  assert.ok(resolvedBefore.includes("custom.cap") && resolvedBefore.includes("vendored.cap"));

  // 3. the human report says the same thing.
  const human = cli(team, catalog, "migrate", "--official", "--recursive", "--dir", team);
  assert.notEqual(human.status, 0);
  assert.match(human.stdout, /BLOCKED\s+this scope mixes convertible work with 2 entries/);
  rmSync(base, { recursive: true, force: true });
});

test("guided migration of an ALL-OFFICIAL scope: config bytes preserved, exact v2 graph, superseded artifacts removed, owned untouched, trust + requirements reported", () => {
  const base = temp();
  const { outer, team, nested } = deploy018(base, { custom: false });
  const catalog = writeCatalog(join(base, "catalog.json"), officialSources(base), ["oas.okf", "oas.dev", "oas.aweb", "oas.authoring"]);
  const configsBefore = Object.fromEntries([outer, team, nested].map((d) => [d, readFileSync(join(d, "oas-config.yaml"), "utf8")]));
  const ownedArtifact = snapshot(ownedCapabilitiesDir(team));

  const env = json(cli(team, catalog, "migrate", "--official", "--recursive", "--dir", team, "--json"));
  assert.equal(env.ok, true, JSON.stringify(env));
  assert.deepEqual(env.result.scopes.map((s) => [s.level, s.status]), [[outer, "migrated"], [team, "migrated"], [nested, "migrated"]]);
  // There is no residue container, so no result shape may claim one.
  for (const sc of env.result.scopes) assert.equal(Object.hasOwn(sc, "residue"), false, JSON.stringify(sc));

  // 1. config files are byte-for-byte what they were.
  for (const [d, text] of Object.entries(configsBefore)) assert.equal(readFileSync(join(d, "oas-config.yaml"), "utf8"), text, `${d} config rewritten`);

  // 2. exact v2 lock graph at the team scope; oas.review arrives through oas.dev.
  const lock = JSON.parse(readFileSync(join(team, OAS_LOCK_FILE), "utf8"));
  assert.equal(lock.lockfileVersion, 2);
  assert.deepEqual(Object.keys(lock.packages).sort(), ["oas.dev", "oas.okf"]);
  assert.equal(lock.packages["oas.review"], undefined, "the package identity is oas.dev, not the capability id");
  for (const [id, expectCaps] of [["oas.okf", ["oas.okf"]], ["oas.dev", ["oas.review"]]]) {
    const e = lock.packages[id];
    assert.equal(e.source, `catalog:${id}`, "the ORIGINAL bare catalog spec is locked — no ref guessed from the v1 version");
    assert.equal(e.path, ".");
    assert.equal(e.version, "2.0.0");
    assert.match(e.commit, /^[0-9a-f]{40}$/);
    assert.match(e.integrity, /^sha256-[0-9a-f]{64}$/);
    assert.deepEqual(e.dependencies, []);
    // Package rows lock the TRANSPORT only; the capability rows' provider
    // back-reference is the single truth about what a package supplies.
    assert.equal(Object.hasOwn(e, "capabilities"), false);
    assert.equal(Object.hasOwn(e, "trustedCapabilities"), false);
    for (const cap of expectCaps) {
      assert.equal(lock.capabilities[cap].package, id);
      assert.equal(lock.capabilities[cap].trusted, false, "executable approvals are re-earned, never carried over");
    }
  }
  assert.deepEqual(Object.keys(lock.capabilities).sort(), ["oas.okf", "oas.review"]);

  // 3. superseded official artifacts are removed; owned capabilities are not touched.
  assert.equal(existsSync(join(installedCapabilitiesDir(team), "oas-okf")), false);
  assert.equal(existsSync(join(installedCapabilitiesDir(team), "oas-review")), false);
  assert.ok(existsSync(join(installedCapabilitiesDir(team), "oas.okf", "oas.json")), "materialized flat, by capability id");
  assert.deepEqual(snapshot(ownedCapabilitiesDir(team)), ownedArtifact);

  // 4. activation behavior is unchanged — same ids, same layer, same settings, now package-provided.
  const r = resolveOasConfig(team);
  assert.equal(r.layers.knowledge.id, "oas.okf");
  assert.deepEqual(r.capabilities.map((c) => c.id).sort(), ["mine.cap", "oas.authoring", "oas.okf", "oas.review"]);
  assert.equal(r.capabilities.find((c) => c.id === "oas.review").settings.depth, "full");
  assert.equal(capabilityManifests(team)["oas.okf"]._package, "oas.okf");
  assert.equal(capabilityManifests(team)["oas.review"]._package, "oas.dev");

  // 5. trust must be re-earned, with exact commands; installed host requirements need no reinstall.
  assert.deepEqual(env.result.trust.map((t) => t.capability).sort(), ["oas.aweb", "oas.okf", "oas.review"]);
  assert.ok(env.result.trust.every((t) => t.command === `oas trust ${t.capability} --dir ${t.level}`), JSON.stringify(env.result.trust));
  assert.deepEqual(env.result.requirements, [], "git is on PATH — an installed requirement is verified, not reinstalled");
  assert.equal(env.result.nextCommands.at(-1), `oas install --dir ${team}`);
  rmSync(base, { recursive: true, force: true });
});

test("one scope's failure rolls that scope back byte-identically and the aggregate reports the truth", () => {
  const base = temp();
  // All-official: a mixed scope would be refused before it could demonstrate a
  // rollback, and the point here is the rollback of a scope that DID start.
  const { outer, team, nested } = deploy018(base, { custom: false });
  const sources = officialSources(base);
  // Injected failure: the catalog entry for oas.aweb resolves to a package that
  // does not export oas.aweb — the nested scope's conversion must fail.
  sources["oas.aweb"] = sources["oas.authoring"];
  const catalog = writeCatalog(join(base, "catalog.json"), sources, ["oas.okf", "oas.dev", "oas.aweb", "oas.authoring"]);
  const nestedBefore = snapshot(nested);

  const r = cli(team, catalog, "migrate", "--official", "--recursive", "--dir", team, "--json");
  assert.notEqual(r.status, 0);
  const env = json(r);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "E_MIGRATE_FAILED");
  const byScope = Object.fromEntries(env.error.details.scopes.map((s) => [s.level, s]));
  assert.equal(byScope[outer].status, "migrated");
  assert.equal(byScope[team].status, "migrated", "a healthy scope's success is reported, not hidden by another scope's failure");
  assert.equal(byScope[nested].status, "failed");
  assert.match(byScope[nested].error.message, /rolled back/);
  assert.deepEqual(snapshot(nested), nestedBefore, "the failing scope is byte-identical to before");
  assert.equal(JSON.parse(readFileSync(join(team, OAS_LOCK_FILE), "utf8")).lockfileVersion, 2);
  rmSync(base, { recursive: true, force: true });
});

test("a scope with only custom capabilities is left on v1, untouched, and reports what it RETAINED", () => {
  const base = temp();
  const custom = join(base, "custom-only");
  write(join(custom, "oas-config.yaml"), "name: custom\n");
  legacyCap(custom, "only.cap", { dirName: "only", source: "git:https://host/only.git" });
  legacyCap(custom, "vendor.cap", { dirName: "vendor", source: "path:/somewhere/vendor" });
  const catalog = writeCatalog(join(base, "catalog.json"), officialSources(base), ["oas.okf", "oas.dev"]);
  const before = snapshot(custom);

  const env = json(cli(custom, catalog, "migrate", "--official", "--dir", custom, "--json"));
  assert.equal(env.ok, true, "no official work is a truthful no-op, not a failure");
  const [scope] = env.result.scopes;
  assert.equal(scope.status, "skipped");
  // `retained` — never `residue`: nothing was kept BESIDE a conversion, because
  // there was no conversion. There is no residue container to report.
  assert.deepEqual(scope.retained.sort(), ["only.cap", "vendor.cap"]);
  assert.equal(Object.hasOwn(scope, "residue"), false);
  assert.deepEqual(snapshot(custom), before, "a lock with no official capabilities is not even reformatted");
  assert.equal(JSON.parse(readFileSync(join(custom, OAS_LOCK_FILE), "utf8")).lockfileVersion ?? 1, 1);
  rmSync(base, { recursive: true, force: true });
});

test("several legacy capabilities aliased to ONE package migrate together, acquired once (reviewer-90dbb36)", () => {
  const base = temp();
  // One package exporting two capabilities, both reached through catalog aliases —
  // the shape oas.dev already has, and the shape that must not collide with its
  // own still-unconverted v1 entries during acquisition.
  const bundle = pkgSource(join(base, "pkgs", "bundle"), "oas.bundle", {
    a: { capability: "oas.a" },
    b: { capability: "oas.b", commands: { go: "go.mjs" }, _files: { "go.mjs": "// go\n" } },
  });
  const catalog = writeCatalog(join(base, "catalog.json"), { "oas.bundle": bundle }, ["oas.bundle"], { "oas.a": "oas.bundle", "oas.b": { package: "oas.bundle" } });
  const scope = join(base, "scope");
  write(join(scope, "oas-config.yaml"), "name: s\ncapabilities:\n  additive:\n    oas.a:\n      from: installed\n      global: true\n    oas.b:\n      from: installed\n      global: true\n");
  legacyCap(scope, "oas.a", { dirName: "a" });
  legacyCap(scope, "oas.b", { dirName: "b" });

  const env = json(cli(scope, catalog, "migrate", "--official", "--dir", scope, "--json"));
  assert.equal(env.ok, true, JSON.stringify(env));
  const row = env.result.scopes[0];
  assert.equal(row.status, "migrated");
  assert.deepEqual(row.migrated, [
    { capability: "oas.a", package: "oas.bundle", version: "2.0.0" },
    { capability: "oas.b", package: "oas.bundle", version: "2.0.0" },
  ]);
  const lock = JSON.parse(readFileSync(join(scope, OAS_LOCK_FILE), "utf8"));
  assert.deepEqual(Object.keys(lock.packages), ["oas.bundle"]);
  // Package rows lock the TRANSPORT only; the capability rows' `package`
  // back-reference is the single provider truth, so BOTH aliases land as
  // capability rows naming the one package that was acquired once.
  assert.equal(Object.hasOwn(lock.packages["oas.bundle"], "capabilities"), false);
  assert.deepEqual(Object.keys(lock.capabilities).sort(), ["oas.a", "oas.b"]);
  for (const id of ["oas.a", "oas.b"]) assert.equal(lock.capabilities[id].package, "oas.bundle");
  assert.deepEqual(Object.values(lock.capabilities).map((c) => c.trusted), [false, false], "executable approvals are re-earned, never carried over");
  assert.deepEqual(env.result.trust.map((t) => t.capability), ["oas.b"], "only the executable capability needs re-approval");
  assert.deepEqual(resolveOasConfig(scope).capabilities.map((c) => c.id).sort(), ["oas.a", "oas.b"]);
  rmSync(base, { recursive: true, force: true });
});

test("a held dry run reports nonzero — automation can never read it as ready (reviewer-90dbb36)", () => {
  const base = temp();
  const { team } = deploy018(base);
  // Catalog publishes oas.okf but not oas.dev: the team scope is held, the rest planned.
  const catalog = writeCatalog(join(base, "catalog.json"), officialSources(base), ["oas.okf", "oas.aweb", "oas.authoring"]);

  const r = cli(team, catalog, "migrate", "--official", "--recursive", "--dir", team, "--dry-run", "--json");
  assert.notEqual(r.status, 0, "a plan containing held scopes is not a success");
  const env = json(r);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "E_MIGRATE_FAILED");
  assert.match(env.error.message, /1 scope held \(no official package mapping yet\).*2 ready/);
  const byScope = Object.fromEntries(env.error.details.scopes.map((s) => [s.level, s]));
  assert.equal(byScope[team].status, "held", "the complete plan still travels under error.details");
  assert.ok(byScope[team].plan.some((p) => p.action === "hold" && p.capability === "oas.review" && /does not resolve "oas.dev"/.test(p.reason)));

  const human = cli(team, catalog, "migrate", "--official", "--recursive", "--dir", team, "--dry-run");
  assert.notEqual(human.status, 0);
  assert.match(human.stdout, /2 scopes ready, 1 held/);
  assert.match(human.stdout, /Held scopes stay on their v1 locks and their legacy capabilities keep working/);
  rmSync(base, { recursive: true, force: true });
});

test("--recursive without --official refuses a scope it cannot fully map, leaving its v1 lock working", () => {
  const base = temp();
  const root = join(base, "generic");
  write(join(root, "oas-config.yaml"), "name: generic\n");
  legacyCap(root, "some.cap", { dirName: "some" });
  const catalog = writeCatalog(join(base, "catalog.json"), officialSources(base), []);
  const before = snapshot(root);

  // A capability-materialization lock has NO residue container, so there is
  // nowhere for an unmappable v1 entry to live. Converting only the mappable
  // entries would silently drop the rest, so the scope stays v1 IN FULL and
  // keeps working — the refusal is the feature, not a failure to implement one.
  const r = cli(root, catalog, "migrate", "--recursive", "--dir", root, "--json");
  assert.notEqual(r.status, 0, "a scope that cannot be converted is not a success");
  const env = json(r);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "E_MIGRATE_FAILED");
  assert.deepEqual(env.error.details.mode, "generic");
  const [scope] = env.error.details.scopes;
  assert.equal(scope.status, "failed");
  assert.equal(scope.error.code, "legacy-lock");
  assert.match(scope.error.message, /this scope cannot be converted yet — some\.cap/);
  assert.match(scope.error.message, /left unchanged and its v1 capabilities keep working/);

  assert.deepEqual(snapshot(root), before, "a refused scope is byte-identical");
  const lock = JSON.parse(readFileSync(join(root, OAS_LOCK_FILE), "utf8"));
  assert.equal(lock.lockfileVersion ?? 1, 1, "it is still a v1 lock");
  assert.deepEqual(Object.keys(lock.capabilities), ["some.cap"]);
  rmSync(base, { recursive: true, force: true });
});

test("rerun is idempotent and the migrated deployment reaches zero v1 lock files", () => {
  const base = temp();
  // All-official deployment (the plain existing-user cutover).
  const root = join(base, "deployment");
  write(join(root, "oas-config.yaml"), "name: root\nteam:\n  name: cutover\ncapabilities:\n  layers:\n    knowledge:\n      capability: oas.okf\n      from: installed\n      global: true\n");
  legacyCap(root, "oas.okf", { manifest: { layer: "knowledge" }, version: "1.4.1" });
  const inner = join(root, "inner");
  write(join(inner, "oas-config.yaml"), "name: inner\ncapabilities:\n  additive:\n    oas.aweb:\n      from: installed\n      global: true\n");
  legacyCap(inner, "oas.aweb");
  const catalog = writeCatalog(join(base, "catalog.json"), officialSources(base), ["oas.okf", "oas.dev", "oas.aweb", "oas.authoring"]);

  const first = json(cli(root, catalog, "migrate", "--official", "--recursive", "--dir", root, "--json"));
  assert.deepEqual(first.result.scopes.map((s) => s.status), ["migrated", "migrated"]);
  const after = snapshot(root);

  const again = json(cli(root, catalog, "migrate", "--official", "--recursive", "--dir", root, "--json"));
  assert.equal(again.ok, true);
  assert.deepEqual(again.result.scopes.map((s) => s.status), ["skipped", "skipped"]);
  assert.deepEqual(snapshot(root), after, "a rerun changes nothing");

  // Cutover state: trust the executable surfaces, verify the closure, and doctor is clean.
  for (const t of first.result.trust) {
    const tr = cli(root, catalog, "trust", t.capability, "--dir", t.level);
    assert.equal(tr.status, 0, tr.stderr || tr.stdout);
  }
  const inst = cli(root, catalog, "install", "--dir", root);
  assert.equal(inst.status, 0, inst.stderr || inst.stdout);
  const doc = JSON.parse(cli(root, catalog, "doctor", root, "--json").stdout);
  assert.deepEqual(doc.legacyLockFiles, [], "no v1 lock files remain");
  assert.equal(Object.hasOwn(doc, "migrationResidue"), false, "there is no residue view — migration never produces residue");
  assert.equal(doc.lockError, null, "and every lock in the chain reads cleanly");
  assert.equal(doc.officialMigration, null, "nothing left to migrate");
  assert.deepEqual(doc.packages.flatMap((p) => p.problems), [], JSON.stringify(doc.packages));
  rmSync(base, { recursive: true, force: true });
});

test("CLI surface: help documents the guided command and the JSON contract is one stable envelope", () => {
  const base = temp();
  // All-official, so a successful dry run is available to pin the SUCCESS shape.
  const { team } = deploy018(base, { custom: false });
  const catalog = writeCatalog(join(base, "catalog.json"), officialSources(base), ["oas.okf", "oas.dev", "oas.aweb", "oas.authoring"]);

  const help = cli(base, catalog, "help");
  assert.match(help.stdout, /oas migrate --official \[--recursive\]/);

  const env = json(cli(team, catalog, "migrate", "--official", "--recursive", "--dir", team, "--dry-run", "--json"));
  assert.deepEqual(Object.keys(env).sort(), ["ok", "result", "schemaVersion"]);
  assert.equal(env.schemaVersion, 1);
  assert.deepEqual(Object.keys(env.result).sort(), ["boundary", "dryRun", "mode", "nextCommands", "recursive", "requirements", "scopes", "trust", "warnings"]);
  assert.deepEqual(Object.keys(env.result.scopes[0]).sort(), ["error", "file", "level", "levelKind", "plan", "status", "warnings"]);
  assert.deepEqual(Object.keys(env.result.scopes[0].plan[0]).sort(), ["action", "capability", "note", "package", "reason", "source", "spec", "via"]);
  assert.equal(env.result.mode, "official");
  // There is no residue container, so no scope row may carry a `residue` key.
  for (const sc of env.result.scopes) assert.equal(Object.hasOwn(sc, "residue"), false);

  // Failure stays the exact three-key envelope, with the complete report under error.details.
  write(join(team, OAS_LOCK_FILE), "{ not json");
  const bad = cli(team, catalog, "migrate", "--official", "--recursive", "--dir", team, "--json");
  const badEnv = json(bad);
  assert.notEqual(bad.status, 0);
  assert.deepEqual(Object.keys(badEnv).sort(), ["error", "ok", "schemaVersion"], "EXACT failure shape — no extra top-level keys");
  assert.equal(badEnv.error.code, "E_MIGRATE_FAILED");
  assert.ok(badEnv.error.details.scopes.some((s) => s.status === "failed" && s.error.code === "invalid-lock"), JSON.stringify(badEnv.error.details.scopes));
  rmSync(base, { recursive: true, force: true });
});
