#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = join(root, "capabilities", "oas-okf", "skills", "okf", "scripts", "okf-validate.mjs");
const agents = join(root, "agents");
let count = 0;
for (const entry of readdirSync(agents, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  const bundle = join(agents, entry.name, "soul", "knowledge");
  if (!entry.isDirectory() || !existsSync(join(bundle, "index.md"))) continue;
  execFileSync(process.execPath, [validator, bundle, "--strict"], { stdio: "inherit" });
  count++;
}
if (!count) throw new Error("no committed soul knowledge bundles found");
console.log(`Strict OKF validation passed for ${count} committed soul knowledge bundles.`);
