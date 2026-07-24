// Artifact inventory — dormant-surface absence proof (desktop-dist contract).
//
// Desktop 0.18 deletes the dormant Diff and Jira surfaces entirely: modules,
// routes, helpers, tests, styles, imports, and harness entries. This suite
// pins the ABSENCE so a stray revert or cherry-pick cannot silently reship
// them. Markdown's /api/file stays (contract keeps it), and the framework's
// separate oas.jira capability is out of scope here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(PKG, p), "utf8");

test("inventory: dormant view modules are gone", () => {
  assert.ok(!existsSync(join(PKG, "renderer", "views", "diff.mjs")), "diff.mjs must not ship");
  assert.ok(!existsSync(join(PKG, "renderer", "views", "jira.mjs")), "jira.mjs must not ship");
});

test("inventory: server exposes no /api/diff or /api/jira route or helpers", () => {
  const src = read("server/oas-web.mjs");
  assert.ok(!/api\/diff|api\/jira/i.test(src), "no diff/jira API routes");
  assert.ok(!/\bjiraPanel\b|\bacliJson\b|\bparseRoster\b/.test(src), "no jira helpers");
  assert.ok(!/\bdiffData\b|\bparseDiffStats\b|\bsynthUntracked\b/.test(src), "no diff helpers");
  // the instance-addressed route family must not match diff/jira
  const fam = src.match(/\/api\\\/\(([a-z|]+)\)/);
  assert.ok(fam, "instance route family present");
  assert.ok(!fam[1].split("|").includes("diff") && !fam[1].split("|").includes("jira"),
    `route family must exclude diff/jira (got ${fam[1]})`);
  // /api/file (markdown) is contractually kept
  assert.ok(src.includes("/api/file"), "/api/file stays for Markdown");
});

test("inventory: renderer ships no diff/jira imports, tabs, or styles", () => {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(join(PKG, d), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "vendor") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|cjs|html|css)$/.test(e.name)) files.push(p);
    }
  };
  walk("renderer");
  files.push("api-url.mjs", "preload.cjs", "main.mjs", "server-compat.mjs");
  for (const f of files) {
    const src = read(f);
    assert.ok(!/views\/(diff|jira)\.mjs/.test(src), `${f}: imports a deleted view`);
    assert.ok(!/data-view="(diff|jira)"/.test(src), `${f}: dormant tab entry`);
    assert.ok(!/\/api\/(diff|jira)\b/.test(src), `${f}: references a deleted API route`);
    assert.ok(!/\.jkey\b|table\.jt\b/.test(src), `${f}: dormant jira styles`);
  }
});
