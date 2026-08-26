// Hardening of the remote official catalog (round-2 review mandate).
//
// The remote contract turned the catalog into REMOTE INPUT: a document fetched
// from the network whose `url`/`ref`/`path` fields end up in a `git clone` argv
// and on the local filesystem. This suite pins the boundary between the two
// kinds of catalog document:
//
//   * an OVERRIDE FILE (`OAS_PACKAGE_CATALOG`) is operator-controlled and keeps
//     EXACTLY the pre-remote semantics — `file://` urls included, because the
//     hermetic test suites depend on them;
//   * a REMOTE payload, and the CACHE (which only ever holds remote-derived
//     content), are untrusted: every entry is validated, and any failure is a
//     FETCH FAILURE that falls through to the cache and then the bundled seed.
//
// Nothing here touches the network: every case binds `OAS_PACKAGE_CATALOG`,
// injects a fetcher, or runs a child CLI under the fetch canary.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OFFICIAL_CATALOG_URL, commandNeedsOfficialCatalog, officialPackageCatalog,
  parseCatalogDocument, refreshOfficialCatalog, resolveOfficialCatalog,
} from "../lib/core.mjs";
import { BUNDLED_CATALOG } from "./catalog-hermetic.mjs";

const CORE = fileURLToPath(new URL("../lib/core.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../bin/oas.mjs", import.meta.url));
const CANARY = fileURLToPath(new URL("./catalog-fetch-canary.mjs", import.meta.url));
const temp = () => mkdtempSync(join(tmpdir(), "oas-catalog-hard-"));

/** A response in the shape real `fetch` returns: `ok`, `status`, `url` (the
 * FINAL url after redirects) and a `text()` body. */
const response = (doc, { url = OFFICIAL_CATALOG_URL, headers = {} } = {}) => ({
  ok: true, status: 200, url,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  text: async () => (typeof doc === "string" ? doc : JSON.stringify(doc)),
});
const seedCache = (file, doc, fetchedAtMs = Date.now()) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ fetchedAt: new Date(fetchedAtMs).toISOString(), url: OFFICIAL_CATALOG_URL, catalog: doc }));
};
const GOOD = { packages: { "x.good": { url: "https://github.com/example/good.git", ref: "v1.0.0", path: "oas-package" } } };
/** Drop whatever a case installed as this process's catalog. */
const resetProcessCatalog = () => refreshOfficialCatalog({ env: { OAS_PACKAGE_CATALOG: BUNDLED_CATALOG }, fetch: () => { throw new Error("unreachable"); } });

function withOverride(file, fn) {
  const prev = process.env.OAS_PACKAGE_CATALOG;
  process.env.OAS_PACKAGE_CATALOG = file;
  try { return fn(); } finally { if (prev === undefined) delete process.env.OAS_PACKAGE_CATALOG; else process.env.OAS_PACKAGE_CATALOG = prev; }
}

// ---------- FIX A: the root guard is a THROW again, for both kinds ----------

test("A: an override FILE whose root is not a JSON object throws exactly the base message", () => {
  const base = temp();
  for (const body of ["null", "[]", "42", '"a string"', "false"]) {
    const file = join(base, `root-${Buffer.from(body).toString("hex")}.json`);
    writeFileSync(file, body);
    // The pre-remote kernel raised this at the CONSUMER, typed invalid-source,
    // with this exact sentence. Nothing about the remote contract may soften it.
    const e = withOverride(file, () => { try { officialPackageCatalog(); return null; } catch (err) { return err; } });
    assert.ok(e, `root ${body} must throw`);
    assert.equal(e.code, "invalid-source");
    assert.equal(e.message, `broken package catalog ${file}: root must be a JSON object`, `root ${body}`);
  }
});

test("A: a null/non-object REMOTE body is a fetch failure — the good cache survives byte-for-byte", async () => {
  for (const body of ["null", "[]", "42", '"a string"']) {
    const base = temp();
    const cacheFile = join(base, ".oas", "package-catalog.cache.json");
    seedCache(cacheFile, GOOD, Date.now() - 60_000);
    const before = readFileSync(cacheFile);
    const warnings = [];

    const r = await resolveOfficialCatalog({
      env: {}, fetch: async () => response(body), cacheFile, bundledFile: BUNDLED_CATALOG, warn: (l) => warnings.push(l),
    });

    assert.equal(r.provenance, "cache", `remote body ${body} must never become the catalog`);
    assert.deepEqual(Object.keys(r.document.packages), ["x.good"]);
    assert.deepEqual(readFileSync(cacheFile), before, "a failed fetch never rewrites the cache");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /root must be a JSON object/);
  }
});

// ---------- FIX B: remote entries are untrusted input ----------

test("B: the entry validator rejects everything that could reach a git argv", () => {
  const where = OFFICIAL_CATALOG_URL;
  const strict = (doc) => parseCatalogDocument(doc, where, { entries: "remote" });
  const pkg = (entry, id = "x.p") => ({ packages: { [id]: entry } });

  // A hostile URL scheme: the whole point of the allowlist.
  for (const url of ["file:///tmp/evil", "file://localhost/tmp/evil", "ssh://git@evil/x.git", "git://evil/x.git",
    "git@evil:x.git", "/tmp/evil", "../evil", "http://example.com/x.git", "HTTPS://example.com/x.git\n",
    " https://example.com/x.git", "https://exa mple.com/x.git", "not a url", "", null, 7, undefined]) {
    assert.throws(() => strict(pkg({ url })), { code: "invalid-source" }, `url ${JSON.stringify(url)} must be refused`);
  }
  assert.doesNotThrow(() => strict(pkg({ url: "https://github.com/example/x.git" })));

  // A hostile ref: `--upload-pack=…` is remote code execution through `git clone`.
  for (const ref of ["--upload-pack=touch /tmp/pwn", "-x", "a b", "a\nb", "a\0b", "v1..v2", "..", "", 7, null, {}]) {
    assert.throws(() => strict(pkg({ url: "https://github.com/example/x.git", ref })), { code: "invalid-source" }, `ref ${JSON.stringify(ref)} must be refused`);
  }
  for (const ref of ["main", "v2.0.0", "feature/x", "0123456789abcdef0123456789abcdef01234567"]) {
    assert.doesNotThrow(() => strict(pkg({ url: "https://github.com/example/x.git", ref })), `ref ${ref} is legitimate`);
  }

  // A hostile path escapes the checkout or reaches the host.
  for (const path of ["/etc", "../../etc", "a\\b", "~/x", 7, null]) {
    assert.throws(() => strict(pkg({ url: "https://github.com/example/x.git", path })), `path ${JSON.stringify(path)} must be refused`);
  }
  assert.equal(strict(pkg({ url: "https://github.com/example/x.git", path: "./oas-package/" })).packages["x.p"].path, "oas-package");

  // The entry itself, and the id it is filed under.
  for (const entry of [null, "https://github.com/example/x.git", [], 7, {}, { ref: "main" }]) {
    assert.throws(() => strict(pkg(entry)), { code: "invalid-source" }, `entry ${JSON.stringify(entry)} must be refused`);
  }
  for (const id of ["Not An Id", "../evil", ".hidden", "-x", "a/b"]) {
    assert.throws(() => strict(pkg({ url: "https://github.com/example/x.git" }, id)), { code: "invalid-source" }, `id ${id} must be refused`);
  }

  // Unknown keys carry no semantics — they are dropped, not honoured.
  assert.deepEqual(strict(pkg({ url: "https://github.com/example/x.git", commit: "deadbeef", exec: "rm -rf /" })).packages["x.p"],
    { url: "https://github.com/example/x.git" });
});

test("B: a remote payload redirecting an official id to file:// is REJECTED, not served", async () => {
  const base = temp();
  const cacheFile = join(base, ".oas", "package-catalog.cache.json");
  seedCache(cacheFile, GOOD);
  const warnings = [];
  const evil = { packages: { "oas.okf": { url: "file:///tmp/evil", ref: "main", path: "oas-package" } } };

  const r = await resolveOfficialCatalog({
    env: {}, fetch: async () => response(evil), cacheFile, bundledFile: BUNDLED_CATALOG, warn: (l) => warnings.push(l),
  });

  assert.equal(r.provenance, "cache", "the poisoned payload must not become this run's catalog");
  assert.equal(r.document.packages["oas.okf"], undefined);
  assert.match(warnings[0], /https/, "the warning names the scheme rule that refused it");
});

test("B: a CACHE holding a hostile entry is treated as ABSENT — the bundled seed answers", async () => {
  const base = temp();
  const cacheFile = join(base, ".oas", "package-catalog.cache.json");
  seedCache(cacheFile, { packages: { "x.evil": { url: "https://github.com/example/x.git", ref: "--upload-pack=touch /tmp/pwn" } } });
  const r = await resolveOfficialCatalog({
    env: {}, fetch: () => { throw new Error("offline"); }, cacheFile, bundledFile: BUNDLED_CATALOG, warn: () => {},
  });
  assert.equal(r.provenance, "bundled", "a cache that fails entry validation is not a catalog");
});

test("B: an OVERRIDE file keeps base semantics — file:// urls still resolve", () => {
  const base = temp();
  const file = join(base, "override.json");
  // Hermetic suites install from `file://` repositories through an override.
  writeFileSync(file, JSON.stringify({ packages: { "x.local": { url: `file://${base}/repo.git`, ref: "main" } } }));
  withOverride(file, () => {
    assert.deepEqual(officialPackageCatalog()["x.local"], { url: `file://${base}/repo.git`, ref: "main" });
  });
});

test("B: end to end — a poisoned CACHE entry never reaches `git clone`", () => {
  const home = temp();
  const scope = temp();
  writeFileSync(join(scope, "oas-config.yaml"), "capabilities: {}\n");
  seedCache(join(home, ".oas", "package-catalog.cache.json"),
    { packages: { "x.evil": { url: "https://github.com/example/x.git", ref: "--upload-pack=touch /tmp/pwn" } } });

  const canary = join(home, "fetch.log");
  const r = spawnSync(process.execPath, ["--import", CANARY, CLI, "install", "x.evil", "--dir", scope], {
    cwd: scope, encoding: "utf8",
    env: { ...cliEnv(home), OAS_FETCH_CANARY: canary },
  });

  assert.notEqual(r.status, 0, "the poisoned entry must not resolve");
  assert.match(`${r.stdout}${r.stderr}`, /cannot resolve "x\.evil"/);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /upload-pack/, "the hostile ref never reaches a git invocation");
});

// ---------- FIX C: the cache temp file is unguessable and O_EXCL ----------

test("C: a pre-planted symlink at the temp path is never followed", async () => {
  const base = temp();
  const cacheFile = join(base, ".oas", "package-catalog.cache.json");
  const victim = join(base, "victim.txt");
  writeFileSync(victim, "untouched\n");
  mkdirSync(dirname(cacheFile), { recursive: true });
  const suffix = "0123456789abcdef";
  symlinkSync(victim, join(dirname(cacheFile), `.package-catalog.cache.json.oas-tmp-${suffix}`));

  const r = await resolveOfficialCatalog({
    env: {}, fetch: async () => response(GOOD), cacheFile, bundledFile: BUNDLED_CATALOG, cacheTempSuffix: suffix, warn: () => {},
  });

  assert.equal(r.provenance, "remote", "an uncacheable host still gets the fresh catalog");
  assert.match(String(r.cacheError), /EEXIST/, "the exclusive create refuses the planted name");
  assert.equal(readFileSync(victim, "utf8"), "untouched\n", "the symlink target is never written through");
  assert.equal(existsSync(cacheFile), false, "and no cache was produced from the refused write");
});

test("C: the cache file is 0600 and the kernel-created cache dir is 0700", async () => {
  const base = temp();
  const cacheFile = join(base, "state", "package-catalog.cache.json");
  const r = await resolveOfficialCatalog({ env: {}, fetch: async () => response(GOOD), cacheFile, bundledFile: BUNDLED_CATALOG, warn: () => {} });
  assert.equal(r.cacheError, null, r.cacheError);
  assert.equal(statSync(cacheFile).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(cacheFile)).mode & 0o777, 0o700);
});

test("C: the temp name is randomised per write, not derived from the pid", async () => {
  const base = temp();
  const seen = new Set();
  for (let i = 0; i < 4; i++) {
    const cacheFile = join(base, `c${i}`, "package-catalog.cache.json");
    const dir = dirname(cacheFile);
    mkdirSync(dir, { recursive: true });
    // A directory at the temp path makes the write fail and REPORT the name it
    // tried — the only way to observe the suffix without exporting it.
    let name = null;
    await resolveOfficialCatalog({
      env: {}, fetch: async () => response(GOOD), cacheFile, bundledFile: BUNDLED_CATALOG, warn: () => {},
      onCacheTemp: (p) => { name = p; },
    });
    assert.ok(name, "the writer reports the temp path it chose");
    assert.doesNotMatch(name, new RegExp(`-${process.pid}$`), "the pid is not the suffix");
    seen.add(name);
  }
  assert.equal(seen.size, 4, "every write picks a fresh unguessable name");
});

// ---------- FIX D: the library cache branch actually serves ----------

/** Run a snippet against lib/core.mjs in a FRESH process — the only way to
 * exercise `readCatalogFile`'s cache branch, whose cache path is captured from
 * `OAS_HOME_DIR` at module load. */
function inChild(env, snippet) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { officialPackageCatalog, officialCapabilityAliases } from ${JSON.stringify(CORE)};\n${snippet}`],
  { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const bareEnv = (home) => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(OAS|PI)_/.test(k)) env[k] = v;
  return Object.assign(env, { HOME: home, OAS_HOME_DIR: join(home, ".oas") });
};

test("D: a library consumer with no refresh and no override resolves from the CACHE", () => {
  const home = temp();
  const DISTINCT = "https://github.com/example/distinctive-cached-source.git";
  seedCache(join(home, ".oas", "package-catalog.cache.json"),
    { packages: { "x.cachedonly": { url: DISTINCT, ref: "v3.2.1", path: "oas-package" } }, capabilities: { "x.legacy": "x.cachedonly" } });

  const out = inChild(bareEnv(home), "console.log(JSON.stringify({ p: officialPackageCatalog(), a: officialCapabilityAliases() }));");

  assert.deepEqual(Object.keys(out.p), ["x.cachedonly"], "the cache — not the bundled seed — answers");
  assert.equal(out.p["x.cachedonly"].url, DISTINCT);
  assert.equal(out.a["x.legacy"], "x.cachedonly");
});

test("D: with the cache absent the same call resolves the bundled seed", () => {
  const home = temp();
  const out = inChild(bareEnv(home), "console.log(JSON.stringify({ p: officialPackageCatalog() }));");
  assert.deepEqual(Object.keys(out.p), Object.keys(JSON.parse(readFileSync(BUNDLED_CATALOG, "utf8")).packages));
});

// ---------- FIX E: only a catalog-resolved positional may fetch ----------

test("E: `install` fetches only for a bare catalog id, never for a path or git source", () => {
  const dir = temp();
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "oas.local"), { recursive: true });
    for (const argv of [["oas.okf"], ["oas.okf", "--dir", "/x"], ["oas.okf@v2.0.0"], ["x.unknown"]]) {
      assert.equal(commandNeedsOfficialCatalog("install", argv), true, `install ${argv[0]} resolves through the catalog`);
    }
    for (const src of ["./pkg", "../pkg", "/abs/pkg", "~/pkg", "path:./pkg", "git:github.com/o/r",
      "https://github.com/o/r.git", "http://x/y.git", "file:///tmp/r.git", "git@github.com:o/r.git",
      "ssh://git@x/r.git", "git://x/r.git", "a/b", "Not An Id", "oas.local"]) {
      assert.equal(commandNeedsOfficialCatalog("install", [src]), false, `install ${src} never resolves through the catalog`);
    }
  } finally { process.chdir(cwd); }
});

test("E: the network canary stays empty for a local-dir and a git install", () => {
  const home = temp();
  const scope = temp();
  writeFileSync(join(scope, "oas-config.yaml"), "capabilities: {}\n");
  const local = join(scope, "somepkg");
  mkdirSync(local, { recursive: true });

  const run = (argv) => {
    const canary = join(home, `canary-${Math.random().toString(36).slice(2)}.log`);
    const env = bareEnv(home);
    delete env.OAS_CATALOG_FETCH; // the fetch is ON: only the command shape may keep it off the wire
    const r = spawnSync(process.execPath, ["--import", CANARY, CLI, ...argv], { cwd: scope, encoding: "utf8", env: { ...env, OAS_FETCH_CANARY: canary } });
    return { attempts: readFileSync(canary, "utf8").split("\n").filter(Boolean), r };
  };

  assert.deepEqual(run(["install", local, "--dir", scope]).attempts, [], "a local directory source is not a catalog lookup");
  assert.deepEqual(run(["install", "https://host.invalid/o/r.git", "--dir", scope]).attempts, [], "an explicit git source is not a catalog lookup");
  assert.deepEqual(run(["install", "--dir", scope]).attempts, [], "a bare restore is lock-driven");
  // Positive control: the canary DOES see the constant URL when a bare catalog
  // id is what was asked for — an empty log above is a real result, not a
  // broken instrument.
  assert.deepEqual(run(["install", "x.canary", "--dir", scope]).attempts, [OFFICIAL_CATALOG_URL]);
});

// ---------- FIX F: doctor diagnoses, it does not fetch ----------

function cliEnv(home, extra = {}) {
  const env = bareEnv(home);
  return Object.assign(env, { OAS_CATALOG_FETCH: "off" }, extra);
}

test("F: `oas doctor` never reaches the network — not even with the fetch enabled", () => {
  const home = temp();
  const scope = temp();
  seedCache(join(home, ".oas", "package-catalog.cache.json"), GOOD, Date.now() - 26 * 3600_000);
  const canary = join(home, "doctor.log");
  const env = bareEnv(home);
  delete env.OAS_CATALOG_FETCH;

  for (const argv of [["doctor", scope], ["doctor", scope, "--json"]]) {
    const r = spawnSync(process.execPath, ["--import", CANARY, CLI, ...argv], { cwd: scope, encoding: "utf8", env: { ...env, OAS_FETCH_CANARY: canary } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readFileSync(canary, "utf8").split("\n").filter(Boolean), [], `${argv.join(" ")} must stay off the network`);
  }
  assert.equal(commandNeedsOfficialCatalog("doctor", ["--json"]), false, "diagnostics are never an acquiring command");
});

test("F: doctor's cache line reports age and the refresh rule — never a fetch that did not happen", () => {
  const home = temp();
  const scope = temp();
  seedCache(join(home, ".oas", "package-catalog.cache.json"), GOOD, Date.now() - 26 * 3600_000);

  const h = spawnSync(process.execPath, [CLI, "doctor", scope], { cwd: scope, encoding: "utf8", env: cliEnv(home) });
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, /Official package catalog: cache/);
  assert.match(h.stdout, /26h ago/, "the human line names the cache age");
  assert.doesNotMatch(h.stdout, /unreachable/, "doctor attempted no fetch, so nothing was unreachable");
  assert.match(h.stdout, /refresh/i, "and it says WHICH commands do refresh it");

  const j = spawnSync(process.execPath, [CLI, "doctor", scope, "--json"], { cwd: scope, encoding: "utf8", env: cliEnv(home) });
  assert.equal(j.status, 0, j.stderr);
  const doc = JSON.parse(j.stdout);
  assert.equal(doc.catalog.provenance, "cache");
  assert.equal(doc.catalog.refreshedThisRun, false, "--json says plainly that this run did not refresh");
  assert.ok(Object.hasOwn(doc.catalog, "cacheError"), "cacheError is part of the doctor envelope");
  assert.match(doc.catalog.refreshedBy.join(" "), /install/, "and names the commands that do refresh");
});

test("F: a BROKEN override is reported as broken, never rendered as healthy", () => {
  const home = temp();
  const scope = temp();
  const override = join(home, "broken-catalog.json");
  writeFileSync(override, "{not json");

  const h = spawnSync(process.execPath, [CLI, "doctor", scope], { cwd: scope, encoding: "utf8", env: cliEnv(home, { OAS_PACKAGE_CATALOG: override }) });
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, /Official package catalog: override/);
  assert.match(h.stdout, /ERROR: broken package catalog/, "a broken override must be visible in the diagnosis");

  const j = spawnSync(process.execPath, [CLI, "doctor", scope, "--json"], { cwd: scope, encoding: "utf8", env: cliEnv(home, { OAS_PACKAGE_CATALOG: override }) });
  const doc = JSON.parse(j.stdout);
  assert.equal(doc.catalog.provenance, "override");
  assert.match(doc.catalog.error, /broken package catalog/);
});

test("F/G: OAS_CATALOG_FETCH=off says DISABLED, never unreachable", async () => {
  const base = temp();
  const cacheFile = join(base, ".oas", "package-catalog.cache.json");
  seedCache(cacheFile, GOOD, Date.now() - 60_000);
  const warnings = [];
  const r = await resolveOfficialCatalog({
    env: { OAS_CATALOG_FETCH: "off" }, fetch: () => { throw new Error("must not be called"); },
    cacheFile, bundledFile: BUNDLED_CATALOG, warn: (l) => warnings.push(l),
  });
  assert.equal(r.provenance, "cache");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /disabled by OAS_CATALOG_FETCH/);
  assert.doesNotMatch(warnings[0], /unreachable/, "nothing was unreachable — the fetch was switched off");

  const home = temp();
  const scope = temp();
  seedCache(join(home, ".oas", "package-catalog.cache.json"), GOOD, Date.now() - 60_000);
  const h = spawnSync(process.execPath, [CLI, "doctor", scope], { cwd: scope, encoding: "utf8", env: cliEnv(home) });
  assert.match(h.stdout, /disabled by OAS_CATALOG_FETCH/, "doctor says the switch is off, not that the remote failed");
  assert.doesNotMatch(h.stdout, /unreachable/);
});

// ---------- FIX G: the fetch itself ----------

test("G: the body cap is enforced in BYTES, not UTF-16 code units", async () => {
  const base = temp();
  const cacheFile = join(base, "cache.json");
  // 600k × "é" = 600k code units (under a 1MiB char cap) but 1.2MB of UTF-8.
  const body = `{"packages":{},"pad":"${"é".repeat(600_000)}"}`;
  assert.ok(body.length < 1024 * 1024 && Buffer.byteLength(body) > 1024 * 1024);
  const warnings = [];
  const r = await resolveOfficialCatalog({
    env: {}, fetch: async () => response(body), cacheFile, bundledFile: BUNDLED_CATALOG, warn: (l) => warnings.push(l),
  });
  assert.equal(r.provenance, "bundled", "an oversized payload is a fetch failure even once buffered");
  assert.match(warnings[0], /bytes/);
});

test("G: a content-length over the cap is refused BEFORE the body is read", async () => {
  const base = temp();
  let read = false;
  const fetch = async () => {
    const res = response(GOOD, { headers: { "content-length": String(4 * 1024 * 1024) } });
    return { ...res, text: async () => { read = true; return res.text(); } };
  };
  const r = await resolveOfficialCatalog({ env: {}, fetch, cacheFile: join(base, "c.json"), bundledFile: BUNDLED_CATALOG, warn: () => {} });
  assert.equal(r.provenance, "bundled");
  assert.equal(read, false, "an oversized declared length is refused without buffering the body");
});

test("G: a redirect that lands off the GitHub hosts is a fetch failure", async () => {
  const base = temp();
  const warnings = [];
  for (const url of ["https://evil.example.com/package-catalog.json", "http://raw.githubusercontent.com/x", "https://githubusercontent.com.evil.test/x", ""]) {
    const r = await resolveOfficialCatalog({
      env: {}, fetch: async () => response(GOOD, { url }), cacheFile: join(base, "c.json"), bundledFile: BUNDLED_CATALOG, warn: (l) => warnings.push(l),
    });
    assert.equal(r.provenance, "bundled", `final url ${JSON.stringify(url)} must not be trusted`);
  }
  assert.match(warnings[0], /redirect|final/i);
  // The real hosts stay accepted.
  const ok = await resolveOfficialCatalog({
    env: {}, fetch: async () => response(GOOD, { url: "https://raw.githubusercontent.com/OAS-Framework/oas/main/package-catalog.json" }),
    cacheFile: join(base, "ok.json"), bundledFile: BUNDLED_CATALOG, warn: () => {},
  });
  assert.equal(ok.provenance, "remote");
});

test.after(() => resetProcessCatalog());
