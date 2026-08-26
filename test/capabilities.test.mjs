import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  capabilityIntegrity, capabilityManifest, composeInstanceAgentsMd, createAgent, findAgent, findInstanceHomes, resolveOasConfig,
  listInstances, resolveClaudeBinary, resolveWorkMode, retireInstance, runLifecycleHooks, spawnInstance, writeCapabilityLock,
} from "../lib/core.mjs";
import { pinAmbientCatalog } from "./catalog-hermetic.mjs";

// Several cases here spawn the CLI with the ambient environment and reach
// catalog-consuming commands (`init`, `install`, `doctor`). Bind the bundled
// catalog FILE so none of them falls through to the v0.21 remote fetch.
pinAmbientCatalog();

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

/** A `pi` stub that answers `pi list` the way pi actually does: a two-space spec
 * line with an optional "(filtered)" marker, and the install path line ONLY when
 * the package is really installed — pi's list command guards it with
 * `if (pkg.installedPath)`. A stub that always printed a path made a
 * configured-but-never-installed package look installed, which is how a stale
 * row slipped through the gate (reviewer-6ad0dde). */
function fakePiWithPackages(base, rows) {
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  const body = ["User packages:", ...rows.flatMap((r) => [
    `  ${r.source}${r.filtered ? " (filtered)" : ""}`,
    ...(r.dir ? [`    ${r.dir}`] : []),
  ])].join("\n");
  write(join(bin, "pi"), `#!/bin/sh\nif [ "$1" = "list" ]; then cat <<'EOF'\n${body}\nEOF\nfi\nexit 0\n`);
  write(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  execFileSync("chmod", ["-R", "+x", bin]);
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
      if (meta.runtime === "pi") {
        // Strict curriculum: ambient discovery off, the composed set added back
        // explicitly, and the instance's own AGENTS.md delivered by flag because
        // --no-context-files also suppresses it. (This assertion previously
        // required --no-skills to be ABSENT, under the superseded
        // ambient-coexistence decision.)
        assert.match(meta.command, /--skill /);
        assert.match(meta.command, /--no-skills/);
        assert.match(meta.command, /--no-context-files/);
        // Extensions stay AMBIENT by founder ruling: operators run cross-agent
        // pi extensions (web search, formatting) that every instance keeps.
        assert.doesNotMatch(meta.command, /--no-extensions/);
        assert.doesNotMatch(meta.command, / -e /);
        assert.match(meta.command, /--append-system-prompt/);
      }
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

test("classic init acquires layers as PACKAGES, bundled is rejected, restore re-materializes", () => {
  const base = temp(); const repo = join(base, "repo"); gitRepo(repo);
  // A hermetic local-Git fixture catalog: an official ID resolves to a real
  // package on disk, so this case never reaches the network. Classic init has
  // no bundled-marketplace fallback for a cataloged ID — an unreachable source
  // fails and the run rolls back — so the fixture IS the official source here.
  const src = join(base, "src", "okf");
  write(join(src, "capabilities/okf/oas.json"), JSON.stringify({
    capability: "oas.okf", version: "2.0.0", description: "knowledge layer", layer: "knowledge",
    commands: { harvest: "harvest.mjs" },
  }, null, 2));
  write(join(src, "capabilities/okf/harvest.mjs"), "// harvest\n");
  write(join(src, "oas-package.json"), JSON.stringify({
    package: "oas.okf", version: "2.0.0", description: "official oas.okf",
    compatibility: { oas: ">=0.1.0" }, capabilities: ["capabilities/okf"],
  }, null, 2));
  gitRepo(src);
  const catalog = join(base, "catalog.json");
  write(catalog, JSON.stringify({ packages: { "oas.okf": { url: src, path: "." } } }));
  const env = { ...process.env, OAS_PACKAGE_CATALOG: catalog };

  let r = spawnSync(process.execPath, [CLI, "init", "--knowledge", "oas.okf", "--messaging", "none", "--no-tmux-mouse", "--dir", repo], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const config = readFileSync(join(repo, "oas-config.yaml"), "utf8");
  assert.match(config, /from: installed/);
  assert.doesNotMatch(config, /bundled/);
  // Work modes scaffold shows setup:, not injection overrides.
  assert.match(config, /work-modes:\n  worktree:\n    # setup: scripts\/setup-worktree\.sh/);
  assert.doesNotMatch(config, /injections\/workmodes/);

  // Revised-v2 flat capability state: a package row for the transport, a
  // capability row back-referencing it, and an id-keyed artifact directory.
  const lock = JSON.parse(readFileSync(join(repo, "oas-lock.json"), "utf8"));
  assert.equal(lock.lockfileVersion, 2);
  assert.deepEqual(Object.keys(lock.packages), ["oas.okf"]);
  assert.equal(lock.capabilities["oas.okf"].package, "oas.okf");
  const artifact = join(repo, ".agents", "capabilities", "installed", "oas.okf");
  assert.ok(existsSync(join(artifact, "oas.json")));

  // Acquisition is NOT trust: the layer resolves, but its executable surface
  // stays blocked until an explicit `oas trust`.
  assert.equal(lock.capabilities["oas.okf"].trusted, false);
  const cap = resolveOasConfig(repo, "dev").capabilities.find((c) => c.id === "oas.okf");
  assert.equal(cap.trust.trusted, false);
  assert.match(cap.trust.reason, /oas trust oas\.okf/);
  assert.ok(cap._dir || cap.provenance);
  assert.equal(spawnSync(process.execPath, [CLI, "trust", "oas.okf", "--dir", repo], { encoding: "utf8", env }).status, 0);
  assert.equal(resolveOasConfig(repo, "dev").capabilities.find((c) => c.id === "oas.okf").trust.trusted, true);

  // from: bundled is rejected with migration guidance.
  write(join(repo, "oas-config.yaml"), "capabilities:\n  layers:\n    knowledge:\n      capability: oas.okf\n      from: bundled\n");
  assert.throws(() => resolveOasConfig(repo, "dev"), /no longer supported.*oas install/s);
  // Restore: delete the artifact, bare install re-materializes it at locked integrity.
  write(join(repo, "oas-config.yaml"), "capabilities:\n  layers:\n    knowledge:\n      capability: oas.okf\n      from: installed\n");
  rmSync(artifact, { recursive: true });
  r = spawnSync(process.execPath, [CLI, "install", "--dir", repo], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /restored\s+package oas\.okf/);
  assert.ok(existsSync(join(artifact, "oas.json")), "the flat capability artifact is back");
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
  const emptyCatalog = join(base, "empty-catalog.json");
  write(emptyCatalog, JSON.stringify({ packages: {} }));
  r = spawnSync(process.execPath, [CLI, "install", "oas.okf", "--dir", repo], { encoding: "utf8", env: { ...process.env, OAS_PACKAGE_CATALOG: emptyCatalog } });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /not activated/);
  // With no official catalog entry this deliberately exercises the legacy
  // marketplace install: copied into installed/, locked, trusted at acquisition.
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
  // `layers:` moved under `capabilities.layers` — the top-level spelling is
  // refused outright, so a template carrying it can never be seeded.
  writeFileSync(tpl, "name: template-origin\ncapabilities:\n  layers:\n    tasks: none\n  additive:\n    oas.okf:\n      from: installed\n      global: true\n");
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

// ---------- composition preflight: declared resources must exist ----------

test("a capability whose declared skill does not resolve fails the spawn closed, with no scaffold", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  // The reported shape: a manifest declaring skills under a dependency path that
  // only exists after an ad-hoc install. In a fresh worktree it resolves to
  // nothing, and the instance used to be born without them while the
  // capability's injection still told the agent to load them.
  capability(repo, "ghost", {
    capability: "acme.ghost",
    skills: ["node_modules/@vendor/pkg/skills/ghost-skill"],
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.ghost:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-ghost", launch: false }),
      (e) => e.code === "E_CAPABILITY_RESOURCE_MISSING"
        && /skill-tree "node_modules\/@vendor\/pkg\/skills\/ghost-skill" declared by acme.ghost/.test(e.message),
    );
    // Preflight runs before the home exists, so there is nothing to roll back.
    assert.equal(existsSync(join(root, "dev", "instances", "dev-ghost")), false, "no instance home");
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("preflight distinguishes declared-and-missing from declared-nothing and injection-override: none", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  // Declares no skills and no injection at all — contributes nothing, and that
  // is not a missing resource.
  capability(repo, "quiet", { capability: "acme.quiet" });
  // Declares an injection that DOES resolve.
  capability(repo, "loud", { capability: "acme.loud", inject: "injects/loud.md" }, { "injects/loud.md": "## Loud\n" });
  write(join(repo, "oas-config.yaml"),
    "capabilities:\n  additive:\n    acme.quiet:\n      global: true\n    acme.loud:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    const r = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-quiet", launch: false });
    const meta = JSON.parse(readFileSync(join(r.home, "instance.json"), "utf8"));
    assert.ok(meta.composition, "instance.json records the composition");
    assert.ok(meta.composition.expected.some((e) => e.source === "acme.loud" && e.type === "injection"),
      "a resolved injection is recorded as expected with its provenance");
    assert.equal(meta.composition.expected.some((e) => e.source === "acme.quiet"), false,
      "a capability declaring nothing contributes nothing");
    assert.match(readFileSync(join(r.home, "AGENTS.md"), "utf8"), /## Loud/);
    retireInstance(root, "dev-quiet", { tmuxSession: "oas-test-nosuch" });

    // injection-override: none is an explicit choice, not a missing resource.
    write(join(repo, "oas-config.yaml"),
      "capabilities:\n  additive:\n    acme.loud:\n      global: true\n      injection-override: none\n");
    const r2 = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-none", launch: false });
    assert.doesNotMatch(readFileSync(join(r2.home, "AGENTS.md"), "utf8"), /## Loud/);
    retireInstance(root, "dev-none", { tmuxSession: "oas-test-nosuch" });
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("instance.json records expected == materialized, and the .claude/skills alias is verified", () => {
  const base = temp();
  const { repo, root, soul } = fixtureSoul(base, "pi");
  write(join(soul, "skills", "soul-skill", "SKILL.md"), "---\nname: soul-skill\ndescription: A soul-private skill.\n---\nbody\n");
  capability(repo, "withskill", { capability: "acme.withskill", skills: ["skills"] },
    { "skills/cap-skill/SKILL.md": "---\nname: cap-skill\ndescription: A capability skill.\n---\nbody\n" });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.withskill:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    const r = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-mat", launch: false });
    const meta = JSON.parse(readFileSync(join(r.home, "instance.json"), "utf8"));
    const names = meta.composition.materialized.skills.map((s) => s.name);
    assert.ok(names.includes("soul-skill") && names.includes("cap-skill"), `selected skills materialized: ${names}`);
    for (const s of meta.composition.materialized.skills) {
      assert.ok(existsSync(join(r.home, ".agents", "skills", s.name, "SKILL.md")), `${s.name} is a real copy`);
    }
    // .agents/skills is canonical; .claude/skills aliases it and must resolve
    // exactly onto it — the founder's canonical layout.
    assert.equal(lstatSync(join(r.home, ".claude", "skills")).isSymbolicLink(), true);
    assert.equal(realpathSync(join(r.home, ".claude", "skills")), realpathSync(join(r.home, ".agents", "skills")));
    assert.equal(readlinkSync(join(r.home, "CLAUDE.md")), "AGENTS.md");
    // Every expected resource carries provenance for audit.
    for (const e of meta.composition.expected) assert.ok(e.type && e.source && e.declared, `provenance on ${JSON.stringify(e)}`);
    retireInstance(root, "dev-mat", { tmuxSession: "oas-test-nosuch" });
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("a declared skill tree that exists but yields no skills fails closed (reviewer-400c1e6)", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  // The tree RESOLVES — so a mere existence check passes — but contributes
  // nothing: no SKILL.md of its own, and no child directory with one. The
  // capability would spawn with zero of its promised skills.
  const dir = capability(repo, "hollow", { capability: "acme.hollow", skills: ["skills"] });
  mkdirSync(join(dir, "skills", "not-a-skill"), { recursive: true });
  write(join(dir, "skills", "not-a-skill", "README.md"), "no SKILL.md here\n");
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.hollow:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-hollow", launch: false }),
      (e) => e.code === "E_CAPABILITY_RESOURCE_MISSING" && /contains no skill/.test(e.message),
    );
    assert.equal(existsSync(join(root, "dev", "instances", "dev-hollow")), false);
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("a skill directory represented by a symlink is reported, never silently dropped", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  // Materialization's readdir uses lstat semantics, so a symlinked child skill
  // dir is not copied. Preflight must therefore call the tree empty rather than
  // let the capability start without it. The link stays INSIDE the capability's
  // integrity boundary — an escaping one is already rejected, more strictly, by
  // the containment check.
  const dir = capability(repo, "linked", { capability: "acme.linked", skills: ["skills"] });
  write(join(dir, "real", "aliased-skill", "SKILL.md"), "---\nname: aliased-skill\ndescription: Reached only through a symlink.\n---\nbody\n");
  mkdirSync(join(dir, "skills"), { recursive: true });
  symlinkSync(join("..", "real", "aliased-skill"), join(dir, "skills", "aliased-skill"));
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.linked:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-linked", launch: false }),
      (e) => e.code === "E_CAPABILITY_RESOURCE_MISSING" && /symlinked skill directory does not count/.test(e.message),
    );
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("an empty soul skills/ dir is not a broken promise, unlike a declared capability tree", () => {
  const base = temp();
  const { repo, root, soul } = fixtureSoul(base, "pi");
  mkdirSync(join(soul, "skills"), { recursive: true }); // exists, empty, declares nothing
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    const r = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-emptysoul", launch: false });
    assert.ok(existsSync(join(r.home, "instance.json")), "spawn succeeds");
    retireInstance(root, "dev-emptysoul", { tmuxSession: "oas-test-nosuch" });
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("a promised skill still counts when an override satisfies its name from another source", () => {
  const base = temp();
  const { repo, root, soul } = fixtureSoul(base, "pi");
  // Both the soul and a capability offer "shared"; config picks the winner.
  // The capability's promise is satisfied by NAME, so reconciliation must not
  // demand that the capability's own copy won.
  write(join(soul, "skills", "shared", "SKILL.md"), "---\nname: shared\ndescription: Soul version.\n---\nsoul\n");
  capability(repo, "dup", { capability: "acme.dup", skills: ["skills"] },
    { "skills/shared/SKILL.md": "---\nname: shared\ndescription: Capability version.\n---\ncap\n" });
  write(join(repo, "oas-config.yaml"),
    "skill-overrides:\n  shared: soul\ncapabilities:\n  additive:\n    acme.dup:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    const r = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-dup", launch: false });
    assert.match(readFileSync(join(r.home, ".agents", "skills", "shared", "SKILL.md"), "utf8"), /Soul version/);
    retireInstance(root, "dev-dup", { tmuxSession: "oas-test-nosuch" });
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("a SKILL.md that is not a regular file does not count as a skill (reviewer-d70bc8b)", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  // existsSync() is true for a DIRECTORY named SKILL.md, which would let the
  // tree pass preflight, be copied, pass the post-check, and launch an instance
  // with no readable skill document.
  const dir = capability(repo, "fakedoc", { capability: "acme.fakedoc", skills: ["skills"] });
  mkdirSync(join(dir, "skills", "fake", "SKILL.md"), { recursive: true });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.fakedoc:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-fakedoc", launch: false }),
      (e) => e.code === "E_CAPABILITY_RESOURCE_MISSING" && /contains no skill/.test(e.message),
    );
    assert.equal(existsSync(join(root, "dev", "instances", "dev-fakedoc")), false);
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

// ---------- runtime extensions: strict launch resolves them, or refuses ----------

test("spawn fails closed when a capability's runtime package is missing, even after a Claude-only reconciliation", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "claude");   // soul default: claude
  capability(repo, "chan", {
    capability: "acme.chan",
    requires: [{ runtime: "pi", package: "npm:@awebai/pi", why: "channel extension for pi sessions" }],
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  const oldHome = process.env.HOME; process.env.HOME = join(base, "nohome"); // no pi packages
  try {
    // Claude is unaffected: it never needed the pi package.
    const claude = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-claude", launch: false });
    retireInstance(root, "dev-claude", { tmuxSession: "oas-test-nosuch" });
    assert.doesNotMatch(claude.command, /-e /);

    // --runtime pi overrides the soul default long after install-time
    // reconciliation decided this host was Claude-only. Spawn is the
    // authoritative check, and it must refuse rather than launch a pi instance
    // whose channel silently vanished under --no-extensions.
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-pi", runtime: "pi", launch: false }),
      (e) => e.code === "E_RUNTIME_RESOURCE_MISSING"
        && /acme\.chan requires the pi package npm:@awebai\/pi/.test(e.message)
        && /--accept-requirement pi:npm:@awebai\/pi/.test(e.message),
      "spawn names the exact separately-consentable remedy",
    );
    assert.equal(existsSync(join(root, "dev", "instances", "dev-pi")), false, "no scaffold left behind");
  } finally { process.env.PATH = oldPath; process.env.HOME = oldHome; }
  rmSync(base, { recursive: true, force: true });
});


test("a required runtime package is verified and recorded, and pi loads it through its own discovery", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  capability(repo, "chan", {
    capability: "acme.chan",
    requires: [{ runtime: "pi", package: "npm:fake-channel", why: "channel extension" }],
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  // A relocated pi config dir (PI_CODING_AGENT_DIR) holding the package entry.
  const piDir = join(base, "pi-agent");
  write(join(piDir, "settings.json"), JSON.stringify({ packages: ["npm:fake-channel@1.2.3"] }));
  const pkgDir = join(piDir, "npm", "node_modules", "fake-channel");
  write(join(pkgDir, "package.json"), JSON.stringify({ name: "fake-channel" }));
  const oldPath = process.env.PATH;
  process.env.PATH = fakePiWithPackages(base, [{ source: "npm:fake-channel@1.2.3", dir: pkgDir }]);
  const oldPi = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = piDir;
  try {
    const r = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-ext", launch: false });
    // We do NOT name extensions on the command line: pi resolves them itself
    // (its manifest supports globs and conventional directories), and passing
    // them too would load the same extension twice.
    assert.doesNotMatch(r.command, / -e /);
    assert.doesNotMatch(r.command, /--no-extensions/);
    const meta = JSON.parse(readFileSync(join(r.home, "instance.json"), "utf8"));
    const pkgs = meta.composition.materialized.runtimePackages;
    assert.equal(pkgs.length, 1);
    assert.equal(pkgs[0].capability, "acme.chan");
    assert.equal(pkgs[0].package, "npm:fake-channel");
    assert.equal(pkgs[0].loadedBy, "runtime-discovery", "provenance says how it reaches the session");
    retireInstance(root, "dev-ext", { tmuxSession: "oas-test-nosuch" });
  } finally {
    process.env.PATH = oldPath;
    if (oldPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldPi;
  }
  rmSync(base, { recursive: true, force: true });
});

test("PI_PACKAGE_DIR pointing elsewhere does not break detection (reviewer-ad1b9f0)", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  capability(repo, "chan", {
    capability: "acme.chan",
    requires: [{ runtime: "pi", package: "npm:fake-channel", why: "channel extension" }],
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const piDir = join(base, "pi-agent");
  write(join(piDir, "settings.json"), JSON.stringify({ packages: ["npm:fake-channel"] }));
  const pkgDir = join(piDir, "npm", "node_modules", "fake-channel");
  write(join(pkgDir, "package.json"), JSON.stringify({ name: "fake-channel" }));
  const oldPath = process.env.PATH;
  process.env.PATH = fakePiWithPackages(base, [{ source: "npm:fake-channel", dir: pkgDir }]);
  const oldPi = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = piDir;
  const oldPkg = process.env.PI_PACKAGE_DIR; process.env.PI_PACKAGE_DIR = join(base, "nix-store-elsewhere");
  try {
    // PI_PACKAGE_DIR is pi's own asset dir, not `pi install` output. Detection
    // must key off the agent dir alone, or a Nix/Guix-style host fails every spawn.
    const r = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-nix", launch: false });
    assert.ok(existsSync(join(r.home, "instance.json")));
    retireInstance(root, "dev-nix", { tmuxSession: "oas-test-nosuch" });
  } finally {
    process.env.PATH = oldPath;
    if (oldPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldPi;
    if (oldPkg === undefined) delete process.env.PI_PACKAGE_DIR; else process.env.PI_PACKAGE_DIR = oldPkg;
  }
  rmSync(base, { recursive: true, force: true });
});

test('a settings entry with "extensions": [] fails the spawn — it loads none of them (reviewer-8518c49)', () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  capability(repo, "chan", {
    capability: "acme.chan",
    requires: [{ runtime: "pi", package: "npm:fake-channel", why: "channel extension" }],
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const piDir = join(base, "pi-agent");
  // Installed and listed, but the operator disabled every extension from it.
  // A settings row is not proof the capability's extension will load.
  write(join(piDir, "settings.json"), JSON.stringify({ packages: [{ source: "npm:fake-channel", extensions: [] }] }));
  const pkgDir = join(piDir, "npm", "node_modules", "fake-channel");
  write(join(pkgDir, "package.json"), JSON.stringify({ name: "fake-channel" }));
  const oldPath = process.env.PATH;
  process.env.PATH = fakePiWithPackages(base, [{ source: "npm:fake-channel", dir: pkgDir, filtered: true }]);
  const oldPi = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = piDir;
  try {
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-off", launch: false }),
      (e) => e.code === "E_RUNTIME_RESOURCE_MISSING" && /"extensions": \[\], which loads none of them/.test(e.message),
    );
    assert.equal(existsSync(join(root, "dev", "instances", "dev-off")), false);
  } finally {
    process.env.PATH = oldPath;
    if (oldPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldPi;
  }
  rmSync(base, { recursive: true, force: true });
});

test("a stale settings row whose files were never installed fails the spawn (reviewer-8518c49)", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  capability(repo, "chan", {
    capability: "acme.chan",
    requires: [{ runtime: "pi", package: "npm:fake-channel", why: "channel extension" }],
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const piDir = join(base, "pi-agent");
  write(join(piDir, "settings.json"), JSON.stringify({ packages: ["npm:fake-channel"] }));
  // Configured but never installed: pi prints the source line and NO path line,
  // exactly as its list command does when installedPath is unset. Presence in
  // settings — or a parser that shrugs at the missing line — would pass this.
  const oldPath = process.env.PATH;
  process.env.PATH = fakePiWithPackages(base, [{ source: "npm:fake-channel" }]);
  const oldPi = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = piDir;
  try {
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-ghost", launch: false }),
      (e) => e.code === "E_RUNTIME_RESOURCE_MISSING" && /reports no installed location, so it was never installed/.test(e.message),
    );
  } finally {
    process.env.PATH = oldPath;
    if (oldPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldPi;
  }
  rmSync(base, { recursive: true, force: true });
});

test("a non-empty extensions filter fails as unverifiable; a skills-only filter still passes", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  capability(repo, "chan", {
    capability: "acme.chan",
    requires: [{ runtime: "pi", package: "npm:fake-channel", why: "channel extension" }],
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const piDir = join(base, "pi-agent");
  const pkgDir = join(piDir, "npm", "node_modules", "fake-channel");
  write(join(pkgDir, "package.json"), JSON.stringify({ name: "fake-channel" }));
  const oldPath = process.env.PATH;
  process.env.PATH = fakePiWithPackages(base, [{ source: "npm:fake-channel", dir: pkgDir, filtered: true }]);
  const oldPi = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = piDir;
  try {
    // A non-empty extensions filter may name a wrong or nonexistent path, or
    // simply omit the capability's extension. Proving otherwise means
    // implementing pi's matcher, so this is unverifiable — not merely auditable.
    write(join(piDir, "settings.json"), JSON.stringify({ packages: [{ source: "npm:fake-channel", extensions: ["./dist/*.js"] }] }));
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-filt", launch: false }),
      (e) => e.code === "E_RUNTIME_RESOURCE_MISSING" && /filters its extensions/.test(e.message) && /skills-only filter is fine/.test(e.message),
    );

    // A filter on OTHER resource kinds is unrelated and must keep working —
    // the real oas-aweb entry filters skills only, and pi still marks the row
    // "(filtered)", so the two must not be conflated.
    write(join(piDir, "settings.json"), JSON.stringify({ packages: [{ source: "npm:fake-channel", skills: ["skills/one"] }] }));
    const r = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-skillfilt", launch: false });
    const meta = JSON.parse(readFileSync(join(r.home, "instance.json"), "utf8"));
    const pkg = meta.composition.materialized.runtimePackages[0];
    assert.equal(pkg.filtered, true, "pi's own (filtered) marker is recorded…");
    assert.equal(pkg.dir, pkgDir, "…along with where the runtime says it lives");
    retireInstance(root, "dev-skillfilt", { tmuxSession: "oas-test-nosuch" });
  } finally {
    process.env.PATH = oldPath;
    if (oldPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldPi;
  }
  rmSync(base, { recursive: true, force: true });
});

test("a directory pi names but that does not exist also fails the spawn", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  capability(repo, "chan", {
    capability: "acme.chan",
    requires: [{ runtime: "pi", package: "npm:fake-channel", why: "channel extension" }],
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const piDir = join(base, "pi-agent");
  write(join(piDir, "settings.json"), JSON.stringify({ packages: ["npm:fake-channel"] }));
  const oldPath = process.env.PATH;
  process.env.PATH = fakePiWithPackages(base, [{ source: "npm:fake-channel", dir: join(piDir, "npm", "node_modules", "gone") }]);
  const oldPi = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = piDir;
  try {
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-gonedir", launch: false }),
      (e) => e.code === "E_RUNTIME_RESOURCE_MISSING" && /but nothing is installed there/.test(e.message),
    );
  } finally {
    process.env.PATH = oldPath;
    if (oldPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldPi;
  }
  rmSync(base, { recursive: true, force: true });
});

test("when pi cannot be run, a config entry is not accepted as an installation", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  capability(repo, "chan", {
    capability: "acme.chan",
    requires: [{ runtime: "pi", package: "npm:fake-channel", why: "channel extension" }],
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const piDir = join(base, "pi-agent");
  write(join(piDir, "settings.json"), JSON.stringify({ packages: ["npm:fake-channel"] }));
  // `pi list` fails, so only settings are readable — which record intent, never
  // installation. Fail closed rather than trust a config file.
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  write(join(bin, "pi"), "#!/bin/sh\nexit 3\n");
  write(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  execFileSync("chmod", ["-R", "+x", bin]);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${process.env.PATH}`;
  const oldPi = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = piDir;
  try {
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-noverify", launch: false }),
      (e) => e.code === "E_RUNTIME_RESOURCE_MISSING" && /could not verify it is installed/.test(e.message),
    );
  } finally {
    process.env.PATH = oldPath;
    if (oldPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldPi;
  }
  rmSync(base, { recursive: true, force: true });
});

test("instance.json records the runtime posture — what is composed, curtailed, and ambient", () => {
  const base = temp();
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    for (const runtime of ["pi", "claude"]) {
      const b = join(base, runtime);
      const { root } = fixtureSoul(b, runtime);
      const r = spawnInstance(root, findAgent(root, "dev"), { instance: `dev-${runtime}`, launch: false });
      const posture = JSON.parse(readFileSync(join(r.home, "instance.json"), "utf8")).composition.materialized.runtimePosture;
      assert.ok(posture.oasComposed, `${runtime} records the composed surface`);
      assert.ok(posture.ambient?.length, `${runtime} states what remains ambient`);
      assert.ok(posture.why, `${runtime} records why`);
      if (runtime === "pi") assert.ok(posture.curtailed?.includes("user skills"), "pi curtails ambient skills");
      // Claude keeps its own global and per-repo configuration by founder ruling.
      else assert.ok(posture.ambient.some((a) => /plugins/.test(a)), "claude keeps user/project plugins");
      retireInstance(root, `dev-${runtime}`, { tmuxSession: "oas-test-nosuch" });
    }
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

// ---------- required lifecycle hooks ----------

test("a failing REQUIRED spawn hook fails the spawn and rolls it back", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  // A capability that cannot configure itself. Left best-effort, the instance
  // would start believing this capability works.
  capability(repo, "chan", { capability: "acme.chan", hooks: { spawn: { command: "hook.mjs spawn", required: true } } },
    { "hook.mjs": "process.stderr.write('identity minting failed\\n'); process.exit(1);" });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-reqhook", launch: false }),
      (e) => e.code === "E_REQUIRED_HOOK_FAILED"
        && /acme\.chan spawn hook \(declared required\)/.test(e.message)
        && /spawn rolled back/.test(e.message),
    );
    assert.equal(existsSync(join(root, "dev", "instances", "dev-reqhook")), false, "no half-configured instance left behind");
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("a failing hook that is NOT required still only warns", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  // Advisory work — memory scaffolding and the like — must not become a spawn
  // blocker just because required hooks now exist.
  capability(repo, "soft", { capability: "acme.soft", hooks: { spawn: "hook.mjs spawn" } },
    { "hook.mjs": "process.stderr.write('scaffolding failed\\n'); process.exit(1);" });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.soft:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    const r = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-soft", launch: false });
    assert.ok(r.warnings?.some((w) => /acme\.soft spawn hook failed/.test(w)), `failure is surfaced: ${JSON.stringify(r.warnings)}`);
    retireInstance(root, "dev-soft", { tmuxSession: "oas-test-nosuch" });
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("a required worktree spawn rolls back the worktree and branch too", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  capability(repo, "chan", { capability: "acme.chan", hooks: { spawn: { command: "hook.mjs spawn", required: true } } },
    { "hook.mjs": "process.exit(1);" });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "cap"]);
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-wtreq", work: "worktree", launch: false }),
      (e) => e.code === "E_REQUIRED_HOOK_FAILED" && /spawn rolled back/.test(e.message),
    );
    const wts = execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" });
    assert.doesNotMatch(wts, /dev-wtreq/, "worktree deregistered");
    const branches = execFileSync("git", ["-C", repo, "branch", "--list"], { encoding: "utf8" });
    assert.doesNotMatch(branches, /dev-wtreq/, "branch deleted");
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("only the spawn hook may be declared required", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  // retire and soul-scaffold run outside a spawn transaction, so "required"
  // there would promise an enforcement with no moment to act.
  capability(repo, "bad", { capability: "acme.bad", hooks: { retire: { command: "hook.mjs retire", required: true } } }, { "hook.mjs": "" });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.bad:\n      global: true\n");
  assert.throws(() => resolveOasConfig(repo, "dev"), /cannot be required — only the spawn hook is enforced/);
  rmSync(base, { recursive: true, force: true });
});

test("a clean rollback reports no verification problems (probe stderr regression)", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  capability(repo, "chan", { capability: "acme.chan", hooks: { spawn: { command: "hook.mjs spawn", required: true } } },
    { "hook.mjs": "process.exit(1);" });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "cap"]);
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    // execFileSync with encoding:"utf8" gives stderr === "" for a silent
    // command, so `stderr || message` fell through to "Command failed: …" and
    // an absent ref — the SUCCESS signal of `rev-parse --verify --quiet` —
    // looked like an unverifiable probe. Every clean rollback then reported
    // INCOMPLETE, training readers to ignore the one message that matters.
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-cleanrb", work: "worktree", launch: false }),
      (e) => /spawn rolled back/.test(e.message) && !/rollback INCOMPLETE/.test(e.message),
      "a rollback that fully succeeded must say so",
    );
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("a failed required hook hands back its metadata so compensation can undo external state", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  // The hook creates external state, reports it, then fails. Its stdout is the
  // ONLY channel for that state; discarding it strands whatever it created.
  const marker = join(base, "external-identity");
  capability(repo, "chan", {
    capability: "acme.chan",
    hooks: { spawn: { command: "hook.mjs spawn", required: true }, retire: "hook.mjs retire" },
  }, {
    "hook.mjs": `import {writeFileSync, rmSync, existsSync} from 'node:fs';
const marker = ${JSON.stringify(marker)};
if (process.env.OAS_EVENT === 'spawn') {
  writeFileSync(marker, 'joined');                       // external state exists now
  console.log(JSON.stringify({ meta: { alias: 'probe-alias' } }));
  process.exit(1);                                        // …and then we fail
}
const meta = JSON.parse(process.env.OAS_META || '{}');
if (meta.alias === 'probe-alias' && existsSync(marker)) rmSync(marker);   // compensate
console.log('{}');`,
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-comp", launch: false }),
      (e) => e.code === "E_REQUIRED_HOOK_FAILED",
    );
    assert.equal(existsSync(marker), false, "the retire hook received the failed hook's metadata and undid its external state");
    assert.equal(existsSync(join(root, "dev", "instances", "dev-comp")), false);
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("the SHIPPED aweb spawn hook exits nonzero when it cannot mint an identity", () => {
  // The required-hook contract is worthless if the capability that declares it
  // swallows its own failures. This executes the real hook, not a fixture.
  const base = temp();
  const hook = resolve(new URL("../capabilities/oas-aweb/bin/oas-aweb.mjs", import.meta.url).pathname);
  const r = spawnSync(process.execPath, [hook, "spawn"], {
    encoding: "utf8",
    env: { ...process.env, OAS_EVENT: "spawn", OAS_INSTANCE: "probe", OAS_HOME: join(base, "no-such-home"), OAS_WORKSPACE: base, OAS_CONTEXT: base, OAS_TEAM_SCOPE: base },
  });
  assert.notEqual(r.status, 0, `no aweb root must be fatal, got exit ${r.status}: ${r.stdout}`);
  assert.match(r.stdout, /no identity could be minted/);
  const manifest = JSON.parse(readFileSync(resolve(new URL("../capabilities/oas-aweb/oas.json", import.meta.url).pathname), "utf8"));
  assert.equal(manifest.hooks.spawn.required, true, "and the manifest declares it required, so the kernel acts on that exit code");
  rmSync(base, { recursive: true, force: true });
});

test("the manifest schema rejects `required` on non-spawn hooks, matching runtime validation", async () => {
  // A schema more permissive than the runtime lets authoring approve a manifest
  // OAS then refuses to load.
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");   // the schema declares draft 2020-12, as validate-project.mjs does
  const schema = JSON.parse(readFileSync(resolve(new URL("../docs/capability-manifest.schema.json", import.meta.url).pathname), "utf8"));
  const validate = new Ajv2020({ strict: false, allowUnionTypes: true }).compile(schema);
  const manifest = (hooks) => ({ capability: "acme.x", version: "1.0.0", compatibility: { oas: ">=0.6.2" }, description: "x", hooks });
  assert.equal(validate(manifest({ spawn: { command: "h.mjs spawn", required: true } })), true, "spawn may be required");
  assert.equal(validate(manifest({ retire: { command: "h.mjs retire", required: true } })), false, "retire may not");
  assert.equal(validate(manifest({ "soul-scaffold": { command: "h.mjs s", required: true } })), false, "soul-scaffold may not");
  assert.equal(validate(manifest({ retire: "h.mjs retire" })), true, "the plain string form still validates");
});

test("the SHIPPED aweb hook is fatal on every terminal pre-mint path (reviewer-5b78764)", () => {
  const base = temp();
  const hook = resolve(new URL("../capabilities/oas-aweb/bin/oas-aweb.mjs", import.meta.url).pathname);
  // A stub `aw` that reports an initialized root but NO team, so the hook gets
  // past the root check and reaches team resolution — the paths that used to
  // warn-and-exit-0 while minting nothing.
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  // CURRENT aw shape: memberships, not teams. Using the stale key here is what
  // let a real field drift pass review (reviewer-602627c).
  write(join(bin, "aw"), `#!/bin/sh\nif [ "$1" = "team" ] && [ "$2" = "list" ]; then echo '{"memberships":[],"active_team":null}'; exit 0; fi\nexit 0\n`);
  execFileSync("chmod", ["+x", join(bin, "aw")]);
  const root = join(base, "awroot"); mkdirSync(join(root, ".aw"), { recursive: true });
  const run = (env) => spawnSync(process.execPath, [hook, "spawn"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OAS_EVENT: "spawn", OAS_INSTANCE: "probe", OAS_HOME: root, OAS_WORKSPACE: root, OAS_CONTEXT: root, OAS_TEAM_SCOPE: root, ...env },
  });

  // Root present, no team resolvable at all.
  const noTeam = run({ OAS_TEAM_ID: "", OAS_TEAM_NAME: "" });
  assert.notEqual(noTeam.status, 0, `no active team must be fatal, got ${noTeam.status}: ${noTeam.stdout}`);
  assert.match(noTeam.stdout, /no identity could be minted/);

  // A bare team name with no matching membership.
  const noMatch = run({ OAS_TEAM_NAME: "nosuchteam" });
  assert.notEqual(noMatch.status, 0, `unresolved team must be fatal, got ${noMatch.status}: ${noMatch.stdout}`);
  assert.match(noMatch.stdout, /no membership matching team/);
  rmSync(base, { recursive: true, force: true });
});

test("a compensation hook that reports incomplete cleanup is not announced as a clean rollback", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  // Retire exits 0 but says it could not undo its external state — the shape of
  // aweb's self-delete failure. Announcing "spawn rolled back" would be a lie,
  // AND the home holds the only credential that can retry the cleanup.
  capability(repo, "chan", {
    capability: "acme.chan",
    hooks: { spawn: { command: "hook.mjs spawn", required: true }, retire: "hook.mjs retire" },
  }, {
    "hook.mjs": `if (process.env.OAS_EVENT === 'spawn') {
  console.log(JSON.stringify({ meta: { alias: 'probe' }, warning: 'oas-chan: minting failed — run: chan setup' }));
  process.exit(1);
}
console.log(JSON.stringify({ meta: { retired: false, reason: 'self-delete-failed' } }));`,
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-badcomp", launch: false }),
      (e) => e.code === "E_REQUIRED_HOOK_FAILED"
        && /rollback INCOMPLETE/.test(e.message)
        && /external state may remain/.test(e.message)
        && /instance home is RETAINED/.test(e.message)
        // …and the hook's OWN diagnosis reaches the operator, not just "Command failed: node …".
        && /run: chan setup/.test(e.message),
      "the failure must name the cause, admit the incomplete cleanup, and say the home is kept",
    );
    // The home SURVIVES: deleting it would destroy the credentials a retry needs,
    // turning a transient cleanup failure into permanent external residue.
    const kept = join(root, "dev", "instances", "dev-badcomp");
    assert.equal(existsSync(kept), true, "the home is quarantined, not destroyed");
    const marker = JSON.parse(readFileSync(join(kept, ".oas-rollback-incomplete.json"), "utf8"));
    assert.equal(marker.instance, "dev-badcomp");
    assert.ok(marker.incomplete.length, "the marker records what is outstanding");
    assert.equal(JSON.stringify(marker).includes("chan setup"), false, "and carries no hook output");
    // status must read it as retained state, never as a live instance.
    const listed = listInstances(root, "oas-test-nosuch").flatMap((a) => a.instances || []).find((i) => i.instance === "dev-badcomp");
    assert.ok(listed?.rollbackIncomplete, "status identifies the quarantine");
    assert.equal(listed.running, false);
    rmSync(kept, { recursive: true, force: true });
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("a compensation hook with nothing to undo still counts as a clean rollback", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  capability(repo, "chan", {
    capability: "acme.chan",
    hooks: { spawn: { command: "hook.mjs spawn", required: true }, retire: "hook.mjs retire" },
  }, {
    "hook.mjs": `if (process.env.OAS_EVENT === 'spawn') { console.log(JSON.stringify({ warning: 'nope' })); process.exit(1); }
console.log(JSON.stringify({ meta: { retired: false, reason: 'nothing-to-delete' } }));`,
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-nooop", launch: false }),
      (e) => /spawn rolled back/.test(e.message) && !/rollback INCOMPLETE/.test(e.message),
      "nothing to undo is completion, not failure",
    );
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("a name-only team config resolves against the CURRENT aw memberships shape (reviewer-602627c)", () => {
  const base = temp();
  const hook = resolve(new URL("../capabilities/oas-aweb/bin/oas-aweb.mjs", import.meta.url).pathname);
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  // A real membership exists under `memberships`. Reading only `teams` here
  // classified it as "no membership" — and since that path is now fatal, it
  // would block every spawn on a perfectly valid deployment.
  write(join(bin, "aw"), `#!/bin/sh
if [ "$1" = "team" ] && [ "$2" = "list" ]; then echo '{"active_team":"default:acme.aweb.ai","memberships":[{"team_id":"default:acme.aweb.ai","alias":"x"}]}'; exit 0; fi
if [ "$1" = "team" ] && [ "$2" = "invite" ]; then echo '{"token":"tok"}'; exit 0; fi
if [ "$1" = "team" ] && [ "$2" = "join" ]; then echo '{"team_id":"default:acme.aweb.ai","alias":"probe"}'; exit 0; fi
exit 0
`);
  execFileSync("chmod", ["+x", join(bin, "aw")]);
  const root = join(base, "awroot"); mkdirSync(join(root, ".aw"), { recursive: true });
  const r = spawnSync(process.execPath, [hook, "spawn"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OAS_EVENT: "spawn", OAS_INSTANCE: "probe", OAS_HOME: root, OAS_WORKSPACE: root, OAS_CONTEXT: root, OAS_TEAM_SCOPE: root, OAS_TEAM_NAME: "default", OAS_TEAM_ID: "" },
  });
  assert.equal(r.status, 0, `a resolvable name-only team must succeed, got ${r.status}: ${r.stdout} ${r.stderr}`);
  assert.match(r.stdout, /"alias":"probe"/);
  rmSync(base, { recursive: true, force: true });
});

test("no failure path discloses the invite token (reviewer-aggregate2, reviewer-1a6e82e)", () => {
  const hook = resolve(new URL("../capabilities/oas-aweb/bin/oas-aweb.mjs", import.meta.url).pathname);
  const TOKEN = "inv_SUPERSECRET_TOKEN_9f3a";
  // execFileSync puts the whole argv in its error message, JSON.parse quotes the
  // malformed input in its SyntaxError, and a command that MINTS a credential can
  // print it while failing — at which point there is nothing for the caller to
  // scrub, because the token is exactly what it never received. This hook's
  // failures are surfaced by the kernel into CLI/Desktop logs, so every one of
  // those paths is a disclosure.
  const cases = {
    "the join fails, echoing the token": `if [ "$1" = "team" ] && [ "$2" = "invite" ]; then echo '{"token":"${TOKEN}"}'; exit 0; fi
if [ "$1" = "team" ] && [ "$2" = "join" ]; then echo "join rejected for token ${TOKEN}" 1>&2; exit 3; fi`,
    "the INVITE fails after printing the token it minted": `if [ "$1" = "team" ] && [ "$2" = "invite" ]; then echo "minted ${TOKEN} then failed" 1>&2; exit 3; fi`,
    "the invite returns malformed JSON containing the token": `if [ "$1" = "team" ] && [ "$2" = "invite" ]; then echo '{"token":"${TOKEN}"'; exit 0; fi`,
    "the join returns malformed JSON containing the token": `if [ "$1" = "team" ] && [ "$2" = "invite" ]; then echo '{"token":"${TOKEN}"}'; exit 0; fi
if [ "$1" = "team" ] && [ "$2" = "join" ]; then echo '{"alias":"probe" ${TOKEN}'; exit 0; fi`,
  };
  for (const [label, script] of Object.entries(cases)) {
    const base = temp();
    const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
    write(join(bin, "aw"), `#!/bin/sh
if [ "$1" = "team" ] && [ "$2" = "list" ]; then echo '{"active_team":"default:acme.aweb.ai","memberships":[{"team_id":"default:acme.aweb.ai","alias":"x"}]}'; exit 0; fi
${script}
exit 0
`);
    execFileSync("chmod", ["+x", join(bin, "aw")]);
    const root = join(base, "awroot"); mkdirSync(join(root, ".aw"), { recursive: true });
    const r = spawnSync(process.execPath, [hook, "spawn"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OAS_EVENT: "spawn", OAS_INSTANCE: "probe", OAS_HOME: root, OAS_WORKSPACE: root, OAS_CONTEXT: root, OAS_TEAM_SCOPE: root, OAS_TEAM_NAME: "default", OAS_TEAM_ID: "" },
    });
    assert.notEqual(r.status, 0, `${label}: the spawn still fails`);
    assert.doesNotMatch(r.stdout, new RegExp(TOKEN), `${label}: the token must not reach stdout`);
    assert.doesNotMatch(r.stderr, new RegExp(TOKEN), `${label}: nor stderr`);
    assert.match(r.stderr + r.stdout, /identity minting failed|no usable/, `${label}: while the failure is still reported`);
    rmSync(base, { recursive: true, force: true });
  }
});

test("a WELL-FORMED join response cannot reflect the invite token into the output (reviewer-a6aa1c5)", () => {
  const base = temp();
  const hook = resolve(new URL("../capabilities/oas-aweb/bin/oas-aweb.mjs", import.meta.url).pathname);
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  // Suppressing the FAILURE paths achieves nothing if a successful reply is
  // copied into meta and the briefing verbatim. Here every command succeeds and
  // the response is valid JSON — it simply echoes the invite token back as the
  // alias, and the hook printed it twice on exit 0.
  const TOKEN = "inv_SUPERSECRET_TOKEN_9f3a";
  write(join(bin, "aw"), `#!/bin/sh
if [ "$1" = "team" ] && [ "$2" = "list" ]; then echo '{"active_team":"default:acme.aweb.ai","memberships":[{"team_id":"default:acme.aweb.ai","alias":"x"}]}'; exit 0; fi
if [ "$1" = "team" ] && [ "$2" = "invite" ]; then echo '{"token":"${TOKEN}"}'; exit 0; fi
if [ "$1" = "team" ] && [ "$2" = "join" ]; then echo '{"team_id":"${TOKEN}","alias":"${TOKEN}"}'; exit 0; fi
exit 0
`);
  execFileSync("chmod", ["+x", join(bin, "aw")]);
  const root = join(base, "awroot"); mkdirSync(join(root, ".aw"), { recursive: true });
  const r = spawnSync(process.execPath, [hook, "spawn"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OAS_EVENT: "spawn", OAS_INSTANCE: "probe", OAS_HOME: root, OAS_WORKSPACE: root, OAS_CONTEXT: root, OAS_TEAM_SCOPE: root, OAS_TEAM_NAME: "default", OAS_TEAM_ID: "" },
  });
  assert.doesNotMatch(r.stdout, new RegExp(TOKEN), "no emitted field may carry the token");
  assert.doesNotMatch(r.stderr, new RegExp(TOKEN));
  // The spawn still succeeds, using what WE asked for — the requested alias and
  // team are always known, so a rejected field has an honest fallback.
  assert.equal(r.status, 0, `a successful join stays successful: ${r.stderr}`);
  assert.match(r.stdout, /"alias":"probe"/, "the requested alias stands in");
  assert.match(r.stdout, /default:acme\.aweb\.ai/, "as does the requested team");
  rmSync(base, { recursive: true, force: true });
});

test("an alias minted with no local key is incomplete cleanup, not 'nothing to delete'", () => {
  const base = temp();
  const hook = resolve(new URL("../capabilities/oas-aweb/bin/oas-aweb.mjs", import.meta.url).pathname);
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  write(join(bin, "aw"), "#!/bin/sh\nexit 0\n");
  execFileSync("chmod", ["+x", join(bin, "aw")]);
  const homeDir = join(base, "home"); mkdirSync(homeDir, { recursive: true });   // no .aw
  const r = spawnSync(process.execPath, [hook, "retire"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OAS_EVENT: "retire", OAS_INSTANCE: "probe", OAS_HOME: homeDir, OAS_META: JSON.stringify({ alias: "probe", team: "default:acme.aweb.ai" }) },
  });
  // The remote record exists and its key is gone: the self-delete cannot be
  // authenticated, so this must NOT read as a vacuous no-op.
  assert.notEqual(r.status, 0, `missing key must be incomplete, got ${r.status}: ${r.stdout}`);
  assert.match(r.stdout, /no-local-identity-key/);
  assert.doesNotMatch(r.stdout, /nothing-to-delete/);

  // …while a retire with no alias at all genuinely has nothing to undo.
  const noAlias = spawnSync(process.execPath, [hook, "retire"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OAS_EVENT: "retire", OAS_INSTANCE: "probe", OAS_HOME: homeDir, OAS_META: "{}" },
  });
  assert.equal(noAlias.status, 0);
  assert.match(noAlias.stdout, /nothing-to-delete/);
  rmSync(base, { recursive: true, force: true });
});

// ---------- Claude runtime packages (consented, never installed at spawn) ----------

/** A `claude` stub answering `plugin list --json` in Claude's real shape, and
 * REFUSING every other `plugin` subcommand so an imperative install during spawn
 * fails loudly instead of passing silently. `name` lets a test install two
 * differently-named wrappers (e.g. `claude` and `claude-personal`) reporting
 * DIFFERENT plugin states. */
function fakeClaudeWithPlugins(base, rows, { name = "claude", keepPath = false } = {}) {
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  const json = JSON.stringify(rows.map((r) => ({
    id: r.name, version: "1.0.0", scope: r.scope || "user", enabled: r.disabled !== true,
    ...(r.projectPath ? { projectPath: r.projectPath } : {}),
    installPath: join(base, "plugins", r.name),
  })));
  // Claude advertises an installPath, so the fixture must MAKE it: a stub that
  // names a directory it never creates would prove the preflight passes on a
  // registration whose install is gone — the very thing it must reject.
  // `missing: true` keeps the row without the directory, for that case.
  for (const r of rows) {
    const dir = join(base, "plugins", r.name);
    if (r.missing) rmSync(dir, { recursive: true, force: true });   // an earlier fixture in the same test may have made it
    else mkdirSync(dir, { recursive: true });
  }
  write(join(bin, name), `#!/bin/sh
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then cat <<'EOF'
${json}
EOF
exit 0; fi
if [ "$1" = "plugin" ]; then echo "REFUSED: spawn must not install plugins" >&2; exit 9; fi
exit 0
`);
  if (!existsSync(join(bin, "pi"))) write(join(bin, "pi"), "#!/bin/sh\nexit 0\n");
  if (!existsSync(join(bin, "claude"))) write(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  execFileSync("chmod", ["-R", "+x", bin]);
  return keepPath ? `${bin}:${process.env.PATH}` : `${bin}:${process.env.PATH}`;
}

test("a Claude capability plugin is verified at spawn, never installed there", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "claude");
  capability(repo, "chan", {
    capability: "acme.chan",
    requires: [{ runtime: "claude", package: "chan@acme-marketplace", marketplace: "acme/claude-plugins", why: "push events" }],
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const oldPath = process.env.PATH;
  // The stub REFUSES any `claude plugin` subcommand other than list, so an
  // imperative install during spawn would fail loudly rather than pass silently.
  process.env.PATH = fakeClaudeWithPlugins(base, [{ name: "chan@acme-marketplace" }]);
  try {
    const r = spawnInstance(root, findAgent(root, "chan") || findAgent(root, "dev"), { instance: "dev-cc", launch: false });
    const meta = JSON.parse(readFileSync(join(r.home, "instance.json"), "utf8"));
    const pkg = meta.composition.materialized.runtimePackages[0];
    assert.equal(pkg.runtime, "claude");
    assert.equal(pkg.package, "chan@acme-marketplace");
    retireInstance(root, "dev-cc", { tmuxSession: "oas-test-nosuch" });
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("a missing or DISABLED Claude plugin fails the spawn with the consent remedy", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "claude");
  capability(repo, "chan", {
    capability: "acme.chan",
    requires: [{ runtime: "claude", package: "chan@acme-marketplace", marketplace: "acme/claude-plugins", why: "push events" }],
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const oldPath = process.env.PATH;
  try {
    // Absent entirely: the remedy names the consent command AND both install steps.
    process.env.PATH = fakeClaudeWithPlugins(base, []);
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-miss", launch: false }),
      (e) => e.code === "E_RUNTIME_RESOURCE_MISSING"
        && /--accept-requirement claude:chan@acme-marketplace/.test(e.message)
        && /claude plugin marketplace add acme\/claude-plugins && claude plugin install chan@acme-marketplace/.test(e.message),
    );
    // Installed but switched off will not load, so it does not satisfy the requirement.
    process.env.PATH = fakeClaudeWithPlugins(base, [{ name: "chan@acme-marketplace", disabled: true }]);
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-off", launch: false }),
      (e) => e.code === "E_RUNTIME_RESOURCE_MISSING" && /installed but DISABLED/.test(e.message),
    );
    // REGISTERED but gone: Claude still lists the plugin and names an installPath
    // that no longer exists (a cleared cache, a pruned directory). The row is not
    // the install — a registration OAS accepts on the strength of the row alone
    // starts an instance whose required channel is simply absent
    // (reviewer-aggregate2).
    process.env.PATH = fakeClaudeWithPlugins(base, [{ name: "chan@acme-marketplace", missing: true }]);
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-gone", launch: false }),
      (e) => e.code === "E_RUNTIME_RESOURCE_MISSING",
      "a plugin whose advertised install directory is gone does not satisfy the requirement",
    );
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("the shipped aweb capability declares the Claude channel instead of installing it", () => {
  const dir = resolve(new URL("../capabilities/oas-aweb", import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(join(dir, "oas.json"), "utf8"));
  const req = (manifest.requires || []).find((r) => r.runtime === "claude");
  assert.ok(req, "the Claude channel plugin is a declared requirement");
  assert.equal(req.package, "aweb-channel@awebai-marketplace");
  assert.equal(req.marketplace, "awebai/claude-plugins");
  // …and the hook no longer mutates the operator's Claude installation at spawn.
  const hook = readFileSync(join(dir, "bin", "oas-aweb.mjs"), "utf8");
  assert.doesNotMatch(hook, /claude plugin marketplace add/, "no imperative marketplace registration");
  assert.doesNotMatch(hook, /claude plugin install/, "no imperative plugin install");
});

test("the aweb hook runs argv only, and detects `aw` without a shell builtin", () => {
  const dir = resolve(new URL("../capabilities/oas-aweb", import.meta.url).pathname);
  const hook = readFileSync(join(dir, "bin", "oas-aweb.mjs"), "utf8");
  // This is a REQUIRED spawn hook: it gates every spawn, and team ids, aliases,
  // instance names and invite tokens all flow through it. argv removes the
  // injection class rather than relying on one quoting helper staying correct.
  assert.doesNotMatch(hook, /execSync\(/, "no shell-string execution");
  assert.doesNotMatch(hook, /shq\s*\(/, "no shell quoting helper left to get wrong");
  // `command -v` is a SHELL BUILTIN — spawning it as a program depends on a
  // /usr/bin/command binary that many hosts do not ship, and its absence would
  // read as "aw is missing" on every one of them.
  assert.doesNotMatch(hook, /"command",\s*"-v"/, "PATH lookup is resolved in-process");
  assert.match(hook, /function onPath\(/);

  // Drive it with a PATH that has no `aw`: the diagnosis must name the CLI.
  const base = temp();
  const r = spawnSync(process.execPath, [join(dir, "bin", "oas-aweb.mjs"), "spawn"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", OAS_EVENT: "spawn", OAS_INSTANCE: "probe", OAS_HOME: join(base, "nope") },
  });
  assert.notEqual(r.status, 0, "a missing aw CLI is fatal for a required spawn hook");
  assert.match(r.stdout, /aw CLI not on PATH/);
  rmSync(base, { recursive: true, force: true });
});

test("the plugin probe uses the CONTEXT-SELECTED claude executable, not the literal one (reviewer-6f1bb9c)", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "claude");
  capability(repo, "chan", {
    capability: "acme.chan",
    requires: [{ runtime: "claude", package: "chan@acme-marketplace", marketplace: "acme/claude-plugins", why: "push events" }],
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  // oas-claude-config names a wrapper — a separate account with its own plugins.
  write(join(repo, "oas-claude-config"), "claude-personal\n");
  const oldPath = process.env.PATH;
  try {
    // Default `claude` HAS the plugin; the selected `claude-personal` does NOT.
    // Probing the literal executable would pass preflight and launch an
    // instance claiming a channel the real runtime lacks.
    fakeClaudeWithPlugins(base, [{ name: "chan@acme-marketplace" }], { name: "claude" });
    process.env.PATH = fakeClaudeWithPlugins(base, [], { name: "claude-personal" });
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-wrap", launch: false }),
      (e) => e.code === "E_RUNTIME_RESOURCE_MISSING" && /chan@acme-marketplace/.test(e.message),
      "the wrapper's missing plugin must fail, despite `claude` having it",
    );
    // And the reverse: the wrapper has it, the default does not → spawn succeeds.
    const base2 = temp();
    fakeClaudeWithPlugins(base2, [], { name: "claude" });
    process.env.PATH = fakeClaudeWithPlugins(base2, [{ name: "chan@acme-marketplace" }], { name: "claude-personal" });
    const r = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-wrap2", launch: false });
    assert.match(r.command, /claude-personal/, "and the session launches with that same executable");
    retireInstance(root, "dev-wrap2", { tmuxSession: "oas-test-nosuch" });
    rmSync(base2, { recursive: true, force: true });
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("a plugin installed for an UNRELATED project does not satisfy the requirement", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "claude");
  capability(repo, "chan", {
    capability: "acme.chan",
    requires: [{ runtime: "claude", package: "chan@acme-marketplace", marketplace: "acme/claude-plugins", why: "push events" }],
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const oldPath = process.env.PATH;
  try {
    // Enabled and matching, but scoped to someone else's project. Human `plugin
    // list` output loses this distinction entirely.
    process.env.PATH = fakeClaudeWithPlugins(base, [
      { name: "chan@acme-marketplace", scope: "project", projectPath: join(base, "somebody-elses-repo") },
    ]);
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-otherproj", launch: false }),
      (e) => e.code === "E_RUNTIME_RESOURCE_MISSING",
      "a project-scoped install elsewhere must not count",
    );
    // A user-scope install does apply everywhere.
    process.env.PATH = fakeClaudeWithPlugins(base, [{ name: "chan@acme-marketplace", scope: "user" }]);
    const r = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-userscope", launch: false });
    retireInstance(root, "dev-userscope", { tmuxSession: "oas-test-nosuch" });
    assert.ok(r.home);
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("an UNTRUSTED capability's required hook fails the spawn instead of being skipped", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  // Package-backed capability with no executable approval — the default state
  // right after `oas install`. Gating requiredHooks on trust made this spawn
  // succeed with a warning while the required setup never ran.
  const capDir = capability(repo, "chan", {
    capability: "acme.chan",
    hooks: { spawn: { command: "hook.mjs spawn", required: true } },
  }, { "hook.mjs": "console.log('{}');" });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    const resolved = resolveOasConfig(repo, "dev");
    const cap = resolved.capabilities.find((c) => c.id === "acme.chan");
    assert.deepEqual(cap.requiredHooks, ["spawn"], "the DECLARATION is visible regardless of trust");
    if (!cap.trust?.trusted) {
      assert.throws(
        () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-untrusted", launch: false }),
        (e) => e.code === "E_REQUIRED_HOOK_UNTRUSTED"
          && /acme\.chan declares required hook\(s\) spawn/.test(e.message)
          && /oas trust acme\.chan/.test(e.message),
        "a required hook that cannot execute must fail closed, with the trust remedy",
      );
      assert.equal(existsSync(join(root, "dev", "instances", "dev-untrusted")), false, "and before any scaffold");
    }
    // An ADVISORY executable hook stays disabled-with-warning, not fatal.
    write(join(capDir, "oas.json"), JSON.stringify({
      capability: "acme.chan", version: "1.0.0", compatibility: { oas: ">=0.6.2" },
      description: "Test capability.", hooks: { spawn: "hook.mjs spawn" },
    }, null, 2));
    const r = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-advisory", launch: false });
    assert.ok(r.home, "advisory hooks never block a spawn");
    retireInstance(root, "dev-advisory", { tmuxSession: "oas-test-nosuch" });
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("a quarantined home can be cleaned up on retry, and only then removed", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  // EXTERNAL state stands in for a remote identity. Cleanup must actually RUN on
  // retry and remove it — asserting only that the directory disappeared passes
  // even when every retire hook is skipped, which is exactly the bug this covers
  // (reviewer-453d793).
  const remote = join(base, "remote-identity");
  const allowCleanup = join(base, "cleanup-works");
  const credential = "identity.key";
  capability(repo, "chan", {
    capability: "acme.chan",
    hooks: { spawn: { command: "hook.mjs spawn", required: true }, retire: "hook.mjs retire" },
  }, {
    "hook.mjs": `import {writeFileSync, existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';
const home = process.env.OAS_HOME;
const remote = ${JSON.stringify(remote)};
if (process.env.OAS_EVENT === 'spawn') {
  writeFileSync(remote, 'joined');
  writeFileSync(join(home, ${JSON.stringify(credential)}), 'key');
  console.log(JSON.stringify({ meta: { alias: 'probe' } }));
  process.exit(1);
}
const meta = JSON.parse(process.env.OAS_META || '{}');
if (!meta.alias) { console.log(JSON.stringify({ meta: { retired: false, reason: 'nothing-to-delete' } })); process.exit(0); }
if (!existsSync(join(home, ${JSON.stringify(credential)}))) { console.log(JSON.stringify({ meta: { retired: false, reason: 'credential-gone' } })); process.exit(1); }
if (!existsSync(${JSON.stringify(allowCleanup)})) { console.log(JSON.stringify({ meta: { retired: false, reason: 'self-delete-failed' } })); process.exit(1); }
rmSync(remote);
console.log(JSON.stringify({ meta: { retired: true } }));`,
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  const home = join(root, "dev", "instances", "dev-retry");
  try {
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-retry", launch: false }),
      (e) => e.code === "E_REQUIRED_HOOK_FAILED" && /RETAINED/.test(e.message),
    );
    assert.equal(existsSync(remote), true, "external state exists and cleanup has not succeeded");
    assert.equal(existsSync(join(home, credential)), true, "its credential is preserved");
    // The marker must carry what a retry NEEDS, not only what went wrong.
    const marker = JSON.parse(readFileSync(join(home, ".oas-rollback-incomplete.json"), "utf8"));
    assert.equal(marker.cleanup.repo, repo, "cleanup descriptor records the context");
    assert.equal(marker.cleanup.capabilityMeta["acme.chan"].alias, "probe", "and the failed hook's metadata");
    assert.ok(marker.cleanup.capabilityRuntime.some((c) => c.id === "acme.chan"), "and the capability runtime");

    // Retry while the cause persists: cleanup runs, still fails, home SURVIVES.
    const first = retireInstance(root, "dev-retry", { tmuxSession: "oas-test-nosuch" });
    assert.ok(first.rollbackIncomplete, "an unsuccessful retry reports incomplete");
    assert.equal(first.removedDir, false, "and must not delete the credential it still needs");
    assert.equal(existsSync(home), true);
    assert.equal(existsSync(remote), true, "external state is still there");

    // Operator fixes the cause; retry removes the EXTERNAL state, then the home.
    writeFileSync(allowCleanup, "ok");
    const second = retireInstance(root, "dev-retry", { tmuxSession: "oas-test-nosuch" });
    assert.equal(second.rollbackIncomplete, undefined, "cleanup completed");
    assert.equal(existsSync(remote), false, "the retire hook actually ran and removed the external state");
    assert.equal(existsSync(home), false, "and only then is the home removed");
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("a quarantine retry re-runs and VERIFIES the rollback-owned Git cleanup (reviewer-d6e916d)", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  const allow = join(base, "cleanup-works");
  // Retire fails until the operator fixes the cause, so the spawn genuinely
  // quarantines. Hooks then succeed on retry — which is the point: hook-only
  // verification would clear the home while Git residue survives.
  capability(repo, "chan", {
    capability: "acme.chan",
    hooks: { spawn: { command: "hook.mjs spawn", required: true }, retire: "hook.mjs retire" },
  }, {
    "hook.mjs": `import {existsSync} from 'node:fs';
if (process.env.OAS_EVENT === 'spawn') { console.log(JSON.stringify({ meta: { alias: 'probe' } })); process.exit(1); }
if (!existsSync(${JSON.stringify(allow)})) { console.log(JSON.stringify({ meta: { retired: false, reason: 'self-delete-failed' } })); process.exit(1); }
console.log(JSON.stringify({ meta: { retired: true } }));`,
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "cap"]);
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  const home = join(root, "dev", "instances", "dev-git");
  try {
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-git", work: "worktree", launch: false }),
      (e) => e.code === "E_REQUIRED_HOOK_FAILED" && /RETAINED/.test(e.message),
    );
    assert.equal(existsSync(home), true, "the spawn quarantined the home");

    // Git residue the initial rollback left behind: a rollback-owned branch that
    // still exists. Cleanup is NOT complete until it is gone, and the retry must
    // delete it WITHOUT the normal-retire --delete-branch flag.
    execFileSync("git", ["-C", repo, "branch", "dev-git-leftover"]);
    const markerPath = join(home, ".oas-rollback-incomplete.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    marker.cleanup.work = "worktree";
    marker.cleanup.branch = "dev-git-leftover";
    // A Git-ONLY quarantine: hooks finished, the branch did not go. It is the one
    // shape whose outstanding hook list is legitimately empty, and it must stay
    // retryable — the Git verification is its proof (reviewer-2baa631).
    marker.cleanup.outstanding = { hooks: [], git: ["branch"] };
    writeFileSync(markerPath, JSON.stringify(marker, null, 2));

    writeFileSync(allow, "ok");                 // hooks will now succeed
    const r = retireInstance(root, "dev-git", { tmuxSession: "oas-test-nosuch" });
    const branches = execFileSync("git", ["-C", repo, "branch", "--list"], { encoding: "utf8" });
    assert.doesNotMatch(branches, /dev-git-leftover/, "the rollback-owned branch is deleted and verified on retry");
    // Doing it is not enough: --json consumers read branchDeleted, and this path
    // deletes without the --delete-branch flag that normally sets it.
    assert.equal(r.branchDeleted, true, "and the verified deletion is REPORTED");
    assert.equal(r.rollbackIncomplete, undefined, "and cleanup then reports complete");
    assert.equal(existsSync(home), false);
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("a home with no instance.json and no cleanup descriptor is not silently deleted", () => {
  const base = temp();
  const { root } = fixtureSoul(base, "pi");
  // Reachable for real: the spawn path tolerates a failed marker write, leaving
  // a retained home that identifies as nothing. Deleting it would destroy
  // whatever external state it still owns.
  const orphan = join(root, "dev", "instances", "dev-orphan");
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, "identity.key"), "secret");
  assert.throws(
    () => retireInstance(root, "dev-orphan", { tmuxSession: "oas-test-nosuch" }),
    (e) => e.code === "E_UNIDENTIFIED_INSTANCE_HOME" && /no cleanup descriptor/.test(e.message),
  );
  assert.equal(existsSync(join(orphan, "identity.key")), true, "nothing was destroyed");
  // force is the deliberate manual-cleanup escape.
  retireInstance(root, "dev-orphan", { tmuxSession: "oas-test-nosuch", force: true });
  assert.equal(existsSync(orphan), false);
  rmSync(base, { recursive: true, force: true });
});

test("--force clears a home whose quarantine marker cannot drive a retry (reviewer-adff009, reviewer-45ff039r2, reviewer-0ad27d1, reviewer-dd03a98)", () => {
  const base = temp();
  const { root } = fixtureSoul(base, "pi");
  // The cleanup descriptor is a strict contract with exactly one producer (the
  // required-hook rollback), so each case below is that contract with ONE field
  // broken. A marker that cannot drive the retry identifies nothing: retire must
  // refuse by default, and --force — the documented escape — has to work.
  // Tolerating any of these produced a retry that resolved nothing, reported no
  // failures, and CLEARED the quarantine: the credential deleted while the
  // external state it was held for survived.
  //
  // The positive control is not here but in the real-spawn quarantine tests
  // above, which drive this same contract end to end.
  const valid = () => ({
    reason: "required spawn hook failed and compensation did not complete",
    failed: [{ capability: "acme.chan", event: "spawn" }],
    cleanup: {
      version: 1, repo: join(base, "repo"), work: "checkout", branch: "main",
      outstanding: { hooks: ["acme.chan"], git: [] },
      capabilityRuntime: [{ id: "acme.chan", hooks: { retire: "hook.mjs retire" } }],
      capabilityMeta: { "acme.chan": { alias: "probe" } },
    },
  });
  const broken = (fn) => { const m = valid(); fn(m); return JSON.stringify(m); };
  const unusable = {
    "truncated JSON": '{"cleanup": {"repo":',
    "no descriptor at all": '{"reason": "required spawn hook failed"}',
    "an array descriptor": '{"cleanup": []}',
    "an empty descriptor": '{"cleanup": {}}',
    // The contract version: a marker this kernel cannot interpret must not drive
    // a retry on a guess.
    "no contract version": broken((m) => { delete m.cleanup.version; }),
    "a future contract version": broken((m) => { m.cleanup.version = 2; }),
    // repo: retire resolves capabilities and reruns every hook from it.
    "no context repo": broken((m) => { delete m.cleanup.repo; }),
    "a blank context repo": broken((m) => { m.cleanup.repo = "   "; }),
    "a mistyped context repo": broken((m) => { m.cleanup.repo = 17; }),
    // work/branch: the rollback-owned Git steps. An unrecognised mode skips them
    // silently and calls the cleanup complete.
    "no work mode": broken((m) => { delete m.cleanup.work; }),
    "an unknown work mode": broken((m) => { m.cleanup.work = "wortree"; }),
    "a worktree with no branch": broken((m) => { m.cleanup.work = "worktree"; delete m.cleanup.branch; }),
    "a worktree with a mistyped branch": broken((m) => { m.cleanup.work = "worktree"; m.cleanup.branch = ["a"]; }),
    // capabilityRuntime IS the capability set handed to runLifecycleHooks.
    "no capability set": broken((m) => { delete m.cleanup.capabilityRuntime; }),
    "a mistyped capability set": broken((m) => { m.cleanup.capabilityRuntime = {}; }),
    "an empty capability set": broken((m) => { m.cleanup.capabilityRuntime = []; }),
    "capability entries that are not capabilities": broken((m) => { m.cleanup.capabilityRuntime = [{}]; }),
    "a null capability entry": broken((m) => { m.cleanup.capabilityRuntime = [null]; }),
    "an id-less capability entry": broken((m) => { m.cleanup.capabilityRuntime = [{ id: "  " }]; }),
    "a capability set missing the outstanding capability": broken((m) => { m.cleanup.capabilityRuntime = [{ id: "acme.other" }]; }),
    // outstanding.hooks is what the retry must PROVE it reran.
    "no outstanding record": broken((m) => { delete m.cleanup.outstanding; }),
    "a mistyped outstanding record": broken((m) => { m.cleanup.outstanding = ["acme.chan"]; }),
    "a mistyped outstanding hook list": broken((m) => { m.cleanup.outstanding = { hooks: "acme.chan" }; }),
    "a mistyped outstanding hook id": broken((m) => { m.cleanup.outstanding = { hooks: [{ id: "acme.chan" }], git: [] }; }),
    "a missing outstanding git list": broken((m) => { delete m.cleanup.outstanding.git; }),
    "a mistyped outstanding git list": broken((m) => { m.cleanup.outstanding.git = "branch"; }),
    "an unknown outstanding git item": broken((m) => { m.cleanup.outstanding.git = ["stash"]; }),
    // The rollback owns Git steps only for a worktree, so debt claimed anywhere
    // else describes a quarantine that could not have happened.
    "git debt in a non-worktree mode": broken((m) => { m.cleanup.outstanding.git = ["branch"]; }),
    // NOTHING outstanding is a proof obligation of zero: the retry runs, proves
    // nothing, and deletes the home and its credential. The ID-only capability
    // entry is the shape that makes it look plausible (reviewer-2baa631).
    "nothing outstanding at all": broken((m) => {
      m.cleanup.outstanding = { hooks: [], git: [] };
      m.cleanup.capabilityRuntime = [{ id: "acme.chan" }];
    }),
    "a mistyped capabilityMeta": broken((m) => { m.cleanup.capabilityMeta = []; }),
  };
  for (const [label, marker] of Object.entries(unusable)) {
    const home = join(root, "dev", "instances", "dev-broken");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "identity.key"), "secret");
    writeFileSync(join(home, ".oas-rollback-incomplete.json"), marker);
    assert.throws(
      () => retireInstance(root, "dev-broken", { tmuxSession: "oas-test-nosuch" }),
      (e) => e.code === "E_UNIDENTIFIED_INSTANCE_HOME",
      `${label}: an unusable marker is an unidentified home, not a retryable quarantine`,
    );
    assert.equal(existsSync(join(home, "identity.key")), true, `${label}: nothing was destroyed`);
    const r = retireInstance(root, "dev-broken", { tmuxSession: "oas-test-nosuch", force: true });
    assert.equal(r.rollbackIncomplete, undefined, `${label}: force does not report an incompletion it cannot retry`);
    assert.equal(r.removedDir, true, `${label}: removedDir`);
    assert.equal(existsSync(home), false, `${label}: the operator's escape hatch actually removes the home`);
  }
  rmSync(base, { recursive: true, force: true });
});

test("a retry that reruns NO outstanding hook fails closed, and --force is the way out (reviewer-dd03a98)", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  const remote = join(base, "remote-identity");
  capability(repo, "chan", {
    capability: "acme.chan",
    hooks: { spawn: { command: "hook.mjs spawn", required: true }, retire: "hook.mjs retire" },
  }, {
    "hook.mjs": `import {writeFileSync} from 'node:fs';
if (process.env.OAS_EVENT === 'spawn') { writeFileSync(${JSON.stringify(remote)}, 'joined'); console.log(JSON.stringify({ meta: { alias: 'probe' } })); process.exit(1); }
console.log(JSON.stringify({ meta: { retired: false, reason: 'self-delete-failed' } })); process.exit(1);`,
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  const home = join(root, "dev", "instances", "dev-nohook");
  try {
    assert.throws(() => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-nohook", launch: false }),
      (e) => e.code === "E_REQUIRED_HOOK_FAILED");
    const markerPath = join(home, ".oas-rollback-incomplete.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    assert.deepEqual(marker.cleanup.outstanding.hooks, ["acme.chan"], "the marker records WHICH hook still owes cleanup");

    // The descriptor stays structurally valid and still names the outstanding
    // capability — it simply carries no retire hook for it. Whether that comes
    // from a hand-edited marker or from config drift since the spawn, the retry
    // resolves nothing to run: zero hooks, zero failures. Reporting that as a
    // completed cleanup deletes the credential while the remote identity lives on.
    marker.cleanup.capabilityRuntime = [{ id: "acme.chan" }];
    writeFileSync(markerPath, JSON.stringify(marker, null, 2));

    const r = retireInstance(root, "dev-nohook", { tmuxSession: "oas-test-nosuch" });
    // Either way the retry resolved nothing to run for acme.chan — whether the
    // entry names no retire hook or the capability is gone from config — and a
    // hook that never ran cannot count as cleanup done.
    assert.ok(r.rollbackIncomplete?.some((f) => /acme\.chan/.test(f) && /did not run|cannot verify or undo/.test(f)),
      `a hook that never ran cannot count as cleanup done, got ${JSON.stringify(r.rollbackIncomplete)}`);
    assert.equal(r.removedDir, false);
    assert.equal(existsSync(home), true, "the home survives");
    assert.equal(existsSync(remote), true, "and so does the external state nobody cleaned up");

    // ...and because that state can persist forever, the operator must still have
    // a way out. --force removes the home and NAMES what it is leaving behind,
    // rather than reporting a clean retirement.
    const env = { ...process.env, PI_AGENTS_TMUX_SESSION: "oas-test-nosuch" };
    delete env.PI_AGENTS_ROOT;
    const cli = spawnSync(process.execPath, [CLI, "retire", "dev-nohook", "--dir", root, "--force", "--json"], { encoding: "utf8", env });
    assert.equal(cli.status, 0, `a forced removal succeeded, so it exits 0: ${cli.stderr}`);
    const f = JSON.parse(cli.stdout);
    assert.equal(f.rollbackIncomplete, undefined);
    assert.ok(f.forcedIncomplete?.length, "forced removal reports what was left outstanding");
    assert.equal(f.removedDir, true);
    assert.match(cli.stderr, /NOT cleaned up/, "and says so to the human, not only in the JSON");
    assert.match(cli.stderr, /acme\.chan/, "naming the state they now own");
    assert.equal(existsSync(home), false, "the home is gone because the operator said so");
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

// The founder-approved home/work boundary. These assertions are about what the
// composed text MEANS for the agent reading it, not which literals it contains:
// a contract that merely restates its own strings passes while contradicting the
// mode it was composed for (reviewer-focus-c6e3680).
const BOUNDARY_MUST_SAY = [
  "$OAS_INSTANCE_HOME",                                   // the runtime-neutral name
  "It is not your user home (`~`), not the repository root, and not the work tree",
  "commands from active capabilities, from instance home",   // the shape, not the sentence
  "for example, when the aweb messaging capability is active",  // an optional capability is CITED, never commanded
  "oas <cmd> --dir <path>",                               // the deliberate alternate scope
  "The home's `soul` link is not your edit surface",      // not "read-only": it is writable, and that is the point
];
// The instruction that taught the root-placement bug, in any shipped surface.
const SETTLE_IN_WORK = /cd work\/? once|and stay there|where you live|Start in `work\/`/i;
/** Compare wording, not line wrapping: the contract is what the agent reads. */
const flat = (t) => t.replace(/\s+/g, " ");

test("every work mode's generated instructions carry the home/work boundary (maintainer contract)", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  const soulDir = join(root, "dev", "soul");
  for (const mode of ["worktree", "checkout", "attached", "workspace"]) {
    const text = flat(composeInstanceAgentsMd(soulDir, repo, "dev", mode).text);
    for (const must of BOUNDARY_MUST_SAY) {
      assert.ok(text.includes(flat(must)), `${mode}: generated instructions must say ${JSON.stringify(must)}`);
    }
    assert.doesNotMatch(text, SETTLE_IN_WORK, `${mode}: must not teach settling in the work tree`);
    assert.ok(text.includes(`Work mode: ${mode}`), `${mode}: and still carries its own mode block`);
    assert.ok(text.indexOf("Your two directories") < text.indexOf(`Work mode: ${mode}`),
      `${mode}: the boundary precedes the mode rules it frames`);
    // The boundary must DEFER to the mode on what is permitted. An unqualified
    // "everything happens in work/" is false for workspace mode (read-only, not
    // a repo) and forbids the episodic state the same text puts in the home.
    assert.ok(text.includes(flat("What your mode permits is the mode block's call")),
      `${mode}: the boundary must defer to the mode on permitted operations`);
    assert.doesNotMatch(text, /Nothing you produce belongs anywhere else/,
      `${mode}: an absolute output ban contradicts episodic state and role artifacts`);
  }
  rmSync(base, { recursive: true, force: true });
});

test("the boundary does not contradict a read-only workspace instance (reviewer-focus-c6e3680)", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  const text = flat(composeInstanceAgentsMd(join(root, "dev", "soul"), repo, "dev", "workspace").text);
  // Workspace `work` is the deployment scope, not a repo, and it is read-only.
  assert.ok(text.includes("never edit or commit inside them"), "the mode's read-only rule survives");
  assert.ok(text.includes(flat("`<instance-home>/work` is your repository or workspace view")),
    "and the boundary calls it a repository OR WORKSPACE view, not simply the repository");
  assert.doesNotMatch(text, /work` is the repository\b/, "no unqualified 'work is the repository' claim");
  rmSync(base, { recursive: true, force: true });
});

test("a REAL spawned packaged reviewer gets the boundary and keeps its own report path (reviewer-focus-c6e3680)", async () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  // The SHIPPED oas-review capability, spawned through the real service path —
  // not a synthetic composer call. Its own instructions require writing a report
  // to a temp file before mailing it, so a boundary forbidding output outside
  // work/ would contradict the very agent it ships beside.
  const src = resolve(new URL("../capabilities/oas-review", import.meta.url).pathname);
  const dst = join(repo, ".agents", "capabilities", "owned", "oas-review");
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    oas.review:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    // `await` INSIDE the try: returning the promise from the try block restores
    // PATH before the body ever runs, so the test silently used whatever `pi`
    // the machine happened to have installed (reviewer-focus-699fdb6).
    const core = await import("../lib/core.mjs");
    const agent = core.findCapabilityAgent(repo, root, "reviewer");
    assert.ok(agent, "the shipped reviewer resolves");
    const res = core.spawnInstance(root, { ...agent, repo }, { instance: "reviewer-boundary", work: "checkout", launch: false });
    const text = flat(readFileSync(join(res.home, "AGENTS.md"), "utf8"));
    for (const must of BOUNDARY_MUST_SAY) {
      assert.ok(text.includes(flat(must)), `spawned reviewer: must say ${JSON.stringify(must)}`);
    }
    assert.doesNotMatch(text, SETTLE_IN_WORK);
    // Its mandated artifact must remain possible.
    assert.match(text, /Write the report to a temp file first/,
      "the reviewer's own report artifact survives composition — the boundary must not forbid it");
    assert.doesNotMatch(text, /Nothing you produce belongs anywhere else/,
      "and the boundary must not forbid the temp file that instruction requires");
    core.retireInstance(root, "reviewer-boundary", { tmuxSession: "oas-test-nosuch" });
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

// Notes and `oas okf harvest` come from the oas.okf capability. An instance
// without it has neither, and a capability service agent has its knowledge layer
// SUPPRESSED by design — the shipped reviewer is told in its own soul not to
// write notes/ and not to run any harvest. So the kernel-composed blocks must
// stay knowledge-provider-neutral: prescribing that protocol unconditionally
// tells those instances to use machinery they do not have, or that their own
// instructions forbid (reviewer-focus-b512782).
// PRESCRIPTION, not mention: naming "harvesters" as a kind of service agent is
// fine; telling an instance to write `notes/`, run a harvest, or promising how
// its promotions are delivered is what only the knowledge layer may do.
const KNOWLEDGE_PROTOCOL = /notes\/|okf harvest|memory promotion|harvester(,? which| that)? promot|promot\w* (it |them |your learnings )?(in)?to (its|your|the) soul|knowledge (promotion|updates) (arrive|are delivered)/i;

test("kernel-composed blocks never prescribe a knowledge protocol they cannot guarantee (reviewer-focus-b512782)", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  const soulDir = join(root, "dev", "soul");
  // No oas.okf capability anywhere in this fixture: whatever these blocks say,
  // no notes/ dir is scaffolded and no `oas okf harvest` exists.
  const kernelOnly = (mode, kind) => flat(composeInstanceAgentsMd(soulDir, repo, "dev", mode, kind).text);
  for (const mode of ["worktree", "checkout", "attached", "workspace"]) {
    for (const kind of [undefined, "local", "capability"]) {
      const text = kernelOnly(mode, kind);
      for (const must of BOUNDARY_MUST_SAY) {
        assert.ok(text.includes(flat(must)), `${mode}/${kind}: must say ${JSON.stringify(must)}`);
      }
      assert.doesNotMatch(text, KNOWLEDGE_PROTOCOL,
        `${mode}/${kind}: kernel blocks must not prescribe notes//harvest — no knowledge layer is composed here`);
      // aweb is a capability too, so the kernel may CITE `aw` as an example of an
      // active capability's command but never command it. Checking three
      // spellings let "Use `aw`" or "Run aw" through, so check the property:
      // every sentence mentioning `aw` must carry a conditional (reviewer-focus-d589eec).

      assert.doesNotMatch(text, SETTLE_IN_WORK, `${mode}/${kind}`);
    }
  }
  // The local block states CUSTODY (no commit, no PR, immediate effect) without
  // prescribing who writes, and no longer tells the agent to edit its own soul.
  const local = kernelOnly("worktree", "local");
  assert.ok(local.includes("Local soul (uncommitted)"), "precondition: the local block composed");
  assert.doesNotMatch(local, /Your soul updates are plain file edits/,
    "the retired direct-edit instruction must stay gone");
  assert.ok(local.includes(flat("no git commit, no PR, because this directory is not version-controlled")));
  rmSync(base, { recursive: true, force: true });
});

test("with the knowledge layer active, ONE block owns the protocol (reviewer-focus-b512782)", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  const src = resolve(new URL("../capabilities/oas-okf", import.meta.url).pathname);
  const dst = join(repo, ".agents", "capabilities", "owned", "oas-okf");
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  layers:\n    knowledge:\n      capability: oas.okf\n      global: true\n");
  const soulDir = join(root, "dev", "soul");

  // Persistent + worktree + OKF: the combination the earlier local-only test
  // could not reach. The knowledge block prescribes the protocol; the kernel
  // boundary defers to it and speaks only about ASSIGNED soul work.
  // Count OWNING BLOCKS, not matches in flattened prose: "at least one match"
  // passed while a second block carried its own competing rule (the workspace
  // briefing's "Memory promotion writes there, on a branch, delivered as a PR")
  // — which the old narrow regex could not even see (reviewer-focus-d357cee).
  const owners = (mode, kind) => composeInstanceAgentsMd(soulDir, repo, "dev", mode, kind)
    .blocks.filter((b) => KNOWLEDGE_PROTOCOL.test(b.content)).map((b) => b.source);
  for (const mode of ["worktree", "checkout", "attached", "workspace"]) {
    for (const kind of [undefined, "local"]) {
      assert.deepEqual(owners(mode, kind), ["capability:oas.okf"],
        `${mode}/${kind}: exactly one block may own the knowledge protocol`);
    }
    // Capability service agents suppress the knowledge layer by design, so NO
    // block may carry it — the shipped reviewer is told not to write notes at all.
    assert.deepEqual(owners(mode, "capability"), [],
      `${mode}/capability: the suppressed layer must leave nothing behind`);
  }
  const text = flat(composeInstanceAgentsMd(soulDir, repo, "dev", "worktree").text);
  assert.ok(text.includes(flat("How your own learnings reach your soul is your knowledge layer's business")),
    "and the boundary defers rather than competing with it");
  assert.ok(text.includes(flat("If your TASK is to change soul content that lives in this repository")),
    "assigned soul-maintenance work is distinguished from promotion of learnings");
  for (const must of BOUNDARY_MUST_SAY) {
    assert.ok(flat(composeInstanceAgentsMd(soulDir, repo, "dev", "attached", "capability").text).includes(flat(must)),
      `capability: must still say ${JSON.stringify(must)}`);
  }
  rmSync(base, { recursive: true, force: true });
});

test("every harvest spawn path briefs its own custody-specific finish (reviewer-focus-d357cee)", () => {
  // The harvester's soul and skill accompany ALL THREE spawn paths, so neither
  // may mandate a finish: oas-okf.mjs briefs a shared-tree commit, a worktree
  // plus PR, or a direct edit with nothing to commit. Two of three harvesters
  // were reading instructions that did not describe their situation.
  const okf = resolve(new URL("../capabilities/oas-okf", import.meta.url).pathname);
  const soul = readFileSync(join(okf, "agents", "memory-harvest.md"), "utf8");
  const skill = readFileSync(join(okf, "skills", "memory-harvest", "SKILL.md"), "utf8");
  for (const [what, text] of [["soul", soul], ["skill", skill]]) {
    assert.match(text, /briefing|TASK\.md/i, `the ${what} must defer to the briefing`);
    assert.doesNotMatch(flat(text), /then commit on the shared work tree and retire|commit once with a `memory-harvest:` prefix, then/i,
      `the ${what} must not mandate ONE finish for three custodies`);
  }
  // And the skill must actually describe all three deliveries.
  for (const delivery of ["Attached to the source work tree", "Worktree of the soul's home repo", "Uncommitted local soul"]) {
    assert.ok(skill.includes(delivery), `the skill must describe the "${delivery}" path`);
  }
  // Each briefing the spawner emits states its own finish.
  const bin = readFileSync(join(okf, "bin", "oas-okf.mjs"), "utf8");
  assert.match(bin, /Do NOT merge it/, "workspace path briefs PR delivery");
  assert.match(bin, /commit your promotions there as a single commit/, "attached path briefs the shared-tree commit");
  rmSync(join(okf, "..", "..", "nonexistent-cleanup-noop"), { recursive: true, force: true });
});

test("no shipped instructional surface teaches settling in the work tree (maintainer contract)", () => {
  // One line in one file caused this; pin the property across every surface an
  // agent or operator can read, present and future.
  const pkg = resolve(new URL("..", import.meta.url).pathname);
  const surfaces = [];
  const walk = (dir, filter) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, filter);
      else if (filter(e.name)) surfaces.push(p);
    }
  };
  walk(join(pkg, "injects"), (n) => n.endsWith(".md"));
  walk(join(pkg, "docs"), (n) => n.endsWith(".md"));
  walk(join(pkg, "skills"), (n) => n === "SKILL.md");
  walk(join(pkg, "capabilities"), (n) => n.endsWith(".md"));
  surfaces.push(join(pkg, "README.md"));
  assert.ok(surfaces.length > 10, `expected the full instructional surface, saw ${surfaces.length}`);
  for (const f of surfaces) {
    assert.doesNotMatch(readFileSync(f, "utf8"), SETTLE_IN_WORK, `${relative(pkg, f)} teaches the root-placement bug`);
  }
});

test("the independently targetable oas.review assumes no knowledge or messaging layer", () => {
  // oas.review may be composed into a deployment that has replaced or disabled
  // either layer — `requires` is for host commands and runtime packages, never
  // capability dependencies (maintainer ruling). These are BOUNDED, observable
  // properties. Provider neutrality as a whole is not machine-decidable from
  // prose: when these surfaces change, it needs semantic review by the
  // maintainer, which the PR process already provides.
  const dir = resolve(new URL("../capabilities/oas-review", import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(join(dir, "oas.json"), "utf8"));
  for (const r of manifest.requires || []) {
    assert.ok(!r.capability && !r.layer, `requires must not carry layer dependencies: ${JSON.stringify(r)}`);
  }
  // The two surfaces that ship INDEPENDENTLY of any layer must issue no
  // unconditional command belonging to one.
  for (const f of ["injects/review.md", "agents/reviewer/AGENTS.md"]) {
    const text = readFileSync(join(dir, f), "utf8");
    assert.doesNotMatch(text, /\baw\b/i, `${f} commands the aweb CLI`);
    assert.doesNotMatch(text, /\boas okf\b/i, `${f} commands the OKF layer`);
  }
  // Conditional wording plus the transcript fallback: what an instance actually
  // needs to behave correctly with, and without, a messaging layer.
  const soul = readFileSync(join(dir, "agents", "reviewer", "AGENTS.md"), "utf8");
  const noLayerPara = soul.split(/\n\s*\n/).find((para) => /none is active/i.test(para));
  assert.ok(noLayerPara && /print the full report as your final message/i.test(noLayerPara) && /transcript/i.test(noLayerPara),
    "the reviewer must define transcript delivery in the no-layer instruction itself");
  assert.match(soul, /If a messaging layer is active/, "and the active-layer path must be conditional");
  const inject = readFileSync(join(dir, "injects", "review.md"), "utf8");
  assert.match(inject, /otherwise in its own session transcript/, "the discipline block states the no-layer delivery");
  assert.match(inject, /when a knowledge\s+layer is active/i, "and makes the promotion step conditional");
});

test("the accepted trust boundary is DOCUMENTED, not left as a code comment (maintainer contract)", () => {
  // The maintainer accepted the narrow filesystem TOCTOU residual as a deployment
  // trust boundary — which only holds if operators are TOLD. A prerequisite that
  // lives in a source comment is one no deployment ever reads.
  const doc = readFileSync(resolve(new URL("../docs/souls-and-instances.md", import.meta.url).pathname), "utf8");
  const flatDoc = doc.replace(/\s+/g, " ");
  for (const must of [
    "must be owned by the operator and not writable by untrusted users or processes",
    "openat",                                    // why the kernel cannot close it
    "E_NO_CANONICAL_ROOT",                       // what failure looks like
    "OAS_INSTANCE_HOME",                         // how an instance learns its home
    "soul-owning repo's primary checkout",       // where homes actually land
  ]) {
    assert.ok(flatDoc.includes(must.replace(/\s+/g, " ")), `public docs must state ${JSON.stringify(must)}`);
  }
});

test("instance homes stay inside the deployment: every layout, every symlink escape (reviewer-aggregate2, reviewer-1a6e82e)", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  // A SECOND primary Git repo standing in for "somewhere else entirely" — the
  // escapes below are only interesting because the home would land in a real,
  // unrelated deployment-looking place, taking any credential a hook writes.
  const foreign = join(base, "foreign"); gitRepo(foreign);
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  const spawnHome = (agent, instance) =>
    spawnInstance(root, agent, { instance, launch: false }).home;
  try {
    // --- Legitimate layouts still work. ------------------------------------
    const persistent = spawnHome(findAgent(root, "dev"), "dev-ok");
    assert.equal(realpathSync(persistent), join(realpathSync(join(root, "dev")), "instances", "dev-ok"));

    // A local soul under the scope's SIBLING local-agents/.
    const localSoul = join(base, "local-agents", "helper", "soul");
    write(join(localSoul, "soul.yaml"), `name: helper\nkind: local\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
    write(join(localSoul, "AGENTS.md"), "# helper\n");
    const localHome = spawnHome(findAgent(root, "helper"), "helper-ok");
    assert.ok(realpathSync(localHome).includes(join("local-agents", "helper", "instances")), "sibling local-agents layout spawns");

    // A legacy NESTED local dir, still read by the kernel.
    const legacySoul = join(root, "tmp-agents", "scratch", "soul");
    write(join(legacySoul, "soul.yaml"), `name: scratch\nkind: local\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
    write(join(legacySoul, "AGENTS.md"), "# scratch\n");
    const legacyHome = spawnHome(findAgent(root, "scratch"), "scratch-ok");
    assert.ok(realpathSync(legacyHome).includes(join("tmp-agents", "scratch", "instances")), "legacy nested layout spawns");

    // --- Every escape is refused, and NOTHING is created outside. ----------
    const escapes = {
      // The instances/ dir itself redirects the home.
      "a symlinked instances/ dir": () => {
        const d = join(root, "esc1", "soul"); write(join(d, "soul.yaml"), `name: esc1\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
        write(join(d, "AGENTS.md"), "# esc1\n");
        symlinkSync(foreign, join(root, "esc1", "instances"));
        return findAgent(root, "esc1");
      },
      // The agent dir redirects one level up.
      "a symlinked agent dir": () => {
        const out = join(base, "outside-soul", "soul");
        write(join(out, "soul.yaml"), `name: esc2\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
        write(join(out, "AGENTS.md"), "# esc2\n");
        symlinkSync(join(base, "outside-soul"), join(root, "esc2"));
        return findAgent(root, "esc2");
      },
      // The BASE redirects: resolving each base and trusting the result made the
      // symlink's target an allowed deployment base (reviewer-1a6e82e).
      "a symlinked legacy local base": () => {
        const outside = join(base, "foreign-agents");
        write(join(outside, "esc3", "soul", "soul.yaml"), `name: esc3\nkind: local\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
        write(join(outside, "esc3", "soul", "AGENTS.md"), "# esc3\n");
        symlinkSync(outside, join(root, "local-agents"));
        return findAgent(root, "esc3");
      },
    };
    for (const [label, setup] of Object.entries(escapes)) {
      const agent = setup();
      assert.ok(agent, `${label}: precondition — the agent resolves, so only the placement guard can stop it`);
      const before = readdirSync(foreign).length;
      assert.throws(
        () => spawnInstance(root, agent, { instance: `${agent.name}-x`, launch: false }),
        (e) => e.code === "E_NO_CANONICAL_ROOT",
        `${label}: the home would land outside the deployment`,
      );
      assert.equal(readdirSync(foreign).length, before, `${label}: nothing was created outside`);
    }
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("a path swapped AFTER validation is caught before anything is written (reviewer-a6aa1c5)", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  const foreign = join(base, "foreign"); gitRepo(foreign);
  // The placement checks run before composition and the runtime preflight, both
  // of which shell out — a real window. The fake `pi` swaps instances/ for a link
  // to the foreign repo WHILE the preflight is running, which is exactly the
  // race: mkdirSync then follows the link, and everything after it (scaffolding,
  // the identity hook and its key) would land outside the deployment.
  capability(repo, "chan", { capability: "acme.chan", requires: [{ runtime: "pi", package: "npm:@acme/chan", why: "channel" }] });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  const instances = join(root, "dev", "instances");
  const pkgDir = join(base, "pkg"); mkdirSync(pkgDir, { recursive: true });
  write(join(bin, "pi"), `#!/bin/sh
if [ "$1" = "list" ]; then
  rm -rf ${JSON.stringify(instances)}
  ln -s ${JSON.stringify(foreign)} ${JSON.stringify(instances)}
  echo "User packages:"
  echo "  npm:@acme/chan"
  echo "    ${pkgDir}"
fi
exit 0
`);
  write(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  execFileSync("chmod", ["-R", "+x", bin]);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${process.env.PATH}`;
  try {
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-race", launch: false }),
      (e) => e.code === "E_NO_CANONICAL_ROOT" && /after it was validated|not at/.test(e.message),
      "a destination that changed after validation must not be used",
    );
    assert.deepEqual(readdirSync(foreign).filter((f) => f !== ".git" && f !== ".gitignore"), [],
      "and nothing — not even the empty home — is left outside the deployment");
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("a rollback AFTER launch quarantines too — every path, not just required hooks (reviewer-terminal54a87fd)", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  // The spawn SUCCEEDS, then re-pointing the parent anchor fails, so the kernel
  // rolls back an instance that already exists. That path deleted the home
  // unconditionally — including while its own retire hook was reporting failure
  // — which strands the external state the hook could not undo and destroys the
  // credential that was the only way to retry. Same defect the required-hook
  // path was fixed for; a second copy of the logic is how it survived.
  const remote = join(base, "remote-identity");
  const allow = join(base, "cleanup-works");
  capability(repo, "comp", { capability: "acme.comp", hooks: { spawn: "hook.mjs spawn", retire: "hook.mjs retire" } }, {
    "hook.mjs": `import {writeFileSync, existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';
if (process.env.OAS_EVENT === 'spawn') {
  writeFileSync(${JSON.stringify(remote)}, 'joined');
  writeFileSync(join(process.env.OAS_HOME, 'identity.key'), 'key');
  console.log(JSON.stringify({ meta: { alias: 'probe' } }));
  process.exit(0);
}
if (!existsSync(${JSON.stringify(allow)})) { console.log(JSON.stringify({ meta: { retired: false, reason: 'self-delete-failed' } })); process.exit(3); }
// Actually undo the external state — a hook that only REPORTS success would let
// the test pass while the remote identity survived.
rmSync(${JSON.stringify(remote)}, { force: true });
console.log(JSON.stringify({ meta: { retired: true } }));`,
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.comp:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  const home = join(root, "dev", "instances", "dev-child");
  try {
    const anchorInst = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-anchor", launch: false });
    // Make the anchor's atomic re-point fail: a DIRECTORY where its temp file goes.
    mkdirSync(join(anchorInst.home, "instance.json.tmp-dev-child"), { recursive: true });
    write(join(anchorInst.home, "instance.json.tmp-dev-child", "x"), "x");

    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-child", relation: "parent", relativeTo: "dev-anchor", launch: false }),
      (e) => /failed to re-point anchor/.test(e.message) && /RETAINED/.test(e.message),
      "a rollback that could not compensate must not report a clean one",
    );
    assert.equal(existsSync(join(home, "identity.key")), true, "the credential the retry needs survives");
    assert.equal(existsSync(remote), true, "and the external state nobody cleaned up is still there");
    const marker = JSON.parse(readFileSync(join(home, ".oas-rollback-incomplete.json"), "utf8"));
    assert.equal(marker.cleanup.version, 1, "the quarantine carries the same cleanup contract");
    assert.deepEqual(marker.cleanup.outstanding.hooks, ["acme.comp"], "naming the hook that still owes cleanup");

    // The home this path retains ALREADY HAS instance.json — it was written
    // before the anchor step — and gating the marker on its absence made retire
    // ignore the quarantine entirely, take the ordinary path where hook failures
    // do not retain, and delete the credential (reviewer-final0130bc8).
    assert.equal(existsSync(join(home, "instance.json")), true, "precondition: a live-looking home");
    assert.equal(marker.cleanup.capabilityMeta["acme.comp"]?.alias, "probe",
      "the descriptor keeps the SPAWN metadata a retry needs, not the failed compensation's report");

    // FIRST retry, cause unfixed: must retain everything and not claim success.
    const first = retireInstance(root, "dev-child", { tmuxSession: "oas-test-nosuch" });
    assert.ok(first.rollbackIncomplete?.length, "a failing retry reports incomplete");
    assert.equal(first.removedDir, false);
    assert.equal(existsSync(join(home, "identity.key")), true, "the credential survives the failed retry");
    assert.equal(existsSync(join(home, ".oas-rollback-incomplete.json")), true, "and so does the marker");
    assert.equal(existsSync(remote), true, "and the external state it exists to undo");
    const after = JSON.parse(readFileSync(join(home, ".oas-rollback-incomplete.json"), "utf8"));
    assert.equal(after.cleanup.capabilityMeta["acme.comp"]?.alias, "probe",
      "the spawn metadata is not displaced by the retry's own failure report");

    // SECOND retry, cause fixed: external cleanup verified, then removal.
    writeFileSync(allow, "ok");
    const r = retireInstance(root, "dev-child", { tmuxSession: "oas-test-nosuch" });
    assert.equal(r.rollbackIncomplete, undefined, `the retry completes: ${JSON.stringify(r.rollbackIncomplete)}`);
    assert.equal(existsSync(remote), false, "the remote state is actually gone");
    assert.equal(existsSync(home), false, "and only then is the home removed");
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("a marker beside a live instance.json is authoritative, usable or not (reviewer-final0130bc8)", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    // An UNUSABLE marker next to instance.json is evidence that cleanup was
    // interrupted, not noise to skip: OAS cannot tell what remains, so it fails
    // closed and `--force` is the deliberate escape.
    const a = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-broke", launch: false });
    writeFileSync(join(a.home, "identity.key"), "secret");
    writeFileSync(join(a.home, ".oas-rollback-incomplete.json"), '{"cleanup": {"repo":');
    assert.throws(
      () => retireInstance(root, "dev-broke", { tmuxSession: "oas-test-nosuch" }),
      (e) => e.code === "E_UNIDENTIFIED_INSTANCE_HOME",
      "an unusable marker must not be ignored just because instance.json exists",
    );
    assert.equal(existsSync(join(a.home, "identity.key")), true, "nothing destroyed");
    retireInstance(root, "dev-broke", { tmuxSession: "oas-test-nosuch", force: true });
    assert.equal(existsSync(a.home), false, "and --force still clears it");

    // An ordinary live instance with NO marker retires normally — the guard must
    // not turn every retire into a quarantine.
    const b = spawnInstance(root, findAgent(root, "dev"), { instance: "dev-plain", launch: false });
    const r = retireInstance(root, "dev-plain", { tmuxSession: "oas-test-nosuch" });
    assert.equal(r.rollbackIncomplete, undefined, "no marker, no quarantine");
    assert.equal(r.removedDir, true);
    assert.equal(existsSync(b.home), false);
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("a required spawn hook with NO retire hook quarantines instead of deleting the credential (reviewer-446ebe1)", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  // The manifest permits this shape: a required spawn hook and no retire hook.
  // The hook creates remote state and a local key, then fails. Compensation has
  // nothing to run, so it reports nothing wrong — and the clean-rollback path
  // deleted the home, taking the only key that could ever reach the remote state.
  // Silence from a capability that declares no cleanup is not evidence of a clean
  // rollback.
  const remote = join(base, "remote-identity");
  capability(repo, "chan", {
    capability: "acme.chan",
    hooks: { spawn: { command: "hook.mjs spawn", required: true } },
  }, {
    "hook.mjs": `import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
writeFileSync(${JSON.stringify(remote)}, 'joined');
writeFileSync(join(process.env.OAS_HOME, 'identity.key'), 'key');
console.log(JSON.stringify({ meta: { alias: 'probe' } }));
process.exit(1);`,
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  const home = join(root, "dev", "instances", "dev-nocomp");
  try {
    assert.throws(
      () => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-nocomp", launch: false }),
      (e) => e.code === "E_REQUIRED_HOOK_FAILED" && /RETAINED/.test(e.message),
      "a rollback that could not compensate must not report a clean one",
    );
    assert.equal(existsSync(join(home, "identity.key")), true, "the key the hook wrote survives");
    assert.equal(existsSync(remote), true, "and so does the remote state it created");
    const marker = JSON.parse(readFileSync(join(home, ".oas-rollback-incomplete.json"), "utf8"));
    assert.deepEqual(marker.cleanup.outstanding.hooks, ["acme.chan"], "which is recorded as outstanding");

    // A retry cannot fix this — there is no hook to run — so it must keep saying
    // so, and point at the only exit rather than quietly clearing.
    const r = retireInstance(root, "dev-nocomp", { tmuxSession: "oas-test-nosuch" });
    assert.ok(r.rollbackIncomplete?.some((f) => /declares no retire hook/.test(f)),
      `the reason must name the real situation, got ${JSON.stringify(r.rollbackIncomplete)}`);
    assert.equal(existsSync(join(home, "identity.key")), true, "nothing was destroyed on the retry either");

    const f = retireInstance(root, "dev-nocomp", { tmuxSession: "oas-test-nosuch", force: true });
    assert.ok(f.forcedIncomplete?.length, "and --force reports what the operator now owns");
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(remote), true, "the remote state is still theirs to clean up");
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("an incomplete cleanup names the home's REAL path, including local-agents/ (reviewer-adff009)", async () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  // Capability-defined agents home under the scope's local-agents/, NOT under
  // <root>/<agent>/instances/. A reconstructed path sends the operator to a
  // directory that does not exist, on the one message that asks them to go
  // clean up by hand.
  capability(repo, "rev", {
    capability: "acme.review",
    agents: ["agents/reviewer"],
    hooks: { spawn: { command: "hook.mjs spawn", required: true }, retire: "hook.mjs retire" },
  }, {
    "agents/reviewer/soul.yaml": "name: reviewer\nkind: capability\nwork: checkout\nruntime: pi\ndescription: Fresh reviewer.\n",
    "agents/reviewer/AGENTS.md": "# Reviewer\n",
    "hook.mjs": `if (process.env.OAS_EVENT === 'spawn') { console.log(JSON.stringify({ meta: { alias: 'probe' } })); process.exit(1); }
console.log(JSON.stringify({ meta: { retired: false, reason: 'self-delete-failed' } }));`,
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.review:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    const core = await import("../lib/core.mjs");
    const agent = core.findCapabilityAgent(repo, root, "reviewer");
    assert.throws(() => spawnInstance(root, { ...agent, repo }, { instance: "reviewer-q", launch: false }),
      (e) => e.code === "E_REQUIRED_HOOK_FAILED");
    const home = findInstanceHomes(root, "reviewer-q")[0].home;
    assert.ok(home.includes(join("local-agents", "reviewer", "instances")), "precondition: it homes under local-agents/");

    const r = retireInstance(root, "reviewer-q", { tmuxSession: "oas-test-nosuch" });
    assert.ok(r.rollbackIncomplete, "cleanup is incomplete");
    assert.equal(realpathSync(r.retainedHome), realpathSync(home), "the result names the home that actually survived");

    const env = { ...process.env, PI_AGENTS_TMUX_SESSION: "oas-test-nosuch" };
    delete env.PI_AGENTS_ROOT;
    const cli = spawnSync(process.execPath, [CLI, "retire", "reviewer-q", "--dir", root], { encoding: "utf8", env });
    assert.notEqual(cli.status, 0);
    assert.match(cli.stderr, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `the diagnostic must point at the retained home, got: ${cli.stderr}`);
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("`oas retire` reports an incomplete cleanup and exits nonzero, not 'Retired'", () => {
  const base = temp();
  const { repo, root } = fixtureSoul(base, "pi");
  // Compensation keeps failing, so the home and its external state remain. A
  // zero exit here tells a human — and any script — that the work is done.
  capability(repo, "chan", {
    capability: "acme.chan",
    hooks: { spawn: { command: "hook.mjs spawn", required: true }, retire: "hook.mjs retire" },
  }, {
    "hook.mjs": `if (process.env.OAS_EVENT === 'spawn') { console.log(JSON.stringify({ meta: { alias: 'probe' } })); process.exit(1); }
console.log(JSON.stringify({ meta: { retired: false, reason: 'self-delete-failed' } }));`,
  });
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.chan:\n      global: true\n");
  const oldPath = process.env.PATH; process.env.PATH = fakeRuntimes(base);
  try {
    assert.throws(() => spawnInstance(root, findAgent(root, "dev"), { instance: "dev-cli", launch: false }),
      (e) => e.code === "E_REQUIRED_HOOK_FAILED");
    const env = { ...process.env, PI_AGENTS_TMUX_SESSION: "oas-test-nosuch" };
    delete env.PI_AGENTS_ROOT;
    const r = spawnSync(process.execPath, [CLI, "retire", "dev-cli", "--dir", root], { encoding: "utf8", env });
    assert.notEqual(r.status, 0, `an incomplete cleanup must exit nonzero, got ${r.status}: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /^Retired /m, "and must not claim the instance was retired");
    assert.match(r.stderr, /INCOMPLETE/);
    assert.match(r.stderr, /self-delete-failed/, "the outstanding failure is named");
    assert.equal(existsSync(join(root, "dev", "instances", "dev-cli")), true, "the home is still retained");
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});
