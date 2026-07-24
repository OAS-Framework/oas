#!/usr/bin/env node
/* oas desktop — dev harness server (NOT part of the app).
   Serves the renderer directory and proxies /api/* to a running oas-web
   server, so the harness page is same-origin with the API (oas-web sends no
   CORS headers, and its loopback origin guard governs POSTs — same-origin
   keeps both happy, exactly like the real shell's ctx.api).

     node packages/desktop/renderer/harness-server.mjs [--port 4899] [--api http://127.0.0.1:4820]

   Exports createHarnessServer(api) so tests can exercise the security
   boundary behaviorally (started only when run as a script, below). */
import { createServer, request as httpRequest } from "node:http";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json" };

export function createHarnessServer(api) {
  return createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    // Same DNS-rebinding guard as oas-web itself: the harness can reach
    // mutating endpoints upstream, so a hostile page resolving to 127.0.0.1
    // must be rejected HERE — never launder a forged origin into a trusted one.
    const okHost = (h) => h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
    const host = String(req.headers.host || "").replace(/:\d+$/, "");
    let originOk = true;
    if (req.headers.origin !== undefined) {
      try { originOk = okHost(new URL(String(req.headers.origin)).hostname); } catch { originOk = false; }
    }
    if (!okHost(host) || !originOk) { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "forbidden origin" })); return; }
    if (url.pathname.startsWith("/api/")) {
      // Proxy to the oas-web server, preserving method/body AND the browser's
      // own Origin header (already validated loopback above — the upstream
      // loopback guard understands it; forging a trusted origin would defeat
      // the guard). Host is rewritten only so the request routes upstream.
      const p = httpRequest({
        hostname: api.hostname, port: api.port, path: url.pathname + url.search,
        method: req.method,
        headers: { ...req.headers, host: `${api.hostname}:${api.port}` },
      }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
      p.on("error", (e) => { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: `oas-web unreachable at ${api}: ${e.message}` })); });
      req.pipe(p);
      return;
    }
    // static files: the renderer dir, plus /node_modules/* pinned to the
    // package's node_modules (browser-ready ESM deps — marked, dompurify —
    // resolve through the importmap; still traversal-guarded).
    const NM = join(HERE, "..", "node_modules");
    const base = url.pathname.startsWith("/node_modules/") ? NM : HERE;
    const rel = url.pathname === "/" ? "/harness.html"
      : url.pathname.startsWith("/node_modules/") ? url.pathname.slice("/node_modules".length) : url.pathname;
    const file = normalize(join(base, rel));
    if (!(file === base || file.startsWith(base + sep)) || !existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "content-type": `${TYPES[ext] || "application/octet-stream"}; charset=utf-8`, "cache-control": "no-store" });
    res.end(readFileSync(file));
  });
}

// script mode: `node harness-server.mjs [--port n] [--api url]`
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const port = Number(flag("port", 4899));
  const api = new URL(flag("api", "http://127.0.0.1:4820"));
  createHarnessServer(api).listen(port, "127.0.0.1", () => {
    console.log(`harness at http://127.0.0.1:${port}/  (API proxied to ${api})`);
  });
}
