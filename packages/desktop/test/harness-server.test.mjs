import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createHarnessServer } from "../renderer/harness-server.mjs";

// The harness page resolves marked/dompurify via /node_modules/* — the route
// must serve browser-ready ESM and stay traversal-guarded.
test("harness-server: serves renderer files and /node_modules ESM, guards traversal", async () => {
  const server = createHarnessServer(new URL("http://127.0.0.1:1")); // api unused here
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const get = (p, headers = {}) => fetch(`http://127.0.0.1:${port}${p}`, { headers });
  try {
    assert.equal((await get("/")).status, 200, "harness page serves");
    assert.equal((await get("/views/markdown.mjs")).status, 200, "view module serves");
    const marked = await get("/node_modules/marked/lib/marked.esm.js");
    assert.equal(marked.status, 200, "marked ESM serves through /node_modules");
    assert.ok((marked.headers.get("content-type") || "").includes("text/javascript"), "ESM content-type");
    assert.equal((await get("/node_modules/dompurify/dist/purify.es.mjs")).status, 200, "dompurify ESM serves");
    assert.equal((await get("/node_modules/%2e%2e/package.json")).status, 404, "encoded traversal out of node_modules rejected");
    assert.equal((await get("/%2e%2e/package.json")).status, 404, "encoded traversal out of renderer rejected");
    // fetch cannot forge Host — raw request for the rebinding case
    const hostile = await new Promise((resolve, reject) => {
      const rq = httpRequest({ host: "127.0.0.1", port, path: "/", headers: { host: "evil.example" } }, (rs) => resolve(rs.statusCode));
      rq.on("error", reject); rq.end();
    });
    assert.equal(hostile, 403, "hostile Host rejected");
  } finally { server.close(); }
});
