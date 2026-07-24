/* oas desktop — CLI degradation state (shared, view-independent).

   The desktop-dist contract: without a compatible installed `oas` CLI, all
   reads and existing terminal access keep working, while Spawn and Harvest
   are disabled behind ONE consistent card showing the detected path/version,
   the required range, **Choose oas…**, **Retry**, a docs link, and a
   copyable `npm install -g @oas-framework/oas@0.18.0`. Never silently
   install. Missing tmux is a SEPARATE diagnosis — never conflated with CLI
   compatibility.

   This module owns the fetch/refresh/subscribe state and the card DOM so
   every mutation surface renders the SAME card; views only mount it. */
import { escapeHtml, apiJson, postJson } from "./common.mjs";

export const INSTALL_COMMAND = "npm install -g @oas-framework/oas@0.18.0";
export const DOCS_URL = "https://github.com/OAS-Framework/oas/blob/main/docs/desktop-cli-api.md";

let cli = null;              // last GET /api/cli payload (null = not yet probed)
const listeners = new Set();

export function cliStatus() { return cli; }
export function cliAvailable() { return !!cli?.ok; }
export function onCliChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of [...listeners]) { try { fn(cli); } catch { /* listener errors stay local */ } } }

/** Refresh from GET /api/cli (cheap — server-side cached probe state). */
export async function refreshCli(ctx) {
  try {
    const d = await apiJson(ctx, "/api/cli");
    // Only a real status payload counts — an older server (or a test stub)
    // answering something else must read as "unknown", never "unavailable":
    // degrading mutations on bad data would disable Spawn against a fully
    // capable backend.
    if (d && typeof d.ok === "boolean") cli = d;
  } catch { /* server unreachable — keep last state */ }
  emit();
  return cli;
}

/** POST /api/cli/reprobe — Retry and Choose-binary trigger. */
export async function reprobeCli(ctx, bin) {
  try {
    const d = await postJson(ctx, "/api/cli/reprobe", bin ? { bin } : {});
    if (d && typeof d.ok === "boolean") cli = d;
  } catch { /* keep last state */ }
  emit();
  return cli;
}

/** The one degradation card. `ctx` needs api(); optional ctx.chooseCliBinary
 * (native picker via preload) and ctx.openExternal for the docs link. */
export function cliCard(doc, ctx) {
  const el = doc.createElement("div");
  el.className = "cli-card";
  const render = () => {
    const s = cli;
    const detected = s?.tried?.find((t) => t.version) || null;
    el.innerHTML = `
      <div class="cli-head"><span class="glyph" aria-hidden="true">⚠</span> Compatible <code>oas</code> CLI required</div>
      <div class="cli-body">
        Spawn and Harvest run through the installed <code>oas</code> CLI. Reads and
        terminals keep working without it.
        <div class="cli-kv">
          <span class="k">Detected</span>
          <span class="v">${detected
            ? `${escapeHtml(detected.path)} <span class="cli-ver">(${escapeHtml(detected.version || "unknown")})</span>`
            : "no oas binary found"}</span>
          <span class="k">Required</span>
          <span class="v">${escapeHtml(s?.required?.range || ">=0.18.0 <0.19.0")} with desktop API ${escapeHtml(String(s?.required?.desktopApi ?? 1))}</span>
        </div>
        <div class="cli-install">
          <code class="cli-cmd">${escapeHtml(INSTALL_COMMAND)}</code>
          <button class="act cli-copy" title="Copy install command">Copy</button>
        </div>
      </div>
      <div class="cli-actions">
        <button class="act cli-choose">Choose oas…</button>
        <button class="act cli-retry">Retry</button>
        <a class="cli-docs" href="#" title="${escapeHtml(DOCS_URL)}">CLI setup docs</a>
        <span class="cli-status" role="status"></span>
      </div>`;
    el.querySelector(".cli-copy").addEventListener("click", async () => {
      try { await doc.defaultView.navigator.clipboard.writeText(INSTALL_COMMAND); } catch { /* clipboard denied */ }
      const st = el.querySelector(".cli-status");
      if (st) st.textContent = "Install command copied.";
    });
    el.querySelector(".cli-retry").addEventListener("click", async () => {
      const st = el.querySelector(".cli-status");
      if (st) st.textContent = "Probing…";
      await reprobeCli(ctx);
      // onCliChange re-renders; if still failing, say so explicitly
      if (!cliAvailable() && el.isConnected) {
        const st2 = el.querySelector(".cli-status");
        if (st2) st2.textContent = "Still no compatible oas CLI.";
      }
    });
    const choose = el.querySelector(".cli-choose");
    if (typeof ctx.chooseCliBinary === "function") {
      choose.addEventListener("click", async () => {
        const st = el.querySelector(".cli-status");
        const picked = await ctx.chooseCliBinary();          // native picker (privileged)
        if (!picked?.path) return;                           // cancelled
        if (st) st.textContent = "Probing chosen binary…";
        await reprobeCli(ctx, picked.path);
        if (!cliAvailable() && el.isConnected) {
          const st2 = el.querySelector(".cli-status");
          if (st2) st2.textContent = "Chosen binary is not a compatible oas CLI.";
        }
      });
    } else choose.disabled = true;
    el.querySelector(".cli-docs").addEventListener("click", (e) => {
      e.preventDefault();
      if (typeof ctx.openExternal === "function") ctx.openExternal(DOCS_URL);
      else doc.defaultView.open?.(DOCS_URL, "_blank", "noreferrer");
    });
  };
  render();
  const off = onCliChange(render);
  // dispose with the element: observe removal via the returned disposer
  return { el, dispose: off };
}
