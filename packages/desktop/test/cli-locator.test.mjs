// CLI locator (packages/desktop/cli-locator.mjs) — Desktop CLI API v1
// discovery order, canonicalization, acceptance, and stable diagnostics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { delimiter } from "node:path";
import {
  acceptProbe, parseSemver, parseProbeStdout, candidates, discover, DESKTOP_API,
} from "../cli-locator.mjs";

const PROBE = (v = "0.18.0") => ({ schemaVersion: 1, name: "@oas-framework/oas", version: v, desktopApi: 1 });

test("acceptProbe: exact v1 payload accepted; every deviation rejected with a reason", () => {
  assert.equal(acceptProbe(PROBE()).ok, true);
  assert.equal(acceptProbe(PROBE("0.18.9")).ok, true);
  const cases = [
    [null, /no probe/],
    [{ ...PROBE(), schemaVersion: 2 }, /schemaVersion/],
    [{ ...PROBE(), name: "@other/pkg" }, /not the oas CLI/],
    [{ ...PROBE(), desktopApi: 2 }, /desktopApi 2/],
    [{ ...PROBE(), desktopApi: undefined }, /desktopApi missing/],
    [PROBE("0.17.9"), /outside/],
    [PROBE("0.19.0"), /outside/],
    [PROBE("1.0.0"), /outside/],
    [PROBE("not-a-version"), /unparsable/],
  ];
  for (const [payload, re] of cases) {
    const r = acceptProbe(payload);
    assert.equal(r.ok, false, JSON.stringify(payload));
    assert.match(r.reason, re);
  }
});

test("acceptProbe: API version is authoritative — a 0.18.x CLI without desktopApi is rejected", () => {
  // Source adjacency / same version number is NOT enough: the probe field decides.
  const r = acceptProbe({ schemaVersion: 1, name: "@oas-framework/oas", version: "0.18.0" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /desktopApi/);
});

test("parseSemver handles pre-release/build suffixes and rejects garbage", () => {
  assert.deepEqual(parseSemver("0.18.0"), { nums: [0, 18, 0], prerelease: false });
  assert.deepEqual(parseSemver("0.18.1-rc.1"), { nums: [0, 18, 1], prerelease: true });
  assert.deepEqual(parseSemver("0.18.0+build.5"), { nums: [0, 18, 0], prerelease: false });
  assert.equal(parseSemver("v0.18.0"), null);
  assert.equal(parseSemver(""), null);
});

test("acceptProbe: prereleases are rejected — 0.18.0-rc.1 precedes 0.18.0 (review 53a20c7)", () => {
  for (const v of ["0.18.0-rc.1", "0.18.0-0", "0.18.5-beta.2", "0.19.0-rc.1"]) {
    const r = acceptProbe(PROBE(v));
    assert.equal(r.ok, false, v);
    assert.match(r.reason, /prerelease/, v);
  }
  assert.equal(acceptProbe(PROBE("0.18.0+build.7")).ok, true, "build metadata does not affect precedence");
});

test("parseProbeStdout: only a single JSON object passes", () => {
  assert.deepEqual(parseProbeStdout(JSON.stringify(PROBE())), PROBE());
  assert.equal(parseProbeStdout("oas 0.18.0\n"), null);
  assert.equal(parseProbeStdout('{"a":1}\n{"b":2}'), null);
  assert.equal(parseProbeStdout('"just-a-string"'), null);
});

test("candidates: contract discovery order — persisted, env, PATH, npm-global, login-shell", async () => {
  const io = {
    persisted: () => "/chosen/oas",
    env: { OAS_DESKTOP_OAS_BIN: "/env/oas", PATH: ["/p1", "/p2"].join(delimiter) },
    npmGlobalBin: () => "/npmg/bin",
    loginShellWhich: () => "/login/oas",
  };
  assert.deepEqual(await candidates(io), [
    { path: "/chosen/oas", source: "persisted" },
    { path: "/env/oas", source: "env" },
    { path: "/p1/oas", source: "path" },
    { path: "/p2/oas", source: "path" },
    { path: "/npmg/bin/oas", source: "npm-global" },
    { path: "/login/oas", source: "login-shell" },
  ]);
});

test("candidates: relative and empty entries are dropped (absolute executables only)", async () => {
  const io = {
    persisted: () => "relative/oas",
    env: { OAS_DESKTOP_OAS_BIN: "", PATH: "" },
    npmGlobalBin: () => null,
    loginShellWhich: () => undefined,
  };
  assert.deepEqual(await candidates(io), []);
});

test("discover: expensive sources are LAZY and at-most-once — never invoked when an earlier candidate wins (review 53a20c7)", async () => {
  let npmCalls = 0, shellCalls = 0;
  const io = {
    persisted: () => "/chosen/oas",
    env: { PATH: "" },
    isExecutableFile: () => true,
    canonicalize: (p) => p,
    npmGlobalBin: () => { npmCalls++; return "/npmg/bin"; },
    loginShellWhich: () => { shellCalls++; return "/login/oas"; },
  };
  const r = await discover(io, async () => ({ stdout: JSON.stringify(PROBE()) }));
  assert.equal(r.ok, true);
  assert.equal(r.bin, "/chosen/oas");
  assert.equal(npmCalls, 0, "npm helper never runs when the persisted candidate wins");
  assert.equal(shellCalls, 0, "login-shell helper never runs when the persisted candidate wins");
  // full-failure sweep: each expensive source runs exactly once
  const io2 = {
    env: { PATH: "" },
    isExecutableFile: () => false,
    npmGlobalBin: () => { npmCalls++; return "/npmg/bin"; },
    loginShellWhich: () => { shellCalls++; return "/login/oas"; },
  };
  await discover(io2, async () => ({ stdout: "" }));
  assert.equal(npmCalls, 1, "npm helper invoked exactly once on a full sweep");
  assert.equal(shellCalls, 1, "login-shell helper invoked exactly once on a full sweep");
});

test("discover: a probe that REJECTS is never accepted, even with plausible stdout beforehand (review 53a20c7)", async () => {
  // The server's probeBin rejects on ANY execFile error (nonzero exit,
  // timeout) — discover must record the rejection, not accept the payload.
  const io = {
    persisted: () => "/liar/oas",
    env: { PATH: "" },
    isExecutableFile: () => true,
    canonicalize: (p) => p,
  };
  const probe = async () => { const e = new Error("exit 1 (printed probe then failed)"); throw e; };
  const r = await discover(io, probe);
  assert.equal(r.ok, false);
  assert.match(r.tried[0].reason, /probe failed/);
});

test("discover: first ACCEPTABLE candidate wins — earlier rejects are recorded diagnostics", async () => {
  const io = {
    persisted: () => "/old/oas",                       // probes as 0.17 → rejected
    env: { PATH: "/good" },                            // /good/oas → accepted
    isExecutableFile: () => true,
    canonicalize: (p) => p,
  };
  const probe = async (path) => ({
    stdout: JSON.stringify(path === "/old/oas" ? PROBE("0.17.0") : PROBE("0.18.2")),
  });
  const r = await discover(io, probe);
  assert.equal(r.ok, true);
  assert.equal(r.bin, "/good/oas");
  assert.equal(r.source, "path");
  assert.equal(r.version, "0.18.2");
});

test("discover: full failure returns per-candidate stable diagnostics", async () => {
  const io = {
    persisted: () => "/gone/oas",
    env: { OAS_DESKTOP_OAS_BIN: "/broken/oas", PATH: "/incompat" },
    isExecutableFile: (p) => p !== "/gone/oas",        // persisted: not executable
    canonicalize: (p) => p,
  };
  const probe = async (path) => {
    if (path === "/broken/oas") throw new Error("ENOENT spawn");
    return { stdout: JSON.stringify(PROBE("0.17.5")) }; // incompatible
  };
  const r = await discover(io, probe);
  assert.equal(r.ok, false);
  assert.equal(r.tried.length, 3);
  assert.match(r.tried[0].reason, /not an executable/);
  assert.match(r.tried[1].reason, /probe failed/);
  assert.match(r.tried[2].reason, /outside/);
  assert.equal(r.tried[2].version, "0.17.5", "rejected version surfaces for the degradation card");
});

test("discover: symlinked duplicates canonicalize and probe once", async () => {
  let probes = 0;
  const io = {
    persisted: () => "/usr/local/bin/oas",             // symlink → /real/oas
    env: { PATH: "/real" },
    isExecutableFile: () => true,
    canonicalize: () => "/real/oas",
  };
  const probe = async () => { probes++; return { stdout: JSON.stringify(PROBE()) }; };
  const r = await discover(io, probe);
  assert.equal(r.ok, true);
  assert.equal(r.bin, "/real/oas", "canonical absolute path is what the adapter execs");
  assert.equal(probes, 1, "identical realpath probed once");
});

test(`DESKTOP_API is ${1} (bump requires a contract revision)`, () => {
  assert.equal(DESKTOP_API, 1);
});

/* ── spawn-time relations capability gate (review f921f7d) ── */

test("supportsRelations: older accepted v1 CLIs are NOT relation-capable", async () => {
  const { supportsRelations, RELATIONS_MIN } = await import("../cli-locator.mjs");
  const min = RELATIONS_MIN.join(".");
  assert.equal(supportsRelations("0.18.0"), false, "pre-relations v1 release");
  assert.equal(supportsRelations("0.18.2"), false, "pre-relations v1 release");
  assert.equal(supportsRelations(min), true, "first relation-capable release");
  assert.equal(supportsRelations("0.18.9"), true);
  assert.equal(supportsRelations(`${min}-rc.1`), false, "prereleases never qualify");
  assert.equal(supportsRelations("garbage"), false);
  assert.equal(supportsRelations(undefined), false);
});

test("relationSupportError: related spawns fail closed on old v1 CLIs, plain spawns unaffected", async () => {
  const { relationSupportError, RELATIONS_MIN } = await import("../cli-locator.mjs");
  const oldCli = { ok: true, version: "0.18.0" };
  const newCli = { ok: true, version: RELATIONS_MIN.join(".") };
  // an older v1 CLI ignores unknown spawn options and reports success —
  // sending relation flags to it would silently create an UNRELATED instance
  const err = relationSupportError(oldCli, { relation: "child", relativeTo: "coord-1" });
  assert.ok(err instanceof Error, "related spawn on an old v1 CLI must throw, not degrade silently");
  assert.equal(err.code, "cli-no-relations", "stable code for the spawn form");
  assert.ok(relationSupportError(oldCli, { relativeTo: "coord-1" }), "anchor alone also gates");
  assert.equal(relationSupportError(oldCli, {}), null, "plain spawns keep working on the full v1 range");
  assert.equal(relationSupportError(newCli, { relation: "sibling", relativeTo: "x" }), null,
    "relation-capable CLI passes");
});
