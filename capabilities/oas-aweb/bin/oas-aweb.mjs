#!/usr/bin/env node
/**
 * oas-aweb — OAS messaging-provider hooks for aweb.
 *
 * Invoked by the OAS kernel at instance lifecycle events (hook contract):
 *   oas-aweb spawn    mint a team-scoped aweb identity for the instance
 *   oas-aweb retire   gracefully self-delete it (BEFORE the home dir is removed)
 *   oas-aweb roster   list the aweb team's members — the cross-machine directory
 *                     of live instances (alias = instance name) and humans
 *
 * Env contract (set by the kernel):
 *   OAS_EVENT     spawn|retire
 *   OAS_INSTANCE  instance name (used as the aweb alias)
 *   OAS_HOME      instance home dir (cwd is also set to it)
 *   OAS_CONTEXT   resolution context dir (the soul's repo / agents root parent)
 *   OAS_WORKSPACE the agents root's parent — the team boundary
 *   OAS_SETTINGS  JSON of the provider's `settings:` block
 *   OAS_TEAM_NAME/OAS_TEAM_ID/OAS_TEAM_SCOPE  resolved config `team:` block (may be empty)
 *   OAS_META      JSON persisted from this hook's previous spawn output (retire only)
 *
 * Output (spawn, stdout JSON):
 *   { "meta": {...persisted to instance.json + OAS_META at retire},
 *     "brief": "one-line TASK.md briefing line", "warning": "non-fatal problem" }
 * Exit code is advisory: the kernel treats hook failure as a warning, never a block.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const sh = (cmd, cwd, timeout = 45000) =>
  execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout }).trim();
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const out = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };
const warn = (m) => out({ warning: `oas-aweb: ${String(m).slice(0, 300)}` });

const event = process.env.OAS_EVENT || process.argv[2];
const instance = process.env.OAS_INSTANCE;
const home = process.env.OAS_HOME || process.cwd();

/**
 * The aweb root (minting authority). BOUNDED candidates — the workspace is the team
 * boundary, so we never walk past it to the laptop root (a `.aw` there would be a
 * different team; minting into it would be a silent cross-team leak):
 *   1. the instance home itself
 *   2. the git repo root containing the home (if any)
 *   3. the resolution context (the soul's target repo) and its git repo root
 *   4. the workspace root (OAS_WORKSPACE — e.g. ~/lfx)
 * First candidate with a `.aw` wins; none → no minting.
 */
function gitRootOf(startDir) {
  let d = resolve(startDir);
  while (true) {
    if (existsSync(join(d, ".git"))) return d;
    const parent = dirname(d);
    if (parent === d) return undefined;
    d = parent;
  }
}
function awebRoot() {
  const candidates = [];
  const push = (p) => { if (p && !candidates.includes(resolve(p))) candidates.push(resolve(p)); };
  push(home);
  push(gitRootOf(home));
  push(process.env.OAS_CONTEXT);
  if (process.env.OAS_CONTEXT) push(gitRootOf(process.env.OAS_CONTEXT));
  push(process.env.OAS_WORKSPACE);
  for (const c of candidates) if (existsSync(join(c, ".aw"))) return c;
  return undefined;
}

try { sh("command -v aw"); } catch { warn("aw CLI not on PATH — no identity minted"); }

if (event === "spawn") {
  const root = awebRoot();
  if (!root) warn(`no initialized aweb root (.aw) in the bounded candidates (home, its git repo, context repo, workspace ${process.env.OAS_WORKSPACE || "?"}) — no identity minted`);
  try {
    // Team correctness: the config's `team:` block wins (id, then name), else the
    // root's active team. ALWAYS pass --team-id explicitly — never inherit whatever
    // team happens to be active at mint time — and verify the joined cert matches.
    // The instance name IS the discoverable alias (the team roster doubles as the
    // cross-machine instance directory).
    let team = process.env.OAS_TEAM_ID || process.env.OAS_TEAM_NAME;
    if (!team) team = JSON.parse(sh("aw team list --json", root)).active_team;
    if (!team) warn("cannot determine target team (no config team block, no active team at root)");
    // A bare team name (no namespace) resolves against the root's memberships.
    if (!team.includes(":")) {
      const teams = JSON.parse(sh("aw team list --json", root));
      const match = (teams.teams || []).map((t) => t.team_id || t.id || t).filter((tid) => String(tid).startsWith(`${team}:`));
      if (match.length === 1) team = match[0];
      else if (match.length > 1) warn(`team name "${team}" is ambiguous at ${root}: ${match.join(", ")} — set team.id in oas-config.yaml`);
      else warn(`no membership matching team "${team}" at ${root} — join/create it first (aweb-team-membership skill), or set team.id`);
    }
    const inv = JSON.parse(sh(`aw team invite --team-id ${shq(team)} --json`, root));
    const joined = JSON.parse(sh(`aw team join ${shq(inv.token)} --name ${shq(instance)} --json`, home));
    sh("aw init --do-not-touch-agents-md", home);
    const alias = joined.alias || instance;
    const mismatch = joined.team_id !== team
      ? ` [WARNING: joined ${joined.team_id}, expected ${team}]` : "";
    out({
      meta: { team: joined.team_id, alias },
      brief: `Comms: you have an aweb identity — alias "${alias}" on team ${joined.team_id}.${mismatch} Use \`aw mail\`/\`aw chat\` for messaging (see the aweb-messaging skill); coordination stays in your deployment's task layer.`,
      ...(mismatch ? { warning: `oas-aweb: team mismatch — joined ${joined.team_id}, expected ${team}` } : {}),
    });
  } catch (e) { warn(`identity minting failed (continuing without): ${e.message || e}`); }
} else if (event === "retire") {
  const meta = JSON.parse(process.env.OAS_META || "{}");
  if (!meta.alias || !existsSync(join(home, ".aw"))) out({ meta: { retired: false } });
  try {
    // Self-delete from inside the home, authenticated by its own key — a remote
    // delete would 409 until the server marks the workspace stale.
    sh(`aw workspace delete ${shq(meta.alias)}`, home);
    out({ meta: { retired: true } });
  } catch (e) { warn(`self-delete failed (record will linger until stale): ${e.message || e}`); }
} else if (event === "roster") {
  // Cross-machine directory: every OAS-spawned instance joins the team with
  // alias = instance name, so the team's member roster lists live instances
  // wherever they run (plus human members). Local liveness comes from
  // `oas status --team`; this is the network view.
  const root = awebRoot();
  if (!root) { console.error("oas aweb roster: no initialized aweb root (.aw) found"); process.exit(1); }
  const team = process.env.OAS_TEAM_ID || process.env.OAS_TEAM_NAME || JSON.parse(sh("aw team list --json", root)).active_team;
  if (!team) { console.error("oas aweb roster: cannot determine team (no config team block, no active team)"); process.exit(1); }
  const teamFlag = team.includes(":") ? `--team-id ${shq(team)}` : `--team ${shq(team)}`;
  const r = JSON.parse(sh(`aw id team members ${teamFlag} --json`, root, 60000));
  if (process.argv.includes("--json")) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  console.log(`aweb team ${r.team_id || team} — member roster (cross-machine):`);
  const members = r.members || [];
  if (!members.length) console.log("  (no member certificates visible from this workspace)");
  for (const m of members) console.log(`  ${m.alias || m.name || m.did || JSON.stringify(m)}`);
  console.log("\nAliases minted by OAS are instance names; message one with `aw mail send <alias> ...`.");
  process.exit(0);
} else {
  warn(`unknown event "${event}" (expected spawn|retire)`);
}
