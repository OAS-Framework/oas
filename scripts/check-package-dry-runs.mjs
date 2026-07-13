#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function dryRun(cwd) {
  return JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0];
}
function requireFiles(pack, required) {
  const files = new Set(pack.files.map((file) => file.path));
  for (const path of required) if (!files.has(path)) throw new Error(`${pack.name} dry run missing ${path}`);
  return files;
}
const kernel = dryRun(root);
const kernelFiles = requireFiles(kernel, [
  "bin/oas.mjs", "lib/core.mjs", "lib/tmux-config.mjs", "capabilities/oas-okf/oas.json",
  "capabilities/oas-authoring/oas.json", "docs/capabilities.md", "docs/capability-manifest.schema.json", "package.json",
]);
for (const path of kernelFiles) if (path.startsWith("agents/") || path === "oas-config.yaml" || path.startsWith("test/") || path.startsWith("tests/")) throw new Error(`kernel tarball leaks non-runtime file ${path}`);
const adapter = dryRun(resolve(root, "packages", "pi"));
requireFiles(adapter, ["extension/index.ts", "extension/core-loader.mjs", "README.md", "package.json"]);
console.log(`Package dry runs passed: kernel ${kernel.entryCount} files, pi adapter ${adapter.entryCount} files; required surfaces present and workspace/test state excluded.`);
