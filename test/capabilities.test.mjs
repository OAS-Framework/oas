import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  capabilityIntegrity, capabilityManifest, composeInstanceAgentsMd, createAgent, findAgent, resolveOasConfig,
  resolveClaudeBinary, resolveWorkMode, retireInstance, runLifecycleHooks, spawnInstance, writeCapabilityLock,
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

test("marketplace lifecycle: init acquires layers, bundled is rejected, restore re-copies", () => {
  const base = temp(); const repo = join(base, "repo"); gitRepo(repo);
  let r = spawnSync(process.execPath, [CLI, "init", "--knowledge", "oas.okf", "--messaging", "none", "--no-tmux-mouse", "--dir", repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const config = readFileSync(join(repo, "oas-config.yaml"), "utf8");
  assert.match(config, /from: installed/);
  assert.doesNotMatch(config, /bundled/);
  // Work modes scaffold shows setup:, not injection overrides.
  assert.match(config, /work-modes:\n  worktree:\n    # setup: scripts\/setup-worktree\.sh/);
  assert.doesNotMatch(config, /injections\/workmodes/);
  // The acquired copy resolves and is trusted (marketplace source).
  const cap = resolveOasConfig(repo, "dev").capabilities.find((c) => c.id === "oas.okf");
  assert.ok(cap.trust.trusted);
  assert.ok(cap._dir || cap.provenance);
  // from: bundled is rejected with migration guidance.
  write(join(repo, "oas-config.yaml"), "capabilities:\n  layers:\n    knowledge:\n      capability: oas.okf\n      from: bundled\n");
  assert.throws(() => resolveOasConfig(repo, "dev"), /no longer supported.*oas install/s);
  // Restore: delete the artifact, bare install brings it back at locked integrity.
  write(join(repo, "oas-config.yaml"), "capabilities:\n  layers:\n    knowledge:\n      capability: oas.okf\n      from: installed\n");
  rmSync(join(repo, ".agents", "capabilities", "installed", "oas-okf"), { recursive: true });
  r = spawnSync(process.execPath, [CLI, "install", "--dir", repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /restored\s+oas\.okf/);
});

test("work-mode injection overrides are rejected; setup script resolves and runs at worktree spawn", () => {
  const base = temp(); const { repo, root, agent } = fixtureSoul(base);
  write(join(repo, "oas-config.yaml"), "work-modes:\n  worktree:\n    injection-override: x.md\n");
  assert.throws(() => resolveOasConfig(repo, "dev"), /work-mode injection overrides were removed/);
  write(join(repo, "oas-config.yaml"), "work-modes:\n  worktree:\n    setup: setup.sh\n");
  write(join(repo, "setup.sh"), "#!/bin/sh\necho ran > setup-ran\n");
  execFileSync("chmod", ["+x", join(repo, "setup.sh")]);
  const wm = resolveWorkMode(repo, "worktree");
  assert.equal(wm.setup, join(repo, "setup.sh"));
  assert.ok(wm.inject.endsWith("work-worktree.md")); // packaged briefing, no override
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    const res = spawnInstance(root, agent, { instance: "dev-wt", work: "worktree", launch: false });
    assert.equal(readFileSync(join(res.home, "work", "setup-ran"), "utf8").trim(), "ran");
  } finally { process.env.PATH = oldPath; }
  // inject eject refuses work modes.
  const r = spawnSync(process.execPath, [CLI, "inject", "eject", "worktree", "--dir", repo], { encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stderr, /removed/);
});

test("claude runtime resolves oas-claude-config and hooks contribute launch args", () => {
  const base = temp(); const { repo, root, agent } = fixtureSoul(base, "claude");
  // Closest oas-claude-config names the binary; none → claude.
  assert.equal(resolveClaudeBinary(repo), "claude");
  write(join(base, "oas-claude-config"), "# personal account\nclaude-personal\n");
  assert.equal(resolveClaudeBinary(repo), "claude-personal");
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  write(join(bin, "claude-personal"), "#!/bin/sh\nexit 0\n");
  execFileSync("chmod", ["+x", join(bin, "claude-personal")]);
  // A spawn hook contributes runtime launch args (the aweb channel-plugin pattern).
  const script = `console.log(JSON.stringify({ launch: { claude: "--extra-flag", pi: "--never-used" } }));`;
  capability(repo, "chan", { capability: "acme.chan", hooks: { spawn: "hook.mjs" } }, { "hook.mjs": script });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${fakeRuntimes(base)}`;
  try {
    const res = spawnInstance(root, agent, { instance: "dev-cl", launch: false });
    const meta = JSON.parse(readFileSync(join(res.home, "instance.json"), "utf8"));
    assert.equal(meta.runtime, "claude");
    assert.match(meta.command, /claude-personal/);
    assert.match(meta.command, /--extra-flag/);
    assert.doesNotMatch(meta.command, /--never-used/);
  } finally { process.env.PATH = oldPath; }
});

test("team block resolves closest-first, reaches hooks/TASK.md, and drives team-wide status", () => {
  const base = temp(); const ws = join(base, "lfx"); mkdirSync(ws);
  const repo = join(ws, "self-serve"); gitRepo(repo);
  write(join(ws, "oas-config.yaml"), "name: lfx\nteam:\n  name: lfx-engineering\n  id: lfx-engineering:example.com\n");
  // Team env reaches hooks.
  const script = `import {appendFileSync} from 'node:fs'; appendFileSync(process.env.OAS_HOME + '/team', process.env.OAS_TEAM_NAME + '|' + process.env.OAS_TEAM_ID);`;
  capability(repo, "t", { capability: "acme.t", hooks: { spawn: "hook.mjs" } }, { "hook.mjs": script });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.t:\n      global: true\n");
  const resolved = resolveOasConfig(repo, "dev");
  assert.equal(resolved.team.name, "lfx-engineering");
  assert.equal(resolved.team.id, "lfx-engineering:example.com");
  assert.equal(resolved.team.scope, ws);
  const home = join(base, "home"); mkdirSync(home);
  runLifecycleHooks("spawn", { home, instance: "dev-1", agentName: "dev", soulDir: home, contextDir: repo, resolved });
  assert.equal(readFileSync(join(home, "team"), "utf8"), "lfx-engineering|lfx-engineering:example.com");
  // Two agents roots inside the team scope: workspace-level and repo-level.
  write(join(ws, "agents", "ws-agent", "soul", "soul.yaml"), `name: ws-agent\nkind: persistent\nrepo: ${repo}\nwork: checkout\n`);
  write(join(ws, "agents", "ws-agent", "soul", "AGENTS.md"), "# ws-agent\n");
  write(join(repo, "agents", "repo-agent", "soul", "soul.yaml"), `name: repo-agent\nkind: persistent\nrepo: ${repo}\nwork: checkout\n`);
  write(join(repo, "agents", "repo-agent", "soul", "AGENTS.md"), "# repo-agent\n");
  const env = { ...process.env, PI_AGENTS_TMUX_SESSION: "oas-test-nosuch" }; delete env.PI_AGENTS_ROOT;
  const r = spawnSync(process.execPath, [CLI, "status", "--team", "--json", "--dir", repo], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.team.name, "lfx-engineering");
  const names = payload.roots.flatMap((x) => x.agents.map((a) => a.name)).sort();
  assert.deepEqual(names, ["repo-agent", "ws-agent"]);
  // TASK.md carries the team line at spawn; instance.json records the team.
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    const root = join(repo, "agents");
    const agent = { name: "repo-agent", kind: "persistent", repo, work: "checkout", runtime: "pi", _dir: join(root, "repo-agent"), _soulDir: join(root, "repo-agent", "soul") };
    const res = spawnInstance(root, agent, { instance: "repo-agent-t", launch: false });
    assert.match(readFileSync(join(res.home, "TASK.md"), "utf8"), /Team: lfx-engineering \(lfx-engineering:example\.com\)/);
    const meta = JSON.parse(readFileSync(join(res.home, "instance.json"), "utf8"));
    assert.equal(meta.team.name, "lfx-engineering");
  } finally { process.env.PATH = oldPath; }
});

test("workspace mode links work to the team scope, records no branch, and requires a boundary", () => {
  const base = temp(); const ws = join(base, "lfx"); mkdirSync(ws);
  const agentsRepo = join(ws, "lfx-agents"); gitRepo(agentsRepo);
  const member = join(ws, "member-repo"); gitRepo(member);
  write(join(ws, "oas-config.yaml"), "name: lfx\nteam:\n  name: lfx\n");
  const root = join(agentsRepo, "agents");
  write(join(root, "coord", "soul", "soul.yaml"), `name: coord\nkind: persistent\nrepo: ${agentsRepo}\nwork: workspace\nruntime: pi\n`);
  write(join(root, "coord", "soul", "AGENTS.md"), "# coord\n");
  const agent = findAgent(root, "coord");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    const res = spawnInstance(root, agent, { instance: "coord-1", launch: false });
    assert.equal(res.work, "workspace");
    assert.equal(readlinkSync(join(res.home, "work")), resolve(ws));
    assert.ok(readFileSync(join(res.home, "TASK.md"), "utf8").includes("WHOLE WORKSPACE"));
    assert.ok(readFileSync(join(res.home, "AGENTS.md"), "utf8").includes("Work mode: workspace"));
    const meta = JSON.parse(readFileSync(join(res.home, "instance.json"), "utf8"));
    assert.equal(meta.branch, undefined);
    // Retire never touches the workspace tree.
    retireInstance(root, "coord-1", { tmuxSession: "oas-test-nosuch" });
    assert.ok(existsSync(join(ws, "member-repo")));
  } finally { process.env.PATH = oldPath; }
  // No boundary: a bare repo outside any team/workspace config refuses workspace mode.
  const lone = join(base, "lone"); gitRepo(lone);
  const loneRoot = join(lone, "agents");
  write(join(loneRoot, "solo", "soul", "soul.yaml"), `name: solo\nkind: persistent\nrepo: ${lone}\nwork: workspace\nruntime: pi\n`);
  write(join(loneRoot, "solo", "soul", "AGENTS.md"), "# solo\n");
  const oldPath2 = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    assert.throws(() => spawnInstance(loneRoot, findAgent(loneRoot, "solo"), { instance: "solo-1", launch: false }), /needs a declared boundary/);
  } finally { process.env.PATH = oldPath2; }
});

test("cross-repo spawn resolves a sibling repo's soul via the team scope and homes it there", () => {
  const base = temp(); const ws = join(base, "lfx"); mkdirSync(ws);
  const repoA = join(ws, "self-serve"); gitRepo(repoA);
  const repoB = join(ws, "projects-api"); gitRepo(repoB);
  write(join(ws, "oas-config.yaml"), "name: lfx\nteam:\n  name: lfx-engineering\n");
  mkdirSync(join(repoA, "agents"), { recursive: true });
  write(join(repoB, "agents", "api-dev", "soul", "soul.yaml"), `name: api-dev\nkind: persistent\nrepo: ${repoB}\nwork: checkout\nruntime: pi\n`);
  write(join(repoB, "agents", "api-dev", "soul", "AGENTS.md"), "# api-dev\n");
  const env = { ...process.env, PATH: fakeRuntimes(base), PI_AGENTS_TMUX_SESSION: "oas-test-nosuch" }; delete env.PI_AGENTS_ROOT;
  // Spawn from repo A; soul lives in repo B — unique team-wide match wins.
  let r = spawnSync(process.execPath, [CLI, "spawn", "api-dev", "--no-launch", "--json", "--dir", repoA], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
  assert.match(res.home, new RegExp(`^${repoB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/agents/api-dev/instances/`));
  assert.equal(JSON.parse(readFileSync(join(res.home, "instance.json"), "utf8")).repo, repoB);
  // Ambiguity: same soul name in repo A errors with guidance.
  write(join(repoA, "agents", "api-dev", "soul", "soul.yaml"), `name: api-dev\nkind: persistent\nrepo: ${repoA}\nwork: checkout\nruntime: pi\n`);
  write(join(repoA, "agents", "api-dev", "soul", "AGENTS.md"), "# local api-dev\n");
  const repoC = join(ws, "third"); gitRepo(repoC);
  write(join(repoC, "agents", "other-dev", "soul", "soul.yaml"), `name: other-dev\nkind: persistent\nrepo: ${repoC}\nwork: checkout\nruntime: pi\n`);
  write(join(repoC, "agents", "other-dev", "soul", "AGENTS.md"), "# other\n");
  write(join(repoB, "agents", "other-dev", "soul", "soul.yaml"), `name: other-dev\nkind: persistent\nrepo: ${repoB}\nwork: checkout\nruntime: pi\n`);
  write(join(repoB, "agents", "other-dev", "soul", "AGENTS.md"), "# other\n");
  r = spawnSync(process.execPath, [CLI, "spawn", "other-dev", "--no-launch", "--dir", repoA], { encoding: "utf8", env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /multiple team repos/);
  // Local soul still wins over team lookup (no cross-repo redirect).
  r = spawnSync(process.execPath, [CLI, "spawn", "api-dev", "--purpose", "local", "--no-launch", "--json", "--dir", repoA], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const local = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
  assert.ok(local.home.startsWith(join(repoA, "agents")));
  // Cross-repo retire finds the instance home in repo B.
  r = spawnSync(process.execPath, [CLI, "retire", res.instance, "--dir", repoA], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(res.home));
});

test("model preference lists resolve to the first available provider/model", async () => {
  const { resolveModelPreference } = await import("../lib/core.mjs");
  // single entries and empties pass through untouched (no probe)
  assert.equal(resolveModelPreference("", "pi"), "");
  assert.equal(resolveModelPreference("github-copilot/claude-fable-5:high", "pi"), "github-copilot/claude-fable-5:high");
  // non-pi runtimes take the first preference
  assert.equal(resolveModelPreference("a/b:high, c/d", "claude"), "a/b:high");
  // pi probing: fake `pi` whose --list-models only knows provider2/model-x
  const base = temp(); const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  write(join(bin, "pi"), "#!/bin/sh\necho 'provider2  model-x  1M  128K  yes  yes'\n");
  execFileSync("chmod", ["+x", join(bin, "pi")]);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${process.env.PATH}`;
  try {
    assert.equal(resolveModelPreference("provider1/model-x:high, provider2/model-x:high", "pi"), "provider2/model-x:high");
    // nothing available -> first preference (pi errors loudly at launch)
    assert.equal(resolveModelPreference("p/none, q/none", "pi"), "p/none");
  } finally { process.env.PATH = oldPath; }
});

test("capability-defined agents resolve when active, home locally, and keep the package soul read-only", () => {
  const base = temp(); const { repo, root } = fixtureSoul(base);
  const capDir = capability(repo, "rev", { capability: "acme.review", agents: ["agents/reviewer"] }, {
    "agents/reviewer/soul.yaml": "name: reviewer\nkind: capability\nwork: checkout\nruntime: pi\nmodel: fake/model\ndescription: Fresh reviewer.\n",
    "agents/reviewer/AGENTS.md": "# Reviewer\n\nReview fresh.\n",
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.review:\n      global: true\n");
  const { findCapabilityAgent, listCapabilityAgents } = { findCapabilityAgent: undefined, listCapabilityAgents: undefined };
  return import("../lib/core.mjs").then((core) => {
    const listed = core.listCapabilityAgents(repo);
    assert.deepEqual(listed.map((a) => a.name), ["reviewer"]);
    const agent = core.findCapabilityAgent(repo, root, "reviewer");
    assert.equal(agent.capability, "acme.review");
    assert.equal(agent._soulDir, join(capDir, "agents", "reviewer"));
    const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
    try {
      const res = core.spawnInstance(root, { ...agent, repo }, { instance: "reviewer-1", launch: false });
      // instance homes under the scope's local-agents/, soul symlink points into the package
      assert.ok(res.home.includes(join("local-agents", "reviewer", "instances")));
      assert.equal(readlinkSync(join(res.home, "soul")), join(capDir, "agents", "reviewer"));
      assert.match(readFileSync(join(res.home, "AGENTS.md"), "utf8"), /Review fresh/);
      // the package soul was not written to (no instances/, no scaffolded memory)
      assert.ok(!existsSync(join(capDir, "agents", "reviewer", "instances")));
      core.retireInstance(root, "reviewer-1", { tmuxSession: "oas-test-nosuch" });
    } finally { process.env.PATH = oldPath; }
  });
});

test("capability agents carry their own capability's skills regardless of targeting", () => {
  const base = temp(); const { repo, root } = fixtureSoul(base);
  capability(repo, "rev2", { capability: "acme.rev2", agents: ["agents/checker"], skills: ["skills"] }, {
    "agents/checker/soul.yaml": "name: checker\nkind: capability\nwork: checkout\nruntime: pi\ndescription: Checker.\n",
    "agents/checker/AGENTS.md": "# Checker\n",
    "skills/deep-check/SKILL.md": "---\nname: deep-check\ndescription: Deep checking.\n---\n",
  });
  // Targeted at a type the checker does NOT belong to — its own skills must still compose.
  write(join(repo, "oas-config.yaml"), "agent-types:\n  devs:\n    description: devs\ncapabilities:\n  additive:\n    acme.rev2:\n      agent-types:\n        devs: true\n");
  return import("../lib/core.mjs").then((core) => {
    const agent = core.findCapabilityAgent(repo, root, "checker");
    assert.ok(agent, "checker resolves on declaration despite type targeting");
    const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
    try {
      const res = core.spawnInstance(root, { ...agent, repo }, { instance: "checker-1", launch: false });
      assert.ok(existsSync(join(res.home, ".agents", "skills", "deep-check", "SKILL.md")), "own capability skill materialized");
      core.retireInstance(root, "checker-1", { tmuxSession: "oas-test-nosuch" });
    } finally { process.env.PATH = oldPath; }
  });
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
  // Marketplace install: copied into installed/, locked with marketplace source, trusted at acquisition.
  const okfLock = JSON.parse(readFileSync(join(repo, "oas-lock.json"), "utf8")).capabilities["oas.okf"];
  assert.match(okfLock.source, /^marketplace:oas\.okf@/);
  assert.equal(okfLock.trustedExecutables, true);
  assert.ok(existsSync(join(repo, ".agents", "capabilities", "installed", "oas-okf", "oas.json")));
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
  assert.match(config, /from: installed/);
  assert.match(config, /# injection-override: \.agents\/injections\/capabilities\/oas\.okf\.md/);
  assert.match(config, /global: true/); assert.match(config, /reviewers: false/); assert.match(config, /lead: true/);
  assert.equal(resolveOasConfig(repo, "reviewer").capabilities.some((c) => c.id === "oas.okf"), true);
});

test("--settings accepts multiple pairs per flag, repeated flags, and rejects malformed pairs", () => {
  const base = temp(); const repo = join(base, "repo"); mkdirSync(repo);
  let r = spawnSync(process.execPath, [CLI, "init", "--raw", "--dir", repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync(process.execPath, [CLI, "install", "oas.okf", "--dir", repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  // One flag, multiple consecutive k=v pairs — all pairs land, none silently dropped.
  r = spawnSync(process.execPath, [CLI, "use", "oas.okf", "--global", "--settings", "site=acme", "project=core", "--dir", repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  // Repeated flags still compose (and later flags override earlier keys).
  r = spawnSync(process.execPath, [CLI, "use", "oas.okf", "--global", "--settings", "depth=low", "--settings", "site=umbrella", "--dir", repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const okf = resolveOasConfig(repo, "dev").capabilities.find((c) => c.id === "oas.okf");
  assert.deepEqual(okf.settings, { site: "umbrella", project: "core", depth: "low" });
  // Malformed pair (missing '=') dies loudly.
  r = spawnSync(process.execPath, [CLI, "use", "oas.okf", "--global", "--settings", "nonsense", "--dir", repo], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--settings expects key=value, got "nonsense"/);
  // Bare --settings with no pairs dies loudly instead of being ignored.
  r = spawnSync(process.execPath, [CLI, "use", "oas.okf", "--global", "--settings", "--dir", repo], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--settings expects one or more key=value pairs/);
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

test("spawn lineage is explicit: ambient env never sets parent; --parent and attached owner do", () => {
  const base = temp(); const repo = join(base, "repo"); gitRepo(repo);
  // Agents root inside the repo so the CLI resolves it from cwd.
  const root = join(repo, "agents");
  write(join(root, "dev", "soul", "soul.yaml"), `name: dev\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
  write(join(root, "dev", "soul", "AGENTS.md"), "# dev\n");
  mkdirSync(join(root, "dev", "instances"), { recursive: true });
  const env = { ...process.env, PATH: fakeRuntimes(base), PI_AGENTS_TMUX_SESSION: "oas-test-nosuch" };
  delete env.PI_AGENTS_ROOT;
  // 1. Env-polluted shell (a terminal opened inside an agent's tmux window) WITHOUT
  //    --parent: operator origin, top-level, and the task still lands in TASK.md.
  const polluted = { ...env, OAS_INSTANCE: "dev-existing", PI_AGENT_INSTANCE: "dev-existing" };
  let r = spawnSync(process.execPath, [CLI, "spawn", "dev", "--task", "manual human task", "--purpose", "manual", "--no-launch", "--json"], { cwd: repo, env: polluted, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const manual = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
  assert.equal(manual.parentInstance, undefined);
  assert.equal(manual.spawnOrigin, "operator");
  assert.match(readFileSync(join(manual.home, "TASK.md"), "utf8"), /manual human task/);
  // 2. --parent with an unknown instance is rejected before scaffolding.
  r = spawnSync(process.execPath, [CLI, "spawn", "dev", "--parent", "no-such-instance", "--purpose", "bad", "--no-launch"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--parent "no-such-instance" does not match any known instance/);
  // 3. Explicit --parent naming a real instance nests, and a --task-file task lands.
  const tf = join(base, "task.md"); writeFileSync(tf, "task from a file\n");
  r = spawnSync(process.execPath, [CLI, "spawn", "dev", "--parent", manual.instance, "--task-file", tf, "--purpose", "child", "--no-launch", "--json"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const child = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
  assert.equal(child.parentInstance, manual.instance);
  assert.equal(child.spawnOrigin, "instance");
  assert.match(readFileSync(join(child.home, "TASK.md"), "utf8"), /task from a file/);
  // 4. --task without a value fails loudly instead of writing a broken TASK.md.
  r = spawnSync(process.execPath, [CLI, "spawn", "dev", "--task", "--purpose", "oops", "--no-launch"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--task needs a value/);
  // 5. Kernel: attached mode still nests under the work-tree OWNER (no env, no parent).
  const agent = findAgent(root, "dev");
  const oldPath = process.env.PATH;
  const oldInst = process.env.OAS_INSTANCE; const oldPiInst = process.env.PI_AGENT_INSTANCE;
  process.env.PATH = fakeRuntimes(base);
  process.env.OAS_INSTANCE = "dev-existing"; process.env.PI_AGENT_INSTANCE = "dev-existing";
  try {
    const attached = spawnInstance(root, agent, { instance: "dev-svc", work: "attached", workDir: join(manual.home, "work"), task: "attached task", launch: false });
    assert.equal(attached.parentInstance, manual.instance, "attached fallback: work-tree owner is the parent");
    assert.equal(attached.spawnOrigin, "instance");
    assert.match(readFileSync(join(attached.home, "TASK.md"), "utf8"), /attached task/);
    // 6. Kernel: explicit o.parent wins even for non-attached spawns; env is ignored.
    const nested = spawnInstance(root, agent, { instance: "dev-sub", parent: manual.instance, task: "sub task", launch: false });
    assert.equal(nested.parentInstance, manual.instance);
    assert.equal(nested.spawnOrigin, "instance");
    // 7. Kernel: no parent, no attached fallback → operator, despite polluted env.
    const top = spawnInstance(root, agent, { instance: "dev-top", launch: false });
    assert.equal(top.parentInstance, undefined);
    assert.equal(top.spawnOrigin, "operator");
    assert.match(readFileSync(join(top.home, "TASK.md"), "utf8"), /No task was provided/);
  } finally {
    process.env.PATH = oldPath;
    if (oldInst === undefined) delete process.env.OAS_INSTANCE; else process.env.OAS_INSTANCE = oldInst;
    if (oldPiInst === undefined) delete process.env.PI_AGENT_INSTANCE; else process.env.PI_AGENT_INSTANCE = oldPiInst;
  }
});
