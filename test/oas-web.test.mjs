import test from "node:test";
import assert from "node:assert/strict";
import { parseTranscript } from "../capabilities/oas-web/bin/oas-web.mjs";

// Session-tail classification (classifySessionTail / sessionTailState) is
// owned by lib/control-pane/model.mjs and tested in control-pane-model.test.mjs.
// This file covers oas-web's own transcript parsing.

const piMsg = (msg, ts = "2026-07-21T14:00:00.000Z") => JSON.stringify({ type: "message", timestamp: ts, message: msg });

test("parseTranscript: pi user/assistant turns parse", () => {
  const lines = [
    piMsg({ role: "user", content: [{ type: "text", text: "hi" }] }),
    piMsg({ role: "assistant", content: [{ type: "text", text: "hello" }] }),
  ];
  const turns = parseTranscript(lines, "pi");
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, "user");
  assert.equal(turns[1].text, "hello");
});

test("parseTranscript: pi tool calls fold their toolResult output in", () => {
  const lines = [
    piMsg({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] }),
    piMsg({ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "file-a\nfile-b" }] }),
  ];
  const turns = parseTranscript(lines, "pi");
  assert.equal(turns.length, 1);
  assert.equal(turns[0].tools[0].name, "bash");
  assert.equal(turns[0].tools[0].result, "file-a\nfile-b");
});

test("parseTranscript: an error-stopped assistant entry with no content yields no turn", () => {
  // The evaporated turn: the banner comes from sessionTail, not the transcript.
  const lines = [
    piMsg({ role: "user", content: [{ type: "text", text: "hi" }] }),
    piMsg({ role: "assistant", stopReason: "error", errorMessage: "No API key", content: [] }),
  ];
  const turns = parseTranscript(lines, "pi");
  assert.equal(turns.length, 1);
  assert.equal(turns[0].role, "user");
});

test("parseTranscript: garbage lines are skipped", () => {
  assert.deepEqual(parseTranscript(["not json", '{"type":"meta"}'], "pi"), []);
});
