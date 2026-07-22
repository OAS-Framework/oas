import { test } from "node:test";
import assert from "node:assert/strict";

// Importing the view modules also proves they resolve/parse as ESM with the
// package's real deps (marked, highlight.js) — what Electron's bundler sees.
const md = await import("../renderer/views/markdown.js");
const dv = await import("../renderer/views/diff.js");

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
