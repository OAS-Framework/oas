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
  assert.deepEqual(parseSemver("0.18.0"), [0, 18, 0]);
  assert.deepEqual(parseSemver("0.18.1-rc.1"), [0, 18, 1]);
  assert.equal(parseSemver("v0.18.0"), null);
  assert.equal(parseSemver(""), null);
});

test("parseProbeStdout: only a single JSON object passes", () => {
  assert.deepEqual(parseProbeStdout(JSON.stringify(PROBE())), PROBE());
  assert.equal(parseProbeStdout("oas 0.18.0\n"), null);
  assert.equal(parseProbeStdout('{"a":1}\n{"b":2}'), null);
  assert.equal(parseProbeStdout('"just-a-string"'), null);
});

test("candidates: contract discovery order — persisted, env, PATH, npm-global, login-shell", () => {
  const io = {
    persisted: () => "/chosen/oas",
    env: { OAS_DESKTOP_OAS_BIN: "/env/oas", PATH: ["/p1", "/p2"].join(delimiter) },
    npmGlobalBin: () => "/npmg/bin",
    loginShellWhich: () => "/login/oas",
  };
  assert.deepEqual(candidates(io), [
    { path: "/chosen/oas", source: "persisted" },
    { path: "/env/oas", source: "env" },
    { path: "/p1/oas", source: "path" },
    { path: "/p2/oas", source: "path" },
    { path: "/npmg/bin/oas", source: "npm-global" },
    { path: "/login/oas", source: "login-shell" },
  ]);
});

test("candidates: relative and empty entries are dropped (absolute executables only)", () => {
  const io = {
    persisted: () => "relative/oas",
    env: { OAS_DESKTOP_OAS_BIN: "", PATH: "" },
    npmGlobalBin: () => null,
    loginShellWhich: () => undefined,
  };
  assert.deepEqual(candidates(io), []);
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
