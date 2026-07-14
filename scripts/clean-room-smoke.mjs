#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const room = mkdtempSync(join(tmpdir(), "oas-packed-smoke-"));
const keep = process.env.OAS_KEEP_SMOKE === "1";
const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: "utf8", stdio: options.capture ? ["ignore", "pipe", "pipe"] : "ignore", ...options,
});
const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };

function pack(cwd, destination) {
  const output = run("npm", ["pack", "--json", "--pack-destination", destination], { cwd, capture: true });
  const parsed = JSON.parse(output);
  if (parsed.length !== 1) throw new Error(`unexpected npm pack output from ${cwd}`);
  return join(destination, parsed[0].filename);
}
function gitRepo(path) {
  mkdirSync(path, { recursive: true });
  run("git", ["init", "-q", path]);
  run("git", ["-C", path, "config", "user.name", "OAS Smoke"]);
  run("git", ["-C", path, "config", "user.email", "smoke@example.invalid"]);
  write(join(path, ".gitignore"), "\n");
  run("git", ["-C", path, "add", "."]);
  run("git", ["-C", path, "commit", "-qm", "smoke fixture"]);
}

try {
  const tarballs = join(room, "tarballs"); mkdirSync(tarballs);
  const kernelTgz = pack(repo, tarballs);
  const adapterTgz = pack(join(repo, "packages", "pi"), tarballs);

  const app = join(room, "app"); mkdirSync(app);
  write(join(app, "package.json"), JSON.stringify({ name: "oas-clean-room", private: true, type: "module" }, null, 2));
  run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", kernelTgz, adapterTgz], { cwd: app });

  const kernelRoot = join(app, "node_modules", "@oas-framework", "oas");
  const adapterRoot = join(app, "node_modules", "@oas-framework", "pi");
  const oas = join(app, "node_modules", ".bin", "oas");
  for (const path of [join(kernelRoot, "lib", "core.mjs"), join(kernelRoot, "capabilities", "oas-okf", "oas.json"), join(adapterRoot, "extension", "index.ts"), oas]) {
    if (!existsSync(path)) throw new Error(`packed install missing ${path}`);
  }
  if (kernelRoot.startsWith(repo) || adapterRoot.startsWith(repo)) throw new Error("smoke install did not leave the checkout");

  const home = join(room, "home"); const fakeBin = join(room, "bin"); mkdirSync(home); mkdirSync(fakeBin);
  write(join(fakeBin, "pi"), "#!/bin/sh\nexit 0\n"); chmodSync(join(fakeBin, "pi"), 0o755);
  const env = {
    ...process.env,
    HOME: home,
    OAS_HOME_DIR: join(home, ".oas"),
    OAS_PKG_ROOT: kernelRoot,
    PATH: `${fakeBin}:${dirname(oas)}:${process.env.PATH}`,
  };
  Object.assign(process.env, env);

  const adapterLoader = await import(pathToFileURL(join(adapterRoot, "extension", "core-loader.mjs")).href);
  if (adapterLoader.OAS_PKG_ROOT !== kernelRoot) throw new Error("packed pi adapter did not resolve packed kernel");
  const kernelPackage = JSON.parse(readFileSync(join(kernelRoot, "package.json"), "utf8"));
  if (adapterLoader.kernelVersion() !== kernelPackage.version) throw new Error("packed adapter/kernel version mismatch");
  const core = await import(pathToFileURL(join(kernelRoot, "lib", "core.mjs")).href);

  const workspace = join(room, "workspace"); const agentsRoot = join(workspace, "agents");
  const modernRepo = join(workspace, "modern"); gitRepo(modernRepo); mkdirSync(agentsRoot, { recursive: true });
  run(oas, ["init", "--raw", "--knowledge", "oas.okf", "--no-tmux-mouse", "--dir", modernRepo], { env });
  const initConfig = readFileSync(join(modernRepo, "oas-config.yaml"), "utf8");
  if (!/oas\.okf/.test(initConfig)) throw new Error("packed oas init did not activate declared knowledge package");

  core.createAgent(agentsRoot, { name: "probe", repo: modernRepo, work: "checkout", runtime: "pi", instructions: "# Packed probe\n\nCanonical instructions.\n" });
  const agent = core.findAgent(agentsRoot, "probe");
  write(join(agent._dir, "soul", "skills", "private", "SKILL.md"), "---\nname: private\ndescription: Packed private smoke skill.\n---\n# Private\n");
  const canonical = readFileSync(join(agent._dir, "soul", "AGENTS.md"), "utf8");
  const spawned = core.spawnInstance(agentsRoot, agent, { instance: "probe-packed", repo: modernRepo, launch: false });
  const meta = JSON.parse(readFileSync(join(spawned.home, "instance.json"), "utf8"));
  const skills = readdirSync(join(spawned.home, ".agents", "skills")).sort();
  if (JSON.stringify(skills) !== JSON.stringify(["memory-harvest", "oas", "oas-config", "okf", "private"])) throw new Error(`unexpected packed skills: ${skills.join(", ")}`);
  if (lstatSync(join(spawned.home, "AGENTS.md")).isSymbolicLink()) throw new Error("instance AGENTS.md was not generated");
  if (readlinkSync(join(spawned.home, "CLAUDE.md")) !== "AGENTS.md") throw new Error("instance CLAUDE.md is not canonical");
  if (readFileSync(join(agent._dir, "soul", "AGENTS.md"), "utf8") !== canonical) throw new Error("spawn mutated packed canonical soul");
  if (!meta.capabilities.some((cap) => cap.id === "oas.okf") || !/--skill /.test(meta.command)) throw new Error("packed instance metadata/isolation missing");
  const doctor = JSON.parse(run(oas, ["doctor", modernRepo, "--soul", "probe", "--json"], { env: { ...env, PI_AGENTS_ROOT: agentsRoot }, capture: true }));
  if (!doctor.composedInstructions.includes("Canonical instructions") || !doctor.composedInstructions.includes("Knowledge: OKF")) throw new Error("packed doctor composition incomplete");
  core.retireInstance(agentsRoot, spawned.instance);
  if (existsSync(spawned.home)) throw new Error("packed probe did not retire cleanly");

  console.log(JSON.stringify({
    passed: true,
    kernelTarball: basename(kernelTgz), adapterTarball: basename(adapterTgz),
    initDoctor: true, exactSkills: skills, canonicalSoulUnchanged: true,
    adapterResolvedPackedKernel: true, cleanContractConfigAndSpawn: true,
  }, null, 2));
} finally {
  if (keep) console.error(`OAS_KEEP_SMOKE=1: retained ${room}`);
  else rmSync(room, { recursive: true, force: true });
}
