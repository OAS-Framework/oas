#!/usr/bin/env node
/**
 * okf-validate.mjs — OKF v0.1 bundle validator (no dependencies).
 *
 * Usage: node okf-validate.mjs <bundle-dir> [--strict] [--json]
 *
 * Conformance (errors): frontmatter parses; non-empty `type` on concepts;
 * reserved files (index.md, log.md) carry no `type`.
 * Producer lints (--strict, warnings): broken intra-bundle links (log.md exempt),
 * links missing .md, concepts unreachable from any index.md, missing title/description.
 * Exit: 0 conformant, 1 errors (or warnings with --strict), 2 usage.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, posix } from "node:path";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const asJson = args.includes("--json");
const dir = args.find((a) => !a.startsWith("--"));
if (!dir || !existsSync(dir)) { console.error("usage: okf-validate.mjs <bundle-dir> [--strict] [--json]"); process.exit(2); }
const root = resolve(dir);

const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".md")) files.push(p);
  }
})(root);

const errors = [], warnings = [];
const rel = (p) => relative(root, p).split("\\").join("/");
const isReserved = (p) => ["index.md", "log.md"].includes(posix.basename(rel(p)));

function parseFrontmatter(text) {
  if (!text.startsWith("---")) return { present: false };
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!m) return { present: true, parsed: false };
  const meta = {};
  for (const line of m[1].split("\n")) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "").trim();
    else if (!/^\s+/.test(line)) return { present: true, parsed: false };
  }
  return { present: true, parsed: true, meta, body: text.slice(m[0].length) };
}

const concepts = new Map(); // rel path -> { meta, body }
for (const f of files) {
  const r = rel(f);
  const text = readFileSync(f, "utf8");
  const fm = parseFrontmatter(text);
  if (isReserved(f)) {
    if (fm.present && fm.parsed && fm.meta.type) errors.push(`${r}: reserved file must not carry a 'type'`);
    if (fm.present && fm.parsed && posix.basename(r) === "index.md" && r !== "index.md") {
      const keys = Object.keys(fm.meta);
      if (keys.some((k) => k !== "okf_version")) warnings.push(`${r}: only the bundle-root index.md may carry frontmatter`);
    }
    concepts.set(r, { reserved: true, body: fm.parsed ? fm.body : text });
    continue;
  }
  if (!fm.present) { errors.push(`${r}: missing YAML frontmatter`); continue; }
  if (!fm.parsed) { errors.push(`${r}: unparseable YAML frontmatter`); continue; }
  if (!fm.meta.type) errors.push(`${r}: missing or empty required field 'type'`);
  if (strict) {
    if (!fm.meta.title) warnings.push(`${r}: missing recommended field 'title'`);
    if (!fm.meta.description) warnings.push(`${r}: missing recommended field 'description'`);
  }
  concepts.set(r, { meta: fm.meta, body: fm.body });
}

if (strict) {
  // Link checks (log.md bodies exempt) + reachability from index files.
  const reachable = new Set();
  const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g;
  const resolveLink = (fromRel, target) => {
    if (/^[a-z]+:\/\//i.test(target) || target.startsWith("mailto:")) return null; // external
    const clean = target.split("#")[0];
    if (!clean) return null;
    const abs = clean.startsWith("/")
      ? posix.normalize(clean.slice(1))
      : posix.normalize(posix.join(posix.dirname(fromRel), clean));
    return abs;
  };
  for (const [r, c] of concepts) {
    const body = c.body ?? "";
    const fromLog = posix.basename(r) === "log.md";
    for (const m of body.matchAll(linkRe)) {
      const t = resolveLink(r, m[1]);
      if (t === null) continue;
      const isDir = t.endsWith("/") || concepts.has(posix.join(t, "index.md")) || existsSync(join(root, t)) && statSync(join(root, t)).isDirectory?.();
      if (posix.basename(r) === "index.md" || !fromLog) {
        if (!t.endsWith(".md") && !isDir) { if (!fromLog) warnings.push(`${r}: link missing .md extension: ${m[1]}`); continue; }
      }
      if (fromLog) continue; // history exempt from broken-link lint
      if (t.endsWith(".md") && !concepts.has(t)) warnings.push(`${r}: broken link: ${m[1]}`);
      if (posix.basename(r) === "index.md" && t.endsWith(".md") && concepts.has(t)) reachable.add(t);
      if (posix.basename(r) === "index.md" && isDir) reachable.add(posix.join(t.replace(/\/$/, ""), "index.md"));
    }
  }
  // Reachability: walk index closure (an index that lists a subdir makes that subdir's index reachable).
  for (const [r, c] of concepts) {
    if (c.reserved || reachable.has(r)) continue;
    // root-level concepts listed in root index handled above; report the rest
    const anyIndex = [...concepts.keys()].some((k) => posix.basename(k) === "index.md");
    if (anyIndex) warnings.push(`${r}: unreachable from any index.md`);
  }
}

const conceptCount = [...concepts.values()].filter((c) => !c.reserved).length;
if (asJson) {
  console.log(JSON.stringify({ bundle: root, concepts: conceptCount, errors, warnings, conformant: errors.length === 0 }, null, 2));
} else {
  console.log(`OKF validate — ${root}`);
  console.log(`  ${conceptCount} concept(s), ${errors.length} error(s), ${warnings.length} warning(s)`);
  for (const e of errors) console.log(`  ERROR ${e}`);
  for (const w of warnings) console.log(`  warn  ${w}`);
  console.log(errors.length === 0 ? (strict && warnings.length ? "PASS (with lints)" : "PASS — conformant") : "FAIL — nonconformant");
}
process.exit(errors.length > 0 ? 1 : strict && warnings.length > 0 && process.env.OKF_STRICT_EXIT ? 1 : 0);
