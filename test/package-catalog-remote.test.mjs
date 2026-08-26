// The official package catalog is read from the OAS repo at resolution time.
//
// Resolution order (the decided contract):
//   (a) OAS_PACKAGE_CATALOG — an explicit local FILE override, REPLACE
//       semantics, never a fetch and never a cache write;
//   (b) the remote catalog on `main`, bounded by a timeout and shape-validated
//       BEFORE use, cached on success;
//   (c) on fetch failure or an invalid payload, the cached last-successful
//       copy, with one staleness line on STDERR naming the cache age;
//   (d) the catalog bundled with this release as the last-resort seed.
//
// Nothing here touches the network: every case either binds OAS_PACKAGE_CATALOG
// or injects a fetcher (child processes use OAS_CATALOG_FETCH=off, the
// air-gapped switch, which fails the fetch without attempting it).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  OFFICIAL_CATALOG_URL, commandNeedsOfficialCatalog, officialCapabilityAliases, officialCatalogProvenance,
  officialPackageCatalog, refreshOfficialCatalog, resolveOfficialCatalog,
} from "../lib/core.mjs";
import { BUNDLED_CATALOG } from "./catalog-hermetic.mjs";

const CLI = resolve(new URL("../bin/oas.mjs", import.meta.url).pathname);
const temp = () => mkdtempSync(join(tmpdir(), "oas-catalog-remote-"));
const HOUR = 3600_000;

/** A fixture catalog document in the shape the bundled reader accepts. */
const REMOTE_DOC = {
  packages: { "x.remote": { url: "https://example.invalid/remote.git", ref: "v9.9.9", path: "oas-package" } },
  capabilities: { "x.alias": { package: "x.remote" } },
};
const CACHED_DOC = { packages: { "x.cached": { url: "https://example.invalid/cached.git", ref: "v1.0.0" } } };

/** A response in the shape real `fetch` returns — `url` is the FINAL url after
 * redirects, which the kernel requires to be an https GitHub host, so every
 * fixture carries it. */
const okResponse = (doc, url = OFFICIAL_CATALOG_URL) => ({
  ok: true, status: 200, url, headers: { get: () => null },
  text: async () => JSON.stringify(doc),
});
/** An injected fetcher that records every call — the proof that a path did or
 * did not go to the network, and that it asked for the CONSTANT catalog URL. */
function spyFetch(handler) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  fn.calls = calls;
  return fn;
}
function seedCache(file, doc, fetchedAtMs) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ fetchedAt: new Date(fetchedAtMs).toISOString(), url: OFFICIAL_CATALOG_URL, catalog: doc }));
}
/** Drop whatever a previous case installed as this process's catalog. Binding
 * an override is the reset: it takes precedence over every resolved source. */
const resetProcessCatalog = () => refreshOfficialCatalog({ env: { OAS_PACKAGE_CATALOG: BUNDLED_CATALOG }, fetch: spyFetch(() => { throw new Error("unreachable"); }) });

test("(a) the env override REPLACES the catalog: no fetch, no cache write", async () => {
  const base = temp();
  const override = join(base, "catalog.json");
  writeFileSync(override, JSON.stringify({ packages: { "x.override": { url: "https://example.invalid/o.git" } } }));
  const cacheFile = join(base, ".oas", "package-catalog.cache.json");
  const fetch = spyFetch(() => { throw new Error("the override must never fetch"); });

  const r = await resolveOfficialCatalog({ env: { OAS_PACKAGE_CATALOG: override }, fetch, cacheFile, bundledFile: BUNDLED_CATALOG });

  assert.equal(r.provenance, "override");
  assert.equal(r.source, override);
  assert.equal(r.warning, null);
  assert.equal(fetch.calls.length, 0, "an explicit override is hermetic — it never reaches the network");
  assert.equal(existsSync(cacheFile), false, "an override never writes the cache");
});

test("(b) a valid remote payload is used and cached atomically under restrictive perms", async () => {
  const base = temp();
  const cacheFile = join(base, ".oas", "package-catalog.cache.json");
  const at = Date.parse("2026-08-26T10:00:00.000Z");
  const fetch = spyFetch(() => okResponse(REMOTE_DOC));

  const r = await resolveOfficialCatalog({ env: {}, fetch, cacheFile, bundledFile: BUNDLED_CATALOG, now: () => at });

  assert.equal(r.provenance, "remote");
  assert.equal(r.source, OFFICIAL_CATALOG_URL);
  assert.equal(r.warning, null);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, OFFICIAL_CATALOG_URL, "the fetched URL is the constant, never config or user input");
  assert.ok(fetch.calls[0].init?.signal, "the fetch is bounded by an abort signal");
  const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
  assert.deepEqual(cached.catalog, REMOTE_DOC, "the cache stores the payload");
  assert.equal(cached.fetchedAt, "2026-08-26T10:00:00.000Z", "the cache stores the fetch timestamp");
  assert.equal(statSync(cacheFile).mode & 0o777, 0o600, "the cache is written with restrictive perms");
  assert.deepEqual(readdirSync(dirname(cacheFile)), [basename(cacheFile)], "temp+rename leaves no residue behind");
});

test("(b) the fetched catalog is what every consumer serves, alias object form included", async () => {
  const base = temp();
  const fetch = spyFetch(() => okResponse(REMOTE_DOC));
  try {
    await refreshOfficialCatalog({ env: {}, fetch, cacheFile: join(base, "cache.json"), bundledFile: BUNDLED_CATALOG });
    assert.deepEqual(Object.keys(officialPackageCatalog()), ["x.remote"], "not the bundled catalog's ids");
    assert.deepEqual(officialPackageCatalog()["x.remote"], REMOTE_DOC.packages["x.remote"]);
    assert.equal(officialCapabilityAliases()["x.alias"], "x.remote", "the { package: <id> } alias form is accepted");
    const prov = officialCatalogProvenance();
    assert.equal(prov.provenance, "remote");
    assert.equal(prov.source, OFFICIAL_CATALOG_URL);
  } finally { await resetProcessCatalog(); }
});

test("(c) a timed-out fetch falls back to the cache and warns with the cache AGE", async () => {
  const base = temp();
  const cacheFile = join(base, ".oas", "package-catalog.cache.json");
  const now = Date.parse("2026-08-26T10:00:00.000Z");
  seedCache(cacheFile, CACHED_DOC, now - 26 * HOUR);
  const warnings = [];

  const r = await resolveOfficialCatalog({
    env: {}, fetch: () => new Promise(() => {}), timeoutMs: 25,
    cacheFile, bundledFile: BUNDLED_CATALOG, now: () => now, warn: (l) => warnings.push(l),
  });

  assert.equal(r.provenance, "cache");
  assert.equal(r.source, cacheFile);
  assert.deepEqual(Object.keys(r.document.packages), ["x.cached"]);
  assert.equal(r.ageMs, 26 * HOUR);
  assert.equal(warnings.length, 1, "exactly one staleness line");
  assert.equal(warnings[0], r.warning);
  assert.match(warnings[0], /26h ago/, "the warning names the cache age");
  assert.match(warnings[0], /timed out/, "and why the remote copy is not being used");
  assert.deepEqual(JSON.parse(readFileSync(cacheFile, "utf8")).catalog, CACHED_DOC, "a failed fetch never rewrites the cache");
});

test("(c) an INVALID remote payload is a fetch failure, not a catalog", async () => {
  const base = temp();
  const cacheFile = join(base, ".oas", "package-catalog.cache.json");
  const now = Date.now();
  seedCache(cacheFile, CACHED_DOC, now - 45 * 1000);
  const warnings = [];
  // Shape-validated BEFORE use: "packages" must be an object map, and an alias
  // must name a package id. Either one disqualifies the whole payload.
  for (const bad of [{ packages: [] }, { packages: {}, capabilities: { "x.a": 42 } }, "not an object", { packages: { "x.p": { url: "u" } }, capabilities: { "not a valid id!": "x.p" } }]) {
    const r = await resolveOfficialCatalog({
      env: {}, fetch: spyFetch(() => okResponse(bad)), cacheFile, bundledFile: BUNDLED_CATALOG,
      now: () => now, warn: (l) => warnings.push(l),
    });
    assert.equal(r.provenance, "cache", `invalid payload ${JSON.stringify(bad)} must not be adopted`);
    assert.deepEqual(Object.keys(r.document.packages), ["x.cached"]);
  }
  assert.equal(warnings.length, 4);
  assert.match(warnings[0], /45s ago/);
  assert.match(warnings[0], /"packages" must be an object map/, "the warning names WHY the remote payload was refused");
});

test("(d) a corrupt cache is treated as ABSENT and the bundled seed answers", async () => {
  const base = temp();
  const cacheFile = join(base, ".oas", "package-catalog.cache.json");
  mkdirSync(dirname(cacheFile), { recursive: true });
  const warnings = [];
  for (const corrupt of ["{not json", JSON.stringify({ fetchedAt: "x" }), JSON.stringify({ catalog: { packages: [] } }), "[]"]) {
    writeFileSync(cacheFile, corrupt);
    const r = await resolveOfficialCatalog({
      env: {}, fetch: spyFetch(() => { throw new Error("offline"); }),
      cacheFile, bundledFile: BUNDLED_CATALOG, warn: (l) => warnings.push(l),
    });
    assert.equal(r.provenance, "bundled", `corrupt cache ${corrupt} must not crash or be served`);
    assert.equal(r.source, BUNDLED_CATALOG);
  }
  assert.equal(warnings.length, 4);
  assert.match(warnings[0], /bundled/);
});

test("(d) no cache and no bundled file: an empty catalog, never a crash", async () => {
  const base = temp();
  const r = await resolveOfficialCatalog({
    env: {}, fetch: spyFetch(() => { throw new Error("offline"); }),
    cacheFile: join(base, "absent-cache.json"), bundledFile: join(base, "absent-bundled.json"), warn: () => {},
  });
  assert.equal(r.provenance, "bundled");
  assert.equal(r.document, null, "the bundled seed is read by the catalog reader, not adopted as a payload here");
});

test("only NEW-work commands may resolve the catalog — lock-driven work never fetches", () => {
  // Fetching: acquiring a bare catalog id, an update, migrate mapping, and the
  // layer/remedy resolution inside init.
  assert.equal(commandNeedsOfficialCatalog("install", ["oas.okf", "--dir", "/x"]), true);
  assert.equal(commandNeedsOfficialCatalog("update", ["oas.okf"]), true);
  assert.equal(commandNeedsOfficialCatalog("migrate", ["--official", "--dry-run"]), true);
  assert.equal(commandNeedsOfficialCatalog("init", []), true);
  assert.equal(commandNeedsOfficialCatalog("init", ["--raw", "--knowledge", "oas.okf"]), true);
  assert.equal(commandNeedsOfficialCatalog("init", ["--package", "oas.dev"]), true);

  // Lock-driven or catalog-free: a bare restore above all.
  assert.equal(commandNeedsOfficialCatalog("install", []), false, "bare `oas install` restore is fully offline");
  assert.equal(commandNeedsOfficialCatalog("install", ["--recursive", "--dir", "/x"]), false);
  // A source that names its own transport is not a catalog lookup (see
  // package-catalog-hardening.test.mjs for the full matrix).
  assert.equal(commandNeedsOfficialCatalog("install", ["git:github.com/o/r"]), false);
  assert.equal(commandNeedsOfficialCatalog("install", ["./local-package"]), false);
  // Diagnostics stay off the network: doctor REPORTS provenance, never refreshes it.
  assert.equal(commandNeedsOfficialCatalog("doctor", ["--json"]), false, "doctor must never fetch the catalog");
  assert.equal(commandNeedsOfficialCatalog("update", ["--check"]), false, "the kernel self-update check is not a catalog path");
  assert.equal(commandNeedsOfficialCatalog("init", ["--raw"]), false);
  assert.equal(commandNeedsOfficialCatalog("init", ["--template", "team"]), false);
  for (const cmd of ["list", "trust", "use", "remove", "status", "spawn", "retire", "config", "version", "root", "inject", "type", "create", "pane"]) {
    assert.equal(commandNeedsOfficialCatalog(cmd, ["--json"]), false, `${cmd} must never fetch the catalog`);
  }
});

// ---------- CLI surface ----------

/** A hermetic CLI environment with its own OAS state dir and the remote fetch
 * switched off, so the cache/bundled fallbacks are exercised without a network. */
function cliEnv(home, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(OAS|PI)_/.test(k)) env[k] = v;
  return Object.assign(env, { HOME: home, OAS_HOME_DIR: join(home, ".oas"), OAS_CATALOG_FETCH: "off" }, extra);
}

test("doctor REPORTS the catalog provenance without refreshing it, and --json stays ONE envelope", () => {
  const home = temp();
  const scope = temp();
  const cacheFile = join(home, ".oas", "package-catalog.cache.json");
  seedCache(cacheFile, CACHED_DOC, Date.now() - 26 * HOUR);

  const j = spawnSync(process.execPath, [CLI, "doctor", scope, "--json"], { cwd: scope, env: cliEnv(home), encoding: "utf8" });
  assert.equal(j.status, 0, j.stderr);
  const doc = JSON.parse(j.stdout); // throws on ANY stdout contamination
  assert.equal(doc.catalog.provenance, "cache");
  assert.equal(doc.catalog.source, cacheFile);
  assert.equal(doc.catalog.url, OFFICIAL_CATALOG_URL);
  assert.equal(doc.catalog.cacheFile, cacheFile);
  assert.equal(doc.catalog.refreshedThisRun, false, "doctor attempted no fetch");
  assert.ok(doc.catalog.ageMs >= 26 * HOUR, "the age of the copy it is serving is in the envelope");

  // The age belongs on the human line — doctor refreshed nothing, so there is
  // no staleness WARNING to emit at all (that line is the acquiring commands').
  const h = spawnSync(process.execPath, [CLI, "doctor", scope], { cwd: scope, env: cliEnv(home), encoding: "utf8" });
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, /Official package catalog: cache/);
  assert.match(h.stdout, /26h ago/);
  assert.match(h.stdout, new RegExp(OFFICIAL_CATALOG_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(h.stdout, /unreachable/, "nothing was unreachable — nothing was contacted");
  assert.doesNotMatch(h.stderr, /26h ago/, "and doctor emits no staleness line of its own");
});

test("the env override is reported as the provenance, and suppresses the staleness line", () => {
  const home = temp();
  const scope = temp();
  seedCache(join(home, ".oas", "package-catalog.cache.json"), CACHED_DOC, Date.now() - 26 * HOUR);
  const r = spawnSync(process.execPath, [CLI, "doctor", scope, "--json"],
    { cwd: scope, env: cliEnv(home, { OAS_PACKAGE_CATALOG: BUNDLED_CATALOG }), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.catalog.provenance, "override");
  assert.equal(doc.catalog.source, BUNDLED_CATALOG);
  assert.doesNotMatch(r.stderr, /ago/, "an override is never stale — it is what the operator asked for");
});

test("a bare `oas install` restore resolves NO catalog at all", () => {
  const home = temp();
  const scope = temp();
  writeFileSync(join(scope, "oas-config.yaml"), "capabilities: {}\n");
  seedCache(join(home, ".oas", "package-catalog.cache.json"), CACHED_DOC, Date.now() - 26 * HOUR);
  const r = spawnSync(process.execPath, [CLI, "install", "--dir", scope], { cwd: scope, env: cliEnv(home), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /ago|catalog/, "restore never resolves the catalog, so it can never warn about it");
});
