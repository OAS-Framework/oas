// Production renderer modules must PARSE — the shell is loaded by Electron,
// not by the unit suite, so a syntax error can hide behind green tests
// (review 40cde0b blocker: shell.mjs shipped unparseable). node --check
// every .mjs under renderer/ (vendor excluded: generated bundle).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RENDERER = join(dirname(fileURLToPath(import.meta.url)), "..", "renderer");

function mjsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== "vendor") out.push(...mjsFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith(".mjs")) out.push(join(dir, entry.name));
  }
  return out;
}

test("every renderer module parses (node --check)", () => {
  const files = mjsFiles(RENDERER);
  assert.ok(files.length >= 15, `found ${files.length} renderer modules`);
  for (const f of files) {
    try {
      execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    } catch (e) {
      assert.fail(`${f} does not parse:\n${e.stderr}`);
    }
  }
});
