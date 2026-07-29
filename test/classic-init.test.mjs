// Fresh CLASSIC `oas init` over capability materialization.
//
// Classic init (no --package, no --template) seeds an oas-config.yaml and, for
// the fundamental layers, acquires whatever backs them. The contract this file
// pins:
//
//   - official layers come through the PACKAGE engine — flat capability
//     artifacts, a capability-materialization lock, no legacy v1 lock, no
//     persistent package store, no legacy/migration warning;
//   - acquisition is not activation, not executable trust, and not requirement
//     consent;
//   - the whole run is ONE transaction: any failure restores the scope,
//     including a capability that was already installed here before the run;
//   - `--raw`, `--template`, and local/owned/path capabilities are unchanged;
//   - `--json` emits exactly one schema-v1 envelope on success and on failure.
//
// Every catalog here is a LOCAL Git fixture bound through OAS_PACKAGE_CATALOG,
// so nothing in this file touches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  OAS_LOCK_FILE, capabilityIntegrity, installedCapabilitiesDir, ownedCapabilitiesDir, writeCapabilityLock,
} from "../lib/core.mjs";

const CLI = resolve(new URL("../bin/oas.mjs", import.meta.url).pathname);
const temp = () => mkdtempSync(join(tmpdir(), "oas-classic-init-"));
function write(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }

function gitify(dir) {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.invalid"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "T"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  // --allow-empty: several scopes here start with no tracked content at all.
  execFileSync("git", ["-C", dir, "commit", "-qm", "init", "--allow-empty"]);
  return dir;
}

/** Run the CLI with a fixture catalog bound through OAS_PACKAGE_CATALOG.
 * Passing `null` binds an EMPTY catalog — the clean-room shape, where the
 * official route is unavailable and init must say so instead of guessing. */
function cli(argv, { catalog, cwd } = {}) {
  const env = { ...process.env };
  if (catalog) env.OAS_PACKAGE_CATALOG = catalog;
  else delete env.OAS_PACKAGE_CATALOG;
  return spawnSync(process.execPath, [CLI, ...argv], { cwd: cwd || tmpdir(), env, encoding: "utf8" });
}

/** Assert stdout is EXACTLY one schema-v1 envelope and return it. */
function envelope(r) {
  const doc = JSON.parse(r.stdout);
  assert.equal(r.stdout.trim(), JSON.stringify(doc), "stdout is exactly one JSON document");
  assert.equal(doc.schemaVersion, 1);
  return doc;
}

/** Content hash of every file under a tree — the byte-identical oracle. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[relative(dir, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

// ---------- official package sources + catalog ----------

/** One official package repository exporting the given capabilities. */
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
  return gitify(dir);
}

/** The official packages classic init reaches for, as local Git repositories. */
function officialSources(base) {
  const p = (n) => join(base, "pkgs", n);
  return {
    "oas.okf": pkgSource(p("okf"), "oas.okf", {
      okf: {
        capability: "oas.okf", layer: "knowledge",
        commands: { harvest: "harvest.mjs" },
        requires: [{ command: "definitely-not-a-real-cmd-xyz", why: "knowledge harvest needs it", install: "brew install nope" }],
        _files: { "harvest.mjs": "// harvest\n" },
      },
    }),
    "oas.aweb": pkgSource(p("aweb"), "oas.aweb", {
      aweb: { capability: "oas.aweb", layer: "messaging", hooks: { spawn: "spawn.mjs" }, _files: { "spawn.mjs": "// spawn\n" } },
    }),
    // A package whose exported capability declares the WRONG layer for the slot
    // it will be asked to fill.
    "oas.mislabelled": pkgSource(p("mislabelled"), "oas.mislabelled", {
      cap: { capability: "oas.mislabelled", layer: "tasks" },
    }),
  };
}

function writeCatalog(file, sources, packages, aliases = {}) {
  const entries = {};
  for (const id of packages) entries[id] = { url: sources[id], path: "." };
  write(file, JSON.stringify({ packages: entries, capabilities: aliases }, null, 2));
  return file;
}

/** A base with official sources published and a catalog naming them. */
function published(packages = ["oas.okf", "oas.aweb", "oas.mislabelled"], aliases = {}) {
  const base = temp();
  const sources = officialSources(base);
  return { base, sources, catalog: writeCatalog(join(base, "catalog.json"), sources, packages, aliases) };
}

const emptyCatalog = (base) => write(join(base, "empty.json"), JSON.stringify({ packages: {} })) ?? join(base, "empty.json");

// ---------- the materialization route ----------

test("classic init acquires official layers through the package engine: flat capabilities, a materialization lock, no v1 residue", () => {
  const { base, catalog } = published();
  const scope = gitify(join(base, "scope"));

  const r = cli(["init", "--knowledge", "oas.okf", "--messaging", "oas.aweb", "--tasks", "none", "--dir", scope], { catalog });
  assert.equal(r.status, 0, r.stdout + r.stderr);

  // The LOCK is a capability-materialization lock with both maps — never v1.
  const lock = JSON.parse(readFileSync(join(scope, OAS_LOCK_FILE), "utf8"));
  assert.equal(lock.lockfileVersion, 2);
  assert.deepEqual(Object.keys(lock.packages).sort(), ["oas.aweb", "oas.okf"]);
  assert.deepEqual(Object.keys(lock.capabilities).sort(), ["oas.aweb", "oas.okf"]);
  // Capability rows back-reference their providing package; package rows carry
  // no capability list of their own (that is the transitional shape).
  assert.equal(lock.capabilities["oas.okf"].package, "oas.okf");
  for (const row of Object.values(lock.packages)) {
    for (const retired of ["capabilities", "trustedCapabilities", "depsIntegrity"]) {
      assert.equal(Object.hasOwn(row, retired), false, `package rows must not carry "${retired}"`);
    }
  }

  // Capabilities are materialized FLAT; there is no persistent package store.
  assert.ok(existsSync(join(scope, ".agents/capabilities/installed/oas.okf/oas.json")));
  assert.ok(existsSync(join(scope, ".agents/capabilities/installed/oas.aweb/oas.json")));
  assert.equal(existsSync(join(scope, ".agents/packages")), false, "capability materialization keeps no package store");

  // The config binds both slots to the materialized capabilities.
  const cfg = readFileSync(join(scope, "oas-config.yaml"), "utf8");
  assert.match(cfg, /knowledge:\n      capability: oas\.okf\n      from: installed/);
  assert.match(cfg, /messaging:\n      capability: oas\.aweb\n      from: installed/);
  assert.match(cfg, /tasks: none/);

  // No legacy/migration warning anywhere: nothing legacy happened.
  assert.doesNotMatch(r.stdout + r.stderr, /LEGACY|oas migrate|lockfileVersion 1/i);

  // Materialized artifacts stay uncommitted; the ignore is part of the run.
  assert.match(readFileSync(join(scope, ".agents/capabilities/.gitignore"), "utf8"), /installed/);
  rmSync(base, { recursive: true, force: true });
});

test("acquisition is not trust and not requirement consent: init says so and leaves both un-granted", () => {
  const { base, catalog } = published();
  const scope = gitify(join(base, "scope"));

  const r = cli(["init", "--knowledge", "oas.okf", "--messaging", "none", "--tasks", "none", "--dir", scope], { catalog });
  assert.equal(r.status, 0, r.stdout + r.stderr);

  // oas.okf ships a command, so its executable surface is BLOCKED until trusted.
  const lock = JSON.parse(readFileSync(join(scope, OAS_LOCK_FILE), "utf8"));
  assert.equal(lock.capabilities["oas.okf"].trusted, false, "the package route never trusts at acquisition");
  assert.match(r.stdout, /blocked until trusted[\s\S]*oas trust oas\.okf/);

  // Its unmet command requirement is REPORTED, never installed or consented to.
  assert.match(r.stdout, /required command "definitely-not-a-real-cmd-xyz" not on PATH/);
  rmSync(base, { recursive: true, force: true });
});

test("classic init --json is one envelope on success and on failure", () => {
  const { base, catalog } = published();
  const scope = gitify(join(base, "scope"));

  const ok = cli(["init", "--knowledge", "oas.okf", "--messaging", "none", "--tasks", "none", "--json", "--dir", scope], { catalog });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const doc = envelope(ok);
  assert.equal(doc.ok, true);
  assert.equal(doc.result.adopted, false, "classic init adopts no config template");
  assert.deepEqual(doc.result.layers, { knowledge: "oas.okf", messaging: "none", tasks: "none" });
  assert.deepEqual(doc.result.acquired.map((a) => [a.layer, a.capability, a.route, a.trusted]), [["knowledge", "oas.okf", "package", false]]);
  assert.deepEqual(doc.result.acquired[0].packages.map((p) => p.package), ["oas.okf"]);
  assert.deepEqual(doc.result.activated, [{ capability: "oas.okf", layer: "knowledge" }]);
  assert.deepEqual(doc.result.requirements.map((q) => q.command), ["definitely-not-a-real-cmd-xyz"]);

  // Failure: a second init at the same scope.
  const again = cli(["init", "--json", "--dir", scope], { catalog });
  assert.equal(again.status, 1);
  const failure = envelope(again);
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, "E_CONFIG_EXISTS");
  rmSync(base, { recursive: true, force: true });
});

test("an unknown layer capability is refused before any mutation, naming both the marketplace and the catalog", () => {
  const { base, catalog } = published();
  const scope = gitify(join(base, "scope"));
  const before = snapshot(scope);

  const r = cli(["init", "--knowledge", "nobody.here", "--json", "--dir", scope], { catalog });
  assert.equal(r.status, 1);
  assert.equal(envelope(r).error.code, "E_UNKNOWN_CAPABILITY");
  assert.deepEqual(snapshot(scope), before, "a refused init touches nothing");
  assert.equal(existsSync(join(scope, ".agents")), false, "not even an anchor directory");
  rmSync(base, { recursive: true, force: true });
});

test("a package whose capability declares the wrong layer is refused and the whole run rolls back", () => {
  const { base, catalog } = published();
  const scope = gitify(join(base, "scope"));
  const before = snapshot(scope);

  // oas.mislabelled declares layer "tasks"; asking it to fill "knowledge" is a lie
  // that is only checkable against the MATERIALIZED manifest.
  const r = cli(["init", "--knowledge", "oas.mislabelled", "--json", "--dir", scope], { catalog });
  assert.equal(r.status, 1, r.stdout);
  assert.equal(envelope(r).error.code, "E_LAYER_MISMATCH");
  assert.deepEqual(snapshot(scope), before, "the acquisition that happened before the check is rolled back");
  assert.equal(existsSync(join(scope, "oas-config.yaml")), false);
  assert.equal(existsSync(join(scope, OAS_LOCK_FILE)), false);
  assert.equal(existsSync(join(scope, ".agents")), false);
  rmSync(base, { recursive: true, force: true });
});

// The blocker regression: a pre-existing same-name capability must come back
// BYTE-IDENTICALLY when a later step of the same run fails.
test("a failing init restores this scope's pre-existing capabilities, lock and provenance byte for byte", () => {
  const base = temp();
  const sources = officialSources(base);
  sources["house.suite"] = pkgSource(join(base, "pkgs", "suite"), "house.suite", {
    k: { capability: "house.knowledge", layer: "knowledge", _files: { "NOTE.md": "the version that was already here\n" } },
  });
  // A second package whose export declares the wrong layer for the slot it will
  // be asked to fill — the acquisition SUCCEEDS and rewrites this scope's lock
  // and store before anything can notice.
  sources["house.clash"] = pkgSource(join(base, "pkgs", "clash"), "house.clash", {
    w: { capability: "house.wrong", layer: "tasks", _files: { "NOTE.md": "the version from the failing run\n" } },
  });
  const catalog = writeCatalog(join(base, "catalog.json"), sources, ["house.suite", "house.clash"], {
    "house.knowledge": "house.suite", "house.wrong": "house.clash",
  });
  const scope = gitify(join(base, "scope"));

  // A real prior deployment at this scope: an installed capability, its
  // materialization lock, and the ignore file that keeps artifacts uncommitted.
  assert.equal(cli(["install", "house.suite", "--dir", scope], { catalog }).status, 0);
  write(join(scope, "keep-me.txt"), "untouched\n");
  const before = snapshot(scope);
  assert.equal(readFileSync(join(scope, ".agents/capabilities/installed/house.knowledge/NOTE.md"), "utf8"), "the version that was already here\n");

  // The messaging slot acquires house.clash — which the local marketplace does
  // not carry, so nothing can refuse it before the acquisition. That acquisition
  // rewrites the lock and adds an artifact; only then does the MATERIALIZED
  // manifest reveal that house.wrong declares "tasks", not "messaging".
  const r = cli(["init", "--knowledge", "house.knowledge", "--messaging", "house.wrong", "--tasks", "none", "--json", "--dir", scope], { catalog });
  assert.equal(r.status, 1, r.stdout);
  assert.equal(envelope(r).error.code, "E_LAYER_MISMATCH", envelope(r).error.message);

  assert.deepEqual(snapshot(scope), before, "every pre-existing byte is restored, and nothing of the run survives");
  assert.equal(readFileSync(join(scope, ".agents/capabilities/installed/house.knowledge/NOTE.md"), "utf8"),
    "the version that was already here\n", "the pre-existing artifact is the ORIGINAL one");
  assert.equal(existsSync(join(scope, "oas-config.yaml")), false);
  assert.equal(existsSync(join(scope, ".agents/capabilities/installed/house.wrong")), false, "the failing run's artifact is gone");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(scope, OAS_LOCK_FILE), "utf8")).packages), ["house.suite"]);
  rmSync(base, { recursive: true, force: true });
});

test("a package that would re-materialize a capability another package already provides here is refused", () => {
  const base = temp();
  const sources = officialSources(base);
  const cap = (note) => ({ k: { capability: "house.knowledge", layer: "knowledge", _files: { "NOTE.md": note } } });
  sources["house.suite"] = pkgSource(join(base, "pkgs", "suite"), "house.suite", cap("already here\n"));
  sources["house.clash"] = pkgSource(join(base, "pkgs", "clash"), "house.clash", cap("the impostor\n"));
  const catalog = writeCatalog(join(base, "catalog.json"), sources, ["house.suite", "house.clash"], {
    "house.knowledge": "house.suite", "house.other": "house.clash",
  });
  const scope = gitify(join(base, "scope"));
  assert.equal(cli(["install", "house.suite", "--dir", scope], { catalog }).status, 0);
  const before = snapshot(scope);

  const r = cli(["init", "--knowledge", "house.other", "--json", "--dir", scope], { catalog });
  assert.equal(r.status, 1, r.stdout);
  assert.equal(envelope(r).error.code, "duplicate-capability-id");
  assert.deepEqual(snapshot(scope), before, "a refused acquisition leaves the incumbent provider untouched");
  assert.equal(readFileSync(join(scope, ".agents/capabilities/installed/house.knowledge/NOTE.md"), "utf8"), "already here\n");
  rmSync(base, { recursive: true, force: true });
});

// ---------- preserved classic behaviour ----------

test("--raw creates a config with every layer explicitly none and acquires nothing", () => {
  const { base, catalog } = published();
  const scope = gitify(join(base, "scope"));

  const r = cli(["init", "--raw", "--dir", scope], { catalog });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const cfg = readFileSync(join(scope, "oas-config.yaml"), "utf8");
  for (const layer of ["knowledge", "messaging", "tasks"]) assert.match(cfg, new RegExp(`${layer}: none`));
  assert.equal(existsSync(join(scope, OAS_LOCK_FILE)), false, "raw init locks nothing");
  assert.equal(existsSync(join(scope, ".agents")), false, "raw init acquires nothing");
  rmSync(base, { recursive: true, force: true });
});

test("--template seeds from a declared template and reports through the same JSON envelope", () => {
  const { base, catalog } = published();
  const outer = join(base, "outer"); mkdirSync(outer, { recursive: true });
  const seed = join(base, "seed", "oas-config.yaml");
  write(seed, "name: seeded\ncapabilities:\n  layers:\n    knowledge: none\n    messaging: none\n    tasks: none\n");
  write(join(outer, "oas-config.yaml"), `name: outer\ntemplates:\n  house: ${seed}\n`);
  const scope = gitify(join(outer, "repo"));

  const r = cli(["init", "--template", "house", "--json", "--dir", scope], { catalog });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const doc = envelope(r);
  assert.equal(doc.result.template, "house");
  const seeded = readFileSync(join(scope, "oas-config.yaml"), "utf8");
  // A template is a SNAPSHOT: it records where it came from and takes this
  // scope's own name, so later edits to the template never propagate.
  assert.match(seeded, /^# template: .*seed\/oas-config\.yaml \(snapshot/m);
  assert.match(seeded, /^name: repo$/m);
  assert.match(seeded, /knowledge: none/);
  assert.equal(existsSync(join(scope, OAS_LOCK_FILE)), false, "a template seeds config only — it acquires nothing");

  // An unknown template name is a coded failure, not a bare stderr string.
  const scope2 = gitify(join(outer, "repo2"));
  const bad = cli(["init", "--template", "nope", "--json", "--dir", scope2], { catalog });
  assert.equal(bad.status, 1);
  assert.equal(envelope(bad).error.code, "E_UNKNOWN_TEMPLATE");
  assert.equal(existsSync(join(scope2, "oas-config.yaml")), false);
  rmSync(base, { recursive: true, force: true });
});

test("an OWNED capability at this scope fills a layer without any acquisition, before a config exists", () => {
  const { base, catalog } = published();
  const scope = gitify(join(base, "scope"));
  // Owned capabilities are authored in place and committed — never acquired.
  write(join(ownedCapabilitiesDir(scope), "house-knowledge", "oas.json"),
    JSON.stringify({ capability: "house.knowledge", version: "1.0.0", description: "ours", layer: "knowledge" }, null, 2));

  const r = cli(["init", "--knowledge", "house.knowledge", "--messaging", "none", "--tasks", "none", "--json", "--dir", scope], { catalog });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(envelope(r).result.acquired, [], "an owned capability is not acquired");
  assert.match(readFileSync(join(scope, "oas-config.yaml"), "utf8"), /knowledge:\n      capability: house\.knowledge\n      from: owned/);
  assert.equal(existsSync(join(scope, OAS_LOCK_FILE)), false, "nothing was locked");
  rmSync(base, { recursive: true, force: true });
});

test("a capability materialized EARLIER IN THE SAME RUN fills a later layer without a second acquisition", () => {
  const base = temp();
  const sources = officialSources(base);
  // One package supplying two different layers — the shape that makes same-run
  // visibility matter: after the knowledge slot acquires it, the messaging slot
  // must SEE the materialized artifact, even though no config exists yet and the
  // config-chain walk therefore cannot reach this scope.
  sources["house.suite"] = pkgSource(join(base, "pkgs", "suite"), "house.suite", {
    k: { capability: "house.knowledge", layer: "knowledge" },
    m: { capability: "house.messaging", layer: "messaging" },
  });
  const catalog = writeCatalog(join(base, "catalog.json"), sources, ["house.suite"], {
    "house.knowledge": "house.suite", "house.messaging": "house.suite",
  });
  const scope = gitify(join(base, "scope"));

  const r = cli(["init", "--knowledge", "house.knowledge", "--messaging", "house.messaging", "--tasks", "none", "--json", "--dir", scope], { catalog });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const acquired = envelope(r).result.acquired;
  assert.deepEqual(acquired.map((a) => a.layer), ["knowledge"], "the package is acquired ONCE, for the first slot that needs it");
  const lock = JSON.parse(readFileSync(join(scope, OAS_LOCK_FILE), "utf8"));
  assert.deepEqual(Object.keys(lock.packages), ["house.suite"]);
  assert.deepEqual(Object.keys(lock.capabilities).sort(), ["house.knowledge", "house.messaging"]);
  const cfg = readFileSync(join(scope, "oas-config.yaml"), "utf8");
  assert.match(cfg, /knowledge:\n      capability: house\.knowledge/);
  assert.match(cfg, /messaging:\n      capability: house\.messaging/);
  rmSync(base, { recursive: true, force: true });
});

test("a 0.18 scope keeps working: an existing v1 capability lock is neither read as a package lock nor rewritten", () => {
  const { base, catalog } = published();
  const scope = gitify(join(base, "scope"));
  // A real 0.18 shape: v1 lock + installed artifact, no config yet.
  const dir = join(installedCapabilitiesDir(scope), "legacy-knowledge");
  write(join(dir, "oas.json"), JSON.stringify({ capability: "legacy.knowledge", version: "1.0.0", description: "0.18", layer: "knowledge" }, null, 2));
  writeCapabilityLock(scope, "legacy.knowledge", {
    source: "marketplace:legacy.knowledge@1.0.0", version: "1.0.0", integrity: capabilityIntegrity(dir), trustedExecutables: true,
  });
  const lockBefore = readFileSync(join(scope, OAS_LOCK_FILE), "utf8");

  const r = cli(["init", "--knowledge", "legacy.knowledge", "--messaging", "none", "--tasks", "none", "--json", "--dir", scope], { catalog });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(envelope(r).result.acquired, []);
  assert.equal(readFileSync(join(scope, OAS_LOCK_FILE), "utf8"), lockBefore, "the v1 lock is left exactly as it was");
  assert.equal(JSON.parse(lockBefore).lockfileVersion ?? 1, 1);
  rmSync(base, { recursive: true, force: true });
});

// ---------- clean room: no catalog to reach for ----------

test("with an EMPTY catalog the official route is unavailable and init says so instead of guessing", () => {
  const base = temp();
  const scope = gitify(join(base, "scope"));
  const r = cli(["init", "--knowledge", "totally.unpublished", "--json", "--dir", scope], { catalog: emptyCatalog(base) });
  assert.equal(r.status, 1);
  const doc = envelope(r);
  assert.equal(doc.error.code, "E_UNKNOWN_CAPABILITY");
  assert.match(doc.error.message, /catalog: empty/);
  assert.equal(existsSync(join(scope, ".agents")), false);
  rmSync(base, { recursive: true, force: true });
});

test("a NON-GIT scope is first class: the same materialization route, and no ignore file is invented", () => {
  const { base, catalog } = published();
  const scope = join(base, "plain"); mkdirSync(scope, { recursive: true });

  const r = cli(["init", "--knowledge", "oas.okf", "--messaging", "none", "--tasks", "none", "--dir", scope], { catalog });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(join(scope, ".git")), false, "the boundary must not need git");
  assert.equal(JSON.parse(readFileSync(join(scope, OAS_LOCK_FILE), "utf8")).lockfileVersion, 2);
  assert.ok(existsSync(join(scope, ".agents/capabilities/installed/oas.okf/oas.json")));
  rmSync(base, { recursive: true, force: true });
});

// ---------- catalog-first precedence ----------

test("a capability alias resolves to its owning package: the catalog decides which package supplies a layer", () => {
  const base = temp();
  const sources = officialSources(base);
  // The capability id and the package id differ — exactly the oas.review/oas.dev
  // shape the release catalog publishes.
  const catalog = writeCatalog(join(base, "catalog.json"), sources, ["oas.okf"], { "house.knowledge": "oas.okf" });
  const scope = gitify(join(base, "scope"));

  const r = cli(["init", "--knowledge", "house.knowledge", "--json", "--dir", scope], { catalog });
  // oas.okf does not export house.knowledge, so the alias is followed and the
  // lie is caught at the ONLY place it can be: the acquired package's exports.
  assert.equal(r.status, 1, r.stdout);
  const doc = envelope(r);
  assert.equal(doc.error.code, "E_LAYER_NOT_EXPORTED");
  assert.match(doc.error.message, /package oas\.okf does not export capability "house\.knowledge"/);
  assert.equal(existsSync(join(scope, OAS_LOCK_FILE)), false, "the acquisition rolled back");
  rmSync(base, { recursive: true, force: true });
});

test("a template carrying keys this kernel refuses fails typed, and leaves no config behind", () => {
  const { base, catalog } = published();
  const outer = join(base, "outer"); mkdirSync(outer, { recursive: true });
  // A pre-0.19 template: `layers:` moved under `capabilities.layers` and the
  // kernel refuses the old spelling outright.
  const seed = join(base, "seed", "oas-config.yaml");
  write(seed, "name: old\nlayers:\n  knowledge: oas.okf\n");
  write(join(outer, "oas-config.yaml"), `name: outer\ntemplates:\n  stale: ${seed}\n`);
  const scope = gitify(join(outer, "repo"));
  const before = snapshot(scope);

  const r = cli(["init", "--template", "stale", "--json", "--dir", scope], { catalog });
  assert.equal(r.status, 1, r.stdout);
  const doc = envelope(r);
  assert.match(doc.error.message, /could not be seeded from template stale/);
  assert.match(doc.error.message, /unsupported oas-config key "layers"/);

  // Seeding is a transaction: the config this run wrote is gone, not left for
  // the next command to trip over.
  assert.equal(existsSync(join(scope, "oas-config.yaml")), false);
  assert.deepEqual(snapshot(scope), before, "a refused seed is byte-identical");
  rmSync(base, { recursive: true, force: true });
});

test("a template may activate what is not acquired yet: it seeds, says so, and does not roll back", () => {
  const { base, catalog } = published();
  const outer = join(base, "outer"); mkdirSync(outer, { recursive: true });
  const seed = join(base, "seed", "oas-config.yaml");
  // Seeding policy you then acquire is the whole point of a template — an
  // unresolvable activation right after seeding is the expected state, not a
  // broken config.
  write(seed, "name: seeded\ncapabilities:\n  additive:\n    not.acquired.yet:\n      from: installed\n      global: true\n");
  write(join(outer, "oas-config.yaml"), `name: outer\ntemplates:\n  house: ${seed}\n`);
  const scope = gitify(join(outer, "repo"));

  const r = cli(["init", "--template", "house", "--json", "--dir", scope], { catalog });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(envelope(r).result.activated, [], "nothing resolves yet, and that is fine");
  assert.match(readFileSync(join(scope, "oas-config.yaml"), "utf8"), /not\.acquired\.yet/, "the config survives");
  assert.match(r.stderr, /does not resolve yet/, "…and the run says so, on stderr, outside the envelope");
  rmSync(base, { recursive: true, force: true });
});
