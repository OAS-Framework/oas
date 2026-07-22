#!/usr/bin/env node
/**
 * dev-serve.mjs — same-origin dev harness server for renderer views.
 *
 * oas-web sends no CORS headers (by design: loopback-only, no cross-origin
 * consumers), so a harness page served from another origin cannot call it.
 * This server gives the harness ONE origin: it serves the renderer directory
 * statically and proxies /api/* to a running oas-web server.
 *
 *   node capabilities/oas-web/bin/oas-web.mjs start --port 4820 --dir <ws>
 *   node packages/desktop/renderer/dev-serve.mjs [--port 4830] [--api 4820]
 *   open http://127.0.0.1:4830/dev-brain.html
 *
 * Dev-only; binds 127.0.0.1, path-guarded to this directory, and rejects
 * non-loopback Host values — a DNS-rebinding page must not reach the /api
 * proxy (which rewrites Host to loopback) through this port.
 */
import { createServer, request } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
const port = arg("port", 4830);
const apiPort = arg("api", 4820);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

/* DEVSERVE_HOSTGUARD_BEGIN — loopback Host guard, extracted by tests */
function loopbackHost(hostHeader) {
  const raw = String(hostHeader || "").toLowerCase();
  // strip a port — but not the tail of a bare IPv6 address like "::1"
  const h = raw === "::1" ? raw : raw.replace(/:\d+$/, "");
  return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
}
/* DEVSERVE_HOSTGUARD_END */

createServer((req, res) => {
  // DNS-rebinding guard BEFORE static serving or proxying: the /api proxy
  // rewrites Host to loopback, so an arbitrary inbound Host would otherwise
  // let a hostile origin read agent metadata/transcripts through this port.
  if (!loopbackHost(req.headers.host)) { res.writeHead(403); res.end("forbidden host"); return; }
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    // same-origin proxy to the oas-web server
    const p = request({ host: "127.0.0.1", port: apiPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${apiPort}` } },
      (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
    p.on("error", () => { res.writeHead(502); res.end(`oas-web not reachable on :${apiPort}`); });
    req.pipe(p);
    return;
  }
  const rel = normalize(url.pathname === "/" ? "/dev-brain.html" : url.pathname).replace(/^([/\\])+/, "");
  const file = join(HERE, rel);
  if (!file.startsWith(HERE + "/") || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end("not found"); return; }
  const ext = file.slice(file.lastIndexOf("."));
  res.writeHead(200, { "content-type": `${TYPES[ext] || "application/octet-stream"}; charset=utf-8` });
  res.end(readFileSync(file));
}).listen(port, "127.0.0.1", () => {
  console.log(`dev harness at http://127.0.0.1:${port}/dev-brain.html (proxying /api → :${apiPort})`);
});
