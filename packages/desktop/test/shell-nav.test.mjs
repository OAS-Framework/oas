// Shell navigation reachability + Instances-stage ABSENCE pins.
//
// History: PR #29 shipped a first-class "Instances" nav stage
// (views/instances.mjs). The human rejected that surface as scope overreach
// — the instances context is the shell's PERMANENT sidebar roster, not a
// rail destination. This suite pins both directions:
//   - every remaining NAV entry resolves to a real mount-exporting module
//     (the manifest lesson from the original reachability regression), and
//   - the Instances stage stays gone (inventory-style absence pin, so a
//     stray revert/cherry-pick cannot silently reship it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NAV, stageSidebarMode, loadStageView } from "../renderer/shell-nav.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

test("NAV is exactly the two pre-#29 destinations — no Instances stage", () => {
  assert.deepEqual(NAV.map((v) => v.name), ["hierarchy", "spawn"],
    "rail destinations are Active overview and Soul roster only");
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
  assert.equal(stageSidebarMode("hierarchy"), "overview");
  assert.equal(stageSidebarMode(undefined), "overview", "no-stage fallback stays overview");
});

test("shell.mjs consumes the manifest: rail built from shell-nav NAV, openView routes to showStage", () => {
  const src = readFileSync(join(PKG, "renderer", "shell.mjs"), "utf8");
  assert.match(src, /import\s*\{[^}]*\bNAV\b[^}]*\}\s*from\s*"\.\/shell-nav\.mjs"/,
    "shell imports NAV from shell-nav.mjs");
  assert.ok(!/const NAV\s*=/.test(src), "no shadowing local NAV manifest");
  assert.match(src, /openView:\s*\(name\)\s*=>\s*showStage\(name\)/,
    "openView routes every named view through the stage host");
});

test("palette view commands derive from NAV — no hard-coded destination list to drift", () => {
  const src = readFileSync(join(PKG, "renderer", "shell.mjs"), "utf8");
  assert.match(src, /NAV\.map\(\(v\) => \(\{ label: `View: \$\{v\.label\}`,.*run: \(\) => showStage\(v\.name\) \}\)\)/,
    "palette view commands are generated from the nav manifest");
  assert.ok(!/label:\s*"View: /.test(src), "no hard-coded View: palette entries remain");
});

test("inventory: the Instances stage view is gone and nothing references it", () => {
  assert.ok(!existsSync(join(PKG, "renderer", "views", "instances.mjs")),
    "views/instances.mjs must not ship");
  for (const f of ["renderer/shell.mjs", "renderer/shell-nav.mjs", "renderer/harness.html"]) {
    const src = readFileSync(join(PKG, f), "utf8");
    assert.ok(!/views\/instances\.mjs/.test(src), `${f}: imports the deleted Instances view`);
    assert.ok(!/data-view="instances"/.test(src), `${f}: dormant Instances tab entry`);
  }
});
