import test from "node:test";
import assert from "node:assert/strict";
import { classifySessionTail, parseTranscript } from "../capabilities/oas-web/bin/oas-web.mjs";

const piMsg = (msg, ts = "2026-07-21T14:00:00.000Z") => JSON.stringify({ type: "message", timestamp: ts, message: msg });

test("classifySessionTail: pi tail error is surfaced with the provider message", () => {
  const lines = [
    piMsg({ role: "user", content: [{ type: "text", text: "hello" }] }),
    piMsg({ role: "assistant", stopReason: "error", errorMessage: "No API key for provider anthropic" }, "2026-07-21T14:01:00.000Z"),
  ];
  const tail = classifySessionTail(lines, "pi");
  assert.equal(tail.state, "error");
  assert.equal(tail.errorMessage, "No API key for provider anthropic");
  assert.equal(tail.ts, "2026-07-21T14:01:00.000Z");
});

test("classifySessionTail: pi session that recovered after an error is ok", () => {
  const lines = [
    piMsg({ role: "assistant", stopReason: "error", errorMessage: "Token is expired" }),
    piMsg({ role: "user", content: [{ type: "text", text: "retry please" }] }),
    piMsg({ role: "assistant", content: [{ type: "text", text: "done" }] }),
  ];
  const tail = classifySessionTail(lines, "pi");
  assert.equal(tail.state, "ok");
  assert.equal(tail.errorMessage, null);
});

test("classifySessionTail: error message is trimmed and capped at 500 chars", () => {
  const lines = [piMsg({ role: "assistant", stopReason: "error", errorMessage: "  " + "x".repeat(900) })];
  const tail = classifySessionTail(lines, "pi");
  assert.equal(tail.state, "error");
  assert.equal(tail.errorMessage.length, 500);
});

test("classifySessionTail: unknown when there are no message entries or garbage input", () => {
  assert.equal(classifySessionTail([], "pi").state, "unknown");
  assert.equal(classifySessionTail(["not json", JSON.stringify({ type: "meta" })], "pi").state, "unknown");
});

test("classifySessionTail: claude trailing api-error entry is an error tail", () => {
  const lines = [
    JSON.stringify({ type: "user", timestamp: "t1", message: { role: "user", content: "hi" } }),
    JSON.stringify({ type: "assistant", timestamp: "t2", isApiErrorMessage: true, message: { role: "assistant", content: [{ type: "text", text: "API Error: 401 unauthorized" }] } }),
  ];
  const tail = classifySessionTail(lines, "claude");
  assert.equal(tail.state, "error");
  assert.match(tail.errorMessage, /401 unauthorized/);
});

test("classifySessionTail: claude normal tail is ok", () => {
  const lines = [
    JSON.stringify({ type: "assistant", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }),
  ];
  assert.equal(classifySessionTail(lines, "claude").state, "ok");
});

test("parseTranscript: pi user/assistant turns still parse (regression)", () => {
  const lines = [
    piMsg({ role: "user", content: [{ type: "text", text: "hi" }] }),
    piMsg({ role: "assistant", content: [{ type: "text", text: "hello" }] }),
  ];
  const turns = parseTranscript(lines, "pi");
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, "user");
  assert.equal(turns[1].text, "hello");
});
