// Framework-hoisted resources of marketplace-sourced capabilities.
//
// An installed marketplace capability may declare resources that live outside
// its installed copy (`oas.authoring` ships no skills of its own; it selects
// three kernel skills with `../../skills/<name>`). Those declarations are
// written against the capability's directory in the kernel marketplace
// (`<PKG_ROOT>/capabilities/<slug>`), so that is the only correct anchor —
// anchoring at PKG_ROOT resolves two levels above the kernel and nothing
// resolves at all.
//
// Every test here runs against a copy of the kernel shaped like an INSTALLED
// one (package `files` only, nested the way npm installs it) rather than the
// source checkout, because the anchor bug is a path-arithmetic bug: it must be
// visible from wherever the kernel really lives.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(new URL("..", import.meta.url).pathname);
function temp() { return mkdtempSync(join(tmpdir(), "oas-hoist-test-")); }
function write(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function gitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  write(join(dir, ".gitignore"), "\n");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
}
function fakeRuntimes(base) {
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  for (const name of ["pi", "claude"]) { write(join(bin, name), "#!/bin/sh\nexit 0\n"); execFileSync("chmod", ["+x", join(bin, name)]); }
  return `${bin}:${process.env.PATH}`;
}
/** The kernel as npm installs it: only the published `files`, nested under a
 * node_modules-shaped prefix. Nesting matters — the pre-fix anchor resolved
 * `<PKG_ROOT>/../../<rel>`, and that must land inside the temp tree so the
 * regression cannot be masked by an unrelated directory on the host. */
function installedKernel(base) {
  const kernel = join(base, "opt", "lib", "node_modules", "@oas-framework", "oas");
  mkdirSync(kernel, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  cpSync(join(REPO, "package.json"), join(kernel, "package.json"));
  for (const entry of pkg.files) {
    const rel = entry.replace(/\/$/, "");
    if (existsSync(join(REPO, rel))) cpSync(join(REPO, rel), join(kernel, rel), { recursive: true });
  }
  // These fixtures exercise the legacy bundled marketplace compatibility seam,
  // not the now-preferred official package catalog route.
  rmSync(join(kernel, "package-catalog.json"), { force: true });
  return kernel;
}
const loadKernel = (kernel) => import(pathToFileURL(join(kernel, "lib", "core.mjs")).href);
function frameworkAuthor(base) {
  const repo = join(base, "repo"); gitRepo(repo);
  const root = join(base, "agents");
  const soul = join(root, "framework-author", "soul");
  write(join(soul, "soul.yaml"), `name: framework-author\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
  write(join(soul, "AGENTS.md"), "# Canonical framework-author\n");
  symlinkSync("AGENTS.md", join(soul, "CLAUDE.md"));
  mkdirSync(join(root, "framework-author", "instances"), { recursive: true });
  return { repo, root };
}
// The fixture kernel deliberately has NO package-catalog.json, so the official
// route must resolve to nothing. Bind that absent file explicitly: an unbound
// catalog would fall through to the v0.21 remote fetch instead.
const oasCli = (kernel, ...argv) => spawnSync(process.execPath, [join(kernel, "bin", "oas.mjs"), ...argv],
  { encoding: "utf8", env: { ...process.env, OAS_PACKAGE_CATALOG: join(kernel, "package-catalog.json") } });
function install(kernel, id, dir) {
  const r = oasCli(kernel, "install", id, "--dir", dir);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return r;
}
const instances = (root) => readdirSync(join(root, "framework-author", "instances"));

test("oas.authoring: hoisted skills anchor at the capability's marketplace dir, so a framework-author spawns with all three", async () => {
  const base = temp();
  try {
    const kernel = installedKernel(base);
    const { repo, root } = frameworkAuthor(base);
    write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    oas.authoring:\n      souls:\n        framework-author: true\n");
    install(kernel, "oas.authoring", repo);
    const lock = JSON.parse(readFileSync(join(repo, "oas-lock.json"), "utf8"));
    assert.equal(lock.lockfileVersion, 1, "the acquisition writes the marketplace v1 capability lock");
    assert.equal(lock.capabilities["oas.authoring"].source, "marketplace:oas.authoring@1.0.0");

    const core = await loadKernel(kernel);
    // The anchor itself: each declared path resolves inside the INSTALLED kernel.
    const declared = core.capabilityDeclaredSkills("oas.authoring", repo);
    assert.deepEqual(declared.map((s) => s.declared).sort(),
      ["../../skills/integration-authoring", "../../skills/skill-craft", "../../skills/soul-craft"]);
    for (const s of declared) {
      assert.equal(realpathSync(s.path), realpathSync(join(kernel, "skills", s.declared.replace("../../skills/", ""))),
        `${s.declared} resolves against <PKG_ROOT>/capabilities/oas-authoring, not <PKG_ROOT>`);
    }

    const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
    try {
      const res = core.spawnInstance(root, core.findAgent(root, "framework-author"), { instance: "fa-1", launch: false });
      const names = readdirSync(join(res.home, ".agents", "skills")).sort();
      assert.deepEqual(names, ["integration-authoring", "oas", "oas-config", "oas-packages", "skill-craft", "soul-craft"]);
      for (const name of ["integration-authoring", "skill-craft", "soul-craft"]) {
        assert.match(readFileSync(join(res.home, ".agents", "skills", name, "SKILL.md"), "utf8"), /^---/, `${name} materialized`);
      }
      const meta = JSON.parse(readFileSync(join(res.home, "instance.json"), "utf8"));
      assert.deepEqual(meta.skills.map((s) => s.name).sort(), names, "instance.json records the composed set");
      assert.ok(meta.capabilities.some((c) => c.id === "oas.authoring"));
    } finally { process.env.PATH = oldPath; }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("marketplace dependencies may be npm-hoisted to the kernel root (published oas.aweb layout)", async () => {
  const base = temp();
  try {
    const kernel = installedKernel(base);
    const { repo } = frameworkAuthor(base);
    write(join(repo, "oas-config.yaml"), "name: test\n");
    for (const name of ["aweb-messaging", "aweb-team-membership", "aweb-identity"]) {
      write(join(kernel, "node_modules", "@awebai", "pi", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n`);
    }
    install(kernel, "oas.aweb", repo);
    const core = await loadKernel(kernel);
    const declared = core.capabilityDeclaredSkills("oas.aweb", repo);
    assert.equal(declared.length, 3);
    for (const s of declared) {
      assert.ok(s.path, `${s.declared} resolves from npm's kernel-root hoist`);
      assert.ok(realpathSync(s.path).startsWith(realpathSync(join(kernel, "node_modules", "@awebai", "pi", "skills"))));
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("kernel upgrades keep older locked marketplace installs working; installed/lock drift still fails closed", async () => {
  const base = temp();
  try {
    const kernel = installedKernel(base);
    const { repo, root } = frameworkAuthor(base);
    write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    oas.authoring:\n      souls:\n        framework-author: true\n");
    install(kernel, "oas.authoring", repo);
    const core = await loadKernel(kernel);

    // A kernel upgrade intentionally advances framework-hoisted content while
    // the user's valid v1 installed copy and lock remain on their old version.
    // This is the real 0.18.6 → 0.19 state (not drift): the upgraded kernel is
    // itself the trusted source of the hoisted skills.
    const sourceManifest = join(kernel, "capabilities", "oas-authoring", "oas.json");
    const shipped = JSON.parse(readFileSync(sourceManifest, "utf8"));
    writeFileSync(sourceManifest, JSON.stringify({ ...shipped, version: "2.0.0" }, null, 2));
    const installedCopy = join(repo, ".agents", "capabilities", "installed", "oas-authoring");
    const upgraded = core.capabilityDeclaredSkills("oas.authoring", repo);
    assert.equal(upgraded.filter((s) => s.path).length, 3,
      "a newer kernel keeps the older valid installed+locked marketplace capability usable");
    for (const s of upgraded) {
      assert.equal(realpathSync(s.path), realpathSync(join(kernel, "skills", s.declared.replace("../../skills/", ""))));
    }
    assert.equal(JSON.parse(readFileSync(join(repo, "oas-lock.json"), "utf8")).capabilities["oas.authoring"].version, "1.0.0",
      "using upgraded kernel content does not silently rewrite the legacy lock");

    // Real drift is between the installed copy and its lock. The advertised
    // recovery must actually recover, and its delete step is load-bearing:
    // `oas install <id>` alone finds the copy and stops.
    const lockFile = join(repo, "oas-lock.json");
    const lock = JSON.parse(readFileSync(lockFile, "utf8"));
    lock.capabilities["oas.authoring"].version = "0.9.0";
    writeFileSync(lockFile, JSON.stringify(lock, null, 2));
    assert.throws(() => core.capabilityDeclaredSkills("oas.authoring", repo), (e) => e.code === "E_MARKETPLACE_SOURCE_DRIFT"
      && /lock pins 0\.9\.0, installed copy is 1\.0\.0/.test(e.message)
      && e.message.includes(installedCopy) && /oas install oas\.authoring --dir /.test(e.message),
    "lock/copy drift names the drift, copy to delete, and reacquire command");
    const naive = oasCli(kernel, "install", "oas.authoring", "--dir", repo);
    assert.match(naive.stdout, /Already acquired capability oas\.authoring \(1\.0\.0\); not activated or updated/,
      "an install that keeps the copy is a no-op — which is why the message says to delete it first");
    assert.throws(() => core.capabilityDeclaredSkills("oas.authoring", repo), (e) => e.code === "E_MARKETPLACE_SOURCE_DRIFT",
      "and it leaves the scope exactly as drifted as before");
    rmSync(installedCopy, { recursive: true, force: true });
    install(kernel, "oas.authoring", repo);
    assert.equal(JSON.parse(readFileSync(lockFile, "utf8")).capabilities["oas.authoring"].version, "2.0.0",
      "the recovery relocks the scope onto the shipped version");
    for (const s of core.capabilityDeclaredSkills("oas.authoring", repo)) {
      assert.equal(realpathSync(s.path), realpathSync(join(kernel, "skills", s.declared.replace("../../skills/", ""))),
        `${s.declared} resolves again after the documented recovery`);
    }

    // And when this kernel does not ship the capability at all, the declared
    // resources simply do not resolve — spawn fails closed with no zombie home.
    rmSync(join(kernel, "capabilities", "oas-authoring"), { recursive: true });
    assert.deepEqual(core.capabilityDeclaredSkills("oas.authoring", repo).map((s) => s.path), [undefined, undefined, undefined]);
    const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
    try {
      assert.throws(() => core.spawnInstance(root, core.findAgent(root, "framework-author"), { instance: "fa-gone", launch: false }),
        (e) => e.code === "E_CAPABILITY_RESOURCE_MISSING" && /skills\/skill-craft/.test(e.message));
      assert.deepEqual(instances(root), [], "no instance home survives the failed spawn");
    } finally { process.env.PATH = oldPath; }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a hoisted path may leave the installed copy but never the kernel package", async () => {
  const base = temp();
  try {
    const kernel = installedKernel(base);
    const { repo } = frameworkAuthor(base);
    const core = await loadKernel(kernel);
    // `..` escape: the declaration resolves to a real tree ABOVE the kernel.
    write(join(kernel, "capabilities", "escape-cap", "oas.json"), JSON.stringify({
      capability: "acme.escape", version: "1.0.0", compatibility: { oas: ">=0.6.2" },
      description: "hoists above the kernel", skills: ["../../../outside-skills"],
    }, null, 2));
    write(join(dirname(kernel), "outside-skills", "leak", "SKILL.md"), "---\nname: leak\ndescription: Leak.\n---\n");
    // symlink escape: the declaration lands inside the kernel, a link inside it does not.
    write(join(kernel, "capabilities", "link-cap", "oas.json"), JSON.stringify({
      capability: "acme.link", version: "1.0.0", compatibility: { oas: ">=0.6.2" },
      description: "hoists to a tree holding an escaping link", skills: ["../../hoisted-skills"],
    }, null, 2));
    write(join(kernel, "hoisted-skills", "linked", "SKILL.md"), "---\nname: linked\ndescription: Linked.\n---\n");
    write(join(base, "outside-file.md"), "unlocked instructions\n");
    symlinkSync(join(base, "outside-file.md"), join(kernel, "hoisted-skills", "linked", "outside.md"));

    write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.escape:\n      global: true\n    acme.link:\n      global: true\n");
    install(kernel, "acme.escape", repo);
    install(kernel, "acme.link", repo);
    assert.throws(() => core.capabilityDeclaredSkills("acme.escape", repo), /acme\.escape path escapes its integrity boundary/,
      "a hoisted path resolving above PKG_ROOT is rejected");
    assert.throws(() => core.capabilityDeclaredSkills("acme.link", repo), /acme\.link skill path escapes its integrity boundary/,
      "a symlink out of a hoisted tree is rejected — hoisted trees are walked, not exempted");
    assert.throws(() => core.resolveOasConfig(repo, "framework-author"), /escapes its integrity boundary/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("owned and path capabilities never hoist: only a marketplace lock source grants the exemption", async () => {
  const base = temp();
  try {
    const kernel = installedKernel(base);
    const { repo } = frameworkAuthor(base);
    const core = await loadKernel(kernel);
    // Same declaration as oas.authoring, but authored at the scope (owned) and
    // referenced by path — neither is marketplace-sourced.
    for (const [dir, id] of [[join(repo, ".agents", "capabilities", "owned", "hoist"), "acme.owned"], [join(repo, "authored-cap"), "acme.path"]]) {
      write(join(dir, "oas.json"), JSON.stringify({
        capability: id, version: "1.0.0", compatibility: { oas: ">=0.6.2" },
        description: "wants framework skills", skills: ["../../skills/skill-craft"],
      }, null, 2));
    }
    write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.owned:\n      global: true\n    acme.path:\n      from: path:authored-cap\n      global: true\n");
    for (const id of ["acme.owned", "acme.path"]) {
      assert.deepEqual(core.capabilityDeclaredSkills(id, repo).map((s) => s.path), [undefined],
        `${id} gets no framework-hoisted resolution`);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});
