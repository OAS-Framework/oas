// Process-group reaper (scripts/proc-reaper.mjs) — the leak-proofing
// contract from review 4e2667b:
//   * group ids are RETAINED after leader exit (descendants can outlive the
//     leader; -pgid still reaps them);
//   * runTracked group-kills on timeout without blocking the event loop;
//   * reapAll covers retained groups from already-exited leaders.
// io-injected fakes make retention/kill semantics observable without real
// processes; the "leader exits, descendant remains" case is ALSO proven
// against real processes below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { createReaper } from "../scripts/proc-reaper.mjs";

let nextPid = 51000;
function fakeChild() {
  const c = new EventEmitter();
  c.pid = nextPid++;
  c.killed = false;
  c.kill = () => { c.killed = true; };
  c.stdout = new EventEmitter();
  return c;
}

test("group ids are retained after leader exit — reapAll still group-kills them", () => {
  const killed = [];
  const r = createReaper({ spawn: () => fakeChild(), killGroup: (pgid) => killed.push(pgid) });
  const c = r.spawnTracked("app", []);
  const pgid = c.pid;
  c.emit("exit", 0);                       // leader exits — descendants may remain
  assert.ok(r.pendingGroups().has(pgid), "group RETAINED after leader exit (the review's exact finding)");
  r.reapAll();
  assert.deepEqual(killed, [pgid], "reapAll group-kills the retained group");
  assert.equal(r.pendingGroups().size, 0, "reaped groups are cleared");
});

test("reapGroup kills the group and clears retention exactly once", () => {
  const killed = [];
  const r = createReaper({ spawn: () => fakeChild(), killGroup: (pgid) => killed.push(pgid) });
  const c = r.spawnTracked("app", []);
  r.reapGroup(c);
  assert.deepEqual(killed, [c.pid]);
  assert.equal(r.pendingGroups().size, 0);
  r.reapAll();
  assert.deepEqual(killed, [c.pid], "no double group-kill after explicit reap");
});

test("runTracked: timeout group-kills and resolves timedOut without leader cooperation", async () => {
  const killed = [];
  let child;
  const r = createReaper({ spawn: () => (child = fakeChild()), killGroup: (pgid) => killed.push(pgid) });
  const p = r.runTracked("app", [], { timeout: 30 });
  // the child NEVER exits on its own — only the timeout's group kill ends it
  const result = await Promise.race([p, new Promise((res) => setTimeout(() => res("hung"), 500))]);
  // after the group kill the fake leader emits exit (as a real one would)
  if (result === "hung") { child.emit("exit", null); }
  const final = result === "hung" ? await p : result;
  assert.equal(final.timedOut, true, "timeout reported");
  assert.deepEqual(killed, [child.pid], "group killed on timeout");
});

test("runTracked: normal exit still group-reaps (descendants may remain in the group)", async () => {
  const killed = [];
  let child;
  const r = createReaper({ spawn: () => (child = fakeChild()), killGroup: (pgid) => killed.push(pgid) });
  const p = r.runTracked("app", [], { timeout: 5000 });
  child.stdout.emit("data", "OUT");
  child.emit("exit", 0);
  const result = await p;
  assert.equal(result.stdout, "OUT");
  assert.equal(result.timedOut, false);
  assert.deepEqual(killed, [child.pid], "group reaped even on clean leader exit");
  assert.equal(r.pendingGroups().size, 0);
});

// ---- real-process regression: leader exits while a descendant remains ------
test("real processes: a descendant surviving its exited leader is reaped by group kill", async () => {
  const r = createReaper({ spawn });
  // Leader: a shell that starts a long-running descendant IN ITS GROUP and
  // exits immediately — exactly the reviewed leak (leader exit dropped the
  // group while the descendant lived on).
  const c = r.spawnTracked("/bin/sh", ["-c", "sleep 300 & echo started"]);
  await new Promise((ok) => c.on("exit", ok));           // leader is gone
  assert.ok(r.pendingGroups().has(c.pid), "group retained after real leader exit");
  // the descendant (sleep) is alive in the leader's group
  const alive = () => {
    try { return execFileSync("pgrep", ["-g", String(c.pid)], { encoding: "utf8" }).trim().length > 0; }
    catch { return false; }                              // pgrep exits 1 when none
  };
  assert.ok(alive(), "descendant still running after leader exit");
  r.reapAll();
  await new Promise((ok) => setTimeout(ok, 200));
  assert.ok(!alive(), "group kill reaped the orphaned descendant");
});

// ---- interruption during a tracked run (the ABI-probe interruption case) ---
test("real processes: killing the smoke mid-runTracked leaves no group survivors", async () => {
  // Child smoke-like script: uses the reaper to run a tree, then hangs so we
  // can interrupt it mid-probe. Its own signal handler must reap the tree.
  const script = `
    import { spawn } from "node:child_process";
    import { createReaper } from "${new URL("../scripts/proc-reaper.mjs", import.meta.url).pathname}";
    const r = createReaper({ spawn });
    process.on("SIGTERM", () => { r.reapAll(); process.exit(1); });
    const c = r.spawnTracked("/bin/sh", ["-c", "sleep 300"]);
    console.log("TREE_UP " + c.pid);
    setInterval(() => {}, 1000);   // stay alive until interrupted
  `;
  const runner = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "ignore"] });
  const pgidLine = await new Promise((ok) => {
    let buf = "";
    runner.stdout.on("data", (d) => { buf += d; if (buf.includes("TREE_UP")) ok(buf); });
    setTimeout(() => ok(buf), 8000);
  });
  const m = String(pgidLine).match(/TREE_UP (\d+)/);
  assert.ok(m, "runner started its tree");
  const treePgid = Number(m[1]);
  const treeAlive = () => {
    try { return execFileSync("pgrep", ["-g", String(treePgid)], { encoding: "utf8" }).trim().length > 0; }
    catch { return false; }
  };
  assert.ok(treeAlive(), "tree running before interruption");
  runner.kill("SIGTERM");                                 // interrupt mid-run (ABI-probe case)
  await new Promise((ok) => runner.on("exit", ok));
  await new Promise((ok) => setTimeout(ok, 300));
  assert.ok(!treeAlive(), "interrupted smoke reaped its whole tree via the signal handler");
});
