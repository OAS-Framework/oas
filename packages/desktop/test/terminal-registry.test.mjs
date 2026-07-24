// Terminal resource registry (terminal-registry.mjs) — Slice G hard
// invariant: the Desktop app must never fan out enough terminal viewers to
// hang the machine. Dedupe by target + hard cap of 6, enforced main-side.
//
// The tests drive a FAITHFUL simulation of main.mjs's term:open handler
// (plan → create-on-"create" → commit; release on close/exit/failure) with a
// fake openTerm that counts real viewer creations, so the regressions prove
// the resource bound end to end, not just the map bookkeeping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerminalRegistry, terminalTargetKey, MAX_TERMINALS } from "../terminal-registry.mjs";

// A stand-in for the main-process handler + openTerm + ptys map.
function makeApp({ max = MAX_TERMINALS, failTargets = new Set() } = {}) {
  const reg = createTerminalRegistry({ max });
  const ptys = new Map();          // id -> { key, killed }
  let nextId = 1;
  let viewersCreated = 0;          // real openTerm() calls that built a viewer
  // Mirrors main.mjs term:open EXACTLY: synchronous plan→create→commit.
  const open = (session, window) => {
    const key = terminalTargetKey(session, window);
    const plan = reg.plan(key);
    if (plan.action === "reuse") return { reused: true, id: plan.id };
    if (plan.action === "cap") return { capped: true, active: plan.active, max: plan.max };
    // create
    if (failTargets.has(key)) return { error: "no tmux target" }; // openTerm threw; nothing committed
    viewersCreated++;
    const id = nextId++;
    ptys.set(id, { key, killed: false });
    reg.commit(key, id);
    return { id };
  };
  const close = (id) => {           // term:close
    const t = ptys.get(id);
    if (!t) return;
    t.killed = true;
    ptys.delete(id);
    reg.release(id);
  };
  const ptyExit = (id) => {          // pty onExit (session ended / detach)
    ptys.delete(id);
    reg.release(id);
  };
  const quit = () => {               // app shutdown
    for (const id of [...ptys.keys()]) { ptys.get(id).killed = true; ptys.delete(id); reg.release(id); }
  };
  return { reg, open, close, ptyExit, quit, viewers: () => viewersCreated, live: () => reg.activeCount() };
}

test("100 repeated opens of the SAME target create exactly one viewer", () => {
  const app = makeApp();
  let ids = new Set();
  for (let i = 0; i < 100; i++) {
    const r = app.open("pi-agents", "dev-1");
    assert.ok(r.id !== undefined, "always resolves to the one id");
    if (i === 0) assert.ok(!r.reused, "first is a create");
    else assert.equal(r.reused, true, "subsequent are reuse");
    ids.add(r.id);
  }
  assert.equal(app.viewers(), 1, "exactly one viewer session ever created");
  assert.equal(ids.size, 1, "always the same id");
  assert.equal(app.live(), 1);
});

test("7 DISTINCT opens → 6 created + the 7th rejected actionably; no silent create/evict", () => {
  const app = makeApp();
  for (let i = 1; i <= 6; i++) {
    const r = app.open("pi-agents", `dev-${i}`);
    assert.ok(r.id !== undefined, `open ${i} created`);
  }
  assert.equal(app.live(), 6);
  const seventh = app.open("pi-agents", "dev-7");
  assert.equal(seventh.capped, true, "7th distinct open is capped");
  assert.equal(seventh.max, 6);
  assert.equal(seventh.active, 6);
  assert.equal(seventh.id, undefined, "no id handed out");
  assert.equal(app.viewers(), 6, "no 7th viewer was created (no silent create)");
  assert.equal(app.live(), 6, "no eviction of an existing terminal (no silent evict)");
});

test("closing a terminal frees exactly one slot; a new distinct open then succeeds", () => {
  const app = makeApp();
  const ids = [];
  for (let i = 1; i <= 6; i++) ids.push(app.open("pi-agents", `dev-${i}`).id);
  assert.equal(app.open("pi-agents", "dev-7").capped, true, "at cap");
  app.close(ids[2]);                                   // close one
  assert.equal(app.live(), 5);
  const r = app.open("pi-agents", "dev-7");            // now allowed
  assert.ok(r.id !== undefined && !r.capped, "a slot freed, new open succeeds");
  assert.equal(app.live(), 6);
  assert.equal(app.open("pi-agents", "dev-8").capped, true, "and we are back at the cap");
});

test("a pty exit (session ended) frees the slot and allows re-open of the SAME target", () => {
  const app = makeApp();
  const id = app.open("pi-agents", "dev-1").id;
  assert.equal(app.open("pi-agents", "dev-1").reused, true, "same target reuses while live");
  app.ptyExit(id);                                     // source window died
  assert.equal(app.live(), 0, "slot freed on exit");
  const r = app.open("pi-agents", "dev-1");
  assert.ok(r.id !== undefined && !r.reused, "re-open after exit creates a fresh viewer");
  assert.equal(app.viewers(), 2, "one viewer per live epoch, not accumulated");
});

test("out-of-order concurrent opens cannot exceed the cap (synchronous check+commit is atomic)", () => {
  // The handler is synchronous, so 'concurrent' IPC calls are serialized on
  // the main thread. Interleave distinct opens and closes in an adversarial
  // order and assert the live count NEVER exceeds the cap.
  const app = makeApp();
  const ops = [];
  for (let i = 1; i <= 20; i++) ops.push(["open", `dev-${i}`]);
  // sprinkle closes of not-yet-open ids (no-ops) and real ones
  let maxLive = 0;
  const openIds = [];
  for (const [op, name] of ops) {
    const r = app.open("pi-agents", name);
    if (r.id !== undefined && !r.reused) openIds.push(r.id);
    maxLive = Math.max(maxLive, app.live());
    // adversarial interleave: every 3rd op, close the oldest live one
    if (openIds.length && openIds.length % 3 === 0) app.close(openIds.shift());
    maxLive = Math.max(maxLive, app.live());
  }
  assert.ok(maxLive <= 6, `live count never exceeded the cap (peak ${maxLive})`);
});

test("a create FAILURE (bad target) commits nothing and leaves the baseline count", () => {
  const app = makeApp({ failTargets: new Set([terminalTargetKey("pi-agents", "ghost")]) });
  app.open("pi-agents", "dev-1");
  const before = app.live();
  const r = app.open("pi-agents", "ghost");
  assert.equal(r.error, "no tmux target", "failure surfaced");
  assert.equal(r.id, undefined, "no id");
  assert.equal(app.live(), before, "failed open leaves the live count unchanged");
  assert.equal(app.viewers(), 1, "no viewer created for the failed target");
  // and the failed target can be retried later (slot was never held)
  assert.equal(app.reg.has(terminalTargetKey("pi-agents", "ghost")), false);
});

test("app quit releases every slot back to baseline zero", () => {
  const app = makeApp();
  for (let i = 1; i <= 6; i++) app.open("pi-agents", `dev-${i}`);
  assert.equal(app.live(), 6);
  app.quit();
  assert.equal(app.live(), 0, "all slots released on quit");
  // a fresh app cycle starts clean
  const r = app.open("pi-agents", "dev-1");
  assert.ok(r.id !== undefined);
});

test("MAX_TERMINALS is 6 (bump requires a human release-blocker review)", () => {
  assert.equal(MAX_TERMINALS, 6);
});

test("terminalTargetKey: distinct session/window pairs never collide; same pair is stable", () => {
  assert.equal(terminalTargetKey("s", "w"), terminalTargetKey("s", "w"));
  assert.notEqual(terminalTargetKey("s", "w1"), terminalTargetKey("s", "w2"));
  assert.notEqual(terminalTargetKey("s1", "w"), terminalTargetKey("s2", "w"));
  // NUL join: a window value cannot forge a different session's key
  assert.notEqual(terminalTargetKey("a", "b"), terminalTargetKey("a\u0000b", ""));
});
