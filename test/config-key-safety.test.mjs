// Config keys are attacker-reachable strings. Every table they index must
// answer for its OWN entries and nothing else: `Object.prototype` supplies
// `constructor`, `toString`, `valueOf`, `hasOwnProperty` … to a plain-object
// lookup, and `__proto__` is not a key at all — assigning it rewrites the
// parsed object's prototype, so the entry disappears from `Object.keys` (past
// every validator) while still answering property reads.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  capabilityManifest, marketplaceCapabilities, parseYamlFlat, parseYamlNested,
  resolveCapabilities, resolveOasConfig, RUNTIME_PACKAGE_MANAGERS, validateConfigShape,
} from "../lib/core.mjs";
import { REQUIREMENT_MANAGERS, requirementInstallPlan } from "../lib/packages.mjs";

const CLI = resolve(new URL("../bin/oas.mjs", import.meta.url).pathname);
function temp() { return mkdtempSync(join(tmpdir(), "oas-keysafe-test-")); }
function write(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
/** Native function source text is what an inherited-name lookup leaks into a diagnostic. */
const NATIVE_SOURCE = /\[native code\]|function \w*\s*\(/;

test("inherited-name config keys get the ordinary unsupported-key diagnostic", () => {
  const file = join(temp(), "oas-config.yaml");
  for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
    const cfg = parseYamlNested(`${key}: x\n`);
    assert.deepEqual(Object.keys(cfg), [key]);
    assert.throws(() => validateConfigShape(cfg, file), (e) => {
      assert.equal(e.message, `unsupported oas-config key in ${file}: ${key}`);
      assert.doesNotMatch(e.message, NATIVE_SOURCE);
      return true;
    });
  }
  // The renamed-key table still answers for its own entries.
  assert.throws(() => validateConfigShape(parseYamlNested("groups:\n  devs: [dev]\n"), file), /unsupported oas-config key "groups".*agent-types/s);
  // …and inside a capability entry, where RENAMED_ENTRY_KEYS is indexed the same way.
  assert.throws(
    () => validateConfigShape(parseYamlNested("capabilities:\n  additive:\n    acme.thing:\n      constructor: x\n"), file),
    (e) => {
      assert.equal(e.message, `unsupported keys for capability acme.thing in ${file}: constructor`);
      assert.doesNotMatch(e.message, NATIVE_SOURCE);
      return true;
    });
  assert.throws(() => validateConfigShape(parseYamlNested("capabilities:\n  additive:\n    acme.thing:\n      injection: none\n"), file), /unsupported key "injection".*injection-override/s);
});

test("__proto__ is refused by every YAML reader and pollutes nothing", () => {
  const documents = [
    "__proto__:\n  polluted: true\n",                       // nested map
    "__proto__: {polluted: true}\n",                         // inline map
    "capabilities:\n  additive:\n    __proto__:\n      polluted: true\n", // nested under a real key
    'name: demo\n"__proto__": {polluted: true}\n',           // quoted spelling
  ];
  for (const doc of documents) {
    assert.throws(() => parseYamlNested(doc), (e) => {
      assert.equal(e.code, "unsafe-config-key");
      assert.match(e.message, /unsupported oas-config key "__proto__"/);
      return true;
    }, doc);
  }
  assert.throws(() => parseYamlFlat("__proto__: polluted\n"), (e) => e.code === "unsafe-config-key");
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal({}.polluted, undefined);
  // A template shipped as config source material is refused on the same path,
  // so it can neither mutate a prototype nor smuggle an unvalidated key past
  // validateConfigShape by vanishing from Object.keys.
  const file = join(temp(), "oas-config.yaml");
  assert.throws(() => validateConfigShape(parseYamlNested("__proto__: {name: smuggled}\n"), file), /unsupported oas-config key "__proto__"/);
  assert.equal(Object.prototype.name, undefined);
});

test("ordinary config parses unchanged (control)", () => {
  const cfg = parseYamlNested([
    "name: demo",
    "team:",
    "  name: Demo",
    "agent-types:",
    "  developers:",
    "    description: Devs",
    "capabilities:",
    "  layers:",
    "    knowledge:",
    "      capability: acme.knowledge",
    "      global: true",
    "  additive:",
    "    acme.chat:",
    "      souls: {dev: true}",
    "",
  ].join("\n"));
  assert.deepEqual(Object.keys(cfg), ["name", "team", "agent-types", "capabilities"]);
  assert.equal(cfg.name, "demo");
  assert.equal(cfg.team.name, "Demo");
  assert.equal(cfg.capabilities.layers.knowledge.capability, "acme.knowledge");
  assert.equal(cfg.capabilities.additive["acme.chat"].souls.dev, true);
  validateConfigShape(cfg, join(temp(), "oas-config.yaml"));
  assert.deepEqual(parseYamlFlat("type: developers\nruntime: pi\n"), { type: "developers", runtime: "pi" });
});

test("an inherited-name capability id is not acquired just because Object.prototype has it", () => {
  const repo = temp();
  // `constructor` and `toString` both satisfy the capability-id grammar, so the
  // manifest maps must report them as NOT acquired rather than hand back
  // Object.prototype.constructor as if it were a manifest.
  assert.equal(capabilityManifest("constructor", repo), undefined);
  assert.equal(capabilityManifest("toString", repo), undefined);
  assert.equal(marketplaceCapabilities().toString, undefined);
  write(join(repo, "oas-config.yaml"), "name: keysafe\ncapabilities:\n  additive:\n    constructor:\n      global: true\n");
  assert.throws(() => resolveOasConfig(repo, "dev"), /capability "constructor" is activated but no manifest was acquired/);
});

test("an inherited-name agent type is declarable, and refused only once really declared", () => {
  const repo = temp();
  write(join(repo, "oas-config.yaml"), "name: keysafe\nagent-types:\n  developers:\n    description: Devs\n");
  const r = spawnSync(process.execPath, [CLI, "type", "add", "constructor", "--description", "Odd but legal", "--dir", repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(repo, "oas-config.yaml"), "utf8"), / {2}constructor:\n {4}description: Odd but legal/);
  // Declared once, the second attempt IS refused — the own-property check still works.
  const again = spawnSync(process.execPath, [CLI, "type", "add", "constructor", "--dir", repo], { encoding: "utf8" });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /agent type "constructor" already declared/);
});

test("a soul named __proto__ gets no binding: targeting reads own properties only", () => {
  const repo = temp();
  write(join(repo, ".agents", "capabilities", "owned", "acme.x", "oas.json"),
    JSON.stringify({ capability: "acme.x", version: "1.0.0", description: "cap" }));
  write(join(repo, "oas-config.yaml"), [
    "name: keysafe",
    "capabilities:",
    "  additive:",
    "    acme.x:",
    "      from: owned",
    "      global: false",
    "      souls:",
    "        alice: true",
    "",
  ].join("\n"));

  // `souls.__proto__` is Object.prototype — an object, so `bindingObject`
  // accepted it and filed it at specificity 2 (the highest), overriding the
  // explicit global: false for a soul the config never mentions.
  const ids = (soul) => resolveCapabilities(repo, soul).map((c) => c.id);
  assert.deepEqual(ids("__proto__"), [], "an inherited soul name enabled an excluded capability");
  assert.deepEqual(ids("constructor"), []);
  assert.deepEqual(ids("hasOwnProperty"), []);
  // The declared soul still wins over the exclusion, unchanged.
  assert.deepEqual(ids("alice"), ["acme.x"]);
  assert.deepEqual(ids("bob"), []);
  assert.equal(Object.prototype.enabled, undefined);
});

test("an agent type named constructor is matched by declaration, never by inheritance", () => {
  const repo = temp();
  write(join(repo, ".agents", "capabilities", "owned", "acme.x", "oas.json"),
    JSON.stringify({ capability: "acme.x", version: "1.0.0", description: "cap" }));
  write(join(repo, "agents", "dev", "soul", "soul.yaml"), "name: dev\ntype: constructor\n");
  write(join(repo, "oas-config.yaml"), [
    "name: keysafe",
    "capabilities:",
    "  additive:",
    "    acme.x:",
    "      from: owned",
    "      global: false",
    "      agent-types:",
    "        constructor: true",
    "",
  ].join("\n"));
  // Declared: ordinary type targeting applies.
  assert.deepEqual(resolveCapabilities(repo, "dev").map((c) => c.id), ["acme.x"]);
  // Undeclared: a soul of ANOTHER type gets nothing, and no inherited name
  // stands in for the declaration.
  write(join(repo, "agents", "other", "soul", "soul.yaml"), "name: other\ntype: toString\n");
  assert.deepEqual(resolveCapabilities(repo, "other").map((c) => c.id), []);
});

test("a capability command namespace named constructor is not a duplicate of Object.prototype", () => {
  const repo = temp();
  write(join(repo, ".agents", "capabilities", "owned", "acme.x", "oas.json"),
    JSON.stringify({ capability: "acme.x", version: "1.0.0", description: "cap", command: "constructor" }));
  write(join(repo, "oas-config.yaml"), [
    "name: keysafe",
    "capabilities:",
    "  additive:",
    "    acme.x:",
    "      from: owned",
    "      global: true",
    "",
  ].join("\n"));
  // The owner table used to answer `Object` for "constructor", so a SINGLE
  // capability collided with the prototype and the diagnostic embedded native
  // function source.
  assert.deepEqual(resolveOasConfig(repo).capabilities.map((c) => c.command), ["constructor"]);
  // A REAL duplicate is still refused, and names only real owners.
  write(join(repo, ".agents", "capabilities", "owned", "acme.y", "oas.json"),
    JSON.stringify({ capability: "acme.y", version: "1.0.0", description: "cap", command: "constructor" }));
  writeFileSync(join(repo, "oas-config.yaml"),
    readFileSync(join(repo, "oas-config.yaml"), "utf8") + "    acme.y:\n      from: owned\n      global: true\n");
  assert.throws(() => resolveOasConfig(repo), (e) => {
    assert.match(e.message, /duplicate capability command namespace "constructor": acme\.[xy], acme\.[xy]/);
    assert.doesNotMatch(e.message, NATIVE_SOURCE);
    return true;
  });
});

test("manager allowlists answer for their own entries only", () => {
  assert.equal(RUNTIME_PACKAGE_MANAGERS.constructor, undefined);
  assert.deepEqual(Object.keys(RUNTIME_PACKAGE_MANAGERS).sort(), ["claude", "pi"]);
  assert.equal(REQUIREMENT_MANAGERS.constructor, undefined);
  // An inherited runtime name must fail the unknown-runtime gate, not sail
  // through it and then be dereferenced as a manager.
  const unknownRuntime = requirementInstallPlan({ runtime: "constructor", package: "x", why: "test" });
  assert.match(unknownRuntime.unavailable, /unknown runtime "constructor"/);
  // A non-allowlisted install method is ignored the ordinary way — not
  // dereferenced as `Function.prototype.toString` and reported as an internal
  // TypeError.
  const inheritedManager = requirementInstallPlan({ command: "tmux", install: { methods: [{ manager: "toString", package: "tmux" }] } });
  assert.equal(inheritedManager.argv, undefined);
  assert.equal(inheritedManager.unavailable, "no allowlisted install method for this host");
});
