// Quick Open for souls (Mod+P) — pure row logic, overlay picker chrome,
// keymap/terminal-policy pins, and the Spawn-view preselect handoff.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { subsequenceScore, createOverlayPicker } from "../renderer/overlay-picker.mjs";
import { quickOpenRows, createQuickOpen } from "../renderer/quick-open.mjs";
import { paletteRows } from "../renderer/palette.mjs";
import { DEFAULT_KEYMAP, TERMINAL_ALLOWLIST } from "../renderer/keybindings.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(PKG, f), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── house fuzzy matcher (shared) ─────────────────────────────────────────

test("subsequenceScore: subsequence matches, prefix bonus, no-match null", () => {
  assert.equal(subsequenceScore("abc", "zzz"), null);
  assert.ok(subsequenceScore("oas-desktop-engineer", "ode") != null);
  assert.ok(subsequenceScore("reviewer", "rev") < subsequenceScore("harvester-rev", "rev"),
    "prefix match scores better (lower)");
  assert.ok(subsequenceScore("theme: toggle", "theme") < 0,
    "prefix scores go negative — the legacy sc<0 no-match filter dropped exact prefixes; null is the only no-match");
});

// ── quick-open rows (pure) ───────────────────────────────────────────────

const AGENTS = [
  { name: "oas-expert", repoName: "oas", description: "maintainer", work: "worktree", agentsRoot: "/r1" },
  { name: "reviewer", repoName: "oas", description: "post-commit review", work: "attached", agentsRoot: "/r1" },
  { name: "ux-designer", repoName: "oas", description: "design", work: "worktree", agentsRoot: "/r2" },
];

test("quickOpenRows: empty query lists all souls alphabetically", () => {
  const rows = quickOpenRows(AGENTS, "", { onPick: () => {} });
  assert.deepEqual(rows.map((r) => r.label), ["oas-expert", "reviewer", "ux-designer"]);
});

test("quickOpenRows: fuzzy filter narrows to matching souls; picking passes name + agentsRoot", () => {
  const picked = [];
  const rows = quickOpenRows(AGENTS, "uxd", { onPick: (s) => picked.push(s) });
  assert.deepEqual(rows.map((r) => r.label), ["ux-designer"]);
  rows[0].run();
  assert.deepEqual(picked, [{ name: "ux-designer", agentsRoot: "/r2" }]);
});

test("quickOpenRows: attached-mode souls are listed but marked attached only", () => {
  const rows = quickOpenRows(AGENTS, "reviewer", { onPick: () => {} });
  assert.equal(rows.length, 1);
  assert.match(rows[0].detail, /attached only/);
});

test("quickOpenRows: caps at 12 results", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `soul-${String(i).padStart(2, "0")}`, work: "worktree" }));
  assert.equal(quickOpenRows(many, "", { onPick: () => {} }).length, 12);
});

// ── overlay picker chrome (shared with the palette) ──────────────────────

function pickerDom() {
  const dom = new JSDOM("<!doctype html><body>", { url: "http://localhost" });
  return { dom, doc: dom.window.document };
}

test("overlay picker: opens, filters, Enter runs active row, Esc closes", async (t) => {
  const { dom, doc } = pickerDom();
  t.after(() => dom.window.close());
  const ran = [];
  const picker = createOverlayPicker({
    placeholder: "p", ariaLabel: "Quick open souls", doc,
    loadItems: async () => AGENTS,
    computeRows: (agents, q) => quickOpenRows(agents || [], q, { onPick: (s) => ran.push(s.name) }),
  });
  await picker.open();
  const input = doc.querySelector(".palette-input");
  assert.ok(input, "overlay input rendered");
  assert.equal(doc.querySelector(".palette").getAttribute("aria-label"), "Quick open souls");
  assert.equal(doc.querySelectorAll(".palette-item").length, 3);
  input.value = "uxd";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(doc.querySelectorAll(".palette-item").length, 1);
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
  assert.deepEqual(ran, ["ux-designer"]);
  assert.equal(doc.querySelector(".palette-overlay"), null, "Enter closes the overlay");
  await picker.open();
  doc.querySelector(".palette-input")
    .dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  assert.equal(doc.querySelector(".palette-overlay"), null, "Esc closes");
});

test("overlay picker: arrows move the active row", async (t) => {
  const { dom, doc } = pickerDom();
  t.after(() => dom.window.close());
  const ran = [];
  const picker = createOverlayPicker({
    placeholder: "p", ariaLabel: "x", doc,
    loadItems: async () => AGENTS,
    computeRows: (agents, q) => quickOpenRows(agents || [], q, { onPick: (s) => ran.push(s.name) }),
  });
  await picker.open();
  const input = doc.querySelector(".palette-input");
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
  assert.deepEqual(ran, ["reviewer"], "second row after one ArrowDown");
});

test("overlay picker: a load resolving after close must not paint (generation guard)", async (t) => {
  const { dom, doc } = pickerDom();
  t.after(() => dom.window.close());
  let release;
  const picker = createOverlayPicker({
    placeholder: "p", ariaLabel: "x", doc,
    loadItems: () => new Promise((ok) => { release = ok; }),
    computeRows: (agents) => quickOpenRows(agents || [], "", { onPick: () => {} }),
  });
  const opening = picker.open();
  picker.close();
  release(AGENTS);
  await opening;
  assert.equal(doc.querySelector(".palette-overlay"), null, "stale load did not resurrect the overlay");
});

test("createQuickOpen: a failing souls load renders an empty list, not a crash", async (t) => {
  const { dom, doc } = pickerDom();
  t.after(() => dom.window.close());
  const qo = createQuickOpen({ loadSouls: async () => { throw new Error("boom"); }, onPick: () => {}, doc });
  await qo.open();
  assert.match(doc.querySelector(".palette-list").textContent, /No matches/);
});

// ── palette parity: paletteRows still behaves on the shared scorer ───────

test("paletteRows: '>' restricts to commands; live chord detail functions re-evaluate", () => {
  let chord = "⌘T";
  const rows = paletteRows(
    [{ instance: "inst-a", running: true }],
    [{ label: "Theme: toggle", detail: () => chord, run: () => {} }],
    ">theme",
  );
  assert.deepEqual(rows.map((r) => r.label), ["Theme: toggle"]);
  assert.equal(rows[0].detail, "⌘T");
});

// ── keymap + terminal policy pins ────────────────────────────────────────

test("app.quickOpenSouls defaults to Mod+P and is NOT terminal-allowlisted", () => {
  assert.equal(DEFAULT_KEYMAP["app.quickOpenSouls"], "Mod+P");
  assert.ok(!TERMINAL_ALLOWLIST.includes("app.quickOpenSouls"),
    "Ctrl+P inside xterm belongs to the shell's history on Linux/Windows");
});

// ── shell wiring pins (source-level, house style) ────────────────────────

test("shell wires quick open: action registered, palette command present, spawn handoff", () => {
  const src = read("renderer/shell.mjs");
  assert.match(src, /id: "app\.quickOpenSouls"/, "action registered");
  assert.match(src, /Souls: quick open…/, "palette discoverability entry");
  assert.match(src, /createQuickOpen\(/, "quick open constructed");
  assert.match(src, /preselectSoul\(/, "selection preselects the soul in the Spawn view");
  assert.match(src, /showStage\("spawn"\)/, "selection routes to the Spawn stage");
});

test("palette and quick open share the overlay-picker machinery (no duplicated chrome)", () => {
  const palette = read("renderer/palette.mjs");
  const qo = read("renderer/quick-open.mjs");
  for (const src of [palette, qo]) {
    assert.match(src, /from "\.\/overlay-picker\.mjs"/);
    assert.ok(!/palette-overlay/.test(src), "overlay DOM lives only in overlay-picker.mjs");
  }
});

// ── Spawn view preselect handoff (jsdom) ─────────────────────────────────

const CLI_OK = { ok: true, bin: "/seed/oas", version: "0.18.0", source: "path", required: { desktopApi: 1, range: ">=0.18.0 <0.19.0" }, probedAt: 1, tried: [] };

async function mountSpawn(t, { cliOk = true } = {}) {
  const dom = new JSDOM("<!doctype html><body><div id=host></div>", { url: "http://localhost" });
  const oldDoc = globalThis.document, oldWin = globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const cliStatus = await import("../renderer/views/cli-status.mjs");
  const spawn = await import("../renderer/views/spawn.mjs");
  await cliStatus.refreshCli({
    api: async () => ({ ok: cliOk, status: cliOk ? 200 : 503, json: async () => (cliOk ? CLI_OK : { ok: false, error: "cli-unavailable", tried: [] }) }),
  });
  const ctx = {
    api: async (pathname) => {
      if (pathname.startsWith("/api/cli")) return { ok: cliOk, status: cliOk ? 200 : 503, json: async () => (cliOk ? CLI_OK : { ok: false, error: "cli-unavailable", tried: [] }) };
      if (pathname.startsWith("/api/agents")) return { ok: true, status: 200, json: async () => ({ agents: AGENTS }) };
      if (pathname.startsWith("/api/panel")) return { ok: true, status: 200, json: async () => ({ instances: [], workspace: { id: "" }, workspaces: [] }) };
      throw new Error(`unexpected ${pathname}`);
    },
    openTerminal: () => {},
  };
  spawn.mount(dom.window.document.getElementById("host"), ctx);
  await tick(); await tick();
  t.after(() => {
    spawn.unmount();
    globalThis.document = oldDoc;
    globalThis.window = oldWin;
    dom.window.close();
  });
  return { dom, doc: dom.window.document, spawn };
}

test("preselectSoul before roster paint opens the soul's spawn modal (CLI ok)", async (t) => {
  const { doc, spawn } = await mountSpawn(t);
  spawn.preselectSoul({ name: "ux-designer", agentsRoot: "/r2" });
  const dialog = doc.querySelector(".spawn-dialog");
  assert.ok(dialog, "spawn modal opened");
  assert.match(dialog.textContent, /Spawn ux-designer/);
});

test("preselectSoul on an attached-only soul focuses its card, never a modal", async (t) => {
  const { doc, spawn } = await mountSpawn(t);
  spawn.preselectSoul({ name: "reviewer", agentsRoot: "/r1" });
  assert.equal(doc.querySelector(".spawn-dialog"), null, "no modal for attached souls");
  assert.equal(doc.activeElement?.dataset?.agent, "reviewer", "card focused so it explains itself");
});

test("preselectSoul with the CLI unavailable focuses the card (degradation respected)", async (t) => {
  const { doc, spawn } = await mountSpawn(t, { cliOk: false });
  spawn.preselectSoul({ name: "ux-designer" });
  assert.equal(doc.querySelector(".spawn-dialog"), null, "no modal without a verified CLI");
  assert.equal(doc.activeElement?.dataset?.agent, "ux-designer");
});

test("preselect is consumed once: a second roster paint must not reopen the modal", async (t) => {
  const { doc, spawn } = await mountSpawn(t);
  spawn.preselectSoul({ name: "ux-designer" });
  assert.ok(doc.querySelector(".spawn-dialog"));
  doc.querySelector(".fcancel").click();
  assert.equal(doc.querySelector(".spawn-dialog"), null);
  // a later roster paint (poll) must not resurrect the consumed preselect
  await tick(); await tick();
  assert.equal(doc.querySelector(".spawn-dialog"), null, "modal stays closed");
});

test("preselectSoul for a soul not in this workspace's roster is a silent no-op", async (t) => {
  const { doc, spawn } = await mountSpawn(t);
  spawn.preselectSoul({ name: "not-here" });
  assert.equal(doc.querySelector(".spawn-dialog"), null);
});
