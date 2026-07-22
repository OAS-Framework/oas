/**
 * Markdown viewer — desktop-app view contract: mount(el, ctx) / unmount().
 *
 * ctx = { api(pathname, opts), openFile(path), openTerminal(instance),
 *         path: "<abs path of the file to open>" }   (path provided by the shell)
 *
 * Renders a proper reader for markdown files (headings, lists, tables, fenced
 * code with syntax highlighting, blockquotes). Relative links to other .md
 * files re-open through ctx.openFile; plain non-markdown text files render
 * read-only with syntax highlighting (same view, cheap win).
 *
 * Data source: GET /api/file?path=<abs> on the oas-web server via ctx.api.
 */
import { Marked } from "marked";
import hljs from "highlight.js";
import DOMPurify from "dompurify";

const EXT_LANG = {
  mjs: "javascript", cjs: "javascript", js: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", py: "python", rb: "ruby", sh: "bash",
  bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", json: "json",
  html: "xml", xml: "xml", css: "css", scss: "scss", go: "go", rs: "rust",
  java: "java", c: "c", h: "c", cpp: "cpp", hpp: "cpp", sql: "sql",
  toml: "ini", ini: "ini", diff: "diff", patch: "diff",
};

export function highlight(code, lang) {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    return hljs.highlightAuto(code).value;
  } catch { return escapeHtml(code); }
}
export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Resolve a relative markdown link against the open file's directory. */
export function resolveRelative(fromPath, href) {
  const base = fromPath.split("/").slice(0, -1);
  const parts = href.split("/");
  const out = [...base];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return "/" + out.filter(Boolean).join("/");
}

const SAFE_EXTERNAL = new Set(["http:", "https:", "mailto:"]);
const isExternal = (href) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
/** Active schemes (javascript:, data:, vbscript:, …) are NOT links we honor. */
export function externalHref(href) {
  try { return SAFE_EXTERNAL.has(new URL(href, "https://x.invalid").protocol) ? href : null; }
  catch { return null; }
}

/** SECURITY: repository markdown is untrusted — marked preserves raw HTML, so
 * everything we insert goes through DOMPurify. data-open-file survives via an
 * explicit attribute allowance; targets/rel are re-forced after sanitize. */
export function sanitizeHtml(html, doc) {
  const purify = typeof DOMPurify === "function" ? DOMPurify(doc.defaultView) : DOMPurify;
  return purify.sanitize(html, {
    ADD_ATTR: ["data-open-file", "target"],
    FORBID_TAGS: ["style", "form", "input", "button"],
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):|^#$/i,
  });
}

function makeMarked(filePath) {
  const marked = new Marked({
    gfm: true,
    renderer: {
      code({ text, lang }) {
        const l = (lang || "").split(/\s+/)[0];
        return `<pre class="md-code"><code class="hljs">${highlight(text, l)}</code></pre>`;
      },
      link({ href, title, tokens }) {
        const label = this.parser.parseInline(tokens);
        const t = title ? ` title="${escapeHtml(title)}"` : "";
        if (isExternal(href)) {
          const safe = externalHref(href);
          // active/unknown schemes (javascript:, data:) render as plain text
          if (!safe) return label;
          return `<a href="${escapeHtml(safe)}"${t} target="_blank" rel="noreferrer noopener">${label}</a>`;
        }
        // relative link: strip fragment, resolve against the open file's dir,
        // and route through ctx.openFile (wired via a delegated click handler)
        const clean = href.split("#")[0];
        if (!clean) return `<a href="${escapeHtml(href)}"${t}>${label}</a>`;
        const abs = clean.startsWith("/") ? clean : resolveRelative(filePath, clean);
        return `<a href="#" data-open-file="${escapeHtml(abs)}"${t}>${label}</a>`;
      },
    },
  });
  return marked;
}

const STYLE = `
.mdv { max-width: 860px; margin: 0 auto; padding: 24px 32px 64px; font: 15px/1.65 -apple-system, "Segoe UI", sans-serif; }
.mdv h1, .mdv h2 { border-bottom: 1px solid var(--md-rule, #8883); padding-bottom: .3em; }
.mdv pre.md-code { padding: 12px 14px; border-radius: 6px; overflow-x: auto; background: var(--md-code-bg, #8881); }
.mdv code { font: 13px/1.5 "SF Mono", Menlo, monospace; }
.mdv :not(pre) > code { background: var(--md-code-bg, #8881); padding: .15em .35em; border-radius: 4px; }
.mdv table { border-collapse: collapse; } .mdv th, .mdv td { border: 1px solid var(--md-rule, #8883); padding: 4px 10px; }
.mdv blockquote { margin: 0; padding: 0 1em; border-left: 3px solid var(--md-rule, #8885); opacity: .85; }
.mdv img { max-width: 100%; }
.mdv .mdv-meta { font-size: 12px; opacity: .6; margin-bottom: 16px; }
.mdv .mdv-error { color: #c33; }
`;

let mounted = null;

export async function mount(el, ctx) {
  unmount();
  const root = el.ownerDocument.createElement("div");
  root.className = "mdv";
  const style = el.ownerDocument.createElement("style");
  style.textContent = STYLE;
  el.append(style, root);

  const onClick = (e) => {
    const a = e.target.closest?.("a[data-open-file]");
    if (!a) return;
    e.preventDefault();
    ctx.openFile(a.getAttribute("data-open-file"));
  };
  root.addEventListener("click", onClick);
  mounted = { el, root, style, onClick };

  const path = ctx.path;
  root.innerHTML = `<div class="mdv-meta">Loading ${escapeHtml(path || "")}…</div>`;
  let file;
  try {
    const res = await ctx.api(`/api/file?path=${encodeURIComponent(path)}`);
    file = res && res.json ? await res.json() : res; // ctx.api may return Response or parsed JSON
    if (file.error) throw new Error(file.error);
  } catch (e) {
    root.innerHTML = `<div class="mdv-error">Could not open ${escapeHtml(path || "(no path)")}: ${escapeHtml(e.message || String(e))}</div>`;
    return;
  }
  const meta = `<div class="mdv-meta">${escapeHtml(file.path)} · ${file.size} bytes</div>`;
  const doc = el.ownerDocument;
  if (file.markdown) {
    root.innerHTML = meta + sanitizeHtml(makeMarked(file.path).parse(file.content), doc);
  } else {
    // plain/code file: read-only highlighted view
    const lang = EXT_LANG[(file.name.split(".").pop() || "").toLowerCase()];
    root.innerHTML = `${meta}<pre class="md-code"><code class="hljs">${highlight(file.content, lang)}</code></pre>`;
  }
}

export function unmount() {
  if (!mounted) return;
  mounted.root.removeEventListener("click", mounted.onClick);
  mounted.root.remove();
  mounted.style.remove();
  mounted = null;
}
