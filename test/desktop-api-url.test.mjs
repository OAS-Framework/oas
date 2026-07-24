// Regression coverage for the desktop app's privileged API proxy URL shaping
// (packages/desktop/api-url.mjs) — findings from review de5141c:
//   1. protocol-relative / backslash pathnames must not steer the privileged
//      fetch off the loopback oas-web origin;
//   2. a caller-supplied ?ws= must not override the verified workspace on a
//      shared server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { apiUrl, apiInit } from "../packages/desktop/api-url.mjs";

const BASE = "http://127.0.0.1:4820";

test("normal API paths stay on the server origin", () => {
  assert.equal(apiUrl("/api/panel", BASE).href, `${BASE}/api/panel`);
  assert.equal(apiUrl("/api/session/foo?lines=100", BASE).href, `${BASE}/api/session/foo?lines=100`);
});

test("rejects non-string and non-absolute pathnames", () => {
  for (const bad of [undefined, null, 42, "api/panel", "http://evil/x", ""]) {
    assert.throws(() => apiUrl(bad, BASE), /pathname/);
  }
});

test("rejects off-origin resolution: protocol-relative and backslash forms", () => {
  for (const bad of ["//attacker.example/x", "/\\attacker.example/x", "//127.0.0.1:9999/x", "/\\\\attacker.example/x"]) {
    assert.throws(() => apiUrl(bad, BASE), /off-origin/, `should reject ${JSON.stringify(bad)}`);
  }
});

test("pins the verified workspace on scoped endpoints, overwriting unknown ws", () => {
  const ws = "/Users/me/oas";
  assert.equal(apiUrl("/api/panel", BASE, ws).searchParams.get("ws"), ws);
  // caller-supplied ws NOT advertised by the server must be overwritten
  assert.equal(apiUrl("/api/panel?ws=/Users/me/other", BASE, ws).searchParams.get("ws"), ws);
  assert.equal(apiUrl("/api/agents?ws=/Users/me/other", BASE, ws).searchParams.get("ws"), ws);
  // ...even with an allowed set that does not contain it
  assert.equal(apiUrl("/api/panel?ws=/Users/me/other", BASE, ws, new Set([ws])).searchParams.get("ws"), ws);
});

test("allows switching to a workspace the server advertises", () => {
  const ws = "/Users/me/oas", other = "/Users/me/lfx";
  const allowed = new Set([ws, other]);
  assert.equal(apiUrl(`/api/panel?ws=${other}`, BASE, ws, allowed).searchParams.get("ws"), other);
  assert.equal(apiUrl(`/api/agents?ws=${other}`, BASE, ws, allowed).searchParams.get("ws"), other);
  // no caller ws → verified id still pinned
  assert.equal(apiUrl("/api/panel", BASE, ws, allowed).searchParams.get("ws"), ws);
});

test("pins ws on /api/brain/* like the other scoped endpoints", () => {
  const ws = "/Users/me/oas", other = "/Users/me/lfx";
  // no caller ws → verified id pinned
  assert.equal(apiUrl("/api/brain/tui-dev", BASE, ws).searchParams.get("ws"), ws);
  // unknown/stale caller ws → overwritten
  assert.equal(apiUrl("/api/brain/tui-dev?ws=/stale/id", BASE, ws, new Set([ws, other])).searchParams.get("ws"), ws);
  assert.equal(apiUrl("/api/brain/tui-dev?ws=/stale/id", BASE, ws).searchParams.get("ws"), ws);
  // server-advertised caller ws → kept (workspace switching)
  assert.equal(apiUrl(`/api/brain/tui-dev?ws=${other}`, BASE, ws, new Set([ws, other])).searchParams.get("ws"), other);
  // /api/diff/* follows the same policy
  assert.equal(apiUrl("/api/diff/inst-a", BASE, ws).searchParams.get("ws"), ws);
  assert.equal(apiUrl("/api/diff/inst-a?ws=/stale", BASE, ws).searchParams.get("ws"), ws);
  assert.equal(apiUrl(`/api/diff/inst-a?ws=${other}`, BASE, ws, new Set([ws, other])).searchParams.get("ws"), other);
});

test("pins ws on the whole instance-addressed route family", () => {
  const ws = "/Users/me/oas", other = "/Users/me/lfx";
  for (const ep of ["session", "keys", "interrupt", "jira", "chat", "diff", "brain"]) {
    // omitted ws → fails safe to the verified workspace
    assert.equal(apiUrl(`/api/${ep}/inst-a`, BASE, ws).searchParams.get("ws"), ws, `${ep}: pin on omission`);
    // stale/unknown caller ws → overwritten
    assert.equal(apiUrl(`/api/${ep}/inst-a?ws=/stale`, BASE, ws, new Set([ws, other])).searchParams.get("ws"), ws, `${ep}: stale overwritten`);
    // server-advertised caller ws → kept (workspace switching)
    assert.equal(apiUrl(`/api/${ep}/inst-a?ws=${other}`, BASE, ws, new Set([ws, other])).searchParams.get("ws"), other, `${ep}: advertised kept`);
  }
});

test("does not pin ws on unscoped endpoints and without a verified id", () => {
  assert.equal(apiUrl("/api/file?path=/x", BASE, "/Users/me/oas").searchParams.get("ws"), null);
  assert.equal(apiUrl("/api/panel", BASE, null).searchParams.get("ws"), null);
});

// apiInit: the IPC proxy must serialize exactly once. Views (common.mjs
// postJson) follow the Fetch contract and pass a pre-serialized string body
// + content-type header; double-serializing broke every POST /api/spawn.
test("apiInit forwards pre-serialized string bodies unchanged", () => {
  const body = JSON.stringify({ agent: "a", agentsRoot: "/r" });
  const init = apiInit({ method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal(init.method, "POST");
  assert.equal(init.body, body); // NOT re-serialized
  assert.deepEqual(JSON.parse(init.body), { agent: "a", agentsRoot: "/r" });
  assert.equal(init.headers["content-type"], "application/json");
});

test("apiInit serializes object bodies exactly once and preserves headers", () => {
  const init = apiInit({ method: "POST", body: { data: "x" }, headers: { "x-extra": "1" } });
  assert.deepEqual(JSON.parse(init.body), { data: "x" });
  assert.equal(init.headers["content-type"], "application/json");
  assert.equal(init.headers["x-extra"], "1");
});

test("apiInit defaults: GET without body or headers", () => {
  const init = apiInit(undefined);
  assert.equal(init.method, "GET");
  assert.equal(init.body, undefined);
});
