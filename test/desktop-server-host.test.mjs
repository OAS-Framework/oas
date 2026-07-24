// createServerHost — the REAL production seam for child lifecycle, ownership
// and trust-state transitions (review wsadd3: regressions that reimplement
// `|| transition` or cache invalidation in mocks pin nothing; these import
// the module main.mjs composes, so reverting a production line fails here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServerHost } from "../packages/desktop/server-host.mjs";

function fakeChild() {
  const c = new EventEmitter();
  c.killed = [];
  c.kill = (sig) => { c.killed.push(sig || "SIGTERM"); };
  c.exitNow = () => c.emit("exit", 0);
  return c;
}

function makeHost(over = {}) {
  const state = { spawned: [], invalidations: 0 };
  const host = createServerHost({
    spawnChild: (dirs, port) => { const c = fakeChild(); c.dirs = dirs; c.port = port; state.spawned.push(c); return c; },
    onInvalidate: () => { state.invalidations++; },
    forceKillMs: 50,
    ...over,
  });
  return { state, host };
}

test("ownership persists through the WHOLE replacement (deferred old-child exit)", async () => {
  const { state, host } = makeHost();
  const first = host.start(["/w/base"]);
  assert.equal(host.owned(), true);
  const replacing = host.replace(["/w/base", "/w/new"]);
  await new Promise((ok) => setImmediate(ok));
  // old child killed but exit not yet emitted: ref cleared, transition live
  assert.equal(host.current(), null, "child ref cleared during transition");
  assert.equal(host.owned(), true, "ownership PERSISTS — mid-transition adds must not see foreign");
  assert.equal(host.inTransition(), true);
  first.exitNow();
  await replacing;
  assert.equal(host.owned(), true);
  assert.equal(host.inTransition(), false);
  assert.deepEqual(state.spawned[1].dirs, ["/w/base", "/w/new"]);
});

test("trust state is invalidated at replacement START, exactly once per replace", async () => {
  const { state, host } = makeHost();
  const first = host.start(["/w/base"]);
  assert.equal(state.invalidations, 0, "start() does not invalidate");
  const replacing = host.replace(["/w/base", "/w/new"]);
  assert.equal(state.invalidations, 1, "invalidated the moment the transition began");
  first.exitNow();
  await replacing;
  assert.equal(state.invalidations, 1);
});

test("an old child's late exit never clears the successor's reference", async () => {
  const { state, host } = makeHost();
  const first = host.start(["/w/base"]);
  const replacing = host.replace(["/w/x"]);
  first.exitNow();
  await replacing;
  const second = host.current();
  assert.ok(second && second !== first);
  first.emit("exit", 0); // late duplicate exit from the dead predecessor
  assert.equal(host.current(), second, "successor reference intact");
});

test("replace force-kills a child that ignores SIGTERM, then proceeds", async () => {
  const { state, host } = makeHost();
  const stubborn = host.start(["/w/base"]);
  const replacing = host.replace(["/w/y"]);
  await new Promise((ok) => setTimeout(ok, 80)); // > forceKillMs
  assert.ok(stubborn.killed.includes("SIGKILL"), "escalated to SIGKILL");
  stubborn.exitNow();
  await replacing;
  assert.equal(host.current().dirs[0], "/w/y");
});

test("stop() kills and clears; owned() false afterwards", () => {
  const { host } = makeHost();
  const c = host.start(["/w/base"]);
  const stopped = host.stop();
  assert.equal(stopped, c);
  assert.equal(host.owned(), false);
  assert.ok(c.killed.length >= 1);
});

test("occupied-port branch: the freshly selected port reaches the spawned child (real composition)", async () => {
  // review wsadd4: main.mjs's spawnServer discarded onPort after the host
  // extraction — on the occupied/incompatible path ensureServerOnPort picks
  // a free port and calls spawnServer(newPort) BEFORE reassigning the
  // module-level port, so the child launched on the OLD port. Model main's
  // exact wiring: a module-level port, a spawnServer wrapper committing
  // onPort, composed through the REAL ensureServerOnPort + createServerHost.
  const { ensureServerOnPort } = await import("../packages/desktop/server-compat.mjs");
  let modulePort = 4820;
  const { state, host } = makeHost();
  const spawnServer = (onPort) => { modulePort = onPort; return host.start(["/w/base"], onPort); };
  const r = await ensureServerOnPort({
    // occupied by an incompatible server:
    panelWorkspaces: async () => [{ id: "/w/base", name: "base" }],
    matchWorkspace: () => "/w/base",
    probeVersion: async () => ({ ok: false, status: 404, body: null }),
    local: { capability: "oas.web", version: "1" },
    port: modulePort,
    freePort: async (from) => from + 3,      // picks 4824
    spawnServer,
    log: () => {},
  });
  assert.equal(r.spawned, true);
  assert.equal(r.port, 4824, "selection reported the new port");
  assert.equal(state.spawned[0].port, 4824, "child launched on the NEW port, not the occupied one");
  assert.equal(modulePort, 4824, "module port committed before spawn — probes and proxy agree");
});
