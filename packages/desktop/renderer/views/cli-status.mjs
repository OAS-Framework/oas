/* oas desktop — CLI degradation state (shared, view-independent).

   The desktop-dist contract: without a compatible installed `oas` CLI, all
   reads and existing terminal access keep working, while Spawn and Harvest
   are disabled behind ONE consistent card showing the detected path/version,
   the required range, **Choose oas…**, **Retry**, a docs link, and a
   copyable install command. Never silently install. Missing tmux is a
   SEPARATE diagnosis — never conflated with CLI compatibility.

   The requirement and the install command are the BACKEND's to state, not
   this module's: /api/cli carries `required.range`, `required.desktopApi`
   and `install`, all derived from the locator's enforced band and this
   app's own version. Nothing here restates a version or a range — a
   renderer-side copy of an enforced value drifts silently, which is how the
   card once advertised a CLI below the relations floor it required. The
   settled-unknown and absent-endpoint states have no payload to read, so
   they say "unknown" and offer the VERSION-LESS install command rather than
   inventing a band.

   This module owns the fetch/refresh/subscribe state and the card DOM so
   every mutation surface renders the SAME card; views only mount it. */
import { escapeHtml } from "./common.mjs";

/** Recovery command when the backend could not tell us which version to
 * pin — version-LESS on purpose: it names the package without restating any
 * band, so it cannot fall out of agreement with what the locator enforces. */
export const GENERIC_INSTALL_COMMAND = "npm install -g @oas-framework/oas";
export const DOCS_URL = "https://github.com/OAS-Framework/oas/blob/main/docs/desktop-cli-api.md";

/** The install command to show/copy: the backend's derived, version-pinned
 * one when a payload settled, else the version-less fallback. */
export function cliInstallCommand(s = cli) {
  return typeof s?.install === "string" && s.install ? s.install : GENERIC_INSTALL_COMMAND;
}
/** The requirement line. Never fabricated: an unreadable/absent payload says
 * so instead of printing a band this build did not obtain. */
export function cliRequirementText(s = cli) {
  const range = s?.required?.range;
  const api = s?.required?.desktopApi;
  if (!range) return "unknown — this build could not read its CLI requirement";
  return `${range} with desktop API ${api ?? 1}`;
}

let cli = null;              // last GET /api/cli payload (null = probe not yet settled)
let settledUnknown = false;  // a response ARRIVED but was unclassifiable (older backend, garbage)
const listeners = new Set();

export function cliStatus() { return cli; }
/** Mutations are enabled ONLY on a verified compatible CLI (coordinator
 * directive — frozen contract): anything else renders disabled. The card
 * distinction is transient-vs-settled (coordinator UX clarification):
 * only PROBE-PENDING (no response yet) may be card-less — every SETTLED
 * non-ok state (incompatible, absent endpoint, malformed payload, failed
 * binary, unclassifiable) shows the actionable Choose/Retry/docs/install
 * card so users always have a recovery path. */
export function cliAvailable() { return !!cli?.ok; }
/** Spawn-time relations capability. Follows the shared degradation rule:
 * unknown (older backend that predates the `relations` field, or test
 * stubs) is treated as CAPABLE — the server independently fails closed
 * (cli-no-relations) if the real CLI cannot do related spawns. Only a
 * PROVEN relations:false hides the relation UI. */
export function cliRelationsAvailable() { return !!cli?.ok && cli.relations !== false; }
export function cliKnownUnavailable() { return (!!cli && !cli.ok) || settledUnknown; }
export function onCliChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/** Test seam: return to the pristine probe-pending state. */
export function resetCliStateForTests() { cli = null; settledUnknown = false; emit(); }
function emit() { for (const fn of [...listeners]) { try { fn(cli); } catch { /* listener errors stay local */ } } }

/** Fetch a CLI endpoint distinguishing TRANSPORT failure (throw — keep last
 * state) from a RECEIVED HTTP error (settled — an older backend's 404 on
 * /api/cli is the contract's "absent endpoint" case and must card).
 * ctx.api has three shapes: a Response-like ({ok,status,json}), the shell
 * proxy's parsed body (throws err.status-tagged Errors on non-2xx), or a
 * plain object. */
async function fetchCliEndpoint(ctx, pathname, opts) {
  let r;
  try {
    r = await ctx.api(pathname, opts);
  } catch (e) {
    // The shell's api() tags RECEIVED HTTP errors with .status; anything
    // untagged is a transport failure and stays transient.
    if (typeof e?.status === "number") return { received: true, error: true, status: e.status };
    throw e;
  }
  if (!r || typeof r.json !== "function") {
    if (r && r.ok === false) return { received: true, error: true };  // proxy-shape non-2xx
    return { received: true, body: r };
  }
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON body */ }
  if (!r.ok) return { received: true, error: true, status: r.status };
  return { received: true, body };
}

/** Refresh from GET /api/cli (cheap — server-side cached probe state). */
export async function refreshCli(ctx) {
  try {
    const r = await fetchCliEndpoint(ctx, "/api/cli");
    // A response was RECEIVED — the probe is SETTLED either way:
    //   status shape        → that state (ok / known-unavailable + card);
    //   HTTP error (404…)   → settled "absent endpoint" — carded;
    //   non-status payload  → settled-unknown (older backend / garbage) —
    //                         carded. "Disabled with no card forever" is
    //                         not acceptable (binding UX clarification).
    const d = r.body;
    cli = d && typeof d.ok === "boolean" ? d : null;
    settledUnknown = !cli;
  } catch { /* TRANSPORT failure — keep last state (transient; no flapping) */ }
  emit();
  return cli;
}

/** POST /api/cli/reprobe — Retry and Choose-binary trigger. */
export async function reprobeCli(ctx, bin) {
  try {
    const r = await fetchCliEndpoint(ctx, "/api/cli/reprobe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bin ? { bin } : {}),
    });
    const d = r.body;
    cli = d && typeof d.ok === "boolean" ? d : null;   // same settled semantics
    settledUnknown = !cli;
  } catch { /* transport failure — keep last state */ }
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
          <span class="v">${escapeHtml(cliRequirementText(s))}</span>
        </div>
        <div class="cli-install">
          <code class="cli-cmd">${escapeHtml(cliInstallCommand(s))}</code>
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
      try { await doc.defaultView.navigator.clipboard.writeText(cliInstallCommand()); } catch { /* clipboard denied */ }
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
