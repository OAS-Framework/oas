#!/usr/bin/env node
/* oas desktop — dev harness server (NOT part of the app).
   Serves the renderer directory and proxies /api/* to a running oas-web
   server, so the harness page is same-origin with the API (oas-web sends no
   CORS headers, and its loopback origin guard governs POSTs — same-origin
   keeps both happy, exactly like the real shell's ctx.api).

     node packages/desktop/renderer/harness-server.mjs [--port 4899] [--api http://127.0.0.1:4820]
*/
import { createServer, request as httpRequest } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const port = Number(flag("port", 4899));
const api = new URL(flag("api", "http://127.0.0.1:4820"));

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json" };

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  // Same DNS-rebinding guard as oas-web itself: the harness can reach mutating
  // endpoints upstream, so a hostile page resolving to 127.0.0.1 must be
  // rejected HERE — never launder a forged origin into a trusted one.
  const okHost = (h) => h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
  const host = String(req.headers.host || "").replace(/:\d+$/, "");
  let originOk = true;
  if (req.headers.origin !== undefined) {
    try { originOk = okHost(new URL(String(req.headers.origin)).hostname); } catch { originOk = false; }
  }
  if (!okHost(host) || !originOk) { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "forbidden origin" })); return; }
  if (url.pathname.startsWith("/api/")) {
    // proxy to the oas-web server, preserving method/body AND the browser's
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
  // static files from the renderer dir only (no traversal)
  const rel = url.pathname === "/" ? "/harness.html" : url.pathname;
  const file = normalize(join(HERE, rel));
  if (!file.startsWith(HERE) || !existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
  const ext = file.slice(file.lastIndexOf("."));
  res.writeHead(200, { "content-type": `${TYPES[ext] || "application/octet-stream"}; charset=utf-8`, "cache-control": "no-store" });
  res.end(readFileSync(file));
});
server.listen(port, "127.0.0.1", () => {
  console.log(`harness at http://127.0.0.1:${port}/  (API proxied to ${api})`);
});
