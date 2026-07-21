import { collectControlPane, capturePreview, relativeAge, switchToInstance, workspaceName } from "./model.mjs";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

// ── Theme ── two named themes: "dark" (default) and "solarized" (light,
// Solarized palette). No terminal guessing — pick with `oas pane --theme` or
// OAS_PANE_THEME. C is mutable: applyTheme() fills it at startup.
const C = {};
let SOUL_PALETTE = [];
let BADGE_TEXT = "";

export const THEMES = ["dark", "solarized"];

function applyTheme(name) {
  const fg = (r, g, b) => `${ESC}38;2;${r};${g};${b}m`;
  const bgc = (r, g, b) => `${ESC}48;2;${r};${g};${b}m`;
  if (name === "solarized") {
    // Solarized Light (Ethan Schoonover) — base3/base2 surfaces, base00 ink.
    Object.assign(C, {
      ink: fg(101, 123, 131), muted: fg(88, 110, 117), faint: fg(147, 161, 161),
      cyan: fg(38, 139, 210), violet: fg(108, 113, 196), green: fg(133, 153, 0),
      amber: fg(181, 137, 0), red: fg(220, 50, 47),
      guide: fg(147, 161, 161),
      panel: bgc(238, 232, 213), card: bgc(253, 246, 227), selected: bgc(222, 216, 197),
      bar: bgc(238, 232, 213),
      bold: `${ESC}1m`, dim: `${ESC}2m`,
    });
    SOUL_PALETTE = [
      { bg: bgc(38, 139, 210), fg: fg(38, 139, 210) },    // blue
      { bg: bgc(108, 113, 196), fg: fg(108, 113, 196) },  // violet
      { bg: bgc(133, 153, 0), fg: fg(133, 153, 0) },      // green
      { bg: bgc(181, 137, 0), fg: fg(181, 137, 0) },      // yellow
      { bg: bgc(211, 54, 130), fg: fg(211, 54, 130) },    // magenta
      { bg: bgc(42, 161, 152), fg: fg(42, 161, 152) },    // cyan
    ];
    BADGE_TEXT = fg(253, 246, 227);
    C.featureBranchBg = bgc(222, 210, 240); C.featureBranchFg = fg(108, 113, 196);
  } else {
    Object.assign(C, {
      ink: fg(226, 231, 245), muted: fg(110, 118, 144), faint: fg(66, 73, 96),
      cyan: fg(77, 208, 225), violet: fg(173, 128, 255), green: fg(94, 234, 156),
      amber: fg(250, 193, 92), red: fg(255, 107, 129),
      guide: fg(86, 98, 140),
      panel: bgc(18, 20, 30), card: bgc(24, 27, 40), selected: bgc(33, 38, 58),
      bar: bgc(13, 15, 23),
      bold: `${ESC}1m`, dim: `${ESC}2m`,
    });
    SOUL_PALETTE = [
      { bg: bgc(77, 208, 225), fg: fg(77, 208, 225) },    // cyan
      { bg: bgc(173, 128, 255), fg: fg(173, 128, 255) },  // violet
      { bg: bgc(94, 234, 156), fg: fg(94, 234, 156) },    // green
      { bg: bgc(250, 193, 92), fg: fg(250, 193, 92) },    // amber
      { bg: bgc(255, 121, 198), fg: fg(255, 121, 198) },  // pink
      { bg: bgc(120, 170, 255), fg: fg(120, 170, 255) },  // blue
    ];
    BADGE_TEXT = fg(12, 14, 22);
    C.featureBranchBg = bgc(64, 46, 96); C.featureBranchFg = fg(204, 170, 255);
  }
}
applyTheme("dark"); // default

export function soulHue(agent = "") {
  let hash = 0;
  for (const char of String(agent)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return SOUL_PALETTE[hash % SOUL_PALETTE.length];
}
function soulBadge(agent) {
  return `${soulHue(agent).bg}${BADGE_TEXT}${C.bold} ${agent} ${RESET}`;
}

function clean(value = "") {
  return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
function capturedSgr(value = "") {
  return String(value)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, (sequence) => sequence.endsWith("m") ? sequence : "")
    .replace(/\x1b(?!\[[0-9;:]*m)/g, "")
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, "");
}
function clipSgr(value, width) {
  const safe = capturedSgr(value);
  let visible = 0;
  let output = "";
  for (const token of safe.match(/\x1b\[[0-9;:]*m|[^\x1b]/g) || []) {
    if (token.startsWith("\x1b")) { output += token; continue; }
    if (visible >= width) break;
    output += token;
    visible++;
  }
  return output + RESET;
}
function clip(value, width) {
  const text = clean(value);
  if (width <= 0) return "";
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + "…";
}
function paint(text, ...styles) { return styles.join("") + text + RESET; }
function wrap(value, width, maxLines = Infinity) {
  if (width < 1) return [];
  const words = clean(value).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (!line) line = word;
    else if (line.length + word.length + 1 <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
    while (line.length > width) { lines.push(line.slice(0, width)); line = line.slice(width); }
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.length && lines.join(" ").length < clean(value).length) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.$/, "…");
  }
  return lines;
}
function line(width, content = "", bg = C.panel) {
  const visible = clean(content);
  if (visible.length <= width) return bg + content + " ".repeat(width - visible.length) + RESET;
  return bg + clip(visible, width) + RESET;
}

function branchChip(git, active) {
  const feature = git.branch && git.branch !== "main" && git.branch !== "master" && git.branch !== "?";
  const churn = (git.additions || git.deletions)
    ? ` ${paint(`+${git.additions || 0}`, C.green)} ${paint(`-${git.deletions || 0}`, C.red)}`
    : git.dirty ? paint(` ~${git.dirty}`, C.muted) : "";
  const movement = `${git.ahead ? paint(` ↑${git.ahead}`, C.muted) : ""}${git.behind ? paint(` ↓${git.behind}`, C.amber) : ""}`;
  const label = feature
    ? paint(` ${git.branch} `, C.featureBranchBg, C.featureBranchFg, C.bold)
    : paint(git.branch, active ? C.muted : C.faint);
  return `${label}${churn}${movement}`;
}

function instanceLabel(instance) {
  const prefix = `${instance.agent}-`;
  return instance.instance.startsWith(prefix) ? instance.instance.slice(prefix.length) : instance.instance;
}

function guides(row, kind) {
  // kind: "node" (branch into this card) | "pass" (continue past this card)
  if (!row.depth) return "";
  const trunk = row.ancestorsLast.slice(1).map((last) => last ? "   " : "│  ").join("");
  if (kind === "node") return trunk + (row.last ? "╰─▸" : "├─▸");
  return trunk + (row.last ? "   " : "│  ");
}

// ── Card renderer ──────────────────────────────────────────────────────────
// Every instance is a card: identity rail (soul color) + name + branch on
// line one, "→ next action" on line two. The selected card expands in place
// with the live session (or details) inside it.

function buildCard(row, ctx) {
  const { width, active, expanded, drivers, preview, previewMode, contentLines, nextRow } = ctx;
  const instance = row.instance;
  const hue = soulHue(instance.agent);
  const on = instance.running;
  const bg = active ? C.selected : C.card;
  const rail = `${on ? hue.bg : C.panel}  ${RESET}${bg} `;
  const railWidth = 3;
  const tree = row.depth ? paint(guides(row, "node") + " ", C.guide) : "";
  const spine = row.depth ? paint(guides(row, "pass") + " ", C.guide) : "";
  const lines = [];

  // 1 · title
  const marker = on ? paint("●", C.green, C.bold) : paint("○", C.faint);
  const name = paint(clean(instanceLabel(instance)), on ? C.ink : C.muted, C.bold);
  const soul = paint(instance.agent, on ? hue.fg : C.muted, C.bold);
  const roleName = row.depth ? "" : drivers.has(instance.instance) ? "driver" : instance.spawnOrigin === "operator" ? "root" : "unlinked";
  const repoName = String(instance.repo || "").split("/").pop();
  const runtimeTag = instance.runtime && instance.runtime !== "pi" ? instance.runtime : "";
  const meta = paint([repoName, runtimeTag, roleName, relativeAge(instance.createdAt)].filter(Boolean).join(" · "), C.faint);
  const branch = branchChip(instance.git, active);
  let left = `${rail}${tree}${marker} ${soul}  ${name}  ${meta}`;
  const spare = width - clean(left).length - clean(branch).length - 2;
  if (spare < 1) {
    const room = Math.max(6, width - railWidth - clean(tree).length - clean(branch).length - clean(meta).length - 8);
    left = `${rail}${tree}${marker} ${soul}  ${paint(clip(instanceLabel(instance), room), on ? C.ink : C.muted, C.bold)}  ${meta}`;
  }
  lines.push(line(width, left + " ".repeat(Math.max(1, width - clean(left).length - clean(branch).length - 2)) + branch + "  ", bg));

  // 2 · next action
  const arrow = paint("→", active ? C.cyan : C.faint);
  const nextWidth = Math.max(8, width - railWidth - clean(spine).length - 6);
  const action = paint(clip(instance.next, nextWidth), active ? C.ink : C.muted);
  lines.push(line(width, `${rail}${spine}${arrow} ${action}`, bg));

  // 3 · expansion — live session or details, inside the card
  if (expanded && contentLines > 0) {
    const innerWidth = width - railWidth - 4;
    if (previewMode && on) {
      const target = paint(`${instance.tmux.session}:${instance.tmux.window}`, C.faint);
      lines.push(line(width, `${rail}${spine}${paint("┈┈ live ┈┈", C.faint)} ${target}`, bg));
      const captured = capturedSgr(preview).split("\n")
        .filter((value, index, all) => clean(value) || index < all.length - 1)
        .slice(-(contentLines - 1));
      for (const capturedLine of captured) lines.push(line(width, `${rail}${spine} ${clipSgr(capturedLine, innerWidth)}`, bg));
    } else {
      lines.push(line(width, `${rail}${spine}${paint("┈┈ details ┈┈", C.faint)}`, bg));
      const field = (label, value, color = C.muted, max = 2) => {
        const prefix = `${rail}${spine}${paint(label.padEnd(9), C.faint)}`;
        for (const [index, part] of wrap(value || "—", Math.max(8, innerWidth - 10), max).entries()) {
          if (lines.length >= 3 + contentLines) return;
          lines.push(line(width, `${index ? `${rail}${spine}${" ".repeat(9)}` : prefix}${paint(part, color)}`, bg));
        }
      };
      field("task", instance.task, C.ink, 4);
      field("progress", instance.progress || "no progress recorded", C.muted, 3);
      field("parent", instance.parentInstance || (instance.spawnOrigin === "operator" ? "operator · root" : "unknown · legacy metadata"), instance.parentInstance ? C.violet : C.muted, 1);
      field("context", `${instance.runtime || "?"} · ${instance.work || "?"} · ${instance.knowledgeCount} concepts`, C.muted, 1);
      field("home", instance.home, C.faint, 1);
    }
  }

  // gap — carries the tree spine toward the next card
  const gapSpine = nextRow?.depth
    ? paint("   " + nextRow.ancestorsLast.slice(1).map((last) => last ? "   " : "│  ").join("") + "│", C.guide)
    : "";
  lines.push(line(width, gapSpine, C.panel));
  return lines;
}

// ── Zoom: full-screen live view of one agent ───────────────────────────────

function zoomFrame(instance, preview, width, height) {
  const hue = soulHue(instance.agent);
  const status = instance.running ? paint("● live", C.green, C.bold) : paint("○ idle", C.muted);
  const title = `  ${soulBadge(instance.agent)}  ${paint(instanceLabel(instance), C.ink, C.bold)}   ${status}   ${branchChip(instance.git, true)}`;
  const output = [line(width, title, C.bar), line(width, `  ${paint("─".repeat(Math.max(0, width - 4)), C.faint)}`, C.panel)];
  const body = height - 4;
  const captured = capturedSgr(preview).split("\n").slice(-body);
  for (const capturedLine of captured) output.push(line(width, `  ${clipSgr(capturedLine, width - 4)}`, C.panel));
  while (output.length < height - 2) output.push(line(width, "", C.panel));
  output.push(line(width, `  ${paint("→", C.cyan)} ${paint(clip(instance.next, width - 8), C.muted)}`, C.bar));
  output.push(line(width, `  ${paint("space/esc", C.ink)} back   ${paint("enter", C.ink)} attach   ${paint("q", C.ink)} quit`, C.bar));
  return output.slice(0, height).join("\n");
}

// ── Frame ──────────────────────────────────────────────────────────────────

export function renderFrame(snapshot, state, columns, rows) {
  const width = Math.max(40, columns);
  const height = Math.max(12, rows);
  const selected = Math.min(Math.max(0, state.selected || 0), Math.max(0, snapshot.rows.length - 1));
  const instance = snapshot.rows[selected]?.instance;

  if (state.zoom && instance) {
    return { text: zoomFrame(instance, state.preview || "", width, height), rowMap: new Map(), topRow: state.topRow || 0, selected };
  }

  const drivers = new Set(snapshot.instances.map((item) => item.parentInstance).filter(Boolean));
  const available = height - 4;
  const expandedContent = Math.max(4, Math.min(16, available - Math.min(snapshot.rows.length, 4) * 3 - 1));
  const expandedIndex = snapshot.rows.length ? selected : -1;

  // Build every card once; scroll on real card heights.
  const cards = snapshot.rows.map((row, index) => buildCard(row, {
    width, drivers,
    active: index === selected,
    expanded: index === expandedIndex,
    preview: state.preview || "",
    previewMode: state.previewMode !== false,
    contentLines: expandedContent,
    nextRow: snapshot.rows[index + 1],
  }));
  const heights = cards.map((card) => card.length);

  // Keep the selected card fully visible.
  let topRow = Math.min(Math.max(0, state.topRow || 0), Math.max(0, snapshot.rows.length - 1));
  if (selected < topRow) topRow = selected;
  const used = (from, to) => heights.slice(from, to + 1).reduce((sum, value) => sum + value, 0);
  while (topRow < selected && used(topRow, selected) > available) topRow++;

  // Header — quiet, factual.
  const workstreams = new Set(snapshot.instances.map((item) => item.git.branch).filter((branch) => branch && branch !== "main" && branch !== "master" && branch !== "?"));
  const unknownLineage = snapshot.instances.filter((item) => !item.spawnOrigin).length;
  const left = `  ${paint("⌁", C.cyan, C.bold)} ${paint("OAS", C.ink, C.bold)} ${paint("· " + workspaceName(snapshot.root), C.muted)}`;
  const facts = [
    paint(`● ${snapshot.running} running`, C.green),
    paint(`○ ${snapshot.instances.length - snapshot.running} idle`, C.muted),
    workstreams.size ? paint(`⌥ ${workstreams.size} workstream${workstreams.size > 1 ? "s" : ""}`, C.violet) : "",
    unknownLineage ? paint(`△ ${unknownLineage} unlinked`, C.amber) : "",
  ].filter(Boolean).join(paint("  ·  ", C.faint));
  const gap = Math.max(1, width - clean(left).length - clean(facts).length - 2);
  const output = [line(width, left + " ".repeat(gap) + facts + "  ", C.bar), line(width, "", C.panel)];

  const rowMap = new Map();
  for (let index = topRow; index < snapshot.rows.length && output.length < height - 2; index++) {
    for (const cardLine of cards[index]) {
      if (output.length >= height - 2) break;
      rowMap.set(output.length, index);
      output.push(cardLine);
    }
  }
  while (output.length < height - 2) output.push(line(width, "", C.panel));

  const message = state.message
    ? paint(state.message, C.amber)
    : [
        `${paint("↑↓", C.ink)} move`, `${paint("space", C.ink)} zoom`, `${paint("enter", C.ink)} attach`,
        `${paint("t", C.ink)} live/details`, `${paint("r", C.ink)} refresh`, `${paint("q", C.ink)} quit`,
      ].join(paint("  ·  ", C.faint));
  output.push(line(width, `  ${message}`, C.bar));
  output.push(line(width, `  ${paint(snapshot.tmuxAvailable ? "tmux connected" : "tmux unavailable · file state only", snapshot.tmuxAvailable ? C.green : C.amber)}${paint(`   ${new Date(snapshot.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`, C.faint)}`, C.bar));
  return { text: output.slice(0, height).join("\n"), rowMap, topRow, selected };
}

function parseInput(data) {
  const text = data.toString("utf8");
  const mouse = text.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (mouse) return { type: "mouse", button: Number(mouse[1]), x: Number(mouse[2]), y: Number(mouse[3]), down: mouse[4] === "M" };
  if (text === "\x1b[A") return { type: "up" };
  if (text === "\x1b[B") return { type: "down" };
  if (text === "\x1b[5~") return { type: "pageUp" };
  if (text === "\x1b[6~") return { type: "pageDown" };
  if (text === "\r" || text === "\n") return { type: "enter" };
  if (text === " ") return { type: "space" };
  if (text === "\x1b") return { type: "escape" };
  if (text === "\x03" || text === "q") return { type: "quit" };
  return { type: text };
}

export async function startControlPane(root, opts = {}) {
  const theme = opts.theme || process.env.OAS_PANE_THEME || "dark";
  if (!THEMES.includes(theme)) throw new Error(`unknown theme "${theme}" (themes: ${THEMES.join(", ")})`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Control Pane needs an interactive terminal (TTY)");
  applyTheme(theme);
  let snapshot = collectControlPane(root);
  const state = { selected: 0, topRow: 0, previewMode: true, preview: "", message: "", zoom: false };
  let frame;
  let timer;
  let cleaned = false;
  const selectedInstance = () => snapshot.rows[state.selected]?.instance;
  const refreshPreview = () => {
    const lines = state.zoom ? Math.max(12, process.stdout.rows - 6) : 16;
    state.preview = capturePreview(selectedInstance(), lines);
  };
  const draw = () => {
    frame = renderFrame(snapshot, state, process.stdout.columns, process.stdout.rows);
    state.topRow = frame.topRow;
    process.stdout.write(`${ESC}H${frame.text}${ESC}J`);
  };
  const refresh = (keepName = selectedInstance()?.instance) => {
    snapshot = collectControlPane(root);
    const index = snapshot.rows.findIndex((row) => row.instance.instance === keepName);
    state.selected = index >= 0 ? index : Math.min(state.selected, Math.max(0, snapshot.rows.length - 1));
    refreshPreview(); draw();
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(timer);
    process.stdin.off("data", onData);
    process.stdout.off("resize", onResize);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${ESC}?1000l${ESC}?1006l${ESC}?25h${ESC}?1049l${RESET}`);
  };
  const move = (amount) => {
    state.selected = Math.min(Math.max(0, state.selected + amount), Math.max(0, snapshot.rows.length - 1));
    state.message = ""; refreshPreview(); draw();
  };
  const onResize = () => { refreshPreview(); draw(); };
  const onData = (data) => {
    const input = parseInput(data);
    if (input.type === "quit") { cleanup(); return; }
    if (input.type === "up" || input.type === "k") move(-1);
    else if (input.type === "down" || input.type === "j") move(1);
    else if (input.type === "pageUp") move(-5);
    else if (input.type === "pageDown") move(5);
    else if (input.type === "g") { state.selected = 0; refreshPreview(); draw(); }
    else if (input.type === "G") { state.selected = Math.max(0, snapshot.rows.length - 1); refreshPreview(); draw(); }
    else if (input.type === "space") { state.zoom = !state.zoom; refreshPreview(); draw(); }
    else if (input.type === "escape") { if (state.zoom) { state.zoom = false; refreshPreview(); draw(); } }
    else if (input.type === "t" || input.type === "p") { state.previewMode = !state.previewMode; draw(); }
    else if (input.type === "r") { state.message = "Refreshed"; refresh(); }
    else if (input.type === "enter") {
      if (!switchToInstance(selectedInstance())) { state.message = "Instance is idle — there is no tmux window to attach to"; draw(); }
    } else if (input.type === "mouse" && input.down) {
      if (input.button === 64) move(-1);
      else if (input.button === 65) move(1);
      else if (input.button === 0 && frame.rowMap.has(input.y - 1)) {
        state.selected = frame.rowMap.get(input.y - 1); refreshPreview(); draw();
      }
    }
  };

  process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}?1000h${ESC}?1006h`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onData);
  process.stdout.on("resize", onResize);
  process.once("exit", cleanup);
  refreshPreview(); draw();
  timer = setInterval(() => refresh(), 2500);
  timer.unref();
}
