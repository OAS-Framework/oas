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
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, realpathSync } from "node:fs";
import { join, isAbsolute, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

/** The kernel install root. When this package runs from inside the kernel
 * (marketplace source tree), ../../.. works; when it runs as a copied
 * marketplace install (.agents/capabilities/installed/oas-okf), resolve the
 * kernel through `oas root` — the same mechanism adapters use. */
const FRAMEWORK_ROOT = (() => {
  const rel = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  if (existsSync(join(rel, "lib", "core.mjs"))) return rel;
  try {
    const root = execSync("oas root", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }).trim();
    if (root && existsSync(join(root, "lib", "core.mjs"))) return root;
  } catch { /* fall through */ }
  return rel; // callers report the missing module with a clear path
})();

const out = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };
const warn = (m) => out({ warning: `oas-okf: ${String(m).slice(0, 300)}` });

const event = process.env.OAS_EVENT || process.argv[2];
const instance = process.env.OAS_INSTANCE;
const home = process.env.OAS_HOME || process.cwd();
const soulDir = process.env.OAS_SOUL;
const agentName = process.env.OAS_AGENT || "agent";
const settings = JSON.parse(process.env.OAS_SETTINGS || "{}");
/** Model for the memory-harvest agent — promotion judgment is cheap-but-good
 *  work; default gpt-5.5, overridable via okf settings { "harvest-model": ... }. */
const DEFAULT_HARVEST_MODEL = "github-copilot/gpt-5.5";

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
  // Ephemeral agents (capability/tmp service agents: reviewer, memory-harvest)
  // carry no episodic state of their own — no STATE.md/log.md/notes scaffolding,
  // and no session-protocol brief that would contradict their souls.
  if (["capability", "tmp"].includes(process.env.OAS_KIND || "")) {
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
      // instances live at <root>/<agent>/instances/<inst> or <root>/local-agents/<agent>/instances/<inst>
      if (root && ["local-agents", "tmp-agents"].includes(root.split("/").pop())) root = dirname(root);
    }
    const notesDir = join(home, "notes");
    const skip = (why) => out({ meta: { harvestSpawn: "skipped", why } });
    if (String(agName).startsWith("memory-harvest")) skip("self (loop guard)");
    const notes = existsSync(notesDir) ? readdirSync(notesDir).filter((f) => f.endsWith(".md")) : [];
    if (notes.length === 0) skip("no pending notes");
    if (!root || !existsSync(root)) skip("no agents root found above this home");
    if (!inst) skip("no instance identity (run from an instance home)");
    const core = await import(pathToFileURL(join(FRAMEWORK_ROOT, "lib", "core.mjs")).href);
    const slug = String(inst).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
    // Debounce: one harvester per source instance at a time.
    const harvesterHome = (base) => join(root, base, "memory-harvest", "instances", `memory-harvest-${slug}`);
    if (["local-agents", "tmp-agents"].some((b) => existsSync(harvesterHome(b)))) skip("harvester already running for this instance");
    let agentDef = core.findAgent(root, "memory-harvest");
    if (!agentDef) {
      core.upsertTmpAgent(root, { name: "memory-harvest", instructions: readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "memory-harvest.md"), "utf8") });
      agentDef = core.findAgent(root, "memory-harvest");
    }
    // Harvest model: explicit okf settings win (hook env, or resolved from config
    // when agent-initiated); else the integration's default.
    let harvestModel = settings["harvest-model"];
    if (!harvestModel && context) {
      try { harvestModel = core.resolveOasConfig(context).layers?.knowledge?.settings?.["harvest-model"]; } catch { /* config unreadable: use default */ }
    }
    harvestModel = harvestModel || DEFAULT_HARVEST_MODEL;
    const workDir = realpathSync(join(home, "work"));
    const realSoul = realpathSync(sDir);
    const harvName = `memory-harvest-${slug}`;
    const gitRootOf = (start) => { let d = start; while (d !== dirname(d)) { if (existsSync(join(d, ".git"))) return d; d = dirname(d); } return undefined; };
    let r;
    if ((process.env.OAS_WORK || meta.work) === "workspace") {
      // WORKSPACE-MODE instance: ./work is the whole workspace, not a git repo —
      // the harvester may NOT commit there. The soul lives in its own home repo
      // (committed to the workspace): harvest in a WORKTREE of that repo and
      // deliver the promotion as a PR, never a direct push to its main branch.
      const soulRepo = gitRootOf(realSoul);
      if (!soulRepo) skip("workspace-mode soul is not inside a git repo — nowhere to deliver a PR");
      const relSoul = realSoul.slice(soulRepo.length + 1);
      r = core.spawnInstance(root, agentDef, {
        instance: harvName, parent: inst,
        repo: soulRepo, work: "worktree", branch: `memory-harvest/${slug}`, model: harvestModel,
        task: `Harvest the pending notes of live WORKSPACE-MODE instance "${inst}" (agent "${agName}") into its soul — delivered as a PR.\n\n- Source notes: ${notesDir} (${notes.join(", ")})\n- Your ./work is a dedicated worktree of the soul's home repo (${soulRepo}), branch memory-harvest/${slug}.\n- Soul knowledge bundle to update: ./work/${join(relSoul, "knowledge")}\n- Soul skills dir (for procedure-shaped notes): ./work/${join(relSoul, "skills")}\n- Follow your memory-harvest skill: promote/merge/drop each note, knowledge vs skill routing, index + log discipline, validate the bundle, DELETE processed notes from the source notes/ dir, commit once (prefixed "memory-harvest:").\n- Then push the branch and open a PR (\`git push -u origin memory-harvest/${slug}\` then \`gh pr create --fill\`). Do NOT merge it; the humans/owners of ${soulRepo} review soul changes. If gh is unavailable, push the branch and report the compare URL.\n- Finally run \`oas retire ${harvName} --self\` (keep the branch: --self only).`,
      });
    } else {
      // Repo-resident souls: write to the soul AS SEEN FROM THE WORK TREE, so the
      // promotion commits onto the instance's own branch. Otherwise the canonical soul.
      const realRepo = realpathSync(context || workDir);
      const soulTarget = realSoul.startsWith(realRepo + "/")
        ? join(workDir, realSoul.slice(realRepo.length + 1))
        : realSoul;
      r = core.spawnInstance(root, agentDef, {
        instance: harvName, parent: inst,
        repo: context, work: "attached", workDir, model: harvestModel,
        task: `Harvest the pending notes of live instance "${inst}" (agent "${agName}") into its soul.\n\n- Source notes: ${notesDir} (${notes.join(", ")})\n- Soul knowledge bundle to update: ${join(soulTarget, "knowledge")}\n- Soul skills dir (for procedure-shaped notes): ${join(soulTarget, "skills")}\n- You are ATTACHED to the instance's work tree (./work) — commit your promotions there as a single commit, prefixed "memory-harvest:".\n- Follow your memory-harvest skill: promote/merge/drop each note, knowledge vs skill routing, index + log discipline, validate the bundle, DELETE processed notes from the source notes/ dir (so they are not re-harvested), commit, then run \`oas retire ${harvName} --self\`.`,
      });
    }
    out({ meta: { harvestSpawn: r.instance, window: r.tmux?.window } });
  } catch (e) { warn(`harvest spawn failed (notes are safe on disk): ${e.message || e}`); }
} else if (event === "retire") {
  // Retirement is intentionally a no-op for knowledge (for now): promotion happens
  // continuously via agent-initiated harvest. Uncommitted notes die with the home —
  // the injection tells instances to bring memory up to date, commit, and harvest
  // before finishing.
  out({ meta: {} });
} else {
  warn(`unknown event "${event}" (expected soul-scaffold|spawn|retire)`);
}
