#!/usr/bin/env node
import Ajv2020 from "ajv/dist/2020.js";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYamlNested } from "../lib/core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const fail = (message) => failures.push(message);
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

function walk(dir, accept = () => true) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path, accept));
    else if (entry.isFile() && accept(path)) files.push(path);
  }
  return files;
}

// Schemas + current clean-contract artifacts.
const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
const manifestSchemaPath = join(root, "docs", "capability-manifest.schema.json");
const configSchemaPath = join(root, "docs", "oas-config.schema.json");
const manifestSchema = json(manifestSchemaPath);
const configSchema = json(configSchemaPath);
for (const [path, schema] of [[manifestSchemaPath, manifestSchema], [configSchemaPath, configSchema]]) {
  if (!ajv.validateSchema(schema)) fail(`${relative(root, path)} is not a valid JSON Schema: ${ajv.errorsText()}`);
}
const validateManifest = ajv.compile(manifestSchema);
const validateConfig = ajv.compile(configSchema);
let manifests = 0;
for (const path of walk(join(root, "capabilities"), (p) => basename(p) === "oas.json")) {
  manifests++;
  if (!validateManifest(json(path))) fail(`${relative(root, path)}: ${ajv.errorsText(validateManifest.errors)}`);
}
const repoConfig = parseYamlNested(readFileSync(join(root, "oas-config.yaml"), "utf8"));
if (!validateConfig(repoConfig)) fail(`oas-config.yaml: ${ajv.errorsText(validateConfig.errors)}`);

// Public Markdown set: local links/anchors and OAS-config YAML examples.
const markdown = [join(root, "README.md"), ...walk(join(root, "docs"), (p) => extname(p) === ".md")];
for (const dir of walk(join(root, "capabilities"), (p) => basename(p) === "README.md")) markdown.push(dir);
markdown.push(join(root, "packages", "pi", "README.md"));
const publicMarkdown = [...new Set(markdown.filter(existsSync))].sort();
const exampleMarkdown = [...new Set([
  ...publicMarkdown,
  ...walk(join(root, "skills"), (p) => basename(p) === "SKILL.md"),
  ...walk(join(root, "capabilities"), (p) => basename(p) === "SKILL.md"),
].filter(existsSync))].sort();

function slugHeadings(text) {
  const counts = new Map();
  const slugs = new Set();
  for (const line of text.split("\n")) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    let slug = match[1].toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/[`*_~]/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim().replace(/\s+/g, "-");
    const count = counts.get(slug) || 0;
    counts.set(slug, count + 1);
    if (count) slug += `-${count}`;
    slugs.add(slug);
  }
  return slugs;
}
const headingCache = new Map();
function headings(path) {
  if (!headingCache.has(path)) headingCache.set(path, slugHeadings(readFileSync(path, "utf8")));
  return headingCache.get(path);
}

let links = 0;
let examples = 0;
for (const file of publicMarkdown) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let href = match[1].trim().replace(/^<|>$/g, "");
    if (!href || /^(?:https?:|mailto:|#)/.test(href)) {
      if (href.startsWith("#") && !headings(file).has(decodeURIComponent(href.slice(1)))) fail(`${relative(root, file)}: missing anchor ${href}`);
      continue;
    }
    links++;
    const [rawPath, rawAnchor] = href.split("#", 2);
    const target = resolve(dirname(file), decodeURIComponent(rawPath));
    if (!existsSync(target)) { fail(`${relative(root, file)}: broken link ${href}`); continue; }
    if (rawAnchor && lstatSync(target).isFile() && extname(target) === ".md" && !headings(target).has(decodeURIComponent(rawAnchor))) {
      fail(`${relative(root, file)}: missing anchor ${href}`);
    }
  }
}
for (const file of exampleMarkdown) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/```ya?ml\s*\n([\s\S]*?)```/g)) {
    const block = match[1];
    if (!/^(?:\s*)(?:capabilities|groups|layers|skill-overrides|agents-md-injection|oas|work-modes):/m.test(block)) continue;
    examples++;
    const parsed = parseYamlNested(block);
    if (!validateConfig(parsed)) fail(`${relative(root, file)} YAML example #${examples}: ${ajv.errorsText(validateConfig.errors)}`);
  }
}

if (failures.length) {
  console.error(`Project validation failed (${failures.length}):\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`Project validation passed: 2 schemas, ${manifests} clean-contract manifests, ${examples} config examples, ${links} local links across ${publicMarkdown.length} public Markdown files.`);
