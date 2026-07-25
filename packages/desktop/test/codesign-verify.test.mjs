// codesign-verify — unit tests for the packaged-app signature gate.
//
// The gate exists to reject the v0.18.2 installer defect class: an arm64
// bundle carrying only the linker-generated partial ad-hoc signature (no
// Contents/_CodeSignature seal; strict deep verify fails with "code has no
// resources but signature indicates they must be present") and an x64
// bundle with no signature at all. These tests pin:
//   * the EXACT codesign argv (weakening --deep/--strict must fail here);
//   * failure handling (nonzero exit, timeout, missing seal, linker-signed);
//   * platform behavior (non-darwin can NEVER pass as verified);
//   * the reaper contract (async group-tracked execution only);
//   * the dist-smoke wiring: the codesign phase is unconditional on darwin
//     and cannot be skipped by any OAS_SMOKE_* env flag.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyArgv, displayArgv, verifyAppSignature } from "../scripts/codesign-verify.mjs";

const APP = "/dist/mac-arm64/OAS Desktop.app";
const goodDisplay = [
  "Executable=/dist/mac-arm64/OAS Desktop.app/Contents/MacOS/OAS Desktop",
  "CodeDirectory v=20500 size=431 flags=0x10002(adhoc,runtime) hashes=3+7 location=embedded",
  "Signature=adhoc",
  "TeamIdentifier=not set",
  "Sealed Resources version=2 rules=13 files=179",
].join("\n");

function fakeReaper(script) {
  const calls = [];
  return {
    calls,
    runTracked: async (exe, args, opts) => {
      calls.push({ exe, args, opts });
      return script(exe, args, calls.length);
    },
  };
}
const sealExists = (p) => p.endsWith("Contents/_CodeSignature/CodeResources");

// ---- argv pins ---------------------------------------------------------------
test("verifyArgv is the exact strict deep verification command", () => {
  assert.deepEqual(verifyArgv(APP), ["--verify", "--deep", "--strict", "--verbose=2", APP]);
});

test("displayArgv is the exact display command", () => {
  assert.deepEqual(displayArgv(APP), ["--display", "--verbose=2", APP]);
});

test("verifyAppSignature invokes codesign with the pinned argv (verify then display)", async () => {
  const r = fakeReaper((exe, args, n) =>
    n === 1 ? { stdout: "", stderr: `${APP}: valid on disk\n${APP}: satisfies its Designated Requirement`, code: 0, timedOut: false }
            : { stdout: "", stderr: goodDisplay, code: 0, timedOut: false });
  const res = await verifyAppSignature(r, APP, { platform: "darwin", existsSync: sealExists });
  assert.equal(res.ok, true, res.detail);
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[0].exe, "codesign");
  assert.deepEqual(r.calls[0].args, verifyArgv(APP));
  assert.equal(r.calls[1].exe, "codesign");
  assert.deepEqual(r.calls[1].args, displayArgv(APP));
  assert.match(res.detail, /--verify --deep --strict PASSED/);
  assert.match(res.detail, /Signature=adhoc/);
  assert.match(res.detail, /Sealed Resources/);
  // execution bounds: a timeout is always passed so the group can be killed
  for (const c of r.calls) assert.ok(c.opts.timeout > 0, "bounded execution");
});

// ---- failure handling ---------------------------------------------------------
test("missing _CodeSignature seal fails BEFORE running codesign (v0.18.2 arm64 class)", async () => {
  const r = fakeReaper(() => { throw new Error("must not execute"); });
  const res = await verifyAppSignature(r, APP, { platform: "darwin", existsSync: () => false });
  assert.equal(res.ok, false);
  assert.match(res.detail, /no bundle signature seal/);
  assert.match(res.detail, /v0\.18\.2 defect class/);
  assert.equal(r.calls.length, 0);
});

test("nonzero codesign exit fails with the codesign output (unsigned x64 class)", async () => {
  const r = fakeReaper(() => ({ stdout: "", stderr: `${APP}: code object is not signed at all`, code: 1, timedOut: false }));
  const res = await verifyAppSignature(r, APP, { platform: "darwin", existsSync: sealExists });
  assert.equal(res.ok, false);
  assert.match(res.detail, /FAILED \(exit 1\)/);
  assert.match(res.detail, /not signed at all/);
});

test("the v0.18.2 strict-verify failure message is surfaced verbatim", async () => {
  const msg = `${APP}: code has no resources but signature indicates they must be present`;
  const r = fakeReaper(() => ({ stdout: "", stderr: msg, code: 1, timedOut: false }));
  const res = await verifyAppSignature(r, APP, { platform: "darwin", existsSync: sealExists });
  assert.equal(res.ok, false);
  assert.match(res.detail, /code has no resources but signature indicates they must be present/);
});

test("codesign timeout fails (group killed, bounded)", async () => {
  const r = fakeReaper(() => ({ stdout: "", stderr: "", code: null, timedOut: true }));
  const res = await verifyAppSignature(r, APP, { platform: "darwin", existsSync: sealExists });
  assert.equal(res.ok, false);
  assert.match(res.detail, /timed out \(group killed\)/);
});

test("a linker-signed-only display result fails even when strict verify passed", async () => {
  // Belt-and-braces: if codesign semantics ever drift, a linker-signed
  // partial signature must still be named and rejected.
  const r = fakeReaper((exe, args, n) =>
    n === 1 ? { stdout: "", stderr: "valid on disk", code: 0, timedOut: false }
            : { stdout: "", stderr: "CodeDirectory flags=0x20002(adhoc,linker-signed)\nSignature=adhoc\nSealed Resources=none", code: 0, timedOut: false });
  const res = await verifyAppSignature(r, APP, { platform: "darwin", existsSync: sealExists });
  assert.equal(res.ok, false);
  assert.match(res.detail, /linker-signed/);
});

test("display failure after a passing verify is still a gate failure", async () => {
  const r = fakeReaper((exe, args, n) =>
    n === 1 ? { stdout: "", stderr: "valid on disk", code: 0, timedOut: false }
            : { stdout: "", stderr: "", code: 1, timedOut: false });
  const res = await verifyAppSignature(r, APP, { platform: "darwin", existsSync: sealExists });
  assert.equal(res.ok, false);
  assert.match(res.detail, /--display failed/);
});

// ---- platform / contract behavior ----------------------------------------------
test("non-darwin platforms can never pass as verified", async () => {
  for (const platform of ["linux", "win32"]) {
    const r = fakeReaper(() => { throw new Error("must not execute"); });
    const res = await verifyAppSignature(r, APP, { platform, existsSync: sealExists });
    assert.equal(res.ok, false);
    assert.match(res.detail, /only meaningful on darwin/);
    assert.equal(r.calls.length, 0);
  }
});

test("a reaper without runTracked is rejected (async group-tracked execution is the contract)", async () => {
  const res = await verifyAppSignature({}, APP, { platform: "darwin", existsSync: sealExists });
  assert.equal(res.ok, false);
  assert.match(res.detail, /runTracked/);
});

test("missing existsSync injection is rejected (no silent structural-check skip)", async () => {
  const r = fakeReaper(() => { throw new Error("must not execute"); });
  const res = await verifyAppSignature(r, APP, { platform: "darwin" });
  assert.equal(res.ok, false);
  assert.match(res.detail, /existsSync/);
});

// ---- source contracts: the smoke cannot silently skip codesign on macOS --------
test("codesign-verify module has no synchronous child execution", () => {
  const src = readFileSync(new URL("../scripts/codesign-verify.mjs", import.meta.url), "utf8");
  assert.ok(!/execFileSync|execSync|spawnSync/.test(src), "no synchronous child execution");
  assert.match(src, /runTracked/, "runs through the reaper contract");
});

test("dist-smoke wires the codesign gate unconditionally on darwin (no env skip)", () => {
  const src = readFileSync(new URL("../scripts/dist-smoke.mjs", import.meta.url), "utf8");
  assert.match(src, /verifyAppSignature\(reaper/, "smoke calls the codesign gate through the reaper");
  // The gate must be guarded ONLY by the platform check — extract the
  // guarding condition and assert no env flag participates.
  const m = src.match(/if \(([^)]*)\) \{\n\s*const r = await verifyAppSignature/);
  assert.ok(m, "codesign gate present with its guard");
  assert.equal(m[1], `process.platform === "darwin"`, "codesign phase guarded by platform ONLY");
  assert.ok(!/OAS_SMOKE[A-Z_]*[^\n]*verifyAppSignature|verifyAppSignature[^\n]*OAS_SMOKE/.test(src),
    "no OAS_SMOKE_* flag on the codesign line");
  // the codesign phase must run BEFORE the launch-skip branching
  assert.ok(src.indexOf("verifyAppSignature") < src.indexOf("OAS_SMOKE_SKIP_LAUNCH"),
    "codesign gate precedes the launch-skip logic — skip flags cannot reach it");
});

test("electron-builder config pins ad-hoc signing (identity '-'), never identity:null", () => {
  const cfg = readFileSync(new URL("../electron-builder.config.cjs", import.meta.url), "utf8");
  assert.match(cfg, /identity:\s*"-"/, "mac.identity must be the ad-hoc identity '-'");
  assert.ok(!/^\s*identity:\s*null/m.test(cfg), "identity: null (signing disabled — the v0.18.2 defect) must not reappear as a config value");
});
