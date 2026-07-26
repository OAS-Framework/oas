#!/usr/bin/env node
/**
 * oas-okf — OAS knowledge-integration hooks for OKF (Open Knowledge Format).
 *
 * THE KNOWLEDGE INTEGRATION OWNS ALL MEMORY CONVENTIONS. The kernel knows
 * nothing about STATE.md, log.md, notes/, knowledge bundles, or harvest —
 * agents without a knowledge integration simply have none of this.
 *
 * Events (hook contract):
 *   soul-scaffold  scaffold the soul's OKF knowledge bundle (idempotent)
 *   spawn          scaffold instance memory (STATE.md, log.md, notes/) + brief
 *   retire         no-op (promotion is continuous — see harvest)
 *   harvest        AGENT-INITIATED (not a kernel hook): run from an instance
 *                  home (`node <pkg>/capabilities/oas-okf/bin/oas-okf.mjs harvest`)
 *                  after committing with pending notes — spawns the memory-harvest
 *                  agent attached to this instance's work tree.
 *
 * Env: OAS_EVENT, OAS_INSTANCE, OAS_HOME, OAS_AGENT, OAS_SOUL (soul dir),
 *      OAS_CONTEXT, OAS_WORKSPACE, OAS_SETTINGS ({ "sections-file"? }),
 *      OAS_TASK (spawn), OAS_REPO/OAS_BRANCH/OAS_WORK (spawn), OAS_META (retire).
 * Output: JSON { meta, brief, warning } on stdout. Failures warn, never block.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, isAbsolute, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";

const out = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };
const warn = (m) => out({ warning: `oas-okf: ${String(m).slice(0, 300)}` });

// Desktop CLI API v1: `oas okf harvest --json` emits EXACTLY ONE envelope
// object on stdout — {schemaVersion:1,ok,result|error} — and a nonzero exit
// on failure. Ordinary (non---json) output keeps the hook JSON shape above.
const JSON_MODE = process.argv.includes("--json");
const jsonOk = (result) => { process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: true, result }) + "\n"); process.exit(0); };
const jsonFail = (code, message) => { process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, error: { code, message: String(message).slice(0, 300) } }) + "\n"); process.exit(1); };

const event = process.env.OAS_EVENT || process.argv[2];
const instance = process.env.OAS_INSTANCE;
const home = process.env.OAS_HOME || process.cwd();
const soulDir = process.env.OAS_SOUL;
const agentName = process.env.OAS_AGENT || "agent";
// Fallible init stays inside an error boundary: malformed inherited env must
// never produce a bare stack trace — in --json mode Desktop expects one
// envelope object on stdout even for init failures.
let settings = {};
try { settings = JSON.parse(process.env.OAS_SETTINGS || "{}"); }
catch (e) {
  if (JSON_MODE) jsonFail("E_HARVEST_FAILED", `malformed OAS_SETTINGS: ${e.message || e}`);
  process.stderr.write(`oas-okf: malformed OAS_SETTINGS (ignoring): ${e.message || e}\n`);
}
/** Model for the memory-harvest agent — promotion judgment is cheap-but-good
 *  work; default gpt-5.5, overridable via okf settings { "harvest-model": ... }. */
const DEFAULT_HARVEST_MODEL = "github-copilot/gpt-5.5";

function runtimeError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Canonical package-runtime binary supplied by capability command dispatch.
 * Never discover or resolve the kernel through PATH. */
function packageRuntimeCli() {
  const cli = process.env.OAS_CLI_BIN;
  if (!cli) throw runtimeError("E_SPAWN_FAILED", "OAS_CLI_BIN is required by the package-runtime contract");
  if (!isAbsolute(cli)) throw runtimeError("E_SPAWN_FAILED", "OAS_CLI_BIN must be an absolute path");
  return cli;
}

/** Invoke the versioned package-runtime boundary. Task text crosses the
 * process boundary only through an owner-readable tempfile, removed on every
 * success/failure outcome. */
async function spawnHarvester(spawnArgs, task) {
  const temp = mkdtempSync(join(tmpdir(), "oas-okf-harvest-"));
  const taskFile = join(temp, "TASK.md");
  try {
    writeFileSync(taskFile, task, { mode: 0o600, flag: "wx" });
    const args = ["spawn", "memory-harvest", ...spawnArgs, "--task-file", taskFile, "--json"];
    const child = await new Promise((resolveChild) => {
      execFile(packageRuntimeCli(), args, {
        encoding: "utf8",
        env: process.env,
        timeout: 300000,
        maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => resolveChild({ error, stdout, stderr }));
    });
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.error && !String(child.stdout || "").trim()) {
      throw runtimeError("E_SPAWN_FAILED", child.error.message || child.error);
    }
    let envelope;
    try { envelope = JSON.parse(String(child.stdout || "").trim()); }
    catch { throw runtimeError("E_SPAWN_FAILED", "oas spawn returned an invalid JSON envelope"); }
    if (envelope?.schemaVersion !== 1 || typeof envelope.ok !== "boolean") {
      throw runtimeError("E_SPAWN_FAILED", "oas spawn returned an unsupported JSON envelope");
    }
    if (!envelope.ok) {
      throw runtimeError(envelope.error?.code || "E_SPAWN_FAILED", envelope.error?.message || "oas spawn failed");
    }
    if (child.error) throw runtimeError("E_SPAWN_FAILED", child.error.message || "oas spawn failed");
    if (!envelope.result?.instance) throw runtimeError("E_SPAWN_FAILED", "oas spawn success envelope has no instance");
    return envelope.result;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function harvestSpawnArgs({ slug, parent, repo, work, workDir, branch, model }) {
  const args = ["--purpose", slug, "--parent", parent, "--repo", repo, "--work", work];
  if (workDir) args.push("--work-dir", workDir);
  if (branch) args.push("--branch", branch);
  args.push("--model", model);
  return args;
}

/** Append a one-line entry to an OKF log.md (newest-first, date-grouped per spec §7). */
function appendLogEntry(logPath, entry, title) {
  const today = new Date().toISOString().slice(0, 10);
  let text = existsSync(logPath) ? readFileSync(logPath, "utf8") : `# ${title}\n\n`;
  const heading = `## ${today}`;
  if (text.includes(heading)) text = text.replace(`${heading}\n`, `${heading}\n* ${entry}\n`);
  else text = text.replace(/^(# [^\n]*\n\n?)/, `$1${heading}\n* ${entry}\n\n`);
  writeFileSync(logPath, text);
}

/** Scaffold the soul's OKF knowledge bundle (idempotent). */
function scaffoldSoul() {
  if (!soulDir) return false;
  const kb = join(soulDir, "knowledge");
  mkdirSync(kb, { recursive: true });
  const index = join(kb, "index.md");
  if (!existsSync(index)) {
    let seeded = "";
    const sf = settings["sections-file"];
    if (sf) {
      const abs = isAbsolute(sf) ? sf : join(process.env.OAS_CONTEXT || home, sf);
      if (existsSync(abs)) seeded = readFileSync(abs, "utf8").trim() + "\n";
    }
    writeFileSync(index, `---
okf_version: "0.1"
---

# ${agentName} knowledge base

Curated long-term knowledge for the ${agentName} agent (OKF bundle). Follow links
selectively — read what the current task needs, not everything.

# Sections

* [lessons/](lessons/) - durable lessons learned (type: Lesson).
* [decisions/](decisions/) - decisions and their rationale (type: Decision).
* [playbooks/](playbooks/) - step-by-step procedures kept as knowledge (type: Playbook).
* [references/](references/) - internal/external reference material (type: Reference).
${seeded}
Grow role-specific sections beyond these as the agent's role demands (e.g.
architecture/, codebase/) — list them here and log the growth in log.md.
`);
  }
  const log = join(kb, "log.md");
  if (!existsSync(log)) appendLogEntry(log, "**Initialization**: knowledge bundle scaffolded by oas-okf.", "Knowledge Log");
  return true;
}

if (event === "soul-scaffold") {
  try { out({ meta: { scaffolded: scaffoldSoul() } }); } catch (e) { warn(e.message || e); }
} else if (event === "spawn") {
  // Ephemeral CAPABILITY agents (reviewer, memory-harvest) carry no episodic
  // state of their own — no STATE.md/log.md/notes scaffolding, and no
  // session-protocol brief. LOCAL souls are full souls: they get everything.
  // ("tmp" is the legacy spelling of local — treat it as local, with memory.)
  if ((process.env.OAS_KIND || "") === "capability") {
    out({ meta: { memory: "none" }, brief: "Memory: none — you are ephemeral; no STATE.md/log.md/notes upkeep, no harvest." });
  }
  try {
    const task = (process.env.OAS_TASK || "").trim();
    writeFileSync(join(home, "STATE.md"), `---
type: Instance State
title: ${instance} working state
description: Live working state for instance ${instance} — rewritten as work progresses.
timestamp: ${new Date().toISOString()}
---

# Task

${task || "_No task assigned yet — await instructions._"}

# Plan

_(numbered steps once you have a plan)_

# Progress

_(what is done — commits, files touched, verified results)_

# Next

_(the single next action — keep this current; a fresh session on any model resumes from here)_

# Context

- repo: ${process.env.OAS_REPO || "?"} (branch ${process.env.OAS_BRANCH || "?"}, mode ${process.env.OAS_WORK || "?"})
- key files/paths: _(fill in as you learn them)_
`);
    appendLogEntry(join(home, "log.md"),
      `**Creation**: instance ${instance} spawned from soul ${agentName}${task ? ` — task: ${task.split("\n")[0].slice(0, 120)}` : ""}.`,
      "Instance Log");
    mkdirSync(join(home, "notes"), { recursive: true });
    out({
      meta: { memory: "okf" },
      brief: "Memory: your STATE.md/log.md/notes/ are scaffolded — your AGENTS.md's 'Knowledge: OKF' section has the session protocol.",
    });
  } catch (e) { warn(`instance memory scaffold failed: ${e.message || e}`); }
} else if (event === "harvest") {
  // AGENT-INITIATED HARVEST. An instance that committed with pending notes
  // runs `harvest` from its home: spawn the
  // memory-harvest agent ATTACHED to the same work tree — sibling home, shared
  // tree — to promote notes into the soul, commit, and retire itself.
  // Long-lived sessions thus feed the soul continuously, on the agent's call.
  try {
    // Derive context from the instance home (cwd) when hook env is absent.
    const metaFile = join(home, "instance.json");
    const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {};
    const inst = instance || meta.instance;
    const agName = process.env.OAS_AGENT || meta.agent || "agent";
    const sDir = soulDir || join(home, "soul");
    const context = process.env.OAS_CONTEXT || meta.repo;
    let root = process.env.OAS_ROOT;
    if (!root) { // walk up from home to the agents/ dir
      let d = home;
      while (d !== dirname(d)) { if (d.endsWith("/instances")) { root = join(d, "..", ".."); break; } d = dirname(d); }
      root = root ? realpathSync(join(root)) : undefined;
      // instances live at <root>/<agent>/instances/<inst>, at the legacy nested
      // <root>/{local,tmp}-agents/<agent>/instances/<inst>, or at the sibling
      // <scope>/local-agents/<agent>/instances/<inst> — canonical root is <scope>/agents.
      if (root && ["local-agents", "tmp-agents"].includes(root.split("/").pop())) {
        const parent = dirname(root);
        root = parent.split("/").pop() === "agents" ? parent : join(parent, "agents");
      }
    }
    const notesDir = join(home, "notes");
    const skip = (why) => (JSON_MODE ? jsonOk({ harvest: "skipped", reason: why }) : out({ meta: { harvestSpawn: "skipped", why } }));
    if (String(agName).startsWith("memory-harvest")) skip("self (loop guard)");
    const notes = existsSync(notesDir) ? readdirSync(notesDir).filter((f) => f.endsWith(".md")) : [];
    if (notes.length === 0) skip("no pending notes");
    if (!root || (!existsSync(root) && !existsSync(join(dirname(root), "local-agents")))) skip("no agents root found above this home");
    if (!inst) skip("no instance identity (run from an instance home)");
    if (!context) skip("no repository context (instance metadata has no repo)");
    const slug = String(inst).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
    // Debounce: one harvester per source instance at a time (canonical sibling
    // local-agents/ plus legacy nested locations). The public spawn boundary
    // derives the deterministic instance name from --purpose <slug>.
    const harvesterHomes = [
      join(dirname(root), "local-agents", "memory-harvest", "instances", `memory-harvest-${slug}`),
      join(root, "local-agents", "memory-harvest", "instances", `memory-harvest-${slug}`),
      join(root, "tmp-agents", "memory-harvest", "instances", `memory-harvest-${slug}`),
    ];
    if (harvesterHomes.some((h) => existsSync(h))) skip("harvester already running for this instance");
    // Effective command settings are injected by capability dispatch. No
    // resolved-config read crosses the public package boundary.
    const harvestModel = settings["harvest-model"] || DEFAULT_HARVEST_MODEL;
    const workDir = realpathSync(join(home, "work"));
    const realSoul = realpathSync(sDir);
    const harvName = `memory-harvest-${slug}`;
    const gitRootOf = (start) => { let d = start; while (d !== dirname(d)) { if (existsSync(join(d, ".git"))) return d; d = dirname(d); } return undefined; };
    let r;
    const srcKind = process.env.OAS_KIND || meta.kind || "";
    if (["local", "tmp"].includes(srcKind)) {
      // LOCAL soul: uncommitted by contract (local-agents/, gitignored). The
      // harvester judges notes exactly as usual, but the deliverable is DIRECT
      // edits to the canonical soul — no commit, no PR: there is nothing to
      // version. It must not touch the owner's work tree.
      const task = `Harvest the pending notes of live LOCAL-SOUL instance "${inst}" (agent "${agName}") into its soul — by direct edits, no commit.\n\n- Source notes: ${notesDir} (${notes.join(", ")})\n- Soul knowledge bundle to update: ${join(realSoul, "knowledge")}\n- Soul skills dir (for procedure-shaped notes): ${join(realSoul, "skills")}\n- This soul is LOCAL (uncommitted, gitignored): edit those soul files IN PLACE. Do NOT run git commit — not for the soul, and not in ./work (the shared tree belongs to the working instance; leave it untouched).\n- Follow your memory-harvest skill for everything else: promote/merge/drop each note, knowledge vs skill routing, index + log discipline, validate the bundle, DELETE processed notes from the source notes/ dir.\n- Then run \`oas retire ${harvName} --self\`.`;
      r = await spawnHarvester(harvestSpawnArgs({
        slug, parent: inst, repo: context, work: "attached", workDir, model: harvestModel,
      }), task);
    } else if ((process.env.OAS_WORK || meta.work) === "workspace") {
      // WORKSPACE-MODE instance: ./work is the whole workspace, not a git repo —
      // the harvester may NOT commit there. The soul lives in its own home repo
      // (committed to the workspace): harvest in a WORKTREE of that repo and
      // deliver the promotion as a PR, never a direct push to its main branch.
      const soulRepo = gitRootOf(realSoul);
      if (!soulRepo) skip("workspace-mode soul is not inside a git repo — nowhere to deliver a PR");
      const relSoul = realSoul.slice(soulRepo.length + 1);
      const task = `Harvest the pending notes of live WORKSPACE-MODE instance "${inst}" (agent "${agName}") into its soul — delivered as a PR.\n\n- Source notes: ${notesDir} (${notes.join(", ")})\n- Your ./work is a dedicated worktree of the soul's home repo (${soulRepo}), branch memory-harvest/${slug}.\n- Soul knowledge bundle to update: ./work/${join(relSoul, "knowledge")}\n- Soul skills dir (for procedure-shaped notes): ./work/${join(relSoul, "skills")}\n- Follow your memory-harvest skill: promote/merge/drop each note, knowledge vs skill routing, index + log discipline, validate the bundle, DELETE processed notes from the source notes/ dir, commit once (prefixed "memory-harvest:").\n- Then push the branch and open a PR (\`git push -u origin memory-harvest/${slug}\` then \`gh pr create --fill\`). Do NOT merge it; the humans/owners of ${soulRepo} review soul changes. If gh is unavailable, push the branch and report the compare URL.\n- Finally run \`oas retire ${harvName} --self\` (keep the branch: --self only).`;
      r = await spawnHarvester(harvestSpawnArgs({
        slug, parent: inst, repo: soulRepo, work: "worktree",
        branch: `memory-harvest/${slug}`, model: harvestModel,
      }), task);
    } else {
      // Repo-resident souls: write to the soul AS SEEN FROM THE WORK TREE, so the
      // promotion commits onto the instance's own branch. Otherwise the canonical soul.
      const realRepo = realpathSync(context || workDir);
      const soulTarget = realSoul.startsWith(realRepo + "/")
        ? join(workDir, realSoul.slice(realRepo.length + 1))
        : realSoul;
      const task = `Harvest the pending notes of live instance "${inst}" (agent "${agName}") into its soul.\n\n- Source notes: ${notesDir} (${notes.join(", ")})\n- Soul knowledge bundle to update: ${join(soulTarget, "knowledge")}\n- Soul skills dir (for procedure-shaped notes): ${join(soulTarget, "skills")}\n- You are ATTACHED to the instance's work tree (./work) — commit your promotions there as a single commit, prefixed "memory-harvest:".\n- Follow your memory-harvest skill: promote/merge/drop each note, knowledge vs skill routing, index + log discipline, validate the bundle, DELETE processed notes from the source notes/ dir (so they are not re-harvested), commit, then run \`oas retire ${harvName} --self\`.`;
      r = await spawnHarvester(harvestSpawnArgs({
        slug, parent: inst, repo: context, work: "attached", workDir, model: harvestModel,
      }), task);
    }
    if (JSON_MODE) jsonOk({ harvest: "spawned", instance: r.instance, window: r.tmux?.window || null });
    out({ meta: { harvestSpawn: r.instance, window: r.tmux?.window } });
  } catch (e) {
    if (JSON_MODE) jsonFail(e.code || "E_HARVEST_FAILED", `harvest spawn failed (notes are safe on disk): ${e.message || e}`);
    warn(`harvest spawn failed (notes are safe on disk): ${e.message || e}`);
  }
} else if (event === "retire") {
  // Retirement is intentionally a no-op for knowledge (for now): promotion happens
  // continuously via agent-initiated harvest. Uncommitted notes die with the home —
  // the injection tells instances to bring memory up to date, commit, and harvest
  // before finishing.
  out({ meta: {} });
} else {
  warn(`unknown event "${event}" (expected soul-scaffold|spawn|retire)`);
}
