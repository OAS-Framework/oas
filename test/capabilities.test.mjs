import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  capabilityIntegrity, capabilityManifest, composeInstanceAgentsMd, createAgent, findAgent, resolveOasConfig,
  retireInstance, runLifecycleHooks, spawnInstance, writeCapabilityLock,
} from "../lib/core.mjs";

const CLI = resolve(new URL("../bin/oas.mjs", import.meta.url).pathname);
function temp() { return mkdtempSync(join(tmpdir(), "oas-cap-test-")); }
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
function capability(repo, folder, manifest, files = {}) {
  const dir = join(repo, ".agents", "capabilities", "owned", folder);
  write(join(dir, "oas.json"), JSON.stringify({ version: "1.0.0", compatibility: { oas: ">=0.6.2" }, description: "Test capability.", ...manifest }, null, 2));
  for (const [name, body] of Object.entries(files)) write(join(dir, name), body);
  return dir;
}
function fakeRuntimes(base) {
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  for (const name of ["pi", "claude"]) { write(join(bin, name), "#!/bin/sh\nexit 0\n"); execFileSync("chmod", ["+x", join(bin, name)]); }
  return `${bin}:${process.env.PATH}`;
}

function fixtureSoul(base, runtime = "pi", type) {
  const repo = join(base, "repo"); gitRepo(repo);
  const root = join(base, "agents");
  const soul = join(root, "dev", "soul");
  write(join(soul, "soul.yaml"), `name: dev\nkind: persistent\n${type ? `type: ${type}\n` : ""}repo: ${repo}\nwork: checkout\nruntime: ${runtime}\n`);
  write(join(soul, "AGENTS.md"), "# Canonical dev\n\nNever mutate me.\n");
  symlinkSync("AGENTS.md", join(soul, "CLAUDE.md"));
  mkdirSync(join(root, "dev", "instances"), { recursive: true });
  return { repo, root, soul, agent: findAgent(root, "dev") };
}

// Soul with a declared type at an agents root, so soul-type targeting resolves.
function typedSoul(base, name, type) {
  const root = join(base, "agents");
  write(join(root, name, "soul", "soul.yaml"), `name: ${name}\nkind: persistent\n${type ? `type: ${type}\n` : ""}`);
  return root;
}

test("target composition applies global + agent-type + soul specificity and exclusions", () => {
  const base = temp(); const repo = join(base, "repo"); mkdirSync(repo);
  capability(repo, "theme", { capability: "acme.theme", description: "theme" });
  typedSoul(repo, "dev", "devs"); typedSoul(repo, "reviewer", "devs"); typedSoul(repo, "other", undefined);
  write(join(repo, "oas-config.yaml"), `agent-types:\n  devs:\n    description: dev family\ncapabilities:\n  additive:\n    acme.theme:\n      global:\n        enabled: true\n        settings:\n          tone: neutral\n          depth: low\n      agent-types:\n        devs:\n          enabled: false\n          settings:\n            depth: medium\n      souls:\n        dev:\n          enabled: true\n          settings:\n            depth: high\n`);
  const dev = resolveOasConfig(repo, "dev").capabilities.find((c) => c.id === "acme.theme");
  assert.deepEqual(dev.settings, { tone: "neutral", depth: "high" });
  assert.ok(dev);
  assert.equal(resolveOasConfig(repo, "reviewer").capabilities.some((c) => c.id === "acme.theme"), false);
  assert.equal(resolveOasConfig(repo, "other").capabilities.some((c) => c.id === "acme.theme"), true);
});

test("layer entries compose with soul targeting and layer/manifest mismatches error", () => {
  const base = temp(); const repo = join(base, "repo"); mkdirSync(repo);
  capability(repo, "knowledge", { capability: "acme.knowledge", layer: "knowledge" });
  write(join(repo, "oas-config.yaml"), `capabilities:\n  layers:\n    knowledge:\n      capability: acme.knowledge\n      global:\n        enabled: true\n        settings:\n          format: default\n      souls:\n        dev:\n          enabled: true\n          settings:\n            format: targeted\n        excluded: false\n`);
  const dev = resolveOasConfig(repo, "dev");
  assert.equal(dev.layers.knowledge.id, "acme.knowledge");
  assert.deepEqual(dev.layers.knowledge.settings, { format: "targeted" });
  const excluded = resolveOasConfig(repo, "excluded");
  assert.equal(excluded.layers.knowledge, undefined);
  assert.equal(excluded.capabilities.some((c) => c.id === "acme.knowledge"), false);
  // A layer capability declared as additive errors; wrong slot errors.
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.knowledge:\n      global: true\n");
  assert.throws(() => resolveOasConfig(repo, "dev"), /declare it under capabilities.layers.knowledge/);
  write(join(repo, "oas-config.yaml"), "capabilities:\n  layers:\n    tasks:\n      capability: acme.knowledge\n");
  assert.throws(() => resolveOasConfig(repo, "dev"), /manifest declares layer "knowledge"/);
});

test("pre-contract manifest, config, and discovery spellings are rejected or ignored", () => {
  const base = temp(); const repo = join(base, "repo"); mkdirSync(repo);
  const oldDir = join(repo, ".agents", "integrations", "old");
  write(join(repo, "oas-config.yaml"), "name: clean-contract-test\n");
  write(join(oldDir, "oas.json"), JSON.stringify({ integration: "old", layer: "knowledge" }));
  assert.equal(capabilityManifest("old", repo), undefined);
  write(join(repo, ".agents", "capabilities", "owned", "bad", "oas.json"), JSON.stringify({ integration: "old", layer: "knowledge" }));
  assert.throws(() => capabilityManifest("old", repo), /needs "capability"/);
  rmSync(join(repo, ".agents", "capabilities", "owned", "bad"), { recursive: true });
  write(join(repo, "oas-config.yaml"), "integrations:\n  old: {}\n");
  assert.throws(() => resolveOasConfig(repo, "dev"), /unsupported oas-config key.*integrations/);
  // v0.8 spellings are rejected with pointed migration errors.
  write(join(repo, "oas-config.yaml"), "groups:\n  devs: [dev]\n");
  assert.throws(() => resolveOasConfig(repo, "dev"), /agent-types/);
  write(join(repo, "oas-config.yaml"), "layers:\n  knowledge: none\n");
  assert.throws(() => resolveOasConfig(repo, "dev"), /capabilities.layers/);
  write(join(repo, "oas-config.yaml"), "capabilities:\n  acme.flat:\n    global: true\n");
  assert.throws(() => resolveOasConfig(repo, "dev"), /must nest under "layers:"/);
});

test("explicit layer none excludes inherited integrations and same-scope contradictions error", () => {
  const base = temp(); const outer = join(base, "workspace"); const repo = join(outer, "repo"); mkdirSync(repo, { recursive: true });
  capability(outer, "knowledge", { capability: "acme.knowledge", layer: "knowledge" });
  write(join(outer, "oas-config.yaml"), "capabilities:\n  layers:\n    knowledge:\n      capability: acme.knowledge\n      global: true\n");
  write(join(repo, "oas-config.yaml"), "capabilities:\n  layers:\n    knowledge: none\n");
  assert.equal(resolveOasConfig(repo, "dev").capabilities.some((c) => c.id === "acme.knowledge"), false);
});

test("equal-specificity type conflicts and competing fundamental integrations error", () => {
  const base = temp(); const repo = join(base, "repo"); mkdirSync(repo);
  capability(repo, "a", { capability: "acme.a", layer: "knowledge" });
  capability(repo, "b", { capability: "acme.b", layer: "knowledge" });
  const outer = join(base, "outer"); // two scopes each binding a different knowledge capability
  write(join(repo, "oas-config.yaml"), "capabilities:\n  layers:\n    knowledge:\n      capability: acme.a\n      global: true\n");
  const dev = resolveOasConfig(repo, "dev");
  assert.equal(dev.layers.knowledge.id, "acme.a");
});

test("pi and Claude instances receive the same exact local skills and generated instructions", () => {
  const base = temp(); const { repo, root, soul, agent } = fixtureSoul(base);
  const canonical = readFileSync(join(soul, "AGENTS.md"), "utf8");
  capability(repo, "review", {
    capability: "acme.review", description: "review", skills: ["skills"], inject: "inject.md",
  }, { "skills/review/SKILL.md": "---\nname: review\ndescription: Review.\n---\n# Review\n", "inject.md": "## Review capability\n\nUse review." });
  write(join(soul, "skills", "private", "SKILL.md"), "---\nname: private\ndescription: Private.\n---\n# Private\n");
  write(join(repo, ".agents", "skills", "pollution", "SKILL.md"), "---\nname: pollution\ndescription: No.\n---\n# No\n");
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.review:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    const pi = spawnInstance(root, agent, { instance: "dev-pi", runtime: "pi", launch: false });
    const claude = spawnInstance(root, agent, { instance: "dev-claude", runtime: "claude", launch: false });
    for (const meta of [pi, claude]) {
      const names = readdirSync(join(meta.home, ".agents", "skills")).sort();
      assert.deepEqual(names, ["oas", "oas-config", "private", "review"]);
      assert.equal(lstatSync(join(meta.home, ".agents", "skills", "review")).isDirectory(), true);
      assert.equal(existsSync(join(meta.home, ".agents", "skills", "pollution")), false);
      assert.equal(lstatSync(join(meta.home, "AGENTS.md")).isSymbolicLink(), false);
      assert.equal(readlinkSync(join(meta.home, "CLAUDE.md")), "AGENTS.md");
      assert.match(readFileSync(join(meta.home, "AGENTS.md"), "utf8"), /Review capability/);
      const diskMeta = JSON.parse(readFileSync(join(meta.home, "instance.json"), "utf8"));
      assert.ok(diskMeta.capabilities.some((c) => c.id === "acme.review"));
      assert.deepEqual(diskMeta.skills.map((s) => s.name), names);
      if (meta.runtime === "pi") { assert.match(meta.command, /--skill /); assert.doesNotMatch(meta.command, /--no-skills/); }
      else assert.doesNotMatch(meta.command, /CLAUDE_CONFIG_DIR/);
    }
    assert.equal(readFileSync(join(soul, "AGENTS.md"), "utf8"), canonical);
  } finally { process.env.PATH = oldPath; }
});

test("duplicate skill names fail unless config explicitly selects a source", () => {
  const base = temp(); const { repo, root, soul, agent } = fixtureSoul(base);
  capability(repo, "dup", { capability: "acme.dup", skills: ["skills"] }, { "skills/shared/SKILL.md": "---\nname: shared\ndescription: A.\n---\n" });
  write(join(soul, "skills", "shared", "SKILL.md"), "---\nname: shared\ndescription: B.\n---\n");
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.dup:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    assert.throws(() => spawnInstance(root, agent, { instance: "dev-bad", launch: false }), /duplicate skill/);
    write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.dup:\n      global: true\nskill-overrides:\n  shared: soul\n");
    const result = spawnInstance(root, agent, { instance: "dev-good", launch: false });
    assert.match(readFileSync(join(result.home, ".agents", "skills", "shared", "SKILL.md"), "utf8"), /description: B/);
  } finally { process.env.PATH = oldPath; }
});

test("hooks run in deterministic order, with retire reversing spawn", () => {
  const base = temp(); const repo = join(base, "repo"); const home = join(base, "home"); mkdirSync(home); mkdirSync(repo);
  const script = `import {appendFileSync} from 'node:fs'; appendFileSync(process.env.OAS_HOME + '/order', process.env.OAS_EVENT + ':' + process.env.OAS_CAPABILITY + '\\n');`;
  capability(repo, "z", { capability: "acme.z", hooks: { spawn: "hook.mjs", retire: "hook.mjs" } }, { "hook.mjs": script });
  capability(repo, "a", { capability: "acme.a", hooks: { spawn: "hook.mjs", retire: "hook.mjs" } }, { "hook.mjs": script });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.z:\n      global: true\n    acme.a:\n      global: true\n");
  const resolved = resolveOasConfig(repo, "dev");
  runLifecycleHooks("spawn", { home, instance: "dev-1", agentName: "dev", soulDir: home, contextDir: repo, resolved });
  runLifecycleHooks("retire", { home, instance: "dev-1", agentName: "dev", soulDir: home, contextDir: repo, resolved });
  assert.deepEqual(readFileSync(join(home, "order"), "utf8").trim().split("\n"), ["spawn:acme.a", "spawn:acme.z", "retire:acme.z", "retire:acme.a"]);
});

test("CLI activation writes stable global/type/soul bindings without activating acquisition", () => {
  const base = temp(); const repo = join(base, "repo"); mkdirSync(repo);
  let r = spawnSync(process.execPath, [CLI, "init", "--raw", "--dir", repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync(process.execPath, [CLI, "install", "oas.okf", "--dir", repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /not activated/);
  assert.equal(resolveOasConfig(repo, "dev").capabilities.length, 0);
  for (const argv of [
    ["use", "oas.okf", "--global", "--dir", repo],
    ["use", "oas.okf", "--type", "reviewers", "--disable", "--dir", repo],
    ["use", "oas.okf", "--soul", "lead", "--dir", repo],
  ]) {
    r = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr);
  }
  const config = readFileSync(join(repo, "oas-config.yaml"), "utf8");
  // Layer capability lands under capabilities.layers.knowledge with from + injection comment.
  assert.match(config, /layers:\n    knowledge:\n      capability: oas\.okf/);
  assert.match(config, /from: bundled/);
  assert.match(config, /# injection-override: \.agents\/injections\/capabilities\/oas\.okf\.md/);
  assert.match(config, /global: true/); assert.match(config, /reviewers: false/); assert.match(config, /lead: true/);
  assert.equal(resolveOasConfig(repo, "reviewer").capabilities.some((c) => c.id === "oas.okf"), true);
});

test("manifest targeting is rejected because activation is config-owned", () => {
  const base = temp(); const repo = join(base, "repo"); mkdirSync(repo);
  capability(repo, "bad-target", { capability: "acme.bad-target", souls: ["dev"] });
  write(join(repo, "oas-config.yaml"), "name: test\n");
  assert.throws(() => capabilityManifest("acme.bad-target", repo), /cannot declare config-owned targets: souls/);
});

test("external acquisition locks exact integrity and executable trust is explicit", () => {
  const base = temp(); const repo = join(base, "repo"); mkdirSync(repo);
  const source = join(base, "external");
  write(join(source, "oas.json"), JSON.stringify({ capability: "vendor.tool", command: "vendor", version: "2.1.0", description: "External test tool.", commands: { ping: "ping.mjs" } }));
  write(join(source, "ping.mjs"), "console.log('pong')\n");
  let r = spawnSync(process.execPath, [CLI, "install", source, "--dir", repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /not activated/);
  const installed = join(repo, ".agents", "capabilities", "installed", "external");
  const lock = JSON.parse(readFileSync(join(repo, "oas-lock.json"), "utf8")).capabilities["vendor.tool"];
  assert.equal(lock.version, "2.1.0"); assert.equal(lock.integrity, capabilityIntegrity(installed)); assert.equal(lock.trustedExecutables, false);
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    vendor.tool:\n      global: true\n");
  assert.equal(resolveOasConfig(repo, "dev").capabilities[0].trust.trusted, false);
  r = spawnSync(process.execPath, [CLI, "trust", "vendor.tool", "--dir", repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(resolveOasConfig(repo, "dev").capabilities[0].trust.trusted, true);
  write(join(installed, "ping.mjs"), "console.log('tampered')\n");
  assert.throws(() => resolveOasConfig(repo, "dev"), /integrity differs/);
});

test("executable and nested skill paths cannot escape the package integrity boundary", () => {
  const base = temp(); const repo = join(base, "repo"); mkdirSync(repo);
  const dir = capability(repo, "escape", {
    capability: "acme.escape", hooks: { spawn: "../../../../outside.mjs" },
  });
  write(join(repo, "outside.mjs"), "console.log('outside lock')\n");
  writeCapabilityLock(repo, "acme.escape", {
    source: "path:escape", integrity: capabilityIntegrity(dir), trustedExecutables: true,
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.escape:\n      global: true\n");
  assert.throws(() => resolveOasConfig(repo, "dev"), /path escapes its integrity boundary/);

  const skillRepo = join(base, "skill-repo"); mkdirSync(skillRepo);
  const skillDir = capability(skillRepo, "escape-skill", { capability: "acme.escape-skill", skills: ["skills"] });
  write(join(skillDir, "skills", "escape", "SKILL.md"), "---\nname: escape\ndescription: Escape.\n---\n");
  write(join(base, "outside.md"), "unlocked instructions\n");
  symlinkSync(join(base, "outside.md"), join(skillDir, "skills", "escape", "outside.md"));
  write(join(skillRepo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.escape-skill:\n      global: true\n");
  assert.throws(() => resolveOasConfig(skillRepo, "dev"), /skill path escapes its integrity boundary/);
});

test("operational commands are gated by active instance metadata; doctor exposes final instructions", () => {
  const base = temp(); const { repo, root, soul } = fixtureSoul(base);
  capability(repo, "ops", { capability: "acme.ops", command: "ops", commands: { ping: "ping.mjs" }, inject: "inject.md" }, { "ping.mjs": "console.log('pong')\n", "inject.md": "## Ops instructions" });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.ops:\n      souls:\n        dev: true\n");
  let r = spawnSync(process.execPath, [CLI, "ops", "ping"], { cwd: repo, encoding: "utf8", env: { ...process.env, PI_AGENT_HOME: "", OAS_HOME: "" } });
  assert.equal(r.status, 1); assert.match(r.stderr, /not active/);
  const home = join(base, "instance"); mkdirSync(home); write(join(home, "instance.json"), JSON.stringify({ repo, capabilities: [{ id: "acme.ops" }] }));
  r = spawnSync(process.execPath, [CLI, "ops", "ping"], { cwd: home, encoding: "utf8", env: { ...process.env, PI_AGENT_HOME: home } });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /pong/);
  r = spawnSync(process.execPath, [CLI, "doctor", repo, "--soul", "dev", "--json"], { cwd: repo, encoding: "utf8", env: { ...process.env, PI_AGENTS_ROOT: root } });
  assert.equal(r.status, 0, r.stderr);
  const doctor = JSON.parse(r.stdout); assert.match(doctor.composedInstructions, /Canonical dev/); assert.match(doctor.composedInstructions, /Ops instructions/);
  assert.ok(doctor.instructionBlocks.some((b) => b.source === "capability:acme.ops"));
  assert.equal(readFileSync(join(soul, "AGENTS.md"), "utf8"), "# Canonical dev\n\nNever mutate me.\n");
});

test("soul-scaffold ownership prevents overwrites and deletion of canonical files", () => {
  const base = temp(); const repo = join(base, "repo"); gitRepo(repo); const root = join(base, "agents"); mkdirSync(root);
  const hook = (value) => `import {writeFileSync} from 'node:fs'; writeFileSync(process.env.OAS_SOUL + '/shared.txt', '${value}');`;
  capability(repo, "a", { capability: "acme.a", hooks: { "soul-scaffold": "hook.mjs" } }, { "hook.mjs": hook("a") });
  capability(repo, "b", { capability: "acme.b", hooks: { "soul-scaffold": "hook.mjs" } }, { "hook.mjs": hook("b") });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.a:\n      global: true\n    acme.b:\n      global: true\n");
  assert.throws(() => createAgent(root, { name: "dev", repo, work: "checkout", runtime: "pi" }), /ownership conflict/);
  const soul = join(root, "dev", "soul");
  assert.match(readFileSync(join(soul, "AGENTS.md"), "utf8"), /# dev/);
  assert.equal(readFileSync(join(soul, "shared.txt"), "utf8"), "a");

  const deleteBase = temp(); const deleteRepo = join(deleteBase, "repo"); gitRepo(deleteRepo); const deleteRoot = join(deleteBase, "agents"); mkdirSync(deleteRoot);
  capability(deleteRepo, "delete", { capability: "acme.delete", hooks: { "soul-scaffold": "hook.mjs" } }, {
    "hook.mjs": "import {rmSync} from 'node:fs'; rmSync(process.env.OAS_SOUL + '/soul.yaml'); rmSync(process.env.OAS_SOUL + '/CLAUDE.md');",
  });
  write(join(deleteRepo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.delete:\n      global: true\n");
  assert.throws(() => createAgent(deleteRoot, { name: "dev", repo: deleteRepo }), /ownership conflict.*soul.yaml/);
  const restored = join(deleteRoot, "dev", "soul");
  assert.equal(existsSync(join(restored, "soul.yaml")), true);
  assert.equal(readlinkSync(join(restored, "CLAUDE.md")), "AGENTS.md");
});

test("bare install restores locked-but-missing capabilities with integrity verification", () => {
  const base = temp(); const repo = join(base, "repo"); gitRepo(repo);
  write(join(repo, "oas-config.yaml"), "name: restore-test\n");
  const source = join(base, "external");
  write(join(source, "oas.json"), JSON.stringify({ capability: "vendor.restorable", version: "1.0.0", description: "Restorable." }));
  write(join(source, "body.md"), "content\n");
  let r = spawnSync(process.execPath, [CLI, "install", source, "--dir", repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const artifact = join(repo, ".agents", "capabilities", "installed", "external");
  // Install maintains the store gitignore so acquired artifacts stay uncommitted.
  assert.match(readFileSync(join(repo, ".agents", "capabilities", ".gitignore"), "utf8"), /^installed\/$/m);
  // Delete the artifact; bare install must restore it to the locked integrity.
  rmSync(artifact, { recursive: true });
  r = spawnSync(process.execPath, [CLI, "install", "--dir", repo], { cwd: repo, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /restored\s+vendor\.restorable/);
  const lock = JSON.parse(readFileSync(join(repo, "oas-lock.json"), "utf8")).capabilities["vendor.restorable"];
  assert.equal(capabilityIntegrity(artifact), lock.integrity);
  // Drifted source aborts restore and leaves no artifact behind.
  rmSync(artifact, { recursive: true });
  write(join(source, "body.md"), "tampered\n");
  r = spawnSync(process.execPath, [CLI, "install", "--dir", repo], { cwd: repo, encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stdout, /FAILED\s+vendor\.restorable/);
  assert.equal(existsSync(artifact), false);
});

test("capabilities outside installed/ and owned/ are rejected with a move error", () => {
  const base = temp(); const repo = join(base, "repo"); mkdirSync(repo);
  write(join(repo, ".agents", "capabilities", "stray", "oas.json"), JSON.stringify({ capability: "acme.stray", version: "1.0.0", description: "Stray." }));
  write(join(repo, "oas-config.yaml"), "name: test\n");
  assert.throws(() => capabilityManifest("acme.stray", repo), /must live under installed\/ \(acquired\) or owned\/ \(authored at this scope\)/);
});

test("config can override an installed capability's injection per scope", () => {
  const base = temp(); const repo = join(base, "repo"); mkdirSync(repo);
  capability(repo, "chat", { capability: "acme.chat", inject: "inject.md" }, { "inject.md": "## Packaged instructions" });
  write(join(repo, "custom.md"), "## Custom instructions");
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chat:\n      global: true\n      injection-override: custom.md\n");
  const cap = resolveOasConfig(repo, "dev").capabilities.find((c) => c.id === "acme.chat");
  assert.equal(cap.inject, join(repo, "custom.md"));
  // `none` suppresses; `default` restores the packaged inject.
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chat:\n      global: true\n      injection-override: none\n");
  assert.equal(resolveOasConfig(repo, "dev").capabilities.find((c) => c.id === "acme.chat").inject, undefined);
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chat:\n      global: true\n      injection-override: default\n");
  assert.match(resolveOasConfig(repo, "dev").capabilities.find((c) => c.id === "acme.chat").inject, /inject\.md$/);
});

test("injection-override is rejected on owned/path capabilities; old injection key is rejected", () => {
  const base = temp(); const repo = join(base, "repo"); gitRepo(repo);
  capability(repo, "own", { capability: "acme.own", inject: "inject.md" }, { "inject.md": "## Own" });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.own:\n      from: owned\n      global: true\n      injection-override: custom.md\n");
  assert.throws(() => resolveOasConfig(repo, "dev"), /not allowed for from: owned.*edit its injects\/ file directly/);
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.own:\n      global: true\n      injection: custom.md\n");
  assert.throws(() => resolveOasConfig(repo, "dev"), /renamed to "injection-override:"/);
});

test("oas type add declares agent types; inject eject copies a packaged default and sets the override", () => {
  const base = temp(); const repo = join(base, "repo"); gitRepo(repo);
  // Installed-provenance capability (eject allowed) and an owned one (refused).
  const inst = join(repo, ".agents", "capabilities", "installed", "chat");
  write(join(inst, "oas.json"), JSON.stringify({ capability: "acme.chat", version: "1.0.0", compatibility: { oas: ">=0.6.2" }, description: "Chat.", inject: "inject.md" }));
  write(join(inst, "inject.md"), "## Packaged instructions");
  writeCapabilityLock(repo, "acme.chat", { source: "test", version: "1.0.0", integrity: capabilityIntegrity(inst) });
  capability(repo, "own", { capability: "acme.own", inject: "inject.md" }, { "inject.md": "## Own" });
  write(join(repo, "oas-config.yaml"), "name: test\ncapabilities:\n  additive:\n    acme.chat:\n      global: true\n    acme.own:\n      global: true\n");
  let r = spawnSync(process.execPath, [CLI, "type", "add", "reviewers", "--description", "Review agents", "--dir", repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const cfg = readFileSync(join(repo, "oas-config.yaml"), "utf8");
  assert.match(cfg, /agent-types:\n  reviewers:\n    description: Review agents/);
  r = spawnSync(process.execPath, [CLI, "type", "list", "--dir", repo], { encoding: "utf8" });
  assert.match(r.stdout, /reviewers/);
  // Eject the capability injection.
  r = spawnSync(process.execPath, [CLI, "inject", "eject", "acme.chat", "--dir", repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const ejected = join(repo, ".agents", "injections", "capabilities", "acme.chat.md");
  assert.equal(readFileSync(ejected, "utf8"), "## Packaged instructions");
  const cap = resolveOasConfig(repo, "dev").capabilities.find((c) => c.id === "acme.chat");
  assert.equal(cap.inject, ejected);
  // Second eject refuses; owned capability refuses.
  r = spawnSync(process.execPath, [CLI, "inject", "eject", "acme.chat", "--dir", repo], { encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stderr, /already exists/);
  r = spawnSync(process.execPath, [CLI, "inject", "eject", "acme.own", "--dir", repo], { encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stderr, /owned\/path-sourced/);
});

test("init --template snapshots a local or named template with provenance and rewrites name", () => {
  const base = temp();
  const tpl = join(base, "template.yaml");
  writeFileSync(tpl, "name: template-origin\ncapabilities:\n  oas.okf:\n    source: bundled\n    global: true\nlayers:\n  tasks: none\n");
  const repo = join(base, "proj"); mkdirSync(repo);
  let r = spawnSync(process.execPath, [CLI, "init", "--template", tpl, "--dir", repo, "--no-tmux-mouse"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const cfg = readFileSync(join(repo, "oas-config.yaml"), "utf8");
  assert.match(cfg, /^# template: .*template\.yaml \(snapshot/m);
  assert.match(cfg, /^name: proj$/m);
  assert.match(cfg, /oas\.okf/);
  // Named template resolved through an outer config's templates: map (workspace level).
  const ws = join(base, "ws"); const inner = join(ws, "repo2"); mkdirSync(inner, { recursive: true });
  writeFileSync(join(ws, "oas-config.yaml"), `name: ws\ntemplates:\n  personal: ${tpl}\n`);
  r = spawnSync(process.execPath, [CLI, "init", "--template", "personal", "--dir", inner, "--no-tmux-mouse"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const cfg2 = readFileSync(join(inner, "oas-config.yaml"), "utf8");
  assert.match(cfg2, /^name: repo2$/m);
  assert.doesNotMatch(cfg2, /templates:/);
  // Unknown named template errors clearly.
  const lone = join(base, "lone"); mkdirSync(lone);
  r = spawnSync(process.execPath, [CLI, "init", "--template", "nope", "--dir", lone, "--no-tmux-mouse"], { encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stderr, /unknown template "nope"/);
});

test("owned capabilities at a non-git scope are discovered and config-owned trusted", () => {
  const base = temp(); const ws = join(base, "workspace"); mkdirSync(ws); // no git init
  capability(ws, "lfx", { capability: "acme.lfx", inject: "inject.md" }, { "inject.md": "## LFX" });
  write(join(ws, "oas-config.yaml"), "name: ws\ncapabilities:\n  additive:\n    acme.lfx:\n      global: true\n");
  const cap = resolveOasConfig(ws, "dev").capabilities.find((c) => c.id === "acme.lfx");
  assert.equal(cap.trust.trusted, true); assert.equal(cap.trust.configOwned, true);
  // No git repo: install's gitignore maintenance must not have created one here.
  assert.equal(existsSync(join(ws, ".agents", "capabilities", ".gitignore")), false);
});
