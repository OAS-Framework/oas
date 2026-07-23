/* oas desktop — theme runtime.
   theme.css defines the semantic tokens (incl. the --ansi-* terminal set);
   this module owns switching (OS-follow by default, manual override
   persisted under the SAME key as the web panel so the two products feel
   like one) and derives the xterm.js theme object from the live tokens. */

const KEY = "oasweb.theme"; // shared with capabilities/oas-web panel

const listeners = new Set();

export function currentTheme() {
  return document.documentElement.dataset.theme || "dark";
}

export function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  for (const fn of [...listeners]) { try { fn(name); } catch { /* one listener must not break others */ } }
}

export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* storage-less */ }
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  applyTheme(saved || (mq.matches ? "dark" : "light"));
  // OS-follow only while the user hasn't chosen explicitly
  mq.addEventListener("change", (e) => {
    let stored = null;
    try { stored = localStorage.getItem(KEY); } catch { /* storage-less */ }
    if (!stored) applyTheme(e.matches ? "dark" : "light");
  });
}

export function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  try { localStorage.setItem(KEY, next); } catch { /* storage-less */ }
  applyTheme(next);
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* Build the xterm.js theme object from the live CSS tokens so the embedded
   terminal always matches the app theme (incl. the solarized light remap). */
const ANSI = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "bright-black", "bright-red", "bright-green", "bright-yellow",
  "bright-blue", "bright-magenta", "bright-cyan", "bright-white",
];
export function xtermTheme(el = document.documentElement) {
  const css = getComputedStyle(el);
  const v = (name, fallback) => (css.getPropertyValue(name) || "").trim() || fallback;
  const t = {
    background: v("--term-bg", "#0a0d12"),
    foreground: v("--term-fg", "#e6edf3"),
    cursor: v("--term-fg", "#e6edf3"),
    cursorAccent: v("--term-bg", "#0a0d12"),
    selectionBackground: v("--term-sel", "#264f78"),
  };
  const camel = (s) => s.replace(/-(\w)/g, (m, c) => c.toUpperCase());
  for (const name of ANSI) {
    const val = v(`--ansi-${name}`, null);
    if (val) t[camel(name)] = val;
  }
  return t;
}
