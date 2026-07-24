// Static assertions on .github/workflows/release.yml — the binding v0.18.0
// release sequencing (desktop-dist contract):
//   * checkout the EXACT tag SHA (github.sha), never a branch ref;
//   * tag-derived version applied to root, packages/pi AND packages/desktop;
//   * every build/test/smoke step runs BEFORE any npm publication;
//   * the GitHub Release is created AFTER npm publication;
//   * the bump PR covers all three package manifests.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const yml = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

test("release checks out the exact tag SHA, never a branch ref", () => {
  assert.match(yml, /ref: \$\{\{ github\.sha \}\}/, "checkout pins github.sha");
  assert.ok(!/ref:\s*main\b/.test(yml), "no checkout of the moving main ref");
  // the on-main ancestry gate remains
  assert.match(yml, /merge-base --is-ancestor "\$\{GITHUB_SHA\}" origin\/main/);
});

test("tag-derived version bumps root, pi, and desktop manifests", () => {
  // bump appears in build and publish jobs; each covers all three packages
  const bumps = yml.match(/npm version "[^"]*" --no-git-tag-version/g) || [];
  assert.ok(bumps.length >= 2, "version bumps in build and publish jobs");
  for (const block of yml.split(/- name: Bump all three packages/).slice(1)) {
    const head = block.slice(0, 400);
    assert.match(head, /packages\/pi && npm version/);
    assert.match(head, /packages\/desktop && npm version/);
  }
});

test("all build/smoke steps precede npm publication", () => {
  const publishJob = yml.indexOf("publish:\n");
  assert.ok(publishJob > 0);
  // publication is gated on both build jobs
  assert.match(yml.slice(publishJob), /needs: \[build-and-test, desktop-build\]/);
  // the first `npm publish` occurs inside the publish job only
  const firstPublish = yml.indexOf("npm publish");
  assert.ok(firstPublish > publishJob, "no npm publish before the gated publish job");
  // smoke steps live in the pre-publish jobs
  for (const step of ["smoke:tarball", "pack:check", "npm test", "version --json probe mismatch"]) {
    const at = yml.indexOf(step);
    assert.ok(at >= 0 && at < publishJob, `${step} runs before publication`);
  }
  // desktop build + artifact upload precede publish
  const desktopJob = yml.indexOf("desktop-build:");
  assert.ok(desktopJob > 0 && desktopJob < publishJob);
  assert.match(yml.slice(desktopJob, publishJob), /needs: build-and-test/);
  assert.match(yml.slice(desktopJob, publishJob), /upload-artifact/);
});

test("GitHub Release is created after npm publication, from the same assets", () => {
  const pubOas = yml.indexOf("Publish @oas-framework/oas");
  const pubPi = yml.indexOf("Publish @oas-framework/pi");
  const ghRelease = yml.indexOf("gh release create");
  assert.ok(pubOas > 0 && pubPi > pubOas && ghRelease > pubPi, "order: oas → pi → GitHub Release");
  assert.match(yml, /--verify-tag/, "release verifies the pushed tag");
  assert.match(yml, /SHA256SUMS\.txt/, "checksums published");
  assert.match(yml, /attest-build-provenance/, "provenance attestation");
});

test("unsigned posture: certificate auto-discovery disabled; supported matrix only", () => {
  assert.match(yml, /CSC_IDENTITY_AUTO_DISCOVERY: "false"/);
  assert.ok(!/windows/i.test(yml), "no Windows job in 0.18.0");
  assert.match(yml, /macos-14/, "macOS arm64");
  assert.match(yml, /macos-13/, "macOS x64");
  assert.match(yml, /ubuntu-latest/, "Linux x64");
});

test("bump PR covers all three package manifests", () => {
  const prBlock = yml.slice(yml.indexOf("Open the version-bump PR"));
  assert.match(prBlock, /git add package\.json package-lock\.json packages\/pi\/package\.json packages\/desktop\/package\.json packages\/desktop\/package-lock\.json/);
  assert.match(prBlock, /gh pr create --base main/);
});
