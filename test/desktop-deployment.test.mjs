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
import * as fsExtra from "node:fs";
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

  // souls (persistent + local). The reader implements the LOCAL SOULS
  // semantics from main (030ad49: kind "local" replaces the public "tmp",
  // scope-sibling local-agents/); this branch's in-tree kernel may predate
  // that — normalize the legacy kind so parity tracks names + local-ness,
  // not the rename.
  const normKind = (k) => (k === "tmp" ? "local" : k);
  assert.deepEqual(
    reader.listAgents(rootA).map((a) => `${normKind(a.kind)}:${a.name}`).sort(),
    core.listAgents(rootA).map((a) => `${normKind(a.kind)}:${a.name}`).sort(),
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
  // instances-home: the reader uses the NEW scope-sibling local-agents/
  // (main 030ad49); a pre-local-souls in-tree kernel still homes nested
  // under the root. Accept either until the kernel lands on this branch.
  const scopeSibling = join(dirname(rootA), "local-agents", "helper");
  const nestedLegacy = join(rootA, "local-agents", "helper");
  assert.equal(mineHelper._dir, scopeSibling, "reader homes capability instances in the scope sibling");
  assert.ok([scopeSibling, nestedLegacy].includes(theirHelper._dir), "kernel homes in a known local-agents location");
  assert.deepEqual(reader.capabilitySkillDirs("clean.cap", ctx).map((s) => s.dir), core.capabilitySkillDirs("clean.cap", ctx), "skill dirs parity");

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

test("reader: local souls (scope-sibling local-agents/) are first-class roster citizens", () => {
  const scope = mkdtempSync(join(tmpdir(), "oas-reader-local-"));
  // committed persistent soul under agents/, LOCAL soul under the SIBLING
  // local-agents/ (gitignored by kernel contract — invisible to git, fully
  // visible to the app)
  const root = join(scope, "agents");
  mkdirSync(join(root, "dev", "soul"), { recursive: true });
  writeFileSync(join(root, "dev", "soul", "soul.yaml"), "name: dev\ndescription: committed soul\n");
  const localBase = join(scope, "local-agents");
  mkdirSync(join(localBase, "my-local", "soul"), { recursive: true });
  writeFileSync(join(localBase, "my-local", "soul", "soul.yaml"), "name: my-local\ndescription: machine-local soul\nkind: local\n");
  mkdirSync(join(localBase, "my-local", "instances", "my-local-1"), { recursive: true });
  writeFileSync(join(localBase, "my-local", "instances", "my-local-1", "instance.json"),
    JSON.stringify({ instance: "my-local-1", agent: "my-local" }));
  // legacy kind: tmp reads as local
  mkdirSync(join(localBase, "old-tmp", "soul"), { recursive: true });
  writeFileSync(join(localBase, "old-tmp", "soul", "soul.yaml"), "name: old-tmp\nkind: tmp\n");

  const agents = reader.listAgents(root);
  const byName = new Map(agents.map((a) => [a.name, a]));
  assert.ok(byName.has("dev"), "persistent soul listed");
  assert.equal(byName.get("my-local").kind, "local", "sibling local soul listed as kind local");
  assert.equal(byName.get("old-tmp").kind, "local", "legacy kind tmp normalizes to local");
  // findAgent resolves local souls by name (brain/spawn-validation seam)
  assert.equal(reader.findAgent(root, "my-local").kind, "local");
  assert.equal(reader.findAgent(root, "my-local")._dir, join(localBase, "my-local"), "soul dir is the scope sibling");
  // instances of local souls surface in the roster walk
  const inst = reader.listInstances(root).find((a) => a.name === "my-local");
  assert.ok(inst, "local soul appears in listInstances");
  assert.deepEqual(inst.instances.map((i) => i.instance), ["my-local-1"], "its instance surfaces");
});

test("reader: an ALL-LOCAL scope (no agents/ at all) resolves and rosters", () => {
  const scope = mkdtempSync(join(tmpdir(), "oas-reader-alllocal-"));
  const localBase = join(scope, "local-agents");
  mkdirSync(join(localBase, "solo", "soul"), { recursive: true });
  writeFileSync(join(localBase, "solo", "soul", "soul.yaml"), "name: solo\ndescription: only local souls here\n");
  // root discovery: canonical root is the (absent) sibling agents/
  const root = reader.findAgentsRoot(scope);
  assert.equal(root, join(scope, "agents"), "canonical root beside local-agents, even when absent");
  // walking up from INSIDE local-agents/ finds the same root
  assert.equal(reader.findAgentsRoot(join(localBase, "solo")), join(scope, "agents"));
  // the roster still lists the local soul through the absent root
  const agents = reader.listAgents(root);
  assert.deepEqual(agents.map((a) => `${a.kind}:${a.name}`), ["local:solo"], "all-local scope rosters its souls");
  // team scopes count all-local members
  const team = mkdtempSync(join(tmpdir(), "oas-reader-teamlocal-"));
  writeFileSync(join(team, "oas-config.yaml"), "name: t\nteam:\n  name: t\n");
  mkdirSync(join(team, "member-a", "agents"), { recursive: true });          // classic member
  mkdirSync(join(team, "member-b", "local-agents", "x", "soul"), { recursive: true }); // all-local member
  writeFileSync(join(team, "member-b", "local-agents", "x", "soul", "soul.yaml"), "name: x\n");
  const roots = reader.teamAgentRoots(team);
  assert.ok(roots.includes(join(team, "member-a", "agents")), "classic member root found");
  assert.ok(roots.includes(join(team, "member-b", "agents")), "all-local member surfaces via its canonical (absent) agents root");
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

test("reader: nested soul.yaml/SKILL.md symlinks escaping the package never get read", () => {
  const base = mkdtempSync(join(tmpdir(), "oas-reader-nest-"));
  const { symlinkSync } = fsExtra;
  // Secret files OUTSIDE the package that symlinks will point at.
  writeFileSync(join(base, "outside-soul.yaml"), "name: leaked\ndescription: TOP-SECRET-SOUL\n");
  writeFileSync(join(base, "outside-skill.md"), "---\nname: leaked-skill\ndescription: TOP-SECRET-SKILL\n---\n# s\n");
  const capDir = join(base, ".agents", "capabilities", "installed", "nest");
  mkdirSync(join(capDir, "agents", "helper"), { recursive: true });
  mkdirSync(join(capDir, "skills", "sneaky"), { recursive: true });
  writeFileSync(join(base, "oas-config.yaml"), "name: t\ncapabilities:\n  additive:\n    nest.cap: {}\n");
  writeFileSync(join(capDir, "oas.json"), JSON.stringify({
    capability: "nest.cap", version: "1.0.0", description: "x",
    agents: ["agents/helper"], skills: ["skills"],
  }));
  // The DIRECTORIES are contained — only the nested FILES are symlinks out.
  symlinkSync(join(base, "outside-soul.yaml"), join(capDir, "agents", "helper", "soul.yaml"));
  symlinkSync(join(base, "outside-skill.md"), join(capDir, "skills", "sneaky", "SKILL.md"));
  // agent: the escaping soul.yaml must never be parsed — agent not listed
  assert.deepEqual(reader.listCapabilityAgents(base), [], "agent behind an escaping soul.yaml symlink is not listed");
  assert.equal(reader.findCapabilityAgent(base, join(base, "agents"), "leaked"), undefined, "nor resolvable by its leaked name");
  assert.equal(reader.findCapabilityAgent(base, join(base, "agents"), "helper"), undefined, "nor by its directory name");
  // skills: the tree dir resolves (it IS contained), but per-file containment
  // must reject the escaping SKILL.md — exposed via containsPackageFile.
  const dirs = reader.capabilitySkillDirs("nest.cap", base);
  assert.equal(dirs.length, 1, "contained skill tree resolves");
  const skillMd = join(dirs[0].dir, "sneaky", "SKILL.md");
  assert.equal(reader.containsPackageFile(dirs[0].packageDir, skillMd), false,
    "escaping nested SKILL.md fails the per-file containment probe");
  // a genuinely contained file passes
  writeFileSync(join(capDir, "skills", "good.md"), "ok");
  assert.equal(reader.containsPackageFile(dirs[0].packageDir, join(capDir, "skills", "good.md")), true);
});

test("reader: semantically malformed instance.json degrades to the bare instance, hides nothing", () => {
  const base = mkdtempSync(join(tmpdir(), "oas-reader-meta-"));
  const root = join(base, "agents");
  mkdirSync(join(root, "dev", "soul"), { recursive: true });
  writeFileSync(join(root, "dev", "soul", "soul.yaml"), "name: dev\ndescription: d\n");
  const mk = (name, content) => {
    mkdirSync(join(root, "dev", "instances", name), { recursive: true });
    if (content !== undefined) writeFileSync(join(root, "dev", "instances", name, "instance.json"), content);
  };
  mk("dev-null", "null");                                   // JSON.parse OK, not an object
  mk("dev-array", "[1,2]");                                 // array
  mk("dev-scalar", '"hi"');                                 // scalar
  mk("dev-empty", "{}");                                    // object missing required fields
  mk("dev-badtypes", JSON.stringify({ instance: 42, home: null })); // wrong types
  mk("dev-good", JSON.stringify({ instance: "dev-good", agent: "dev", extra: "kept" }));
  mk("dev-bare");                                           // no instance.json at all
  const agents = reader.listInstances(root);
  assert.equal(agents.length, 1);
  const byName = new Map(agents[0].instances.map((i) => [i.instance, i]));
  // EVERY directory surfaces — one malformed file must not hide siblings
  for (const name of ["dev-null", "dev-array", "dev-scalar", "dev-empty", "dev-badtypes", "dev-good", "dev-bare"]) {
    const inst = byName.get(name);
    assert.ok(inst, `${name} surfaces in the roster`);
    assert.equal(typeof inst.instance, "string", `${name}: instance is a string`);
    assert.equal(typeof inst.home, "string", `${name}: home is a string`);
    assert.ok(inst.home.endsWith(name), `${name}: home falls back to the directory`);
  }
  assert.equal(byName.get("dev-good").extra, "kept", "valid metadata still merges over the fallback");
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
