// Desktop renderer views — integration-boundary regressions (no DOM needed).
// Guards the seams the harness masks: module naming the shell imports, the
// theme.css fallback URL, the ctx.api dual-shape seam, and the harness
// proxy's origin guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RENDERER = join(ROOT, "packages", "desktop", "renderer");

test("views ship as .mjs with mount/unmount (shell imports ./views/<name>.mjs)", () => {
  for (const name of ["instances", "spawn", "jira"]) {
    const f = join(RENDERER, "views", `${name}.mjs`);
    assert.ok(existsSync(f), `${name}.mjs missing`);
    const src = readFileSync(f, "utf8");
    assert.match(src, /export function mount\(/, `${name}: no mount export`);
    assert.match(src, /export function unmount\(/, `${name}: no unmount export`);
    assert.match(src, /from "\.\/common\.mjs"/, `${name}: must import common.mjs`);
  }
});

test("theme fallback URL resolves from views/ to renderer/theme.css", () => {
  const src = readFileSync(join(RENDERER, "views", "common.mjs"), "utf8");
  const m = src.match(/new URL\("([^"]+)", import\.meta\.url\)/);
  assert.ok(m, "ensureTheme must resolve theme.css via import.meta.url");
  const resolved = join(RENDERER, "views", m[1]);
  assert.ok(existsSync(resolved), `theme URL "${m[1]}" resolves to a missing file: ${resolved}`);
});

test("apiJson accepts both a Fetch Response and shell-parsed JSON", async () => {
  const { apiJson } = await import(new URL("../packages/desktop/renderer/views/common.mjs", import.meta.url).href);
  // Response-shaped (harness): ok → parsed body; !ok → throws server error.
  const asResponse = (ok, status, body) => ({ ok, status, json: async () => body });
  assert.deepEqual(await apiJson({ api: async () => asResponse(true, 200, { a: 1 }) }, "/api/panel"), { a: 1 });
  await assert.rejects(apiJson({ api: async () => asResponse(false, 409, { error: "nope" }) }, "/api/spawn"), /nope/);
  // Shell-shaped: ctx.api resolves already-parsed data (and throws itself on non-2xx).
  assert.deepEqual(await apiJson({ api: async () => ({ agents: [] }) }, "/api/agents"), { agents: [] });
});

test("harness proxy validates incoming Host/Origin before forwarding", () => {
  const src = readFileSync(join(RENDERER, "harness-server.mjs"), "utf8");
  assert.match(src, /okHost\(host\)/, "must validate the incoming Host header");
  assert.match(src, /req\.headers\.origin/, "must validate the incoming Origin header");
  assert.doesNotMatch(src, /origin:\s*`http/, "must never forge a trusted Origin upstream");
});
