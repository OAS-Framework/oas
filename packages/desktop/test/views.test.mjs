import { test } from "node:test";
import assert from "node:assert/strict";

// Importing the view modules also proves they resolve/parse as ESM with the
// package's real deps (marked, highlight.js) — what Electron's bundler sees.
const md = await import("../renderer/views/markdown.mjs");
const dv = await import("../renderer/views/diff.mjs");

test("views export the contract surface", () => {
  for (const m of [md, dv]) {
    assert.equal(typeof m.mount, "function");
    assert.equal(typeof m.unmount, "function");
  }
});

test("markdown: relative links resolve against the open file's directory", () => {
  assert.equal(md.resolveRelative("/a/b/README.md", "docs/x.md"), "/a/b/docs/x.md");
  assert.equal(md.resolveRelative("/a/b/README.md", "../x.md"), "/a/x.md");
  assert.equal(md.resolveRelative("/a/b/README.md", "./x.md"), "/a/b/x.md");
});

test("markdown: highlight falls back safely and escapes", () => {
  assert.ok(md.highlight("const x = 1;", "javascript").includes("hljs-"));
  assert.ok(!md.escapeHtml("<script>").includes("<script>"));
});

test("diff: parseUnifiedDiff extracts files, hunks and line numbers", () => {
  const diff = [
    "diff --git a/foo.js b/foo.js",
    "index 111..222 100644",
    "--- a/foo.js",
    "+++ b/foo.js",
    "@@ -1,3 +1,4 @@ ctx",
    " keep",
    "-old line",
    "+new line",
    "+added line",
    " tail",
  ].join("\n");
  const files = dv.parseUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "foo.js");
  const lines = files[0].hunks[0].lines;
  assert.deepEqual(lines.map((l) => l.kind), [" ", "-", "+", "+", " "]);
  assert.equal(lines[0].oldNo, 1); assert.equal(lines[0].newNo, 1);
  assert.equal(lines[1].oldNo, 2); assert.equal(lines[1].newNo, null);
  assert.equal(lines[2].newNo, 2);
  assert.equal(lines[4].oldNo, 3); assert.equal(lines[4].newNo, 4);
});

test("diff: pairForSideBySide aligns delete/add runs row-by-row", () => {
  const lines = [
    { kind: " ", text: "a" },
    { kind: "-", text: "b1" }, { kind: "-", text: "b2" },
    { kind: "+", text: "c1" },
    { kind: " ", text: "d" },
  ];
  const rows = dv.pairForSideBySide(lines);
  assert.equal(rows.length, 4);
  assert.equal(rows[1].left.text, "b1"); assert.equal(rows[1].right.text, "c1");
  assert.equal(rows[2].left.text, "b2"); assert.equal(rows[2].right, null);
});

test("markdown: active link schemes are rejected, safe ones allowed", () => {
  assert.equal(md.externalHref("javascript:alert(1)"), null);
  assert.equal(md.externalHref("data:text/html,x"), null);
  assert.equal(md.externalHref("vbscript:x"), null);
  assert.equal(md.externalHref("https://example.com"), "https://example.com");
  assert.equal(md.externalHref("mailto:a@b.c"), "mailto:a@b.c");
});

test("diff: newline-terminated diff does not fabricate a trailing context line", () => {
  const diff = [
    "diff --git a/f b/f",
    "@@ -1,1 +1,1 @@",
    "-a",
    "+b",
    "", // split artifact of the trailing newline
  ].join("\n");
  const lines = dv.parseUnifiedDiff(diff)[0].hunks[0].lines;
  assert.deepEqual(lines.map((l) => l.kind), ["-", "+"], "no fabricated context row");
});

test("diff: context rows keep distinct old/new numbers when offsets differ", () => {
  const diff = [
    "diff --git a/f b/f",
    "@@ -10,2 +20,2 @@",
    " ctx",
    "+add",
  ].join("\n");
  const lines = dv.parseUnifiedDiff(diff)[0].hunks[0].lines;
  assert.equal(lines[0].oldNo, 10);
  assert.equal(lines[0].newNo, 20, "right side of a context row must use newNo");
});

test("markdown: sanitizeHtml strips scripts/handlers and normalizes every anchor", async () => {
  const { JSDOM } = await import("jsdom");
  const doc = new JSDOM("<!doctype html><body>").window.document;
  const dirty = [
    `<script>bad()</script>`,
    `<img src=x onerror="bad()">`,
    `<a href="https://evil.example" target="_self" rel="opener">nav</a>`,
    `<a href="javascript:bad()">js</a>`,
    `<a href="relative.md">raw-rel</a>`,
    `<a href="#" data-open-file="/ws/x.md" target="_top">open</a>`,
    `<p onclick="bad()">text</p>`,
  ].join("");
  const out = md.sanitizeHtml(dirty, doc);
  assert.ok(!/script>|onerror|onclick|javascript:/i.test(out), "active content removed");
  const div = doc.createElement("div"); div.innerHTML = out;
  for (const a of div.querySelectorAll("a")) {
    if (a.hasAttribute("data-open-file")) {
      assert.equal(a.getAttribute("href"), "#");
      assert.equal(a.getAttribute("target"), null, "file links carry no target");
    } else {
      assert.equal(a.getAttribute("target"), "_blank", "external anchors forced to _blank");
      assert.equal(a.getAttribute("rel"), "noreferrer noopener", "rel re-forced");
      assert.ok(/^https:/.test(a.getAttribute("href")), "only allowlisted schemes survive");
    }
  }
  assert.ok(div.textContent.includes("js") && !out.includes('href="javascript:'), "js: anchor neutralized to text");
  assert.ok(div.textContent.includes("raw-rel"), "raw relative anchor neutralized to text");
  // plain fragment links stay local — never rewritten to target=_blank
  const frag = doc.createElement("div");
  frag.innerHTML = md.sanitizeHtml('<a href="#section">frag</a>', doc);
  const fa = frag.querySelector("a");
  assert.ok(fa, "fragment anchor survives");
  assert.equal(fa.getAttribute("target"), null, "fragment link is not externalized");
});
