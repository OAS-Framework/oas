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
import { spawnSync } from "node:child_process";

const yml = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const desktopPkg = JSON.parse(readFileSync(new URL("../packages/desktop/package.json", import.meta.url), "utf8"));

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

test("npm publication and GitHub Release are same-tag retryable (idempotent)", () => {
  // Re-running the publish job must skip already-live npm versions instead of
  // failing on npm's already-published rejection, and re-upload GH assets.
  const publishJob = yml.slice(yml.indexOf("publish:\n"));
  const oasStep = publishJob.slice(publishJob.indexOf("Publish @oas-framework/oas"), publishJob.indexOf("Publish @oas-framework/pi"));
  const piStep = publishJob.slice(publishJob.indexOf("Publish @oas-framework/pi"), publishJob.indexOf("Download Desktop artifacts"));
  assert.match(oasStep, /npm view "@oas-framework\/oas@\$\{V\}"/, "oas publish guarded by npm view");
  assert.match(piStep, /npm view "@oas-framework\/pi@\$\{V\}"/, "pi publish guarded by npm view");
  for (const step of [oasStep, piStep]) {
    assert.ok(step.indexOf("npm view") < step.indexOf("npm publish"), "guard precedes publish");
    assert.match(step, /already published/, "skip message on retry");
  }
  const ghStep = publishJob.slice(publishJob.indexOf("Create the GitHub Release"));
  assert.match(ghStep, /gh release view/, "release existence checked");
  assert.match(ghStep, /gh release upload .* --clobber/, "retry re-uploads assets");
  assert.ok(ghStep.indexOf("gh release view") < ghStep.indexOf("gh release create"));
});

test("desktop package scripts invoked by the workflow exist and run", () => {
  // The workflow's desktop-build job runs `npm test` and `npm run dist` in
  // packages/desktop — workflow text matching alone cannot catch a missing
  // script. `test` is owned here and must exist AND run. `dist`/`dist:smoke`
  // are the Desktop owner's deliverable on this seam, but the release path is
  // broken without them — so their presence is asserted UNCONDITIONALLY:
  // this test stays red until the Desktop owner's electron-builder commit
  // lands through the feature branch (coordinator-sequenced dependency).
  assert.equal(typeof desktopPkg.scripts.test, "string", "packages/desktop has a test script");
  const r = spawnSync("npm", ["test"], { cwd: new URL("../packages/desktop", import.meta.url).pathname, encoding: "utf8", timeout: 300000 });
  assert.equal(r.status, 0, `packages/desktop npm test failed:\n${r.stderr?.slice(-2000)}`);
  assert.match(yml, /npm run dist\b/, "workflow invokes npm run dist in packages/desktop");
  assert.equal(typeof desktopPkg.scripts.dist, "string",
    "packages/desktop needs a dist script (electron-builder packaging producing dist/oas-desktop-*) — the release workflow runs `npm run dist` in every desktop matrix leg; this is the Desktop owner's deliverable, landed via feature/desktop-dist");
  assert.ok(
    Object.keys(desktopPkg.devDependencies || {}).some((d) => d.includes("electron-builder")) || /electron-builder/.test(desktopPkg.scripts.dist),
    "dist script is electron-builder packaging");
});

test("electron-builder declares a filesystem-safe Linux executableName (AppImage/DEB name guard)", () => {
  // Without a safe executableName, electron-builder derives it from the
  // SCOPED package name "@oas-framework/desktop" → "@oas-frameworkdesktop",
  // whose "@"/"/" fail the Linux AppImage/DEB build ("characters that cannot
  // be safely used in file paths"). This guards that regressing.
  const cfg = readFileSync(new URL("../packages/desktop/electron-builder.config.cjs", import.meta.url), "utf8");
  const m = cfg.match(/executableName:\s*["']([^"']+)["']/);
  assert.ok(m, "electron-builder.config.cjs must declare an executableName (Linux name safety)");
  const name = m[1];
  // filesystem-safe: no scoped-name metacharacters, path separators, or spaces
  assert.match(name, /^[a-z0-9][a-z0-9._-]*$/, `executableName "${name}" must be filesystem-safe (lowercase alnum/._- only)`);
  assert.ok(!/[@/\\ ]/.test(name), `executableName "${name}" must not contain @ / \\ or spaces`);
});

test("release desktop-build matrix does not fail-fast (one leg must not mask the others)", () => {
  // The Linux leg failing fast previously CANCELLED the mac legs, hiding
  // whether they built. Each matrix leg must report independently.
  const desktopJob = yml.indexOf("desktop-build:");
  assert.ok(desktopJob > 0, "desktop-build job present");
  const nextJob = yml.indexOf("\n  publish:", desktopJob);
  const jobText = yml.slice(desktopJob, nextJob > 0 ? nextJob : undefined);
  assert.match(jobText, /fail-fast:\s*false/, "desktop-build matrix sets fail-fast: false");
});

test("build-installers workflow is VERIFY-ONLY (no publish/release/tag surface)", () => {
  const bi = readFileSync(new URL("../.github/workflows/build-installers.yml", import.meta.url), "utf8");
  // zero publish surface — the whole point is installer evidence without any release action
  assert.ok(!/npm publish/.test(bi), "must not npm publish");
  assert.ok(!/gh release|actions\/create-release|softprops\/action-gh-release/.test(bi), "must not create a GitHub Release");
  assert.ok(!/npm version|git tag|GITHUB_REF_NAME/.test(bi), "must not tag or bump versions");
  assert.ok(!/NPM_TOKEN|NODE_AUTH_TOKEN/.test(bi), "must not reference publish tokens");
  assert.ok(!/attest-build-provenance/.test(bi), "no attestation (that's the release job)");
  // read-only permissions
  assert.match(bi, /permissions:\s*\n\s*contents:\s*read/, "permissions: contents: read only");
  // same 3-leg matrix as the release desktop-build, fail-fast:false
  assert.match(bi, /fail-fast:\s*false/, "independent per-leg evidence");
  for (const leg of ["macos-14", "macos-13", "ubuntu-latest"]) {
    assert.ok(bi.includes(leg), `matrix includes ${leg}`);
  }
  // it does build + smoke
  assert.match(bi, /npm run dist\b/, "builds installers");
  assert.match(bi, /npm run dist:smoke/, "runs the installed-artifact smoke");
  assert.match(bi, /upload-artifact/, "uploads the distributables for inspection");
});

test("build-installers workflow: own concurrency group (never release.yml's), no tag-push trigger", () => {
  const bi = readFileSync(new URL("../.github/workflows/build-installers.yml", import.meta.url), "utf8");
  // must not collide with a real release run
  assert.ok(!/group:\s*release\b/.test(bi), "must NOT reuse release.yml's concurrency group: release");
  assert.match(bi, /concurrency:\s*\n\s*group:\s*build-installers/, "declares its own build-installers concurrency group");
  // triggered by PR + manual only, never by a tag push (that is release.yml)
  assert.ok(!/on:\s*[\s\S]*push:\s*[\s\S]*tags/.test(bi), "must not trigger on tag push (release.yml owns tags)");
  assert.match(bi, /workflow_dispatch:/, "manual trigger present");
  assert.match(bi, /pull_request:/, "pull_request trigger present");
  // its job name must not be the release matrix job name
  assert.ok(!/^\s*desktop-build:/m.test(bi), "distinct job name from release.yml's desktop-build");
});
