/**
 * Network canary for spawned CLI runs.
 *
 * Loaded with `node --import <this file> bin/oas.mjs …`, it replaces
 * `globalThis.fetch` with a recorder that APPENDS every attempted URL to the
 * file named by `OAS_FETCH_CANARY` and then fails. A command that must stay off
 * the network leaves that file empty; a command that legitimately refreshes the
 * catalog leaves exactly the constant catalog URL in it.
 *
 * Failing (rather than returning a stub) is deliberate: the kernel treats a
 * fetch failure as "fall through to the cache", so the canary can never change
 * which catalog a run ends up serving — only whether a fetch was attempted.
 */
import { appendFileSync, writeFileSync } from "node:fs";

const file = process.env.OAS_FETCH_CANARY;
if (file) {
  writeFileSync(file, "");
  globalThis.fetch = async (url) => {
    appendFileSync(file, `${typeof url === "string" ? url : String(url?.url ?? url)}\n`);
    throw new Error("network canary: fetch attempted");
  };
}
