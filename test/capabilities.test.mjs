import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  capabilityIntegrity, capabilityManifest, composeInstanceAgentsMd, createAgent, findAgent, findInstanceHomes, resolveOasConfig,
  resolveClaudeBinary, resolveWorkMode, retireInstance, runLifecycleHooks, spawnInstance, writeCapabilityLock,
} from "../lib/core.mjs";

const CLI = resolve(new URL("../bin/oas.mjs", import.meta.url).pathname);
/** Parse a `--json` CLI success envelope (Desktop CLI API v1): stdout must be
 *  exactly one JSON object {schemaVersion:1,ok:true,result} — no progress prose. */
function jsonResult(r) {
  const env = JSON.parse(r.stdout); // throws on any stdout contamination
  assert.equal(env.schemaVersion, 1);
  assert.equal(env.ok, true, JSON.stringify(env.error));
  return env.result;
}
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
      assert.deepEqual(names, ["oas", "oas-config", "oas-packages", "private", "review"]);
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
    // "--" must terminate option parsing BEFORE the prompt: hook-contributed
    // flags can be greedy/variadic (aweb's --dangerously-load-development-
    // channels), and without the separator the TASK.md prompt is consumed
    // as the flag's next value — claude exits with a parse error and the
    // spawn looks silently stuck (operator report, dev-coordinator-claude-
    // sessions).
    assert.match(meta.command, /--extra-flag -- "\$\(cat TASK\.md\)"/, "prompt is separated from hook launch args by --");
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
  const res = jsonResult(r);
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
  const local = jsonResult(r);
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
  // claude: pi-style patterns TRANSLATE or DROP — claude takes aliases/bare
  // ids only (operator report: a pi-pattern soul default runtime-overridden
  // to claude made claude reject the model at launch)
  assert.equal(resolveModelPreference("anthropic/claude-opus-4-5:high", "claude"), "claude-opus-4-5", "anthropic pattern → bare id, thinking stripped");
  assert.equal(resolveModelPreference("opus", "claude"), "opus", "alias passes through");
  assert.equal(resolveModelPreference("claude-fable-5", "claude"), "claude-fable-5", "bare id passes through");
  assert.equal(resolveModelPreference("github-copilot/claude-fable-5:high", "claude"), "", "non-anthropic provider entry drops to claude default");
  assert.equal(resolveModelPreference("github-copilot/x, anthropic/claude-sonnet-4-5, opus", "claude"), "claude-sonnet-4-5", "first usable list entry wins");
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
    source: "path:escape", version: "1.0.0", integrity: capabilityIntegrity(dir), trustedExecutables: true,
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

test("retired oas.web: config, install, and lock paths all give actionable migration diagnostics", () => {
  const base = temp(); const repo = join(base, "repo"); mkdirSync(repo);
  // config activation of the retired capability names the migration, not "no manifest"
  write(join(repo, "oas-config.yaml"), `capabilities:\n  additive:\n    oas.web:\n      global: true\n`);
  assert.throws(() => resolveOasConfig(repo), /oas\.web web panel was retired[\s\S]*OAS Desktop app[\s\S]*Remove the oas\.web entry/,
    "config activation explains the retirement and the fix");
  // doctor must diagnose the stale activation cleanly (text and JSON), not crash
  const docText = spawnSync(process.execPath, [CLI, "doctor", repo], { encoding: "utf8" });
  assert.notEqual(docText.status, 0);
  assert.match(docText.stderr, /retired.*OAS Desktop app.*Remove the oas\.web entry/s, "doctor (text) emits the cleanup instruction");
  assert.doesNotMatch(docText.stderr, /at resolveCapabilities|at file:/, "doctor (text) does not dump a stack trace");
  const docJson = spawnSync(process.execPath, [CLI, "doctor", repo, "--json"], { encoding: "utf8" });
  assert.notEqual(docJson.status, 0);
  const dj = JSON.parse(docJson.stdout);
  assert.equal(dj.schemaVersion, 1, "the retired-capability error document carries the doctor v1 schema version");
  assert.deepEqual(dj.retired, ["oas.web"], "doctor --json reports the retired id");
  assert.match(dj.error, /Remove the oas\.web entry/, "doctor --json carries the cleanup instruction");
  // explicit install of the retired id explains instead of "not a marketplace capability"
  const inst = spawnSync(process.execPath, [CLI, "install", "oas.web", "--dir", repo], { encoding: "utf8" });
  assert.notEqual(inst.status, 0);
  assert.match(inst.stderr + inst.stdout, /retired.*OAS Desktop app/s, "explicit install names the successor");
  assert.doesNotMatch(inst.stderr + inst.stdout, /not a marketplace capability/, "no unexplained missing-capability failure");
  // bare install with a stale lock entry reports RETIRED (actionable), and doctor warns
  const repo2 = join(base, "repo2"); mkdirSync(repo2);
  write(join(repo2, "oas-config.yaml"), "capabilities:\n  additive: {}\n");
  write(join(repo2, "oas-lock.json"), JSON.stringify({ capabilities: { "oas.web": { version: "0.9.6", integrity: "sha256-x", source: "marketplace:oas-web@0.9.6" } } }));
  const restore = spawnSync(process.execPath, [CLI, "install", "--dir", repo2], { encoding: "utf8" });
  assert.match(restore.stdout, /RETIRED\s+oas\.web.*Remove the oas\.web entry/s, "lock restore reports the retirement with the fix");
  assert.doesNotMatch(restore.stdout + restore.stderr, /FAILED\s+oas\.web/, "retired lock entry is not an opaque failure");
  const doctor = spawnSync(process.execPath, [CLI, "doctor", repo2], { encoding: "utf8" });
  assert.match(doctor.stdout, /WARNING: oas\.web is locked in .*retired.*OAS Desktop app/s, "doctor surfaces the stale lock with migration guidance");
  const doctorJson2 = spawnSync(process.execPath, [CLI, "doctor", repo2, "--json"], { encoding: "utf8" });
  assert.equal(doctorJson2.status, 0, "lock-only state resolves");
  const dj2 = JSON.parse(doctorJson2.stdout);
  assert.equal(dj2.retiredLocks?.[0]?.id, "oas.web", "doctor --json lists the stale retired lock");
  assert.match(dj2.retiredLocks[0].reason, /Remove the oas\.web entry/, "JSON lock report carries the fix");
});

test("retired oas.web: a STALE INSTALLED ARTIFACT never bypasses the retirement diagnostics", () => {
  // The migration's own upgrade state: the user hasn't deleted the stale
  // installed copy yet. Presence must not short-circuit retirement.
  const base = temp(); const repo = join(base, "repo"); mkdirSync(repo);
  const staleDir = join(repo, ".agents", "capabilities", "installed", "oas-web");
  write(join(staleDir, "oas.json"), JSON.stringify({ capability: "oas.web", version: "0.9.6", description: "stale web panel copy" }));
  write(join(repo, "oas-lock.json"), JSON.stringify({ capabilities: { "oas.web": { version: "0.9.6", integrity: "sha256-x", source: "marketplace:oas-web@0.9.6" } } }));
  // config activation with the artifact present still throws the retirement guidance
  write(join(repo, "oas-config.yaml"), `capabilities:\n  additive:\n    oas.web:\n      global: true\n`);
  assert.throws(() => resolveOasConfig(repo), /retired[\s\S]*OAS Desktop app[\s\S]*Remove the oas\.web entry/,
    "stale artifact does not let config activation succeed");
  // explicit install with the artifact present must not exit "Already acquired"
  const inst = spawnSync(process.execPath, [CLI, "install", "oas.web", "--dir", repo], { encoding: "utf8" });
  assert.notEqual(inst.status, 0, "explicit install of a retired id fails even when an artifact is present");
  assert.match(inst.stderr, /retired.*OAS Desktop app/s);
  assert.doesNotMatch(inst.stdout, /Already acquired/, "presence does not short-circuit retirement");
  // bare install must report RETIRED, never ok/present
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive: {}\n");
  const restore = spawnSync(process.execPath, [CLI, "install", "--dir", repo], { encoding: "utf8" });
  assert.match(restore.stdout, /RETIRED\s+oas\.web/s, "lock restore reports RETIRED despite the present artifact");
  assert.doesNotMatch(restore.stdout, /ok\s+oas\.web/, "no 'ok' for a retired capability's stale artifact");
  // doctor's acquired listing flags the stale artifact with the deletion hint
  const doctor = spawnSync(process.execPath, [CLI, "doctor", repo], { encoding: "utf8" });
  assert.match(doctor.stdout, /oas\.web[\s\S]*WARNING: artifact of a retired capability[\s\S]*also delete/, "doctor names the stale installed copy with delete guidance");
});

test("retired oas.web: non-installed origins and source-manifest retirement are handled safely", () => {
  const base = temp();
  // owned origin: doctor warns WITHOUT destructive delete guidance
  const repo = join(base, "repo"); mkdirSync(repo);
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive: {}\n");
  write(join(repo, ".agents", "capabilities", "owned", "oas-web", "oas.json"),
    JSON.stringify({ capability: "oas.web", version: "0.9.6", description: "owned copy" }));
  const doc = spawnSync(process.execPath, [CLI, "doctor", repo], { encoding: "utf8" });
  assert.match(doc.stdout, /WARNING: artifact of a retired capability/, "owned retired artifact is flagged");
  assert.match(doc.stdout, /remove its declaration/, "non-installed origin gets declaration guidance");
  assert.doesNotMatch(doc.stdout, /also delete/, "no delete instruction for an owned source tree");
  // doctor --json reports the artifact in retiredArtifacts
  const docJson = spawnSync(process.execPath, [CLI, "doctor", repo, "--json"], { encoding: "utf8" });
  const dj = JSON.parse(docJson.stdout);
  assert.equal(dj.retiredArtifacts?.[0]?.id, "oas.web", "doctor --json lists the retired artifact");
  assert.match(dj.retiredArtifacts[0].origin, /^owned:/, "artifact record carries the origin");
  // local-path acquisition of a package whose MANIFEST declares a retired id is rejected and cleaned up
  const src = join(base, "ext-pkg"); mkdirSync(src);
  write(join(src, "oas.json"), JSON.stringify({ capability: "oas.web", version: "0.9.9", description: "external" }));
  const target = join(base, "target"); mkdirSync(target);
  write(join(target, "oas-config.yaml"), "capabilities:\n  additive: {}\n");
  const inst = spawnSync(process.execPath, [CLI, "install", src, "--dir", target], { encoding: "utf8" });
  assert.notEqual(inst.status, 0, "path install of a retired-manifest package fails");
  assert.match(inst.stderr, /declares capability "oas\.web".*retired/s, "failure names the manifest's retired id");
  assert.equal(existsSync(join(target, ".agents", "capabilities", "installed", "ext-pkg")), false, "destination artifact removed");
  assert.equal(existsSync(join(target, "oas-lock.json")), false, "no lock entry written");
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
  const manual = jsonResult(r);
  assert.equal(manual.parent, null);
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
  const child = jsonResult(r);
  assert.equal(child.parent, manual.instance);
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

test("--parent accepts capability-defined parent instances homing under local-agents/", () => {
  const base = temp(); const { repo, root } = fixtureSoul(base);
  capability(repo, "rev", { capability: "acme.rev", agents: ["agents/reviewer"] }, {
    "agents/reviewer/soul.yaml": "name: reviewer\nkind: capability\nwork: checkout\nruntime: pi\ndescription: Reviewer.\n",
    "agents/reviewer/AGENTS.md": "# Reviewer\n",
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.rev:\n      global: true\n");
  return import("../lib/core.mjs").then((core) => {
    const capAgent = core.findCapabilityAgent(repo, root, "reviewer");
    const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
    try {
      // Capability agent instance homes under <root>/local-agents/reviewer/instances/.
      const parent = core.spawnInstance(root, { ...capAgent, repo }, { instance: "reviewer-abc", launch: false });
      assert.ok(parent.home.includes(join("local-agents", "reviewer", "instances")));
      // Kernel lookup sees it (this is what `oas spawn --parent` validates with).
      assert.ok(core.findInstanceHome(root, "reviewer-abc"), "findInstanceHome sees capability-agent homes");
      // Coordinator-style spawn: a capability-defined instance passes itself as
      // --parent when spawning a child through the CLI.
      const env = { ...process.env, PATH: fakeRuntimes(base), PI_AGENTS_TMUX_SESSION: "oas-test-nosuch" };
      delete env.PI_AGENTS_ROOT;
      const r = spawnSync(process.execPath, [CLI, "spawn", "dev", "--parent", "reviewer-abc", "--task", "child work", "--purpose", "child", "--no-launch", "--json"], { cwd: repo, env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      const child = jsonResult(r);
      assert.equal(child.parent, "reviewer-abc");
      assert.equal(child.spawnOrigin, "instance");
      assert.match(readFileSync(join(child.home, "TASK.md"), "utf8"), /child work/);
      core.retireInstance(root, "reviewer-abc", { tmuxSession: "oas-test-nosuch" });
    } finally { process.env.PATH = oldPath; }
  });
});

test("spawn relations: child/sibling/parent/unrelated, sugar equivalence, validation", () => {
  const base = temp(); const repo = join(base, "repo"); gitRepo(repo);
  const root = join(repo, "agents");
  write(join(root, "dev", "soul", "soul.yaml"), `name: dev\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
  write(join(root, "dev", "soul", "AGENTS.md"), "# dev\n");
  mkdirSync(join(root, "dev", "instances"), { recursive: true });
  const env = { ...process.env, PATH: fakeRuntimes(base), PI_AGENTS_TMUX_SESSION: "oas-test-nosuch" };
  delete env.PI_AGENTS_ROOT;
  const spawn = (...extra) => spawnSync(process.execPath, [CLI, "spawn", "dev", "--no-launch", "--json", ...extra], { cwd: repo, env, encoding: "utf8" });
  const metaOf = (home) => JSON.parse(readFileSync(join(home, "instance.json"), "utf8"));

  // Root anchor: no relation flags → unrelated (as today).
  let r = spawn("--purpose", "anchor");
  assert.equal(r.status, 0, r.stderr);
  const anchor = jsonResult(r);
  assert.equal(anchor.parent, null); assert.equal(anchor.relation, null);

  // child: --relation child --relative-to === --parent sugar (same recorded fields).
  r = spawn("--purpose", "kid", "--relation", "child", "--relative-to", anchor.instance);
  assert.equal(r.status, 0, r.stderr);
  const kid = jsonResult(r);
  assert.equal(kid.parent, anchor.instance);
  assert.equal(kid.relation, "child");
  assert.equal(kid.spawnOrigin, "instance");
  r = spawn("--purpose", "kid-sugar", "--parent", anchor.instance);
  assert.equal(r.status, 0, r.stderr);
  const sugar = jsonResult(r);
  assert.equal(sugar.parent, anchor.instance);
  assert.equal(sugar.relation, "child", "--parent is sugar for --relation child");
  const kidMeta = metaOf(kid.home); const sugarMeta = metaOf(sugar.home);
  assert.equal(kidMeta.parentInstance, sugarMeta.parentInstance);
  assert.equal(kidMeta.relation, sugarMeta.relation);
  assert.equal(kidMeta.siblingInstance, undefined);

  // sibling of a CHILD: shares the child's parent (same cluster, same level).
  r = spawn("--purpose", "peer", "--relation", "sibling", "--relative-to", kid.instance);
  assert.equal(r.status, 0, r.stderr);
  const peer = jsonResult(r);
  assert.equal(peer.parent, anchor.instance, "sibling of a child shares the parent");
  assert.equal(peer.sibling, null);
  assert.equal(metaOf(peer.home).relativeTo, kid.instance);

  // sibling of a ROOT: no parent to share → explicit siblingInstance link keeps one cluster.
  r = spawn("--purpose", "rootpeer", "--relation", "sibling", "--relative-to", anchor.instance);
  assert.equal(r.status, 0, r.stderr);
  const rootPeer = jsonResult(r);
  assert.equal(rootPeer.parent, null);
  assert.equal(rootPeer.sibling, anchor.instance, "root sibling records siblingInstance");
  assert.equal(metaOf(rootPeer.home).siblingInstance, anchor.instance);

  // parent: the NEW instance becomes the anchor's parent; anchor lineage re-pointed.
  r = spawn("--purpose", "boss", "--relation", "parent", "--relative-to", kid.instance);
  assert.equal(r.status, 0, r.stderr);
  const boss = jsonResult(r);
  assert.equal(boss.parent, anchor.instance, "new parent inherits the anchor's old slot");
  assert.equal(metaOf(kid.home).parentInstance, boss.instance, "anchor re-pointed to the new instance");

  // parent of a ROOT: new instance is top-level, anchor nests under it.
  r = spawn("--purpose", "rootboss", "--relation", "parent", "--relative-to", anchor.instance);
  assert.equal(r.status, 0, r.stderr);
  const rootBoss = jsonResult(r);
  assert.equal(rootBoss.parent, null);
  assert.equal(metaOf(anchor.home).parentInstance, rootBoss.instance);

  // unrelated: explicit flag behaves like the default and takes no --relative-to.
  r = spawn("--purpose", "stranger", "--relation", "unrelated");
  assert.equal(r.status, 0, r.stderr);
  const stranger = jsonResult(r);
  assert.equal(stranger.parent, null); assert.equal(stranger.relation, null);
  assert.equal(stranger.spawnOrigin, "operator");

  // status --json exposes the lineage fields desktop consumes.
  r = spawnSync(process.execPath, [CLI, "status", "--json"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const status = JSON.parse(r.stdout);
  const insts = status.agents.find((a) => a.name === "dev").instances;
  const sKid = insts.find((i) => i.instance === kid.instance);
  assert.equal(sKid.parentInstance, boss.instance);
  const sPeer = insts.find((i) => i.instance === rootPeer.instance);
  assert.equal(sPeer.siblingInstance, anchor.instance);

  // Validation errors (E_BAD_ARGS / not-found), all before scaffolding.
  // JSON mode: failures are a stdout envelope with a stable error code.
  const fail = (re, ...extra) => {
    const x = spawn("--purpose", "bad", ...extra);
    assert.equal(x.status, 1);
    const env2 = JSON.parse(x.stdout);
    assert.equal(env2.ok, false);
    assert.match(env2.error?.message || "", re);
  };
  fail(/--relation child requires --relative-to/, "--relation", "child");
  fail(/--relation sibling requires --relative-to/, "--relation", "sibling");
  fail(/--relation parent requires --relative-to/, "--relation", "parent");
  fail(/unknown --relation "boss"/, "--relation", "boss", "--relative-to", anchor.instance);
  fail(/--relative-to requires --relation/, "--relative-to", anchor.instance);
  fail(/--relation unrelated takes no --relative-to/, "--relation", "unrelated", "--relative-to", anchor.instance);
  fail(/use one form, not both/, "--parent", anchor.instance, "--relation", "child", "--relative-to", anchor.instance);
  fail(/--relation needs a value/, "--relation", "--relative-to", anchor.instance);
  fail(/does not match any known instance/, "--relation", "sibling", "--relative-to", "no-such-instance");

  // ATTACHED agents are ALWAYS children of the work-tree owner (design
  // decision): no relation flags → auto-parent from the canonically resolved
  // owner; non-child relations → rejected; a non-instance work dir requires an
  // explicit --parent naming the owner.
  r = spawn("--purpose", "cli-att-un", "--work", "attached", "--work-dir", join(anchor.home, "work"), "--relation", "unrelated");
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error?.message || "", /always children/);
  r = spawn("--purpose", "cli-att-par", "--work", "attached", "--work-dir", join(anchor.home, "work"), "--relation", "parent", "--relative-to", anchor.instance);
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error?.message || "", /always children/);
  r = spawn("--purpose", "cli-att", "--work", "attached", "--work-dir", join(anchor.home, "work"));
  assert.equal(r.status, 0, r.stderr);
  const cliAtt = jsonResult(r);
  assert.equal(cliAtt.parent, anchor.instance, "CLI: attached auto-parents under the work-tree owner");
  const agentDef = findAgent(root, "dev");
  const oldPath = process.env.PATH;
  process.env.PATH = fakeRuntimes(base);
  try {
    const att = spawnInstance(root, agentDef, { instance: "dev-att", work: "attached", workDir: join(anchor.home, "work"), launch: false });
    assert.equal(att.parentInstance, anchor.instance, "attached auto-parents under the work-tree owner");
    // Kernel enforces the invariant too (covers soul-default attached mode):
    // contradictory relations rejected; redundant child-of-owner allowed.
    assert.throws(() => spawnInstance(root, agentDef, { instance: "dev-att-un", work: "attached", workDir: join(anchor.home, "work"), relation: "unrelated", launch: false }), /always children/);
    assert.throws(() => spawnInstance(root, agentDef, { instance: "dev-att-sib", work: "attached", workDir: join(anchor.home, "work"), relation: "sibling", relativeTo: anchor.instance, launch: false }), /always children/);
    const attKid = spawnInstance(root, agentDef, { instance: "dev-att-kid", work: "attached", workDir: join(anchor.home, "work"), parent: anchor.instance, launch: false });
    assert.equal(attKid.parentInstance, anchor.instance, "redundant child-of-owner is accepted");
    // Ownership is CANONICAL, not lexical: a path merely SHAPED like <owner>/work
    // never records a nonexistent parent, and a non-instance tree (e.g. a
    // coordinator's integration worktree) requires an explicit --parent owner.
    const fakeOwner = join(base, "not-an-instance", "work"); mkdirSync(fakeOwner, { recursive: true });
    assert.throws(() => spawnInstance(root, agentDef, { instance: "dev-att-fake", work: "attached", workDir: fakeOwner, launch: false }), /not a known instance/);
    const integ = join(base, "integration-tree"); mkdirSync(integ, { recursive: true });
    assert.throws(() => spawnInstance(root, agentDef, { instance: "dev-att-integ", work: "attached", workDir: integ, launch: false }), /not a known instance/);
    const owned = spawnInstance(root, agentDef, { instance: "dev-att-owned", work: "attached", workDir: integ, parent: anchor.instance, launch: false });
    assert.equal(owned.parentInstance, anchor.instance, "non-instance tree with explicit --parent owner attaches as its child");

    // Direct-kernel rejection happens BEFORE scaffolding and hooks: no home dir remains.
    const assertNoHome = (name, fn, re) => {
      assert.throws(fn, re);
      assert.equal(existsSync(join(root, "dev", "instances", name)), false, `${name}: no instance dir left behind`);
    };
    assertNoHome("dev-badrel", () => spawnInstance(root, agentDef, { instance: "dev-badrel", relation: "boss", relativeTo: anchor.instance, launch: false }), /unknown relation/);
    assertNoHome("dev-norel", () => spawnInstance(root, agentDef, { instance: "dev-norel", relation: "sibling", launch: false }), /needs a relative-to/);
    assertNoHome("dev-noanchor", () => spawnInstance(root, agentDef, { instance: "dev-noanchor", relation: "sibling", relativeTo: "no-such-instance", launch: false }), /was not found/);
    // Kernel validates the RAW option combination (programmatic callers bypass
    // the CLI): contradictory shapes are rejected, never silently normalized.
    assertNoHome("dev-dangling", () => spawnInstance(root, agentDef, { instance: "dev-dangling", relativeTo: anchor.instance, launch: false }), /needs a relation/);
    assertNoHome("dev-unrel-rt", () => spawnInstance(root, agentDef, { instance: "dev-unrel-rt", relation: "unrelated", relativeTo: anchor.instance, launch: false }), /takes no relativeTo/);
    assertNoHome("dev-both", () => spawnInstance(root, agentDef, { instance: "dev-both", parent: anchor.instance, relation: "child", relativeTo: anchor.instance, launch: false }), /one form, not both/);
    assertNoHome("dev-rr-only", () => spawnInstance(root, agentDef, { instance: "dev-rr-only", relativeRoot: root, launch: false }), /only qualifies/);
  } finally { process.env.PATH = oldPath; }
});

test("relation anchors are ambiguity-safe across same-named team instances", () => {
  const base = temp();
  const ws = join(base, "ws"); mkdirSync(ws, { recursive: true });
  write(join(ws, "oas-config.yaml"), "team:\n  name: t\n");
  const mkMember = (repoName) => {
    const repo = join(ws, repoName); gitRepo(repo);
    write(join(repo, "oas-config.yaml"), "capabilities:\n  additive: {}\n");
    const root = join(repo, "agents");
    write(join(root, "dev", "soul", "soul.yaml"), `name: dev\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
    write(join(root, "dev", "soul", "AGENTS.md"), "# dev\n");
    mkdirSync(join(root, "dev", "instances"), { recursive: true });
    return { repo, root };
  };
  const a = mkMember("repo-a");
  const b = mkMember("repo-b");
  const oldPath = process.env.PATH;
  process.env.PATH = fakeRuntimes(base);
  const metaOf = (root2, name2) => JSON.parse(readFileSync(join(root2, "dev", "instances", name2, "instance.json"), "utf8"));
  try {
    // Same-named anchor in both repos.
    const bossA = spawnInstance(a.root, findAgent(a.root, "dev"), { instance: "dev-boss", launch: false });
    const bossB = spawnInstance(b.root, findAgent(b.root, "dev"), { instance: "dev-boss", launch: false });
    // From repo A, bare "dev-boss" matches BOTH — kernel resolution is
    // local-first for the recorded edge, so the LOCAL one wins silently only
    // when unambiguous... here both exist: without relativeRoot → ambiguous.
    assert.throws(
      () => spawnInstance(a.root, findAgent(a.root, "dev"), { instance: "dev-kid-x", relation: "child", relativeTo: "dev-boss", launch: false }),
      (e) => e.code === "E_RELATIVE_AMBIGUOUS" && /matches multiple instances/.test(e.message),
      "duplicate anchor names without --relative-root are rejected");
    assert.equal(existsSync(join(a.root, "dev", "instances", "dev-kid-x")), false, "no stray home");
    // relativeRoot picks the LOCAL one: round-trips, allowed.
    const kidA = spawnInstance(a.root, findAgent(a.root, "dev"), { instance: "dev-kid-a", relation: "child", relativeTo: "dev-boss", relativeRoot: a.root, launch: false });
    assert.equal(metaOf(a.root, kidA.instance).parentInstance, "dev-boss");
    // relativeRoot picking the FOREIGN same-named one cannot round-trip from
    // repo A (the local dev-boss shadows it) → rejected, not silently wrong.
    assert.throws(
      () => spawnInstance(a.root, findAgent(a.root, "dev"), { instance: "dev-kid-b", relation: "child", relativeTo: "dev-boss", relativeRoot: b.root, launch: false }),
      (e) => e.code === "E_RELATIVE_AMBIGUOUS" && /shadowed/.test(e.message),
      "cross-repo anchor shadowed by a same-named local instance is rejected");
    // relation=parent reverse-edge check: an existing instance in the anchor's
    // repo with the same name the NEW instance would take → rejected (the
    // re-pointed anchor edge would resolve to the wrong instance).
    spawnInstance(b.root, findAgent(b.root, "dev"), { instance: "dev-over", launch: false });
    assert.throws(
      () => spawnInstance(a.root, findAgent(a.root, "dev"), { instance: "dev-over", relation: "parent", relativeTo: bossA.instance, relativeRoot: a.root, launch: false }),
      (e) => e.code === "E_RELATIVE_AMBIGUOUS" && /shadow the new instance/.test(e.message),
      "parent relation rejects a shadowed reverse edge");
    assert.equal(metaOf(a.root, bossA.instance).parentInstance, undefined, "anchor NOT re-pointed by the rejected spawn");
    // Unique names keep working with zero new flags (no breaking change).
    const uniq = spawnInstance(b.root, findAgent(b.root, "dev"), { instance: "dev-uniq-kid", relation: "child", relativeTo: bossB.instance === "dev-boss" ? "dev-over" : bossB.instance, launch: false });
    assert.equal(metaOf(b.root, uniq.instance).parentInstance, "dev-over");

    // INHERITED-edge round-trips (the subtle cases): sibling/parent copy names
    // from the anchor's instance.json — resolved from the ANCHOR's root — and
    // the new root may resolve those same names elsewhere.
    // Repo-B anchor "dev-under" is a child of B's dev-boss; repo A also has a
    // dev-boss. A sibling of dev-under spawned from repo A would record
    // parentInstance: "dev-boss" — which from repo A resolves to A's boss, not
    // the anchor's parent. Must be rejected.
    const under = spawnInstance(b.root, findAgent(b.root, "dev"), { instance: "dev-under", relation: "child", relativeTo: "dev-boss", relativeRoot: b.root, launch: false });
    assert.throws(
      () => spawnInstance(a.root, findAgent(a.root, "dev"), { instance: "dev-sib-x", relation: "sibling", relativeTo: under.instance, launch: false }),
      (e) => e.code === "E_RELATIVE_AMBIGUOUS" && /inherited lineage "dev-boss"/.test(e.message),
      "sibling inheriting a cross-repo-shadowed parent name is rejected");
    assert.equal(existsSync(join(a.root, "dev", "instances", "dev-sib-x")), false, "no stray home");
    // Same inheritance path for relation=parent (new instance takes the
    // anchor's old parent — also "dev-boss").
    assert.throws(
      () => spawnInstance(a.root, findAgent(a.root, "dev"), { instance: "dev-par-x", relation: "parent", relativeTo: under.instance, launch: false }),
      (e) => e.code === "E_RELATIVE_AMBIGUOUS" && /inherited lineage "dev-boss"/.test(e.message),
      "parent inheriting a cross-repo-shadowed lineage name is rejected");
    assert.equal(metaOf(b.root, under.instance).parentInstance, "dev-boss", "anchor untouched by the rejected parent spawn");
    // Sibling of the same anchor spawned from ITS OWN repo round-trips fine.
    const sibOk = spawnInstance(b.root, findAgent(b.root, "dev"), { instance: "dev-sib-ok", relation: "sibling", relativeTo: under.instance, launch: false });
    assert.equal(metaOf(b.root, sibOk.instance).parentInstance, "dev-boss", "same-repo sibling inherits the parent");
  } finally { process.env.PATH = oldPath; }
});

test("anchor enumeration sees intra-root duplicates (generated-name collisions)", () => {
  const base = temp(); const repo = join(base, "repo"); gitRepo(repo);
  const root = join(repo, "agents");
  // Two agents whose generated names collide: agent "dev" with purpose "foo-1"
  // and agent "dev-foo" with purpose "1" both yield instance "dev-foo-1".
  for (const soul of ["dev", "dev-foo"]) {
    write(join(root, soul, "soul", "soul.yaml"), `name: ${soul}\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
    write(join(root, soul, "soul", "AGENTS.md"), `# ${soul}\n`);
    mkdirSync(join(root, soul, "instances"), { recursive: true });
  }
  const oldPath = process.env.PATH;
  process.env.PATH = fakeRuntimes(base);
  try {
    spawnInstance(root, findAgent(root, "dev"), { instance: "dev-foo-1", launch: false });
    spawnInstance(root, findAgent(root, "dev-foo"), { instance: "dev-foo-1", launch: false });
    // findInstanceHomes surfaces both; first-match findInstanceHome sees one.
    assert.equal(findInstanceHomes(root, "dev-foo-1").length, 2, "both same-named homes enumerated");
    // A relation anchored on the duplicated name is inherently ambiguous —
    // --relative-root cannot split two matches under ONE root.
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-kid-dup", relation: "child", relativeTo: "dev-foo-1", relativeRoot: root, launch: false }),
      (e) => e.code === "E_RELATIVE_AMBIGUOUS" && /inherently ambiguous/.test(e.message),
      "intra-root duplicate anchor rejected even with --relative-root");
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-kid-dup", relation: "child", relativeTo: "dev-foo-1", launch: false }),
      (e) => e.code === "E_RELATIVE_AMBIGUOUS",
      "intra-root duplicate anchor rejected without qualifier too");
    assert.equal(existsSync(join(root, "dev", "instances", "dev-kid-dup")), false, "no stray home");
  } finally { process.env.PATH = oldPath; }
});

test("local-soul instances enumerate once and accept relations (no false intra-root ambiguity)", () => {
  const base = temp(); const repo = join(base, "repo"); gitRepo(repo);
  const root = join(repo, "agents");
  write(join(root, "dev", "soul", "soul.yaml"), `name: dev\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
  write(join(root, "dev", "soul", "AGENTS.md"), "# dev\n");
  mkdirSync(join(root, "dev", "instances"), { recursive: true });
  // Local soul under local-agents/ — visible via BOTH listAgents and the
  // capability fallback scan; must not double-count.
  const la = join(repo, "local-agents");
  write(join(la, "helper", "soul", "soul.yaml"), `name: helper\nkind: local\nrepo: ${repo}\nwork: worktree\nruntime: pi\n`);
  write(join(la, "helper", "soul", "AGENTS.md"), "# helper\n");
  mkdirSync(join(la, "helper", "instances"), { recursive: true });
  const oldPath = process.env.PATH;
  process.env.PATH = fakeRuntimes(base);
  try {
    const anchor = spawnInstance(root, findAgent(root, "helper"), { instance: "helper-anchor", launch: false });
    assert.equal(findInstanceHomes(root, anchor.instance).length, 1, "local-soul instance enumerated exactly once");
    // Relations to a local-soul anchor work — with and without --relative-root.
    const kid = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-la-kid", relation: "child", relativeTo: anchor.instance, launch: false });
    assert.equal(kid.parentInstance, anchor.instance);
    const kid2 = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-la-kid2", relation: "child", relativeTo: anchor.instance, relativeRoot: root, launch: false });
    assert.equal(kid2.parentInstance, anchor.instance);
    const sib = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-la-sib", relation: "sibling", relativeTo: kid.instance, launch: false });
    assert.equal(sib.parentInstance, anchor.instance, "sibling inherits the local-soul parent");
  } finally { process.env.PATH = oldPath; }
});

test("retire splices lineage: orphans inherit the retiree's links (parent-relation reviewer cycle)", () => {
  const base = temp(); const repo = join(base, "repo"); gitRepo(repo);
  const root = join(repo, "agents");
  write(join(root, "dev", "soul", "soul.yaml"), `name: dev\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
  write(join(root, "dev", "soul", "AGENTS.md"), "# dev\n");
  mkdirSync(join(root, "dev", "instances"), { recursive: true });
  const oldPath = process.env.PATH;
  process.env.PATH = fakeRuntimes(base);
  const metaOf = (name) => JSON.parse(readFileSync(join(root, "dev", "instances", name, "instance.json"), "utf8"));
  try {
    const agentDef = findAgent(root, "dev");
    // coordinator → developer (child) → reviewer (parent relation over the developer).
    const coord = spawnInstance(root, agentDef, { instance: "dev-coord", launch: false });
    const developer = spawnInstance(root, agentDef, { instance: "dev-worker", relation: "child", relativeTo: coord.instance, launch: false });
    const reviewer = spawnInstance(root, agentDef, { instance: "dev-rev", relation: "parent", relativeTo: developer.instance, launch: false });
    assert.equal(reviewer.parentInstance, coord.instance, "reviewer takes the developer's slot under the coordinator");
    assert.equal(metaOf(developer.instance).parentInstance, reviewer.instance);
    // Reviewer retires → the developer returns to the coordinator (no dangling parent).
    const r = retireInstance(root, reviewer.instance, { keepDir: false });
    assert.ok(r.relinked?.some((x) => x.instance === developer.instance && x.parentInstance === coord.instance), "retire reports the splice");
    assert.equal(metaOf(developer.instance).parentInstance, coord.instance, "developer re-pointed to its previous parent");
    // Root-parent case: reviewer over a ROOT instance → on retire the root becomes a root again.
    const solo = spawnInstance(root, agentDef, { instance: "dev-solo", launch: false });
    const rev2 = spawnInstance(root, agentDef, { instance: "dev-rev2", relation: "parent", relativeTo: solo.instance, launch: false });
    assert.equal(metaOf(solo.instance).parentInstance, rev2.instance);
    retireInstance(root, rev2.instance, { keepDir: false });
    assert.equal(metaOf(solo.instance).parentInstance, undefined, "root anchor is a root again after its reviewer retires");
    // Sibling-link splice: root sibling link to a retiring instance is dropped.
    // parent-relation anchor rewrite is committed only AFTER a successful
    // launch: force a launch failure (PATH without tmux) and assert the
    // anchor's lineage is untouched — no edge to a zombie spawn.
    const rev4 = (() => {
      const restore = process.env.PATH;
      // pi/claude/git available, tmux NOT: which() must fail on tmux only.
      const noTmux = join(base, "bin-notmux"); mkdirSync(noTmux, { recursive: true });
      for (const t of ["pi", "claude"]) write(join(noTmux, t), "#!/bin/sh\nexit 0\n");
      execFileSync("chmod", ["-R", "+x", noTmux]);
      const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      symlinkSync(gitPath, join(noTmux, "git"));
      process.env.PATH = noTmux;
      try {
        assert.throws(
          () => spawnInstance(root, agentDef, { instance: "dev-rev4", relation: "parent", relativeTo: solo.instance, launch: true }),
          /tmux not installed/,
          "launch failure surfaces");
      } finally { process.env.PATH = restore; }
    })();
    void rev4;
    assert.equal(metaOf(solo.instance).parentInstance, undefined, "anchor NOT re-pointed by the failed launch");
    // Anchor-write failure AFTER successful scaffold/launch is COMPENSATED:
    // make the anchor's instance.json unwritable, spawn a parent relation, and
    // assert the spawn throws AND the new home is rolled back (no zombie).
    const soloMetaPath = join(root, "dev", "instances", solo.instance, "instance.json");
    execFileSync("chmod", ["444", soloMetaPath]);
    execFileSync("chmod", ["555", dirname(soloMetaPath)]);
    try {
      assert.throws(
        () => spawnInstance(root, agentDef, { instance: "dev-rev5", relation: "parent", relativeTo: solo.instance, launch: false }),
        /failed to re-point anchor.*rolled back/s,
        "anchor-write failure is compensated");
    } finally {
      execFileSync("chmod", ["755", dirname(soloMetaPath)]);
      execFileSync("chmod", ["644", soloMetaPath]);
    }
    assert.equal(existsSync(join(root, "dev", "instances", "dev-rev5")), false, "rolled-back spawn leaves no home");
    assert.equal(metaOf(solo.instance).parentInstance, undefined, "anchor unchanged after compensated failure");
    const peer = spawnInstance(root, agentDef, { instance: "dev-peer", relation: "sibling", relativeTo: solo.instance, launch: false });
    assert.equal(metaOf(peer.instance).siblingInstance, solo.instance);
    // Mixed edge types: reviewer R as parent over root-sibling peer absorbs
    // peer's sibling link (R.siblingInstance = solo). Retiring R must restore
    // BOTH: peer loses parent AND regains the sibling link — the orphan inherits
    // the retiree's COMPLETE lineage, not just the same-typed edge.
    const rev3 = spawnInstance(root, agentDef, { instance: "dev-rev3", relation: "parent", relativeTo: peer.instance, launch: false });
    assert.equal(rev3.siblingInstance, solo.instance, "parent-relation reviewer absorbs the anchor's sibling link");
    assert.equal(metaOf(peer.instance).parentInstance, rev3.instance);
    assert.equal(metaOf(peer.instance).siblingInstance, undefined);
    retireInstance(root, rev3.instance, { keepDir: false });
    assert.equal(metaOf(peer.instance).parentInstance, undefined, "peer is a root again");
    assert.equal(metaOf(peer.instance).siblingInstance, solo.instance, "cross-type splice restores the sibling cluster link");
    retireInstance(root, solo.instance, { keepDir: false });
    assert.equal(metaOf(peer.instance).siblingInstance, undefined, "dangling sibling link dropped on retire");
  } finally { process.env.PATH = oldPath; }
});

test("parent-relation rollback after LAUNCH kills the window, compensates hooks, and never truncates the anchor", () => {
  const base = temp(); const repo = join(base, "repo"); gitRepo(repo);
  const root = join(repo, "agents");
  write(join(root, "dev", "soul", "soul.yaml"), `name: dev\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
  write(join(root, "dev", "soul", "AGENTS.md"), "# dev\n");
  mkdirSync(join(root, "dev", "instances"), { recursive: true });
  // Capability whose spawn/retire hooks record every event — compensation must
  // fire retire for the rolled-back instance.
  const hookLog = join(base, "hook-events");
  const script = `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(hookLog)}, process.env.OAS_EVENT + ':' + process.env.OAS_INSTANCE + '\\n');`;
  capability(repo, "comp", { capability: "acme.comp", hooks: { spawn: "hook.mjs", retire: "hook.mjs" } }, { "hook.mjs": script });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.comp:\n      global: true\n");
  // STATEFUL fake tmux: tracks window names in a file so list-windows reflects
  // new-window/kill-window; TMUX_FAKE_STUBBORN names a window that kill-window
  // silently fails to remove (for truth-telling assertions).
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  const tmuxLog = join(base, "tmux-log");
  const tmuxWins = join(base, "tmux-windows");
  write(tmuxWins, "");
  write(join(bin, "tmux"), [
    "#!/bin/sh",
    `echo "$@" >> ${tmuxLog}`,
    'cmd="$1"',
    'case "$cmd" in',
    "  new-window)",
    `    while [ $# -gt 0 ]; do if [ "$1" = "-n" ]; then echo "$2" >> ${tmuxWins}; fi; shift; done ;;`,
    "  kill-window)",
    '    while [ $# -gt 0 ]; do if [ "$1" = "-t" ]; then t="$2"; fi; shift; done',
    "    name=$(printf '%s' \"$t\" | sed 's/.*:=//')",
    `    if [ "$name" != "$TMUX_FAKE_STUBBORN" ]; then grep -v -x "$name" ${tmuxWins} > ${tmuxWins}.n || true; mv ${tmuxWins}.n ${tmuxWins}; fi ;;`,
    "  list-windows)",
    '    if [ -n "$TMUX_FAKE_LIST_FAIL" ]; then echo "list-windows broken" >&2; exit 1; fi',
    `    cat ${tmuxWins} ;;`,
    "esac",
    "exit 0",
    "",
  ].join("\n"));
  for (const t of ["pi", "claude"]) write(join(bin, t), "#!/bin/sh\nexit 0\n");
  execFileSync("chmod", ["-R", "+x", bin]);
  for (const t of ["git", "node", "chmod", "sh", "grep", "sed", "mv", "cat", "printf"]) symlinkSync(execFileSync("which", [t], { encoding: "utf8" }).trim(), join(bin, t));
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}`;
  try {
    const agentDef = findAgent(root, "dev");
    const anchor = spawnInstance(root, agentDef, { instance: "dev-anchor", tmuxSession: "oas-test-fake", launch: false });
    const anchorMetaPath = join(anchor.home, "instance.json");
    const before = readFileSync(anchorMetaPath, "utf8");
    // Force the ATOMIC anchor write to fail AFTER a successful launch: 555 on
    // the anchor's home blocks the same-directory temp file creation — the
    // target instance.json is never truncated (rename never happens).
    execFileSync("chmod", ["555", anchor.home]);
    try {
      assert.throws(
        () => spawnInstance(root, agentDef, { instance: "dev-zomb", relation: "parent", relativeTo: anchor.instance, tmuxSession: "oas-test-fake", launch: true }),
        /failed to re-point anchor.*rolled back/s);
    } finally { execFileSync("chmod", ["755", anchor.home]); }
    // Anchor file NEVER truncated or altered (atomic temp+rename path).
    assert.equal(readFileSync(anchorMetaPath, "utf8"), before, "anchor instance.json byte-identical");
    // The launched window was killed with an exact-match target.
    const tmuxCalls = readFileSync(tmuxLog, "utf8");
    assert.match(tmuxCalls, /new-window .*dev-zomb/, "window was launched");
    assert.match(tmuxCalls, /kill-window -t =oas-test-fake:=dev-zomb/, "launched window killed exact-match");
    // Spawn hooks were compensated with retire for the rolled-back instance.
    const events = readFileSync(hookLog, "utf8").trim().split("\n");
    assert.ok(events.includes("spawn:dev-zomb"), "spawn hook ran");
    assert.ok(events.includes("retire:dev-zomb"), "retire hook compensated the rolled-back spawn");
    // Scaffold removed; no temp file remains next to the anchor meta.
    assert.equal(existsSync(join(root, "dev", "instances", "dev-zomb")), false, "no zombie home");
    assert.ok(!readdirSync(anchor.home).some((f) => f.includes(".tmp-")), "no leftover temp file");

    // Temp-cleanup failure must not abort the rollback: pre-create a NON-EMPTY
    // DIRECTORY at the deterministic temp path — writeFileSync fails (EISDIR,
    // the original error) AND rmSync(tmpPath, {force:true}) throws (EISDIR/
    // ENOTEMPTY without recursive), which previously aborted all remaining
    // compensation (window kill, hooks, scaffold removal).
    const tmpDir = `${anchorMetaPath}.tmp-dev-zomb2`;
    mkdirSync(tmpDir); write(join(tmpDir, "blocker"), "x");
    try {
      assert.throws(
        () => spawnInstance(root, agentDef, { instance: "dev-zomb2", relation: "parent", relativeTo: anchor.instance, tmuxSession: "oas-test-fake", launch: true }),
        /failed to re-point anchor.*rollback INCOMPLETE.*tmp-dev-zomb2/s,
        "original anchor-write error surfaces, and the unremovable temp is reported for manual cleanup");
    } finally { rmSync(tmpDir, { recursive: true, force: true }); }
    assert.equal(readFileSync(anchorMetaPath, "utf8"), before, "anchor still byte-identical");
    const tmuxCalls2 = readFileSync(tmuxLog, "utf8");
    assert.match(tmuxCalls2, /kill-window -t =oas-test-fake:=dev-zomb2/, "window killed despite temp-cleanup failure");
    const events2 = readFileSync(hookLog, "utf8").trim().split("\n");
    assert.ok(events2.includes("retire:dev-zomb2"), "hooks compensated despite temp-cleanup failure");
    assert.equal(existsSync(join(root, "dev", "instances", "dev-zomb2")), false, "scaffold removed despite temp-cleanup failure");

    // Home-removal failure must be REPORTED as incomplete with the failed
    // path — never claimed as cleaned up. The retire hook (which compensation
    // runs BEFORE home removal) plants a read-only subdir inside the home so
    // rmSync(home) fails: the zombie home remains and the message says so.
    const tmpDir3 = `${anchorMetaPath}.tmp-dev-zomb3`;
    mkdirSync(tmpDir3); write(join(tmpDir3, "blocker"), "x"); // anchor write fails again
    write(join(repo, ".agents", "capabilities", "owned", "comp", "hook.mjs"),
      `import {appendFileSync, mkdirSync, writeFileSync, chmodSync} from 'node:fs';\n` +
      `appendFileSync(${JSON.stringify(hookLog)}, process.env.OAS_EVENT + ':' + process.env.OAS_INSTANCE + '\\n');\n` +
      `if (process.env.OAS_EVENT === 'retire' && process.env.OAS_INSTANCE === 'dev-zomb3') {\n` +
      `  const d = process.env.OAS_HOME + '/locked'; mkdirSync(d); writeFileSync(d + '/pin', 'x'); chmodSync(d, 0o555);\n` +
      `}\n`);
    const zombHome = join(root, "dev", "instances", "dev-zomb3");
    try {
      assert.throws(
        () => spawnInstance(root, agentDef, { instance: "dev-zomb3", relation: "parent", relativeTo: anchor.instance, tmuxSession: "oas-test-fake", launch: false }),
        /failed to re-point anchor.*rollback INCOMPLETE.*instance home/s,
        "unremovable home reported as incomplete with the failed path");
      assert.ok(existsSync(zombHome), "zombie home really remains (message told the truth)");
    } finally {
      rmSync(tmpDir3, { recursive: true, force: true });
      if (existsSync(join(zombHome, "locked"))) execFileSync("chmod", ["755", join(zombHome, "locked")]);
      rmSync(zombHome, { recursive: true, force: true });
    }

    // Stubborn window: kill-window "succeeds" (exit 0) but the window remains
    // — the effect check must report it (exit codes are not truth).
    const tmpDir4 = `${anchorMetaPath}.tmp-dev-zomb4`;
    mkdirSync(tmpDir4); write(join(tmpDir4, "blocker"), "x");
    process.env.TMUX_FAKE_STUBBORN = "dev-zomb4";
    try {
      assert.throws(
        () => spawnInstance(root, agentDef, { instance: "dev-zomb4", relation: "parent", relativeTo: anchor.instance, tmuxSession: "oas-test-fake", launch: true }),
        /rollback INCOMPLETE.*tmux window oas-test-fake:dev-zomb4 still running/s,
        "unkillable window reported despite kill-window exiting 0");
    } finally {
      delete process.env.TMUX_FAKE_STUBBORN;
      rmSync(tmpDir4, { recursive: true, force: true });
    }

    // Probe failure is NOT confirmation: when list-windows itself fails, the
    // rollback must fail CLOSED and report could-not-verify, not success.
    const tmpDir4b = `${anchorMetaPath}.tmp-dev-zomb4b`;
    mkdirSync(tmpDir4b); write(join(tmpDir4b, "blocker"), "x");
    process.env.TMUX_FAKE_LIST_FAIL = "1";
    try {
      assert.throws(
        () => spawnInstance(root, agentDef, { instance: "dev-zomb4b", relation: "parent", relativeTo: anchor.instance, tmuxSession: "oas-test-fake", launch: true }),
        /rollback INCOMPLETE.*tmux window oas-test-fake:dev-zomb4b: could not verify removal/s,
        "failed verification probe reported as could-not-verify, never as success");
    } finally {
      delete process.env.TMUX_FAKE_LIST_FAIL;
      rmSync(tmpDir4b, { recursive: true, force: true });
    }

    // Failing retire hook: runLifecycleHooks catches hook errors internally,
    // so the rollback must read the structured failures field.
    const tmpDir5 = `${anchorMetaPath}.tmp-dev-zomb5`;
    mkdirSync(tmpDir5); write(join(tmpDir5, "blocker"), "x");
    write(join(repo, ".agents", "capabilities", "owned", "comp", "hook.mjs"),
      `import {appendFileSync} from 'node:fs';\n` +
      `appendFileSync(${JSON.stringify(hookLog)}, process.env.OAS_EVENT + ':' + process.env.OAS_INSTANCE + '\\n');\n` +
      `if (process.env.OAS_EVENT === 'retire' && process.env.OAS_INSTANCE === 'dev-zomb5') process.exit(3);\n`);
    try {
      assert.throws(
        () => spawnInstance(root, agentDef, { instance: "dev-zomb5", relation: "parent", relativeTo: anchor.instance, tmuxSession: "oas-test-fake", launch: false }),
        /rollback INCOMPLETE.*retire hook acme\.comp/s,
        "nonzero retire hook reported via structured failures");
    } finally { rmSync(tmpDir5, { recursive: true, force: true }); }

    // Failed worktree removal: a foreign file inside the worktree with
    // worktree remove blocked — verify via `git worktree list` effect check.
    write(join(root, "dev", "soul", "soul.yaml"), `name: dev\nkind: persistent\nrepo: ${repo}\nwork: worktree\nruntime: pi\n`);
    const tmpDir6 = `${anchorMetaPath}.tmp-dev-zomb6`;
    mkdirSync(tmpDir6); write(join(tmpDir6, "blocker"), "x");
    write(join(repo, ".agents", "capabilities", "owned", "comp", "hook.mjs"),
      `import {appendFileSync, mkdirSync as mk, writeFileSync as wf, chmodSync} from 'node:fs';\n` +
      `appendFileSync(${JSON.stringify(hookLog)}, process.env.OAS_EVENT + ':' + process.env.OAS_INSTANCE + '\\n');\n` +
      `if (process.env.OAS_EVENT === 'retire' && process.env.OAS_INSTANCE === 'dev-zomb6') {\n` +
      `  const d = process.env.OAS_HOME + '/work/pin'; mk(d); wf(d + '/x', 'x'); chmodSync(d, 0o555); chmodSync(process.env.OAS_HOME + '/work', 0o555);\n` +
      `}\n`);
    const zomb6Home = join(root, "dev", "instances", "dev-zomb6");
    try {
      assert.throws(
        () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-zomb6", relation: "parent", relativeTo: anchor.instance, tmuxSession: "oas-test-fake", launch: false }),
        /rollback INCOMPLETE.*(git worktree .* still registered|instance home)/s,
        "failed worktree cleanup reported");
    } finally {
      rmSync(tmpDir6, { recursive: true, force: true });
      if (existsSync(join(zomb6Home, "work"))) {
        execFileSync("chmod", ["-R", "755", join(zomb6Home, "work")]);
        try { execFileSync("git", ["-C", repo, "worktree", "remove", "--force", join(zomb6Home, "work")], { stdio: "ignore" }); } catch { /* cleanup best-effort */ }
      }
      rmSync(zomb6Home, { recursive: true, force: true });
      try { execFileSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" }); } catch { /* cleanup best-effort */ }
    }

    // SECURITY regression: branch names may contain valid-but-hostile shell
    // metacharacters ($(…) passes check-ref-format). The rollback's branch
    // verification must never interpolate them into a shell.
    const marker = join(base, "pwn-marker");
    const evilBranch = `agents/pwn$(touch\${IFS}${marker})`;
    execFileSync("git", ["check-ref-format", `refs/heads/${evilBranch}`]); // fixture sanity: valid ref
    const tmpDir7 = `${anchorMetaPath}.tmp-dev-zomb7`;
    mkdirSync(tmpDir7); write(join(tmpDir7, "blocker"), "x");
    const zomb7Home = join(root, "dev", "instances", "dev-zomb7");
    try {
      assert.throws(
        () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-zomb7", relation: "parent", relativeTo: anchor.instance, branch: evilBranch, tmuxSession: "oas-test-fake", launch: false }),
        /failed to re-point anchor/s,
        "rollback runs with the hostile branch name");
      assert.equal(existsSync(marker), false, "no command injection: metacharacter branch never executed");
    } finally {
      rmSync(tmpDir7, { recursive: true, force: true });
      if (existsSync(join(zomb7Home, "work"))) {
        try { execFileSync("git", ["-C", repo, "worktree", "remove", "--force", join(zomb7Home, "work")], { stdio: "ignore" }); } catch { /* best-effort */ }
      }
      rmSync(zomb7Home, { recursive: true, force: true });
      try { execFileSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" }); } catch { /* best-effort */ }
      try { execFileSync("git", ["-C", repo, "branch", "-D", evilBranch], { stdio: "ignore" }); } catch { /* best-effort */ }
    }
  } finally { process.env.PATH = oldPath; }
});

test("rollback detects a still-registered canonical worktree through a symlinked agents root", () => {
  const base = temp(); const repo = join(base, "repo"); gitRepo(repo);
  const realRoot = join(repo, "agents");
  write(join(realRoot, "dev", "soul", "soul.yaml"), `name: dev\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
  write(join(realRoot, "dev", "soul", "AGENTS.md"), "# dev\n");
  mkdirSync(join(realRoot, "dev", "instances"), { recursive: true });
  // Compensation hook can remove one target's worktree directory BEFORE Git
  // verification, reproducing the canonical-path-loss race from review.
  const vanishHook = `import {rmSync} from 'node:fs'; if (process.env.OAS_EVENT === 'retire' && process.env.OAS_INSTANCE === 'dev-sym-missing') rmSync(process.env.OAS_HOME + '/work', {recursive:true, force:true});`;
  capability(repo, "vanish", { capability: "acme.vanish", hooks: { retire: "hook.mjs" } }, { "hook.mjs": vanishHook });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.vanish:\n      global: true\n");
  const linkedRoot = join(base, "agents-link"); symlinkSync(realRoot, linkedRoot);

  // Git wrapper delegates normally, but can force selected cleanup/probe operations to fail.
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  write(join(bin, "git"), `#!/bin/sh\nif [ "$GIT_FAKE_VANISH_AFTER_ADD" = "1" ] && [ "$3" = "worktree" ] && [ "$4" = "add" ]; then ${realGit} "$@"; s=$?; if [ $s -eq 0 ]; then /bin/rm -rf "$5"; fi; exit $s; fi\nif [ "$GIT_FAKE_FAIL_REMOVE" = "1" ] && [ "$3" = "worktree" ] && [ "$4" = "remove" ]; then echo forced-remove-failure >&2; exit 7; fi\nif [ "$GIT_FAKE_FAIL_PRUNE" = "1" ] && [ "$3" = "worktree" ] && [ "$4" = "prune" ]; then echo forced-prune-failure >&2; exit 6; fi\nif [ "$GIT_FAKE_FAIL_LIST" = "1" ] && [ "$3" = "worktree" ] && [ "$4" = "list" ]; then echo forced-list-failure >&2; exit 8; fi\nif [ "$GIT_FAKE_FAIL_REVP" = "1" ] && [ "$3" = "rev-parse" ] && [ "$4" = "--verify" ]; then echo forced-rev-parse-failure >&2; exit 9; fi\nexec ${realGit} "$@"\n`);
  for (const t of ["pi", "claude"]) write(join(bin, t), "#!/bin/sh\nexit 0\n");
  execFileSync("chmod", ["-R", "+x", bin]);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  let branch;
  try {
    const agentDef = findAgent(linkedRoot, "dev");

    // Post-add canonicalization failure: wrapper removes the just-added tree
    // before `realpathSync(wt)`, while remove+prune cleanup also fail. The
    // error must retain the original canonicalization failure AND report the
    // stranded Git state as rollback INCOMPLETE (never silently best-effort).
    const earlyBranch = "agents/dev-early-canon";
    process.env.GIT_FAKE_VANISH_AFTER_ADD = "1";
    process.env.GIT_FAKE_FAIL_REMOVE = "1";
    process.env.GIT_FAKE_FAIL_PRUNE = "1";
    try {
      assert.throws(
        () => spawnInstance(linkedRoot, agentDef, { instance: "dev-early-canon", work: "worktree", branch: earlyBranch, launch: false }),
        (err) => /git worktree add\/canonicalization failed/.test(err.message)
          && /rollback INCOMPLETE/.test(err.message)
          && /remove failed \(forced-remove-failure\)/.test(err.message)
          && /prune failed \(forced-prune-failure\)/.test(err.message)
          && /could not verify removal \(canonical path unavailable after add\)/.test(err.message),
        "post-add canonicalization failure reports incomplete Git cleanup");
      assert.equal(existsSync(join(linkedRoot, "dev", "instances", "dev-early-canon")), false, "failed spawn home removed");
    } finally {
      delete process.env.GIT_FAKE_VANISH_AFTER_ADD;
      delete process.env.GIT_FAKE_FAIL_REMOVE;
      delete process.env.GIT_FAKE_FAIL_PRUNE;
      execFileSync(realGit, ["-C", repo, "worktree", "prune"]);
      try { execFileSync(realGit, ["-C", repo, "branch", "-D", earlyBranch], { stdio: "ignore" }); } catch { /* cleanup */ }
    }

    const anchor = spawnInstance(linkedRoot, agentDef, { instance: "dev-sym-anchor", launch: false });
    const anchorMetaPath = join(anchor.home, "instance.json");
    const tmpBlock = `${anchorMetaPath}.tmp-dev-sym-child`;
    mkdirSync(tmpBlock); write(join(tmpBlock, "blocker"), "x");
    branch = "agents/dev-sym-child";
    process.env.GIT_FAKE_FAIL_REMOVE = "1";
    try {
      assert.throws(
        () => spawnInstance(linkedRoot, agentDef, { instance: "dev-sym-child", relation: "parent", relativeTo: anchor.instance, work: "worktree", branch, launch: false }),
        (err) => /rollback INCOMPLETE/.test(err.message)
          && /git worktree .*dev-sym-child\/work: still registered/.test(err.message)
          && !err.message.includes(linkedRoot + "/dev/instances/dev-sym-child/work"),
        "canonical registered path is detected and reported, not the lexical symlink path");
    } finally {
      delete process.env.GIT_FAKE_FAIL_REMOVE;
      rmSync(tmpBlock, { recursive: true, force: true });
    }
    // Rollback removed the files but the forced Git failure left registration;
    // prune after the path is gone clears metadata, then remove the branch.
    execFileSync(realGit, ["-C", repo, "worktree", "prune"]);
    try { execFileSync(realGit, ["-C", repo, "branch", "-D", branch], { stdio: "ignore" }); } catch { /* cleanup */ }

    // Canonical path was captured immediately after add. The compensation hook
    // now REMOVES the directory before rollback; remove and prune are forced to
    // fail, while list succeeds and still returns Git's canonical registration.
    // Re-realpath-at-rollback would fail/fall back lexical and miss this record.
    const missingAnchor = spawnInstance(linkedRoot, agentDef, { instance: "dev-missing-anchor", launch: false });
    const tmpMissing = `${join(missingAnchor.home, "instance.json")}.tmp-dev-sym-missing`;
    mkdirSync(tmpMissing); write(join(tmpMissing, "blocker"), "x");
    const missingBranch = "agents/dev-sym-missing";
    process.env.GIT_FAKE_FAIL_REMOVE = "1";
    process.env.GIT_FAKE_FAIL_PRUNE = "1";
    try {
      assert.throws(
        () => spawnInstance(linkedRoot, agentDef, { instance: "dev-sym-missing", relation: "parent", relativeTo: missingAnchor.instance, work: "worktree", branch: missingBranch, launch: false }),
        (err) => /rollback INCOMPLETE/.test(err.message)
          && /git worktree .*dev-sym-missing\/work: still registered/.test(err.message)
          && !err.message.includes(linkedRoot + "/dev/instances/dev-sym-missing/work"),
        "captured canonical path detects stale registration after the directory vanished");
    } finally {
      delete process.env.GIT_FAKE_FAIL_REMOVE;
      delete process.env.GIT_FAKE_FAIL_PRUNE;
      rmSync(tmpMissing, { recursive: true, force: true });
      execFileSync(realGit, ["-C", repo, "worktree", "prune"]);
      try { execFileSync(realGit, ["-C", repo, "branch", "-D", missingBranch], { stdio: "ignore" }); } catch { /* cleanup */ }
    }

    // Probe failure is distinct from confirmed absence: let removal/deletion
    // succeed, but force BOTH verification commands to fail. Rollback must
    // report could-not-verify for each instead of treating failed probes as
    // proof that worktree/ref are gone.
    const anchor2 = spawnInstance(linkedRoot, agentDef, { instance: "dev-probe-anchor", launch: false });
    const tmpBlock2 = `${join(anchor2.home, "instance.json")}.tmp-dev-sym-probe`;
    mkdirSync(tmpBlock2); write(join(tmpBlock2, "blocker"), "x");
    const probeBranch = "agents/dev-sym-probe";
    process.env.GIT_FAKE_FAIL_LIST = "1";
    process.env.GIT_FAKE_FAIL_REVP = "1";
    try {
      assert.throws(
        () => spawnInstance(linkedRoot, agentDef, { instance: "dev-sym-probe", relation: "parent", relativeTo: anchor2.instance, work: "worktree", branch: probeBranch, launch: false }),
        (err) => /rollback INCOMPLETE/.test(err.message)
          && /git worktree .*could not verify removal \(forced-list-failure\)/s.test(err.message)
          && /git branch agents\/dev-sym-probe: could not verify deletion \(forced-rev-parse-failure\)/s.test(err.message),
        "failed Git probes report could-not-verify, never confirmed absence");
    } finally {
      delete process.env.GIT_FAKE_FAIL_LIST;
      delete process.env.GIT_FAKE_FAIL_REVP;
      rmSync(tmpBlock2, { recursive: true, force: true });
      execFileSync(realGit, ["-C", repo, "worktree", "prune"]);
      try { execFileSync(realGit, ["-C", repo, "branch", "-D", probeBranch], { stdio: "ignore" }); } catch { /* cleanup */ }
    }
  } finally {
    delete process.env.GIT_FAKE_VANISH_AFTER_ADD;
    delete process.env.GIT_FAKE_FAIL_REMOVE;
    delete process.env.GIT_FAKE_FAIL_PRUNE;
    delete process.env.GIT_FAKE_FAIL_LIST;
    delete process.env.GIT_FAKE_FAIL_REVP;
    process.env.PATH = oldPath;
    try { execFileSync(realGit, ["-C", repo, "worktree", "prune"], { stdio: "ignore" }); } catch { /* cleanup */ }
    if (branch) try { execFileSync(realGit, ["-C", repo, "branch", "-D", branch], { stdio: "ignore" }); } catch { /* cleanup */ }
  }
});

test("retire splice crosses member repos inside a team deployment", () => {
  const base = temp();
  const ws = join(base, "ws"); mkdirSync(ws, { recursive: true });
  write(join(ws, "oas-config.yaml"), "team:\n  name: t\n");
  const mkMember = (repoName, soulName) => {
    const repo = join(ws, repoName); gitRepo(repo);
    write(join(repo, "oas-config.yaml"), "capabilities:\n  additive: {}\n");
    const root = join(repo, "agents");
    write(join(root, soulName, "soul", "soul.yaml"), `name: ${soulName}\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
    write(join(root, soulName, "soul", "AGENTS.md"), `# ${soulName}\n`);
    mkdirSync(join(root, soulName, "instances"), { recursive: true });
    return { repo, root };
  };
  const a = mkMember("repo-a", "dev");
  const b = mkMember("repo-b", "expert");
  const oldPath = process.env.PATH;
  process.env.PATH = fakeRuntimes(base);
  try {
    // Anchor lives in repo A; the parent-relation instance homes in repo B
    // (spawn resolves cross-repo anchors via findTeamInstance).
    const anchor = spawnInstance(a.root, findAgent(a.root, "dev"), { instance: "dev-anchor", launch: false });
    const boss = spawnInstance(b.root, findAgent(b.root, "expert"), { instance: "expert-boss", relation: "parent", relativeTo: anchor.instance, launch: false });
    const anchorMeta = () => JSON.parse(readFileSync(join(a.root, "dev", "instances", anchor.instance, "instance.json"), "utf8"));
    assert.equal(anchorMeta().parentInstance, boss.instance, "cross-repo parent relation recorded");
    // Retiring the repo-B instance must repair the repo-A anchor: the splice
    // scans every team agents root, not just the retiree's.
    const r = retireInstance(b.root, boss.instance, { keepDir: false });
    assert.ok(r.relinked?.some((x) => x.instance === anchor.instance), "splice reached the sibling repo");
    assert.equal(anchorMeta().parentInstance, undefined, "repo-A anchor no longer points at the retired repo-B instance");
  } finally { process.env.PATH = oldPath; }
});

test("retire splice is identity-safe: a same-named instance in another repo keeps its links", () => {
  const base = temp();
  const ws = join(base, "ws"); mkdirSync(ws, { recursive: true });
  write(join(ws, "oas-config.yaml"), "team:\n  name: t\n");
  const mkMember = (repoName) => {
    const repo = join(ws, repoName); gitRepo(repo);
    write(join(repo, "oas-config.yaml"), "capabilities:\n  additive: {}\n");
    const root = join(repo, "agents");
    write(join(root, "dev", "soul", "soul.yaml"), `name: dev\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
    write(join(root, "dev", "soul", "AGENTS.md"), "# dev\n");
    mkdirSync(join(root, "dev", "instances"), { recursive: true });
    return { repo, root };
  };
  const a = mkMember("repo-a");
  const b = mkMember("repo-b");
  const oldPath = process.env.PATH;
  process.env.PATH = fakeRuntimes(base);
  try {
    // SAME instance name in both repos (names are only unique per agent dir).
    const bossA = spawnInstance(a.root, findAgent(a.root, "dev"), { instance: "dev-boss", launch: false });
    const bossB = spawnInstance(b.root, findAgent(b.root, "dev"), { instance: "dev-boss", launch: false });
    assert.equal(bossA.instance, bossB.instance, "fixture: duplicate names across repos");
    // Each repo's child points at ITS OWN dev-boss (local-first resolution).
    const kidA = spawnInstance(a.root, findAgent(a.root, "dev"), { instance: "dev-kid", relation: "child", relativeTo: "dev-boss", relativeRoot: a.root, launch: false });
    const kidB = spawnInstance(b.root, findAgent(b.root, "dev"), { instance: "dev-kid-b", relation: "child", relativeTo: "dev-boss", relativeRoot: b.root, launch: false });
    const metaOf = (root2, name2) => JSON.parse(readFileSync(join(root2, "dev", "instances", name2, "instance.json"), "utf8"));
    assert.equal(metaOf(a.root, kidA.instance).parentInstance, "dev-boss");
    assert.equal(metaOf(b.root, kidB.instance).parentInstance, "dev-boss");
    // Retiring repo-A's dev-boss must orphan ONLY repo-A's kid: repo-B's edge
    // resolves (local-first) to the still-live repo-B dev-boss and is untouched.
    const r = retireInstance(a.root, "dev-boss", { keepDir: false });
    assert.equal(metaOf(a.root, kidA.instance).parentInstance, undefined, "repo-A kid orphaned to root");
    assert.equal(metaOf(b.root, kidB.instance).parentInstance, "dev-boss", "repo-B kid keeps its own same-named parent");
    assert.ok(!(r.relinked || []).some((x) => x.instance === kidB.instance), "repo-B edge not reported as relinked");
  } finally { process.env.PATH = oldPath; }
});

test("attached ownership is path-first: a same-named local instance cannot shadow the tree's true owner", () => {
  const base = temp();
  const ws = join(base, "ws"); mkdirSync(ws, { recursive: true });
  write(join(ws, "oas-config.yaml"), "team:\n  name: t\n");
  const mkMember = (repoName) => {
    const repo = join(ws, repoName); gitRepo(repo);
    write(join(repo, "oas-config.yaml"), "capabilities:\n  additive: {}\n");
    const root = join(repo, "agents");
    write(join(root, "dev", "soul", "soul.yaml"), `name: dev\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
    write(join(root, "dev", "soul", "AGENTS.md"), "# dev\n");
    mkdirSync(join(root, "dev", "instances"), { recursive: true });
    return { repo, root };
  };
  const a = mkMember("repo-a");
  const b = mkMember("repo-b");
  const oldPath = process.env.PATH;
  process.env.PATH = fakeRuntimes(base);
  try {
    // Same instance name in both repos; the trees differ.
    const bossA = spawnInstance(a.root, findAgent(a.root, "dev"), { instance: "dev-boss", launch: false });
    spawnInstance(b.root, findAgent(b.root, "dev"), { instance: "dev-boss", launch: false });
    // Spawning ATTACHED from repo B onto repo A's dev-boss/work: the path-first
    // match finds A's boss, but from B's root the NAME "dev-boss" resolves to
    // B's (local-first) — recording it would link the child to the wrong
    // instance. Reject as ambiguous, both with and without an explicit parent.
    assert.throws(
      () => spawnInstance(b.root, findAgent(b.root, "dev"), { instance: "dev-att-x", work: "attached", workDir: join(a.root, "dev", "instances", bossA.instance, "work"), launch: false }),
      /ambiguous/,
      "ownership inference rejects the shadowed owner");
    assert.throws(
      () => spawnInstance(b.root, findAgent(b.root, "dev"), { instance: "dev-att-y", work: "attached", workDir: join(a.root, "dev", "instances", bossA.instance, "work"), parent: "dev-boss", launch: false }),
      /ambiguous/,
      "explicit --parent cannot bypass the shadow check — the tree IS an instance's work");
    // No stray homes were scaffolded by the rejected spawns.
    assert.equal(existsSync(join(b.root, "dev", "instances", "dev-att-x")), false);
    assert.equal(existsSync(join(b.root, "dev", "instances", "dev-att-y")), false);
    // Unambiguous case still works from the OWNING repo: A's boss tree, A's root.
    const ok = spawnInstance(a.root, findAgent(a.root, "dev"), { instance: "dev-att-ok", work: "attached", workDir: join(a.root, "dev", "instances", bossA.instance, "work"), launch: false });
    assert.equal(ok.parentInstance, bossA.instance, "owner resolved by path where the name is unambiguous");
  } finally { process.env.PATH = oldPath; }
});

test("attached owner discovery reaches all-local sibling scopes (no agents/ dir)", () => {
  const base = temp();
  const ws = join(base, "ws"); mkdirSync(ws, { recursive: true });
  write(join(ws, "oas-config.yaml"), "team:\n  name: t\n");
  // Repo A: ALL-LOCAL — no agents/ dir, its soul lives under local-agents/.
  const repoA = join(ws, "repo-a"); gitRepo(repoA);
  write(join(repoA, "oas-config.yaml"), "capabilities:\n  additive: {}\n");
  const laDir = join(repoA, "local-agents");
  write(join(laDir, "helper", "soul", "soul.yaml"), `name: helper\nkind: local\nrepo: ${repoA}\nwork: worktree\nruntime: pi\n`);
  write(join(laDir, "helper", "soul", "AGENTS.md"), "# helper\n");
  mkdirSync(join(laDir, "helper", "instances"), { recursive: true });
  // Repo B: regular agents/ root; spawns attach onto A's local instance tree.
  const repoB = join(ws, "repo-b"); gitRepo(repoB);
  write(join(repoB, "oas-config.yaml"), "capabilities:\n  additive: {}\n");
  const rootB = join(repoB, "agents");
  write(join(rootB, "dev", "soul", "soul.yaml"), `name: dev\nkind: persistent\nrepo: ${repoB}\nwork: checkout\nruntime: pi\n`);
  write(join(rootB, "dev", "soul", "AGENTS.md"), "# dev\n");
  mkdirSync(join(rootB, "dev", "instances"), { recursive: true });
  const oldPath = process.env.PATH;
  process.env.PATH = fakeRuntimes(base);
  try {
    const rootA = join(repoA, "agents"); // nonexistent — the all-local case
    const helperAgent = findAgent(rootA, "helper");
    assert.ok(helperAgent, "fixture: local soul resolves through the nonexistent agents/ root");
    const owner = spawnInstance(rootA, helperAgent, { instance: "helper-owner", launch: false });
    // Owner discovery from repo B must reach A's local-agents instance even
    // though teamAgentRoots yields A's NONEXISTENT agents/ root for it.
    const kid = spawnInstance(rootB, findAgent(rootB, "dev"), { instance: "dev-att-la", work: "attached", workDir: join(owner.home, "work"), launch: false });
    assert.equal(kid.parentInstance, owner.instance, "all-local sibling owner discovered by path");
    // Shadow + explicit parent must still be rejected: same-named instance in
    // B's OWN local-agents (names are only unique per agent dir).
    const laB = join(repoB, "local-agents");
    write(join(laB, "helper", "soul", "soul.yaml"), `name: helper\nkind: local\nrepo: ${repoB}\nwork: worktree\nruntime: pi\n`);
    write(join(laB, "helper", "soul", "AGENTS.md"), "# helper\n");
    mkdirSync(join(laB, "helper", "instances"), { recursive: true });
    spawnInstance(rootB, findAgent(rootB, "helper"), { instance: owner.instance, launch: false });
    assert.throws(
      () => spawnInstance(rootB, findAgent(rootB, "dev"), { instance: "dev-att-sh", work: "attached", workDir: join(owner.home, "work"), parent: owner.instance, launch: false }),
      /ambiguous/,
      "shadowed all-local owner rejected even with explicit --parent");
    assert.equal(existsSync(join(rootB, "dev", "instances", "dev-att-sh")), false, "no stray home scaffolded");

    // Retire-splice must ALSO reach the all-local scope (its nonexistent
    // agents/ root is in the scan set): an orphan homed under A's
    // local-agents whose parent lives in repo B gets repaired when that
    // parent retires — this fails if the splice drops unresolvable roots.
    const bossB = spawnInstance(rootB, findAgent(rootB, "dev"), { instance: "dev-la-boss", launch: false });
    const orphanA = spawnInstance(rootA, helperAgent, { instance: "helper-orphan", relation: "child", relativeTo: bossB.instance, launch: false });
    const orphanMeta = () => JSON.parse(readFileSync(join(orphanA.home, "instance.json"), "utf8"));
    assert.equal(orphanMeta().parentInstance, bossB.instance, "cross-repo child into the all-local scope");
    const rr = retireInstance(rootB, bossB.instance, { keepDir: false });
    assert.ok(rr.relinked?.some((x) => x.instance === orphanA.instance), "splice reports the all-local orphan");
    assert.equal(orphanMeta().parentInstance, undefined, "all-local orphan repaired to root");
  } finally { process.env.PATH = oldPath; }
});

test("lineage is deployment-local: --parent from an unrelated deployment is rejected", () => {
  const base = temp();
  // Deployment A: the caller's instance lives here.
  const a = fixtureSoul(base);
  // Deployment B: a separate repo + agents root (oas-support's --dir <repo> case).
  const repoB = join(base, "other-repo"); gitRepo(repoB);
  const rootB = join(repoB, "agents");
  write(join(rootB, "expert", "soul", "soul.yaml"), `name: expert\nkind: persistent\nrepo: ${repoB}\nwork: checkout\nruntime: pi\n`);
  write(join(rootB, "expert", "soul", "AGENTS.md"), "# expert\n");
  mkdirSync(join(rootB, "expert", "instances"), { recursive: true });
  const env = { ...process.env, PATH: fakeRuntimes(base), PI_AGENTS_TMUX_SESSION: "oas-test-nosuch" };
  delete env.PI_AGENTS_ROOT;
  // A real instance in deployment A…
  let r = spawnSync(process.execPath, [CLI, "spawn", "dev", "--purpose", "caller", "--no-launch", "--json"], { cwd: a.repo, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const caller = jsonResult(r);
  // …is NOT a valid parent when spawning into deployment B (its hierarchy
  // cannot resolve foreign instances — cross-deployment spawns are operator-origin).
  r = spawnSync(process.execPath, [CLI, "spawn", "expert", "--dir", repoB, "--parent", caller.instance, "--purpose", "x", "--no-launch"], { cwd: a.repo, env, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not match any known instance/);
  // Without --parent the cross-deployment spawn lands top-level in B.
  r = spawnSync(process.execPath, [CLI, "spawn", "expert", "--dir", repoB, "--task", "support question", "--purpose", "x", "--no-launch", "--json"], { cwd: a.repo, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const expert = jsonResult(r);
  assert.equal(expert.spawnOrigin, "operator");
  assert.equal(expert.parent, null);
  assert.match(readFileSync(join(expert.home, "TASK.md"), "utf8"), /support question/);
});

test("traversal names are rejected: --parent and retire cannot reach outside instances/", () => {
  const base = temp(); const { repo, root, soul, agent } = fixtureSoul(base);
  const env = { ...process.env, PATH: fakeRuntimes(base), PI_AGENTS_TMUX_SESSION: "oas-test-nosuch" };
  delete env.PI_AGENTS_ROOT;
  // A real instance to anchor the fixture (and prove normal lookups still work).
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  let real;
  try { real = spawnInstance(root, agent, { instance: "dev-real", launch: false }); }
  finally { process.env.PATH = oldPath; }
  return import("../lib/core.mjs").then((core) => {
    // Kernel: traversal / separator / dotted names never resolve…
    for (const bad of ["../../dev/soul", "..", "dev/soul", "./dev-real", "dev-real/../../soul"]) {
      assert.equal(core.findInstanceHome(root, bad), undefined, `rejected: ${bad}`);
    }
    // …while the plain name still does, as an immediate child of instances/.
    assert.ok(core.findInstanceHome(root, "dev-real"));
    // CLI spawn --parent with a traversal name fails BEFORE scaffolding.
    const before = readdirSync(join(root, "dev", "instances"));
    let r = spawnSync(process.execPath, [CLI, "spawn", "dev", "--parent", "../../dev/soul", "--purpose", "evil", "--no-launch"], { cwd: repo, env, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not match any known instance/);
    assert.deepEqual(readdirSync(join(root, "dev", "instances")), before, "no home scaffolded");
    // CLI retire with a traversal name fails BEFORE any delete — the canonical soul survives.
    r = spawnSync(process.execPath, [CLI, "retire", "../../dev/soul"], { cwd: repo, env, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no instance named/);
    assert.ok(existsSync(join(soul, "soul.yaml")), "canonical soul.yaml survives");
    assert.ok(existsSync(join(soul, "AGENTS.md")), "canonical AGENTS.md survives");
    // Kernel retire with a traversal name also refuses.
    assert.throws(() => core.retireInstance(root, "../../dev/soul", { tmuxSession: "oas-test-nosuch" }), /no instance named/);
    assert.ok(existsSync(join(soul, "soul.yaml")));
    // A VALIDLY NAMED symlink inside instances/ that points OUTSIDE must also be
    // rejected — this exercises the realpath containment guard independently of
    // the charset regex (the target's basename intentionally matches the name).
    const outside = join(base, "outside", "dev-linked");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "precious.txt"), "keep me");
    symlinkSync(outside, join(root, "dev", "instances", "dev-linked"));
    assert.equal(core.findInstanceHome(root, "dev-linked"), undefined, "escaping symlink rejected by containment");
    assert.throws(() => core.retireInstance(root, "dev-linked", { tmuxSession: "oas-test-nosuch" }), /no instance named/);
    assert.ok(existsSync(join(outside, "precious.txt")), "symlink target untouched");
    // Real instance still retires normally.
    core.retireInstance(root, "dev-real", { tmuxSession: "oas-test-nosuch" });
    assert.ok(!existsSync(real.home));
  });
});

test("local souls: --local creates a full gitignored soul beside agents/, with memory and injection", () => {
  const base = temp(); const repo = join(base, "repo"); gitRepo(repo);
  const env = { ...process.env, PATH: fakeRuntimes(base), PI_AGENTS_TMUX_SESSION: "oas-test-nosuch" }; delete env.PI_AGENTS_ROOT;
  // Bootstrap: NO agents/ dir exists — --local must still work (all-local scopes).
  let r = spawnSync(process.execPath, [CLI, "create", "helper", "--local", "--description", "Local helper.", "--dir", repo], { cwd: repo, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /LOCAL agent/);
  // Soul lives at <scope>/local-agents/<name>/soul — sibling of agents/, not nested.
  const soulDir = join(repo, "local-agents", "helper", "soul");
  assert.ok(existsSync(join(soulDir, "soul.yaml")), "local soul scaffolded at scope level");
  assert.ok(!existsSync(join(repo, "agents", "local-agents")), "not nested inside agents/");
  assert.match(readFileSync(join(soulDir, "soul.yaml"), "utf8"), /kind: local/);
  // Gitignore injected exactly once, and git actually ignores the tree.
  assert.match(readFileSync(join(repo, ".gitignore"), "utf8"), /local-agents\//);
  const ignored = spawnSync("git", ["-C", repo, "check-ignore", "local-agents"], { encoding: "utf8" });
  assert.equal(ignored.status, 0, "git ignores local-agents/");
  r = spawnSync(process.execPath, [CLI, "create", "helper2", "--local", "--dir", repo], { cwd: repo, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const gi = readFileSync(join(repo, ".gitignore"), "utf8");
  assert.equal(gi.match(/local-agents\//g).length, 1, "gitignore entry not duplicated");
  // Roster sees local souls (root resolves through the sibling layout).
  return import("../lib/core.mjs").then((core) => {
    const root = core.ensureRoot(repo);
    const agents = core.listAgents(root);
    const helper = agents.find((a) => a.name === "helper");
    assert.ok(helper, "local soul listed");
    assert.equal(helper.kind, "local");
    // Spawn: full memory scaffold (STATE.md via oas-okf would need the layer —
    // kernel-level checks here: local-soul injection composed, soul symlinked).
    const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
    try {
      const res = core.spawnInstance(root, helper, { instance: "helper-1", launch: false, repo });
      assert.match(readFileSync(join(res.home, "AGENTS.md"), "utf8"), /Local soul \(uncommitted\)/);
      assert.equal(JSON.parse(readFileSync(join(res.home, "instance.json"), "utf8")).kind, "local");
      // findInstanceHome + retire see sibling local-agents homes.
      assert.ok(core.findInstanceHome(root, "helper-1"), "instance home found");
      core.retireInstance(root, "helper-1", { tmuxSession: "oas-test-nosuch" });
      assert.ok(!existsSync(res.home));
    } finally { process.env.PATH = oldPath; }
  });
});

test("local souls get memory scaffolding from oas-okf; capability agents stay memory-less and skip the okf injection", () => {
  const base = temp(); const { repo, root } = fixtureSoul(base);
  // Bind oas.okf from the real package tree (owned copy so no lock needed).
  const okfSrc = resolve(new URL("../capabilities/oas-okf", import.meta.url).pathname);
  const dest = join(repo, ".agents", "capabilities", "owned", "oas-okf");
  mkdirSync(dirname(dest), { recursive: true });
  execFileSync("cp", ["-R", okfSrc, dest]);
  write(join(repo, "oas-config.yaml"), "capabilities:\n  layers:\n    knowledge:\n      capability: oas.okf\n      global: true\n");
  capability(repo, "rev", { capability: "acme.rev", agents: ["agents/reviewer"] }, {
    "agents/reviewer/soul.yaml": "name: reviewer\nkind: capability\nwork: checkout\nruntime: pi\ndescription: Reviewer.\n",
    "agents/reviewer/AGENTS.md": "# Reviewer\n",
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  layers:\n    knowledge:\n      capability: oas.okf\n      global: true\n  additive:\n    acme.rev:\n      global: true\n");
  return import("../lib/core.mjs").then((core) => {
    const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
    try {
      // Local soul: full memory scaffold + okf injection.
      const local = core.upsertLocalAgent(root, { name: "scratch", instructions: "# scratch\n", repo });
      assert.equal(local.kind, "local");
      assert.ok(local._dir.includes(join(base, "local-agents")) || local._dir.includes("local-agents"), "homes under local-agents/");
      const res = core.spawnInstance(root, local, { instance: "scratch-1", launch: false, repo });
      assert.ok(existsSync(join(res.home, "STATE.md")), "local soul instance gets STATE.md");
      assert.ok(existsSync(join(res.home, "notes")), "and notes/");
      const agentsMd = readFileSync(join(res.home, "AGENTS.md"), "utf8");
      assert.match(agentsMd, /Knowledge: OKF/);
      assert.match(agentsMd, /Local soul \(uncommitted\)/);
      // Capability agent: no memory files, no okf injection block.
      const cap = core.findCapabilityAgent(repo, root, "reviewer");
      const rev = core.spawnInstance(root, { ...cap, repo }, { instance: "reviewer-1", launch: false });
      assert.ok(!existsSync(join(rev.home, "STATE.md")), "capability agent gets no STATE.md");
      assert.doesNotMatch(readFileSync(join(rev.home, "AGENTS.md"), "utf8"), /Knowledge: OKF/);
      core.retireInstance(root, "scratch-1", { tmuxSession: "oas-test-nosuch" });
      core.retireInstance(root, "reviewer-1", { tmuxSession: "oas-test-nosuch" });
    } finally { process.env.PATH = oldPath; }
  });
});

test("capability-agent trust isolates providers and preserves path/owned structural trust", async () => {
  const core = await import("../lib/core.mjs");
  const base = temp(); const { repo, root } = fixtureSoul(base);

  // Developer-owned path provider: instruction agents are structurally trusted
  // without a lock, while its executable command policy remains unchanged.
  const pathDir = join(base, "path-cap");
  write(join(pathDir, "oas.json"), JSON.stringify({ capability: "path.agent", version: "1.0.0", description: "path", agents: ["agents/helper"], commands: { run: "run.mjs" } }));
  write(join(pathDir, "agents", "helper", "soul.yaml"), "name: helper\nkind: capability\nwork: checkout\nruntime: pi\n");
  write(join(pathDir, "agents", "helper", "AGENTS.md"), "# path helper\n");
  write(join(pathDir, "run.mjs"), "// executable remains subject to old policy\n");

  // Owned provider parity.
  capability(repo, "own-agent", { capability: "owned.agent", agents: ["agents/ownhelper"] }, {
    "agents/ownhelper/soul.yaml": "name: ownhelper\nkind: capability\nwork: checkout\nruntime: pi\n",
    "agents/ownhelper/AGENTS.md": "# owned helper\n",
  });

  // Locked installed provider with two names; tamper after locking.
  const badDir = join(repo, ".agents", "capabilities", "installed", "bad-agent");
  write(join(badDir, "oas.json"), JSON.stringify({ capability: "bad.agent", version: "1.0.0", description: "bad", agents: ["agents/helper", "agents/badonly"] }));
  for (const name of ["helper", "badonly"]) {
    write(join(badDir, "agents", name, "soul.yaml"), `name: ${name}\nkind: capability\nwork: checkout\nruntime: pi\n`);
    write(join(badDir, "agents", name, "AGENTS.md"), `# ${name}\n`);
  }
  writeCapabilityLock(repo, "bad.agent", { source: "path:/fixture", version: "1.0.0", integrity: capabilityIntegrity(badDir), trustedExecutables: false });
  write(join(badDir, "agents", "badonly", "AGENTS.md"), "TAMPERED\n");

  const config = (badFirst) => `capabilities:\n  additive:\n${badFirst ? "    bad.agent:\n      from: installed\n" : ""}    path.agent:\n      from: path:${pathDir}\n    owned.agent:\n      from: owned\n${badFirst ? "" : "    bad.agent:\n      from: installed\n"}`;
  for (const badFirst of [true, false]) {
    write(join(repo, "oas-config.yaml"), config(badFirst));
    const helper = core.findCapabilityAgent(repo, root, "helper");
    assert.equal(helper.capability, "path.agent", `trusted match survives invalid provider ${badFirst ? "before" : "after"}`);
    assert.equal(core.findCapabilityAgent(repo, root, "does-not-exist"), undefined, "unrelated invalid provider never poisons not-found");
  }
  assert.throws(() => core.findCapabilityAgent(repo, root, "badonly"), (e) => e.code === "integrity-drift", "matched tampered provider rejects");
  assert.equal(core.capabilityTrust(core.capabilityManifest("path.agent", repo), repo).trusted, false, "path executable policy remains lock/approval-gated");

  const listed = core.listCapabilityAgents(repo);
  assert.deepEqual(listed.map((a) => `${a.capability}:${a.name}`).sort(), ["owned.agent:ownhelper", "path.agent:helper"]);
  assert.equal(listed.diagnostics.length, 1, "invalid provider reported once");
  assert.equal(listed.diagnostics[0].capability, "bad.agent");
  assert.match(listed.diagnostics[0].message, /integrity/);
  assert.ok(listed.diagnostics[0].provenance, "diagnostic carries provenance");

  const agent = core.findCapabilityAgent(repo, root, "helper");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    const spawned = core.spawnInstance(root, { ...agent, repo }, { instance: "helper-path", launch: false });
    assert.match(readFileSync(join(spawned.home, "AGENTS.md"), "utf8"), /path helper/);
    core.retireInstance(root, "helper-path", { tmuxSession: "oas-test-nosuch" });
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

// ---------- canonical deployment root (instance homes never in a linked worktree) ----------

/** A repo with a soul, plus a linked worktree of it. Mirrors the real shape:
 *  agents/ is committed, agents/<soul>/instances/ is gitignored, so a home
 *  created in the worktree is invisible AND dies with the tree. */
function repoWithWorktree(base) {
  const repo = join(base, "repo"); gitRepo(repo);
  write(join(repo, ".gitignore"), "agents/*/instances/\n");
  const root = join(repo, "agents");
  write(join(root, "dev", "soul", "soul.yaml"), `name: dev\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
  write(join(root, "dev", "soul", "AGENTS.md"), "# Canonical dev\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "soul"]);
  const wt = join(base, "wt");
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", wt, "-b", "feature/x"]);
  return { repo, root, wt, wtRoot: join(wt, "agents") };
}

test("canonicalAgentsRoot maps a linked worktree's agents root onto the primary checkout", async () => {
  const core = await import("../lib/core.mjs");
  const base = temp();
  const { repo, root, wt, wtRoot } = repoWithWorktree(base);
  // The bug this exists to prevent: discovery from the worktree yields the
  // worktree's own agents/ dir.
  assert.equal(core.findRoot(wt), wtRoot, "findRoot still follows the invocation directory");
  // Canonicalization redirects it to the primary checkout, by Git identity —
  // never by branch name.
  // Git reports canonical paths, so the redirect lands on the primary
  // checkout's REAL path (/private/var/... on macOS, not /var/...).
  const real = (p) => realpathSync(p);
  assert.equal(core.canonicalAgentsRoot(wtRoot), real(root));
  assert.equal(core.ensureRoot(wt), real(root), "ensureRoot resolves the canonical deployment root");
  assert.equal(core.ensureRoot(join(wt, "lib")), real(root), "…from any depth inside the worktree");
  // The primary checkout is left exactly as it is.
  assert.equal(core.canonicalAgentsRoot(root), root);
  assert.equal(core.ensureRoot(repo), root);
  execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt]);
  rmSync(base, { recursive: true, force: true });
});

test("canonicalAgentsRoot leaves non-git and out-of-tree roots untouched", async () => {
  const core = await import("../lib/core.mjs");
  const base = temp();
  // Not a Git work tree at all: nothing to canonicalize, behavior unchanged.
  const plain = join(base, "plain", "agents"); mkdirSync(plain, { recursive: true });
  assert.equal(core.canonicalAgentsRoot(plain), plain);
  // A local-only scope whose agents/ does not exist yet still resolves.
  const localScope = join(base, "localonly");
  mkdirSync(join(localScope, "local-agents"), { recursive: true });
  assert.equal(core.canonicalAgentsRoot(join(localScope, "agents")), join(localScope, "agents"));
  rmSync(base, { recursive: true, force: true });
});

test("spawnInstance refuses to create an instance home inside a linked worktree", () => {
  const base = temp();
  const { repo, root, wt, wtRoot } = repoWithWorktree(base);
  const agent = findAgent(wtRoot, "dev");
  assert.ok(agent, "the soul is present in the worktree too — which is what makes the bug silent");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    // The kernel is its own validation boundary: direct callers (desktop server,
    // adapters, tests) bypass the CLI's ensureRoot canonicalization.
    assert.throws(
      () => spawnInstance(wtRoot, agent, { instance: "dev-wt", launch: false }),
      (e) => e.code === "E_NO_CANONICAL_ROOT" && /primary checkout/.test(e.message),
    );
    // Fail closed means fail clean: no home, not even a partial one.
    assert.equal(existsSync(join(wtRoot, "dev", "instances", "dev-wt")), false, "no scaffold left in the worktree");
    assert.equal(existsSync(join(root, "dev", "instances", "dev-wt")), false, "and none in the primary checkout");
    // Spawning against the canonical root is unaffected.
    const spawned = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-ok", launch: false });
    assert.equal(spawned.home, join(root, "dev", "instances", "dev-ok"));
    retireInstance(root, "dev-ok", { tmuxSession: "oas-test-nosuch" });
  } finally { process.env.PATH = oldPath; }
  execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt]);
  rmSync(base, { recursive: true, force: true });
});

test("spawnInstance validates the AGENT DIR, not just the root (reviewer-2366d09)", () => {
  const base = temp();
  const { repo, root, wt, wtRoot } = repoWithWorktree(base);
  // The hole: canonicalize the root, but keep an agent resolved from the LINKED
  // root. A root-only guard passes and the home is still built under
  // `agent._dir/instances/…` — inside the worktree.
  const linkedAgent = findAgent(wtRoot, "dev");
  assert.equal(linkedAgent._dir, join(wtRoot, "dev"), "the agent carries the linked dir");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    assert.throws(
      () => spawnInstance(root, linkedAgent, { instance: "dev-mixed", launch: false }),
      (e) => e.code === "E_NO_CANONICAL_ROOT" && /agent directory for "dev"/.test(e.message),
      "canonical root + linked agent dir must still fail closed",
    );
    assert.equal(existsSync(join(wtRoot, "dev", "instances", "dev-mixed")), false, "no home in the worktree");
  } finally { process.env.PATH = oldPath; }
  execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt]);
  rmSync(base, { recursive: true, force: true });
});

test("a failed Git probe fails closed instead of passing as a non-Git scope (reviewer-2366d09)", async () => {
  const core = await import("../lib/core.mjs");
  const base = temp();
  const { repo, root, wt, wtRoot } = repoWithWorktree(base);
  // git unavailable / dubious ownership / unreadable metadata: rev-parse fails
  // while the location is still plainly Git-owned. Treating that as "not a repo"
  // would let the linked worktree through — the fail-open this guards.
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  write(join(bin, "git"), `#!/bin/sh\necho "fatal: detected dubious ownership" >&2\nexit 128\n`);
  execFileSync("chmod", ["+x", join(bin, "git")]);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    assert.throws(
      () => core.canonicalAgentsRoot(wtRoot),
      (e) => e.code === "E_NO_CANONICAL_ROOT" && /could not be read/.test(e.message),
      "a Git-owned location with an unreadable repository must not pass as non-Git",
    );
    // A genuinely non-Git scope (no .git marker anywhere above) still passes through.
    const plain = join(base, "plain", "agents"); mkdirSync(plain, { recursive: true });
    assert.equal(core.canonicalAgentsRoot(plain), plain);
  } finally { process.env.PATH = oldPath; }
  execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt]);
  rmSync(base, { recursive: true, force: true });
});

test("OAS_INSTANCE_HOME is exported to the runtime and to lifecycle hooks, aliases retained", () => {
  const base = temp();
  const { repo, root, soul } = fixtureSoul(base, "pi");
  // A hook that records the env it was given.
  const probe = `import {writeFileSync} from 'node:fs';
writeFileSync(process.env.OAS_CONTEXT + '/hook-env.json', JSON.stringify({
  instanceHome: process.env.OAS_INSTANCE_HOME || null,
  legacyHome: process.env.OAS_HOME || null,
  storeDir: process.env.OAS_HOME_DIR || null,
}));
console.log('{}');`;
  capability(repo, "envprobe", { capability: "acme.envprobe", hooks: { spawn: "hook.mjs" } }, { "hook.mjs": probe });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.envprobe:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    const r = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-env", launch: false });
    const seen = JSON.parse(readFileSync(join(repo, "hook-env.json"), "utf8"));
    assert.equal(seen.instanceHome, r.home, "hooks receive the runtime-neutral name");
    assert.equal(seen.legacyHome, r.home, "OAS_HOME stays a compatibility alias for shipped capability hooks");
    // The package STORE root is a different concept and must never be conflated.
    assert.notEqual(seen.storeDir, r.home);
    // Every runtime gets the neutral name; the pi-branded ones remain as aliases
    // because the separately published @oas-framework/pi extension reads them.
    assert.match(r.command, new RegExp(`OAS_INSTANCE_HOME='${r.home}'`));
    assert.match(r.command, new RegExp(`PI_AGENT_HOME='${r.home}'`));
    retireInstance(root, "dev-env", { tmuxSession: "oas-test-nosuch" });
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("symlinks on the path to the home cannot smuggle it into a linked worktree (reviewer-249aa7b)", () => {
  const base = temp();
  const { repo, root, wt, wtRoot } = repoWithWorktree(base);
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    // (1) An agent dir in the PRIMARY checkout that is a symlink to an agent in
    // the linked worktree. Every lexical check sees the primary checkout.
    symlinkSync(join(wtRoot, "dev"), join(root, "alias"));
    const aliased = findAgent(root, "alias");
    assert.equal(aliased._dir, join(root, "alias"), "lexically it is in the primary checkout");
    assert.throws(
      () => spawnInstance(root, aliased, { instance: "alias-x", launch: false }),
      (e) => e.code === "E_NO_CANONICAL_ROOT" && /resolves to/.test(e.message),
    );
    assert.equal(existsSync(join(wtRoot, "dev", "instances", "alias-x")), false, "nothing created through the symlink");

    // (2) The agent dir is genuinely in the primary checkout, but its
    // instances/ dir is a symlink into the worktree.
    const smuggler = join(root, "dev2");
    write(join(smuggler, "soul", "soul.yaml"), `name: dev2\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
    write(join(smuggler, "soul", "AGENTS.md"), "# dev2\n");
    mkdirSync(join(wtRoot, "dev", "instances"), { recursive: true });
    symlinkSync(join(wtRoot, "dev", "instances"), join(smuggler, "instances"));
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev2"), { instance: "dev2-x", launch: false }),
      (e) => e.code === "E_NO_CANONICAL_ROOT" && /resolves to/.test(e.message),
    );
    assert.equal(existsSync(join(wtRoot, "dev", "instances", "dev2-x")), false, "nothing created through the instances symlink");

    // A plain symlinked agents root that stays within the primary checkout is
    // still perfectly fine — this guard is about the destination, not symlinks.
    const linkRoot = join(base, "agents-link"); symlinkSync(root, linkRoot);
    const viaLink = spawnInstance(linkRoot, findAgent(linkRoot, "dev"), { instance: "dev-via-link", launch: false });
    assert.equal(realpathSync(viaLink.home), join(realpathSync(root), "dev", "instances", "dev-via-link"));
    retireInstance(linkRoot, "dev-via-link", { tmuxSession: "oas-test-nosuch" });
  } finally { process.env.PATH = oldPath; }
  execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt]);
  rmSync(base, { recursive: true, force: true });
});
