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
 * everything we insert goes through DOMPurify, then EVERY surviving anchor is
 * normalized: data-open-file links become local (href="#", no target); all
 * other links must pass the external-scheme allowlist and are forced to
 * target="_blank" rel="noreferrer noopener" — raw-HTML anchors cannot keep
 * attacker-chosen target/rel (renderer navigation, tabnabbing). */
export function sanitizeHtml(html, doc) {
  const purify = typeof DOMPurify === "function" ? DOMPurify(doc.defaultView) : DOMPurify;
  const frag = purify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ADD_ATTR: ["data-open-file"],
    FORBID_TAGS: ["style", "form", "input", "button"],
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):|^#/i,
  });
  for (const a of frag.querySelectorAll("a")) {
    if (a.hasAttribute("data-open-file")) {
      a.setAttribute("href", "#");
      a.removeAttribute("target");
      a.removeAttribute("rel");
      continue;
    }
    const href = a.getAttribute("href") || "";
    // plain fragment links are local/neutral — never external, never _blank
    if (href.startsWith("#")) { a.removeAttribute("target"); a.removeAttribute("rel"); continue; }
    const safe = externalHref(href);
    if (!safe) { // unsafe/relative raw-HTML anchor: neutralize to plain text
      a.replaceWith(...a.childNodes);
      continue;
    }
    a.setAttribute("href", safe);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noreferrer noopener");
  }
  const div = doc.createElement("div");
  div.append(frag);
  return div.innerHTML;
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
.mdv-scroll { height: 100%; overflow-y: auto; background: var(--bg, #fff); color: var(--fg, #222); }
.mdv { max-width: 860px; margin: 0 auto; padding: 28px 36px 72px; font: 15px/1.7 -apple-system, "Segoe UI", sans-serif; }
.mdv h1 { font-size: 1.7em; margin: 1.2em 0 .6em; }
.mdv h2 { font-size: 1.35em; margin: 1.4em 0 .5em; }
.mdv h3 { font-size: 1.12em; margin: 1.3em 0 .4em; }
.mdv h1:first-child { margin-top: 0; }
.mdv h1, .mdv h2 { border-bottom: 1px solid var(--md-rule, #8883); padding-bottom: .3em; }
.mdv h1, .mdv h2, .mdv h3, .mdv h4 { position: relative; scroll-margin-top: 16px; }
.mdv .hanchor { position: absolute; left: -22px; top: 0; opacity: 0; color: var(--accent, #4493f8);
                text-decoration: none; font-weight: 400; }
.mdv h1:hover .hanchor, .mdv h2:hover .hanchor, .mdv h3:hover .hanchor, .mdv h4:hover .hanchor { opacity: .8; }
.mdv a { color: var(--accent, #2f6fb2); }
.mdv pre.md-code { position: relative; padding: 13px 15px; border-radius: 8px; overflow-x: auto;
                   background: var(--md-code-bg, #8881); border: 1px solid var(--md-rule, #8882); }
.mdv pre.md-code .md-copy { position: absolute; top: 6px; right: 6px; opacity: 0; border: 1px solid var(--border, #ccc);
                            background: var(--surface, #fff); color: var(--muted, #667); border-radius: 6px;
                            font: 11px -apple-system, sans-serif; padding: 3px 9px; cursor: pointer; }
.mdv pre.md-code:hover .md-copy { opacity: 1; }
.mdv pre.md-code .md-copy:hover { color: var(--fg, #222); border-color: var(--accent, #4493f8); }
.mdv code { font: 13px/1.55 "SF Mono", ui-monospace, Menlo, monospace; }
.mdv :not(pre) > code { background: var(--md-code-bg, #8881); padding: .15em .4em; border-radius: 4px; }
.mdv table { border-collapse: collapse; display: block; overflow-x: auto; }
.mdv th, .mdv td { border: 1px solid var(--md-rule, #8883); padding: 5px 12px; }
.mdv th { background: var(--md-code-bg, #8881); }
.mdv blockquote { margin: 0; padding: 2px 1em; border-left: 3px solid var(--accent, #8885); opacity: .88; }
.mdv img { max-width: 100%; border-radius: 6px; }
.mdv hr { border: none; border-top: 1px solid var(--md-rule, #8883); margin: 24px 0; }
.mdv li + li { margin-top: .18em; }
.mdv .mdv-meta { font: 12px "SF Mono", ui-monospace, monospace; color: var(--muted, #888); margin-bottom: 18px;
                 display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
.mdv .mdv-meta .crumb { word-break: break-all; }
.mdv .mdv-error { color: var(--danger, #c33); }
.mdv .mdv-loading { display: flex; align-items: center; gap: 10px; color: var(--muted, #888);
                    font: 13px -apple-system, sans-serif; padding: 48px 0; justify-content: center; }
@keyframes mdv-spin { to { transform: rotate(360deg); } }
.mdv .mdv-spinner { width: 14px; height: 14px; border: 2px solid var(--md-rule, #8883);
                    border-top-color: var(--accent, #4493f8); border-radius: 50%;
                    animation: mdv-spin .7s linear infinite; }
`;

/* Per-mount state: the shell opens several markdown tabs at once, so each
   mount owns its own nodes and returns its disposer (the view host prefers
   it). The exported unmount() disposes ALL active mounts — kept for the
   original module-contract callers (harness). */
const mounts = new Set();

export async function mount(el, ctx) {
  const doc0 = el.ownerDocument;
  const scroll = doc0.createElement("div");
  scroll.className = "mdv-scroll";
  const root = doc0.createElement("div");
  root.className = "mdv";
  scroll.append(root);
  const style = doc0.createElement("style");
  style.textContent = STYLE;
  el.append(style, scroll);

  const onClick = (e) => {
    const a = e.target.closest?.("a[data-open-file]");
    if (a) {
      e.preventDefault();
      ctx.openFile(a.getAttribute("data-open-file"));
      return;
    }
    // heading anchors + in-document fragment links scroll locally
    const frag = e.target.closest?.('a[href^="#"]');
    if (frag) {
      e.preventDefault();
      const id = decodeURIComponent(frag.getAttribute("href").slice(1));
      scroll.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start" });
      return;
    }
    const copy = e.target.closest?.(".md-copy");
    if (copy) {
      const code = copy.parentElement.querySelector("code")?.textContent || "";
      navigator.clipboard?.writeText(code).then(() => {
        copy.textContent = "copied";
        setTimeout(() => { copy.textContent = "copy"; }, 1200);
      });
    }
  };
  scroll.addEventListener("click", onClick);
  const dispose = () => {
    if (!mounts.has(dispose)) return;
    mounts.delete(dispose);
    scroll.removeEventListener("click", onClick);
    scroll.remove();
    style.remove();
  };
  mounts.add(dispose);

  const path = ctx.path;
  root.innerHTML = `<div class="mdv-loading"><span class="mdv-spinner"></span> Loading ${escapeHtml(String(path || "").split("/").pop())}…</div>`;
  let file;
  try {
    const res = await ctx.api(`/api/file?path=${encodeURIComponent(path)}`);
    file = res && res.json ? await res.json() : res; // ctx.api may return Response or parsed JSON
    if (file.error) throw new Error(file.error);
  } catch (e) {
    root.innerHTML = `<div class="mdv-error">Could not open ${escapeHtml(path || "(no path)")}: ${escapeHtml(e.message || String(e))}</div>`;
    return dispose;
  }
  if (!mounts.has(dispose)) return dispose;   // closed while the file loaded
  const kb = file.size >= 10240 ? `${(file.size / 1024).toFixed(1)} KB` : `${file.size} B`;
  const meta = `<div class="mdv-meta"><span class="crumb">${escapeHtml(file.path)}</span><span>${kb}</span></div>`;
  const doc = el.ownerDocument;
  if (file.markdown) {
    root.innerHTML = meta + sanitizeHtml(makeMarked(file.path).parse(file.content), doc);
    decorate(root, doc);
  } else {
    // plain/code file: read-only highlighted view
    const lang = EXT_LANG[(file.name.split(".").pop() || "").toLowerCase()];
    root.innerHTML = `${meta}<pre class="md-code"><code class="hljs">${highlight(file.content, lang)}</code></pre>`;
    decorate(root, doc);
  }
  return dispose;
}

/* Post-render decoration (plain DOM, after sanitize): slugged heading ids +
   hover anchors, and a copy button on every fenced block. */
function decorate(root, doc) {
  const seen = new Map();
  for (const h of root.querySelectorAll("h1, h2, h3, h4")) {
    const slugBase = h.textContent.trim().toLowerCase().replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "") || "section";
    const n = seen.get(slugBase) || 0;
    seen.set(slugBase, n + 1);
    const slug = n ? `${slugBase}-${n}` : slugBase;
    h.id = slug;
    const a = doc.createElement("a");
    a.className = "hanchor";
    a.href = `#${slug}`;
    a.textContent = "#";
    a.setAttribute("aria-label", `Link to “${h.textContent.trim()}”`);
    h.prepend(a);
  }
  for (const pre of root.querySelectorAll("pre.md-code")) {
    const b = doc.createElement("button");
    b.className = "md-copy";
    b.type = "button";
    b.textContent = "copy";
    b.setAttribute("aria-label", "Copy code block");
    pre.append(b);
  }
}

export function unmount() {
  for (const d of [...mounts]) d();
}
