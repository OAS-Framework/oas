// Regression coverage for the desktop app's privileged API proxy URL shaping
// (packages/desktop/api-url.mjs) — findings from review de5141c:
//   1. protocol-relative / backslash pathnames must not steer the privileged
//      fetch off the loopback oas-web origin;
//   2. a caller-supplied ?ws= must not override the verified workspace on a
//      shared server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { apiUrl } from "../packages/desktop/api-url.mjs";

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

test("pins the verified workspace on scoped endpoints, overwriting caller ws", () => {
  const ws = "/Users/me/oas";
  assert.equal(apiUrl("/api/panel", BASE, ws).searchParams.get("ws"), ws);
  // caller-supplied ws must be overwritten, not respected
  assert.equal(apiUrl("/api/panel?ws=/Users/me/other", BASE, ws).searchParams.get("ws"), ws);
  assert.equal(apiUrl("/api/agents?ws=/Users/me/other", BASE, ws).searchParams.get("ws"), ws);
});

test("does not pin ws on unscoped endpoints and without a verified id", () => {
  assert.equal(apiUrl("/api/session/foo", BASE, "/Users/me/oas").searchParams.get("ws"), null);
  assert.equal(apiUrl("/api/panel", BASE, null).searchParams.get("ws"), null);
});
