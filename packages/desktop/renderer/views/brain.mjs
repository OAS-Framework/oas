/**
 * brain.mjs — "agent brain" view for the OAS desktop app.
 *
 * Contract (desktop-app): ES module exporting mount(el, ctx) / unmount(),
 * where ctx = { api(pathname, opts), openFile(path), openTerminal(instance) }.
 * Data comes from GET /api/brain/<agent> (see capabilities/oas-web/bin/oas-web.mjs);
 * every artifact is an absolute path opened through ctx.openFile → the shell's
 * markdown viewer. No frameworks — plain DOM, panel design tokens (var(--*)).
 */

let root = null;
import { wsQuery, onWorkspaceChange } from "./common.mjs";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `
.brain { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg); color: var(--fg);
         font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.brain-bar { display: flex; align-items: center; gap: 10px; height: var(--bar-h, 48px); flex: none; padding: 0 14px;
             border-bottom: 1px solid var(--border); background: var(--surface); }
.brain-bar label { color: var(--muted); font-size: 12px; }
.brain-bar select { background: var(--surface-2); color: var(--fg); border: 1px solid var(--border); border-radius: 8px;
                    padding: 5px 8px; font: inherit; max-width: 320px; }
.brain-bar select:hover, .brain-bar select:focus { border-color: var(--accent); outline: none; }
.brain-desc { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brain-body { flex: 1; display: flex; gap: 14px; padding: 14px; overflow: auto; min-height: 0; align-items: flex-start; }
.brain-col { flex: 1; min-width: 280px; display: flex; flex-direction: column; gap: 12px; }
.brain-coltitle { font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }
.brain-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); overflow: hidden; }
.brain-card > h3 { margin: 0; padding: 8px 12px; font-size: 12px; font-weight: 600; color: var(--muted);
                   border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
.brain-card > h3 .cnt { margin-left: auto; font-weight: 400; color: var(--faint); font-size: 11px; }
.brain-item { display: block; width: 100%; text-align: left; background: none; border: none; border-bottom: 1px solid var(--border);
              padding: 8px 12px; color: var(--fg); font: inherit; cursor: pointer; }
.brain-item:last-child { border-bottom: none; }
.brain-item:hover { background: var(--sel); }
.brain-item .t { color: var(--accent); font-weight: 550; }
.brain-item .d { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
.brain-empty { padding: 8px 12px; color: var(--faint); font-style: italic; }
.brain-tree { padding: 6px 0; }
.brain-tree .dir { padding: 4px 12px; color: var(--muted); font-size: 12px; font-weight: 600; }
.brain-tree button { display: block; width: 100%; text-align: left; background: none; border: none; padding: 3px 12px;
                     color: var(--fg); font: inherit; cursor: pointer; border-radius: 0; }
.brain-tree button:hover { background: var(--sel); color: var(--accent); }
.brain-tree .indent { padding-left: 26px; }
.brain-inst-head { display: flex; align-items: center; gap: 8px; }
.brain-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); flex: none; }
.brain-dot.on { background: var(--ok); }
.brain-status { padding: 48px 24px; color: var(--muted); text-align: center; font-size: 13.5px; }
.brain-status .big { font-size: 32px; display: block; margin-bottom: 12px; opacity: .5; }
`;

function card(title, count, innerEl) {
  const c = document.createElement("section");
  c.className = "brain-card";
  const h = document.createElement("h3");
  h.innerHTML = `${esc(title)}${count != null ? `<span class="cnt">${count}</span>` : ""}`;
  c.append(h, innerEl);
  return c;
}
function empty(text) {
  const d = document.createElement("div");
  d.className = "brain-empty";
  d.textContent = text;
  return d;
}
function fileItem(label, path, description, openFile) {
  const b = document.createElement("button");
  b.className = "brain-item";
  b.innerHTML = `<span class="t">${esc(label)}</span>${description ? `<span class="d">${esc(description)}</span>` : ""}`;
  b.title = path;
  b.addEventListener("click", () => openFile(path));
  return b;
}
function skillsCard(title, skills, openFile) {
  const box = document.createElement("div");
  if (!skills.length) box.append(empty("no skills"));
  for (const s of skills) box.append(fileItem(s.name, s.path, s.description, openFile));
  return card(title, skills.length, box);
}
/** Knowledge tree: group by directory relative to the bundle root. */
function treeCard(title, paths, baseHint, openFile) {
  const box = document.createElement("div");
  box.className = "brain-tree";
  if (!paths.length) { box.append(empty("empty")); return card(title, 0, box); }
  // common base = dirname of the shortest path (index.md sits at the root)
  const base = baseHint || paths.reduce((a, b) => (a.length <= b.length ? a : b)).replace(/\/[^/]*$/, "");
  const groups = new Map();
  for (const p of paths) {
    const rel = p.startsWith(base + "/") ? p.slice(base.length + 1) : p;
    const slash = rel.indexOf("/");
    const dir = slash > 0 ? rel.slice(0, slash) : "";
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push({ rel: slash > 0 ? rel.slice(slash + 1) : rel, path: p });
  }
  for (const dir of [...groups.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))) {
    if (dir) { const d = document.createElement("div"); d.className = "dir"; d.textContent = dir + "/"; box.append(d); }
    for (const f of groups.get(dir)) {
      const b = document.createElement("button");
      if (dir) b.className = "indent";
      b.textContent = f.rel;
      b.title = f.path;
      b.addEventListener("click", () => openFile(f.path));
      box.append(b);
    }
  }
  return card(title, paths.length, box);
}

function renderBrain(body, d, ctx) {
  body.innerHTML = "";
  // ── Soul column ──
  const soul = document.createElement("div");
  soul.className = "brain-col";
  const st = document.createElement("div");
  st.className = "brain-coltitle";
  st.textContent = "Soul — long-term identity";
  soul.append(st);
  const idBox = document.createElement("div");
  if (d.soul.agentsMd) idBox.append(fileItem("AGENTS.md", d.soul.agentsMd, "who this agent is — soul instructions", ctx.openFile));
  else idBox.append(empty("no AGENTS.md"));
  soul.append(card("Identity", null, idBox));
  soul.append(skillsCard("Skills", d.soul.skills, ctx.openFile));
  const kBase = d.soul.knowledge.index ? d.soul.knowledge.index.replace(/\/index\.md$/, "") : null;
  soul.append(treeCard("Knowledge", d.soul.knowledge.tree, kBase, ctx.openFile));
  body.append(soul);

  // ── Instance columns ──
  const instCol = document.createElement("div");
  instCol.className = "brain-col";
  const it = document.createElement("div");
  it.className = "brain-coltitle";
  it.textContent = `Instances — episodic state (${d.instances.length})`;
  instCol.append(it);
  if (!d.instances.length) {
    const c = document.createElement("div");
    c.append(empty("no instances"));
    instCol.append(card("Instances", 0, c));
  }
  for (const i of d.instances) {
    const box = document.createElement("div");
    for (const [label, path, desc] of [
      ["TASK.md", i.task, "the briefing"],
      ["STATE.md", i.state, "live working state"],
      ["AGENTS.md", i.agentsMd, "composed instance instructions"],
    ]) if (path) box.append(fileItem(label, path, desc, ctx.openFile));
    if (i.notes.length) {
      const nt = treeCard("notes/", i.notes, i.home + "/notes", ctx.openFile);
      nt.style.border = "none"; nt.style.boxShadow = "none"; nt.style.borderRadius = "0";
      box.append(nt);
    }
    if (i.skills.length) {
      const sk = skillsCard("instance skills", i.skills, ctx.openFile);
      sk.style.border = "none"; sk.style.boxShadow = "none"; sk.style.borderRadius = "0";
      box.append(sk);
    }
    const c = document.createElement("section");
    c.className = "brain-card";
    const h = document.createElement("h3");
    h.className = "brain-inst-head";
    h.innerHTML = `<span class="brain-dot${i.running ? " on" : ""}"></span>${esc(i.instance)}<span class="cnt">${i.running ? "running" : "stopped"}</span>`;
    if (i.running && typeof ctx.openTerminal === "function") {
      h.style.cursor = "pointer";
      h.title = "open terminal";
      h.addEventListener("click", () => ctx.openTerminal(i.instance));
    }
    c.append(h, box);
    instCol.append(c);
  }
  body.append(instCol);
}

async function json(res) { return res && typeof res.json === "function" ? res.json() : res; }

let unsubWs = null;
let rosterGen = 0; // /api/agents generation — workspace refreshes
let gen = 0;       // /api/brain generation — agent selections
// SEPARATE tokens (review 3dfe7d1): selections and roster refreshes must not
// share one counter, or a selection made while /api/agents is in flight
// cancels the required workspace refresh and strands the stale roster.

export async function mount(el, ctx) {
  root = document.createElement("div");
  root.className = "brain";
  const style = document.createElement("style");
  style.textContent = CSS;
  const bar = document.createElement("div");
  bar.className = "brain-bar";
  bar.innerHTML = `<label for="brain-agent">Agent</label>`;
  const sel = document.createElement("select");
  sel.id = "brain-agent";
  const desc = document.createElement("span");
  desc.className = "brain-desc";
  bar.append(sel, desc);
  const body = document.createElement("div");
  body.className = "brain-body";
  root.append(style, bar, body);
  el.append(root);

  const status = (msg, glyph) => { body.innerHTML = `<div class="brain-status" style="flex:1">${glyph ? `<span class="big">${glyph}</span>` : ""}${esc(msg)}</div>`; };

  const load = async (name, myGen) => {
    const a = (loadAgents.list || []).find((x) => x.name === name);
    desc.textContent = a?.description || "";
    status(`Loading ${name}…`);
    // House generation-token pattern (see diff.mjs owns()): BOTH completion
    // paths check ownership — an earlier request's rejection must not replace
    // a later selection's rendered brain (round-4 review @3ebfc47), and the
    // selected name is bound in too so completion can't paint a stale agent.
    const owns = () => myGen === gen && root && sel.value === name;
    try {
      const d = await json(await ctx.api(`/api/brain/${encodeURIComponent(name)}${wsQuery()}`));
      if (!owns()) return; // superseded, unmounted, or selection moved on
      if (d.error) { status(d.error); return; }
      renderBrain(body, d, ctx);
    } catch (e) { if (owns()) status(`Failed to load brain: ${e.message || e}`); }
  };

  // Workspace-aware agent loading: /api/agents is ws-scoped, and the shared
  // workspace bus (Instances/Spawn/Jira switchers) must refresh this view.
  async function loadAgents() {
    const myRoster = ++rosterGen;
    gen++;               // also retire in-flight brain requests of the old roster
    sel.disabled = true; // a stale-roster selection must not race the refresh
    status("Loading agents…");
    let agents = [];
    try {
      const d = await json(await ctx.api(`/api/agents${wsQuery()}`));
      agents = (d.agents || []).filter((a, i, arr) => arr.findIndex((x) => x.name === a.name) === i);
    } catch (e) {
      // Current-request failure must re-enable the selector (nothing remains
      // in flight); a STALE failure must not unlock a newer refresh's lock.
      if (myRoster === rosterGen && root) {
        sel.disabled = false;
        status(`Failed to load agents: ${e.message || e}`);
      }
      return;
    }
    if (myRoster !== rosterGen || !root) return;
    loadAgents.list = agents;
    sel.innerHTML = "";
    sel.disabled = false;
    if (!agents.length) { desc.textContent = ""; status("No agents in this workspace.", "◎"); return; }
    for (const a of agents) {
      const o = document.createElement("option");
      o.value = a.name;
      o.textContent = a.name;
      sel.append(o);
    }
    // Soul roster's "View brain" opens this artifact at the chosen soul.
    if (ctx.agent && agents.some((a) => a.name === ctx.agent)) sel.value = ctx.agent;
    await load(sel.value, ++gen);
  }

  // every selection is a NEW generation — reusing the current gen lets a
  // prior request's late completion (success OR error) win over this one
  sel.addEventListener("change", () => load(sel.value, ++gen));
  unsubWs = onWorkspaceChange(() => loadAgents());
  await loadAgents();
}

export function unmount() {
  gen++;
  rosterGen++;
  if (unsubWs) { unsubWs(); unsubWs = null; }
  if (root) { root.remove(); root = null; }
}
