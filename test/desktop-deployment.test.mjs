// App-owned read-only deployment reader (packages/desktop/server/deployment.mjs).
//
// The packaged desktop app must not import lib/core.mjs — the reader
// replicates the READ seams only. This suite proves:
//   1. parity with the kernel on this repo (the richest fixture we have):
//      team resolution, agents roots, souls, capability agents, instances;
//   2. fault tolerance: malformed configs/souls degrade to "not visible";
//   3. the bridge is really gone: no core.mjs import, no
//      OAS_DESKTOP_FRAMEWORK_ROOT acceptance, no repo-root inference in the
//      desktop package's shipped sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const READER = join(ROOT, "packages", "desktop", "server", "deployment.mjs");
const reader = await import(pathToFileURL(READER).href);
const core = await import(pathToFileURL(join(ROOT, "lib", "core.mjs")).href);

test("reader parity: team scope and agents roots match the kernel on this repo", (t) => {
  const r = reader.resolveDeployment(ROOT);
  // The reader must ALWAYS resolve (fault-tolerant observation)…
  assert.ok(Array.isArray(r.chain), "reader resolves the deployment");
  // …while the kernel may legitimately throw on live-environment skew (e.g.
  // a lock/installed-store integrity mismatch between branches). Parity is
  // only comparable when the kernel itself resolves.
  let k;
  try { k = core.resolveOasConfig(ROOT); }
  catch (e) { t.diagnostic(`kernel threw (${e.message}) — reader still resolved; parity skipped`); return; }
  assert.equal(!!r.team, !!k.team, "team presence matches");
  if (r.team) {
    assert.equal(r.team.scope, k.team.scope, "team scope matches");
    assert.equal(r.team.name, k.team.name, "team name matches");
    assert.deepEqual(reader.teamAgentRoots(r.team.scope), core.teamAgentRoots(k.team.scope), "agents roots match");
  }
});

test("reader parity: souls and capability agents match the kernel", () => {
  const roots = (() => {
    const r = reader.resolveDeployment(ROOT);
    return r.team ? reader.teamAgentRoots(r.team.scope) : [reader.findAgentsRoot(ROOT)].filter(Boolean);
  })();
  assert.ok(roots.length, "at least one agents root");
  for (const root of roots) {
    const mine = reader.listAgents(root).map((a) => a.name).sort();
    const theirs = core.listAgents(root).map((a) => a.name).sort();
    assert.deepEqual(mine, theirs, `listAgents parity at ${root}`);
  }
  const ctx = dirname(roots[0]);
  const mineCaps = reader.listCapabilityAgents(ctx).map((c) => `${c.capability}:${c.name}`).sort();
  const theirCaps = core.listCapabilityAgents(ctx).map((c) => `${c.capability}:${c.name}`).sort();
  assert.deepEqual(mineCaps, theirCaps, "capability agents parity");
  // capability agent resolution shape used by brain/spawn validation
  for (const c of reader.listCapabilityAgents(ctx)) {
    const soul = reader.findCapabilityAgent(ctx, roots[0], c.name);
    assert.ok(soul, `findCapabilityAgent resolves ${c.name}`);
    assert.equal(soul.kind, "capability");
    assert.equal(soul.capability, c.capability);
    assert.ok(soul._soulDir && soul._dir, "soul dirs present");
  }
});

// Unconditional parity on a CLEAN fixture: the live-repo test above may skip
// when the checkout's lock state is skewed, so this synthetic deployment is
// the parity proof that can never be skipped — the kernel MUST resolve here
// and MUST agree with the reader on every read seam.
test("reader parity (clean fixture, unconditional): kernel resolves and matches on every seam", () => {
  const scope = mkdtempSync(join(tmpdir(), "oas-reader-clean-"));
  // team deployment: scope config + two member repos with agents roots
  writeFileSync(join(scope, "oas-config.yaml"), "name: clean-team\nteam:\n  name: clean-team\n");
  mkdirSync(join(scope, "agents"), { recursive: true });
  for (const repo of ["repo-a", "repo-b"]) {
    mkdirSync(join(scope, repo, "agents"), { recursive: true });
  }
  // a persistent soul and a tmp soul in repo-a
  const rootA = join(scope, "repo-a", "agents");
  mkdirSync(join(rootA, "dev", "soul"), { recursive: true });
  writeFileSync(join(rootA, "dev", "soul", "soul.yaml"), "name: dev\ndescription: developer soul\nkind: persistent\nwork: worktree\n");
  mkdirSync(join(rootA, "local-agents", "scratch", "soul"), { recursive: true });
  writeFileSync(join(rootA, "local-agents", "scratch", "soul", "soul.yaml"), "name: scratch\ndescription: tmp soul\n");
  // an instance with metadata under dev
  mkdirSync(join(rootA, "dev", "instances", "dev-1"), { recursive: true });
  writeFileSync(join(rootA, "dev", "instances", "dev-1", "instance.json"),
    JSON.stringify({ instance: "dev-1", agent: "dev", home: join(rootA, "dev", "instances", "dev-1") }));
  // a capability package (owned store) declaring an agent soul
  const capDir = join(scope, ".agents", "capabilities", "owned", "clean-cap");
  mkdirSync(join(capDir, "agents", "helper"), { recursive: true });
  writeFileSync(join(capDir, "oas.json"), JSON.stringify({
    capability: "clean.cap", version: "1.0.0", description: "clean fixture capability",
    agents: ["agents/helper"], skills: ["skills"],
  }));
  writeFileSync(join(capDir, "agents", "helper", "soul.yaml"), "name: helper\ndescription: capability helper\n");
  writeFileSync(join(capDir, "agents", "helper", "AGENTS.md"), "# helper\n");
  mkdirSync(join(capDir, "skills", "how-to"), { recursive: true });
  writeFileSync(join(capDir, "skills", "how-to", "SKILL.md"), "---\nname: how-to\ndescription: d\n---\n# s\n");
  writeFileSync(join(scope, "repo-a", "oas-config.yaml"),
    "name: repo-a\ncapabilities:\n  additive:\n    clean.cap:\n      from: path:../.agents/capabilities/owned/clean-cap\n");

  // Kernel MUST resolve on the clean fixture — no conditional escape here.
  const k = core.resolveOasConfig(join(scope, "repo-a"));
  const r = reader.resolveDeployment(join(scope, "repo-a"));
  assert.ok(k.team, "kernel resolves the team on a clean fixture");
  assert.ok(r.team, "reader resolves the team on a clean fixture");
  assert.equal(r.team.scope, k.team.scope, "team scope parity");
  assert.equal(r.team.name, k.team.name, "team name parity");
  assert.deepEqual(reader.teamAgentRoots(r.team.scope), core.teamAgentRoots(k.team.scope), "agents roots parity");

  // souls (persistent + tmp)
  assert.deepEqual(
    reader.listAgents(rootA).map((a) => `${a.kind}:${a.name}`).sort(),
    core.listAgents(rootA).map((a) => `${a.kind}:${a.name}`).sort(),
    "listAgents parity (kinds and names)");
  assert.equal(reader.findAgent(rootA, "dev").name, core.findAgent(rootA, "dev").name, "findAgent parity");

  // capability agents through the config chain + package store
  const ctx = join(scope, "repo-a");
  assert.deepEqual(
    reader.listCapabilityAgents(ctx).map((c) => `${c.capability}:${c.name}`).sort(),
    core.listCapabilityAgents(ctx).map((c) => `${c.capability}:${c.name}`).sort(),
    "capability agents parity");
  const mineHelper = reader.findCapabilityAgent(ctx, rootA, "helper");
  const theirHelper = core.findCapabilityAgent(ctx, rootA, "helper");
  assert.equal(mineHelper._soulDir, theirHelper._soulDir, "capability soul dir parity");
  assert.equal(mineHelper._dir, theirHelper._dir, "capability instances home parity");
  assert.deepEqual(reader.capabilitySkillDirs("clean.cap", ctx), core.capabilitySkillDirs("clean.cap", ctx), "skill dirs parity");

  // instances
  assert.deepEqual(
    reader.listInstances(rootA).map((a) => ({ name: a.name, instances: a.instances.map((i) => i.instance).sort() })).sort((x, y) => x.name.localeCompare(y.name)),
    core.listInstances(rootA).map((a) => ({ name: a.name, instances: a.instances.map((i) => i.instance).sort() })).sort((x, y) => x.name.localeCompare(y.name)),
    "listInstances parity");
});

test("reader parity: listInstances shape matches the kernel", () => {
  const root = reader.findAgentsRoot(ROOT);
  assert.ok(root, "agents root found");
  const mine = reader.listInstances(root);
  const theirs = core.listInstances(root);
  assert.deepEqual(
    mine.map((a) => ({ name: a.name, instances: a.instances.map((i) => i.instance).sort() })).sort((x, y) => x.name.localeCompare(y.name)),
    theirs.map((a) => ({ name: a.name, instances: a.instances.map((i) => i.instance).sort() })).sort((x, y) => x.name.localeCompare(y.name)),
    "same souls and instance names");
});

test("reader: malformed configs and souls degrade instead of throwing", () => {
  const base = mkdtempSync(join(tmpdir(), "oas-reader-"));
  // invalid oas-config.yaml at the top level — chain must skip it
  writeFileSync(join(base, "oas-config.yaml"), ": : :\n\t\tbroken");
  mkdirSync(join(base, "agents", "good-soul", "soul"), { recursive: true });
  writeFileSync(join(base, "agents", "good-soul", "soul", "soul.yaml"), "name: good-soul\ndescription: fine\n");
  mkdirSync(join(base, "agents", "bad-soul", "soul"), { recursive: true });
  // unreadable soul.yaml (a directory where a file should be) — must skip
  mkdirSync(join(base, "agents", "bad-soul", "soul", "soul.yaml"), { recursive: true });
  const r = reader.resolveDeployment(base);
  assert.ok(Array.isArray(r.chain), "chain resolves despite the broken level");
  const agents = reader.listAgents(join(base, "agents"));
  assert.deepEqual(agents.map((a) => a.name), ["good-soul"], "broken soul skipped, good soul listed");
  assert.equal(reader.findAgentsRoot(base), join(base, "agents"), "read-only root discovery");
});

test("reader: manifest paths escaping the package boundary do not resolve", () => {
  const base = mkdtempSync(join(tmpdir(), "oas-reader-esc-"));
  const capDir = join(base, ".agents", "capabilities", "installed", "evil");
  mkdirSync(capDir, { recursive: true });
  writeFileSync(join(base, "oas-config.yaml"), "name: t\ncapabilities:\n  additive:\n    evil.cap: {}\n");
  writeFileSync(join(capDir, "oas.json"), JSON.stringify({
    capability: "evil.cap", version: "1.0.0", description: "x",
    agents: ["../../../../outside-soul"], skills: ["../../.."],
  }));
  mkdirSync(join(base, "outside-soul"), { recursive: true });
  writeFileSync(join(base, "outside-soul", "soul.yaml"), "name: outside\n");
  assert.deepEqual(reader.listCapabilityAgents(base), [], "escaping agents path never resolves");
  assert.deepEqual(reader.capabilitySkillDirs("evil.cap", base), [], "escaping skills path never resolves");
});

// ---- bridge absence: the shipped desktop package carries no kernel tie ----

function desktopSources() {
  const pkg = join(ROOT, "packages", "desktop");
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(join(pkg, d), { withFileTypes: true })) {
      if (["node_modules", "vendor", "test"].includes(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|cjs)$/.test(e.name)) files.push(p);
    }
  };
  walk(".");
  return files.map((f) => [f, readFileSync(join(pkg, f), "utf8")]);
}

test("no shipped desktop source imports the checkout kernel or accepts a framework-root override", () => {
  for (const [f, src] of desktopSources()) {
    assert.ok(!src.includes("lib/core.mjs"), `${f}: references the checkout kernel`);
    assert.ok(!src.includes("OAS_DESKTOP_FRAMEWORK_ROOT"), `${f}: accepts the framework-root env override`);
    assert.ok(!/FRAMEWORK_ROOT|REPO_ROOT/.test(src), `${f}: infers a repo/framework root`);
  }
});
