// Shell navigation reachability — merged-state review regression for
// feature/desktop-ux-fixes: the Instances view (repo → family grouping,
// sort controls, read-only transcript) shipped UNREACHABLE because the
// production shell's NAV had no entry for it and openView("instances")
// only focused the sidebar filter. The nav manifest now lives in
// shell-nav.mjs — the SAME objects shell.mjs renders into the rail and the
// SAME loader showStage() calls — so this suite proves every rail
// destination actually resolves to a mountable view.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NAV, stageSidebarMode, loadStageView } from "../renderer/shell-nav.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

test("NAV exposes the Instances stage alongside hierarchy and spawn", () => {
  const names = NAV.map((v) => v.name);
  assert.ok(names.includes("instances"), "Instances view must be reachable from the nav rail");
  assert.ok(names.includes("hierarchy") && names.includes("spawn"), "existing destinations kept");
  for (const v of NAV) {
    assert.ok(v.label && v.icon && v.title, `${v.name} entry carries full rail chrome`);
  }
});

test("every NAV destination loads a real mount-exporting view module", async () => {
  for (const v of NAV) {
    const mod = await loadStageView(v.name);
    assert.equal(typeof mod.mount, "function", `${v.name} view exports mount`);
    assert.equal(typeof mod.unmount, "function", `${v.name} view exports unmount`);
  }
});

test("stage sidebar pairing: spawn shows souls, others keep the overview tree", () => {
  assert.equal(stageSidebarMode("spawn"), "souls");
  assert.equal(stageSidebarMode("instances"), "overview");
  assert.equal(stageSidebarMode("hierarchy"), "overview");
  assert.equal(stageSidebarMode(undefined), "overview", "no-stage fallback stays overview");
});

test("shell.mjs consumes the manifest: rail built from shell-nav NAV, openView routes to showStage", () => {
  // The manifest test above proves the destinations are valid; this pins that
  // the production shell actually USES them (a re-inlined local NAV or a
  // filter-focus openView special case would regress reachability silently).
  const src = readFileSync(join(PKG, "renderer", "shell.mjs"), "utf8");
  assert.match(src, /import\s*\{[^}]*\bNAV\b[^}]*\}\s*from\s*"\.\/shell-nav\.mjs"/,
    "shell imports NAV from shell-nav.mjs");
  assert.ok(!/const NAV\s*=/.test(src), "no shadowing local NAV manifest");
  assert.match(src, /openView:\s*\(name\)\s*=>\s*showStage\(name\)/,
    "openView routes every named view through the stage host");
  assert.ok(!/openView[^\n]*ctx-filter/.test(src),
    'openView("instances") no longer degrades to focusing the sidebar filter');
});

test("palette view commands derive from NAV — no hard-coded destination list to drift", () => {
  const src = readFileSync(join(PKG, "renderer", "shell.mjs"), "utf8");
  assert.match(src, /NAV\.map\(\(v\) => \(\{ label: `View: \$\{v\.label\}`, run: \(\) => showStage\(v\.name\) \}\)\)/,
    "palette view commands are generated from the nav manifest");
  assert.ok(!/label:\s*"View: /.test(src), "no hard-coded View: palette entries remain");
});
