import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../renderer/theme.css", import.meta.url), "utf8");

function tokens(block) {
  return new Map([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)]
    .map((m) => [m[1], m[2].toLowerCase()]));
}

const dark = tokens(css.match(/:root, \[data-theme="dark"\] \{([\s\S]*?)\n\}/)?.[1] || "");
const light = new Map(dark);
for (const [key, value] of tokens(css.match(/\[data-theme="light"\] \{([\s\S]*?)\n\}/)?.[1] || "")) light.set(key, value);

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map((value) => parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const ansi = [
  "ansi-black", "ansi-red", "ansi-green", "ansi-yellow", "ansi-blue", "ansi-magenta", "ansi-cyan", "ansi-white",
  "ansi-bright-black", "ansi-bright-red", "ansi-bright-green", "ansi-bright-yellow",
  "ansi-bright-blue", "ansi-bright-magenta", "ansi-bright-cyan", "ansi-bright-white",
];

// Explicitly mirrors shipped foreground/background use: shell/view metadata can
// sit on any base/raised surface; status text appears in shell and transcript;
// chip and terminal colors have their dedicated surfaces; ANSI is xterm-only.
const pairs = [
  ...["fg", "muted", "faint", "accent"].flatMap((fg) => ["bg", "surface", "surface-2"].map((bg) => [fg, bg])),
  ...["ok", "warn", "danger"].flatMap((fg) => ["bg", "surface", "surface-2", "term-bg"].map((bg) => [fg, bg])),
  ["chip-fg", "chip-bg"], ["term-fg", "term-bg"],
  ...ansi.map((fg) => [fg, "term-bg"]),
];

for (const [name, palette] of [["dark", dark], ["light", light]]) {
  test(`theme contrast: ${name} text and ANSI pairings meet WCAG AA`, () => {
    for (const [fgName, bgName] of pairs) {
      const fg = palette.get(fgName), bg = palette.get(bgName);
      assert.ok(fg, `${name} defines --${fgName}`);
      assert.ok(bg, `${name} defines --${bgName}`);
      const ratio = contrast(fg, bg);
      assert.ok(ratio >= 4.5,
        `${name} --${fgName} ${fg} on --${bgName} ${bg}: ${ratio.toFixed(2)}:1 < 4.5:1`);
    }
  });
}
