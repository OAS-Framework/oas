import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CAP = join(ROOT, "capabilities", "oas-web");

// ---- ANSI renderer (extracted from the panel's marked DOM-free block) ----

function loadRenderer() {
  const html = readFileSync(join(CAP, "ui", "panel.html"), "utf8");
  const m = html.match(/\/\* OASWEB_RENDERER_BEGIN \*\/([\s\S]*?)\/\* OASWEB_RENDERER_END \*\//);
  assert.ok(m, "renderer block markers present in panel.html");
  const src = m[1] + "\nreturn { renderCapture, renderLine, freshAttr, cellWidth, clusterWidth };";
  const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return new Function("escapeHtml", src)(escapeHtml);
}
const R = loadRenderer();

test("oas-web renderer: each capture line is one row; history maps the screen start", () => {
  const d = { text: "h1\nh2\nscreen1\nscreen2\n", history: 2, size: { rows: 5, cols: 20, cx: 0, cy: 0, cursor: false } };
  const html = R.renderCapture(d);
  assert.equal((html.match(/class="trow"/g) || []).length, 4);
  // scroll marker sits between history and screen
  assert.ok(html.indexOf("h2") < html.indexOf("scrollmark"));
  assert.ok(html.indexOf("scrollmark") < html.indexOf("screen1"));
});

test("oas-web renderer: cursor lands at cursor_y within the screen even when tmux trims blank lines", () => {
  // 3 history rows + only 2 screen rows captured (trailing blanks trimmed); cursor at row 1, col 2
  const d = { text: "a\nb\nc\nprompt\n> hi\n", history: 3, size: { rows: 50, cols: 20, cx: 2, cy: 1, cursor: true } };
  const html = R.renderCapture(d);
  const rows = html.split('class="trow"');
  assert.ok(!rows[4].includes('class="cur"'), "no cursor on the first screen row");
  assert.ok(rows[5].includes('<span class="cur">h</span>'), "cursor on 'h' of '> hi'");
});

test("oas-web renderer: SGR colors, colon-form 256-color, and escaping", () => {
  const attr = R.freshAttr();
  const html = R.renderLine("\x1b[31mred\x1b[0m \x1b[38:5:196mX\x1b[m <&>", attr, null);
  assert.ok(html.includes('class="a31">red<'));
  assert.ok(/style="color:[^"]+">X</.test(html), "colon-form 38:5:196 renders a colored span");
  assert.ok(html.includes("&lt;&amp;&gt;"), "HTML escaped");
  assert.ok(!html.includes("\x1b"), "no raw escapes leak");
});

test("oas-web renderer: cursor column counts terminal cells (CJK wide, combining)", () => {
  assert.equal(R.cellWidth("漢".codePointAt(0)), 2);
  assert.equal(R.cellWidth(0x0301), 0); // combining acute
  // "漢字ab": cursor_x=4 is 'a' (two wide chars occupy cells 0-3)
  const html = R.renderLine("漢字ab", R.freshAttr(), 4);
  assert.ok(html.includes('<span class="cur">a</span>'));
  // combining char stays attached, cursor at col 1 of "e\u0301x" is 'x'
  const html2 = R.renderLine("e\u0301x", R.freshAttr(), 1);
  assert.ok(html2.includes('<span class="cur">x</span>'));
});

test("oas-web renderer: grapheme clusters — ZWJ emoji, VS16, keycaps, flags, kana voicing marks", () => {
  // tmux counts the whole ZWJ family emoji as one 2-cell cluster
  assert.equal(R.clusterWidth("👨\u200D👩\u200D👧\u200D👦"), 2);
  assert.equal(R.clusterWidth("❤\uFE0F"), 2);      // VS16 emoji presentation
  assert.equal(R.clusterWidth("1\uFE0F\u20E3"), 2); // keycap
  assert.equal(R.clusterWidth("🇪🇸"), 2);           // regional-indicator pair
  assert.equal(R.clusterWidth("は\u3099"), 2);      // kana + combining voicing mark (U+3099 is a Mark, not wide)
  assert.equal(R.clusterWidth("क\u094dष"), 2);      // Devanagari क्ष: two spacing bases + virama — widths sum
  assert.equal(R.clusterWidth("👍🏽"), 2);          // emoji + skin-tone modifier collapses to one 2-cell cluster
  // cursor after the family emoji (cursor_x=2) lands on X
  const h1 = R.renderLine("👨\u200D👩\u200D👧\u200D👦X", R.freshAttr(), 2);
  assert.ok(h1.includes('<span class="cur">X</span>'), "ZWJ emoji is one 2-cell cluster");
  // cursor after ば (cursor_x=2) lands on X
  const h2 = R.renderLine("は\u3099X", R.freshAttr(), 2);
  assert.ok(h2.includes('<span class="cur">X</span>'), "voiced kana cluster is 2 cells");
  // cursor after क्ष (cursor_x=2) lands on X — multi-base cluster widths sum
  const h3 = R.renderLine("क\u094dषX", R.freshAttr(), 2);
  assert.ok(h3.includes('<span class="cur">X</span>'), "multi-base Devanagari cluster is 2 cells");
  // cursor after 👍🏽 (cursor_x=2) lands on X — modifier does not add cells
  const h4 = R.renderLine("👍🏽X", R.freshAttr(), 2);
  assert.ok(h4.includes('<span class="cur">X</span>'), "skin-tone emoji cluster is 2 cells");
});

// ---- HTTP origin guard regression (server must not crash on Origin: null) ----

test("oas-web server: POST origin guard rejects hostile/null origins without crashing", async () => {
  const port = 4000 + Math.floor(Math.random() * 2000);
  const proc = spawn(process.execPath, [join(CAP, "bin", "oas-web.mjs"), "start", "--port", String(port), "--dir", ROOT], { stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { await fetch(`http://127.0.0.1:${port}/api/panel`); up = true; } catch { /* retry */ }
    }
    assert.ok(up, "server came up");
    const post = (headers) => fetch(`http://127.0.0.1:${port}/api/keys/x`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: '{"data":"x"}' });
    assert.equal((await post({ origin: "null" })).status, 403, "Origin: null is rejected, not a crash");
    assert.equal((await post({ origin: "http://evil.com" })).status, 403);
    // fetch can't override Host — use a raw request for the rebinding case
    const hostStatus = await new Promise((resolve, reject) => {
      const rq = httpRequest({ host: "127.0.0.1", port, path: "/api/keys/x", method: "POST",
        headers: { "content-type": "application/json", host: "evil.com" } }, (rs) => resolve(rs.statusCode));
      rq.on("error", reject); rq.end('{"data":"x"}');
    });
    assert.equal(hostStatus, 403, "non-loopback Host is rejected");
    const ok = await post({ origin: `http://127.0.0.1:${port}` });
    assert.equal(ok.status, 404, "loopback origin passes the guard (unknown instance)");
    // server survived the malformed origin
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/panel`)).status, 200);
  } finally { proc.kill(); }
});
