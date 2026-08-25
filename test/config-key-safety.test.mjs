// Config keys are attacker-reachable strings. Every table they index must
// answer for its OWN entries and nothing else: `Object.prototype` supplies
// `constructor`, `toString`, `valueOf`, `hasOwnProperty` … to a plain-object
// lookup, and `__proto__` is not a key at all — assigning it rewrites the
// parsed object's prototype, so the entry disappears from `Object.keys` (past
// every validator) while still answering property reads.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  capabilityManifest, marketplaceCapabilities, parseYamlFlat, parseYamlNested,
  resolveCapabilities, resolveOasConfig, RUNTIME_PACKAGE_MANAGERS, validateConfigShape, withConfigFile,
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
      assert.match(e.message, /unsupported mapping key "__proto__"/);
      // The raw reader parses a STRING and cannot name the document, so it must
      // not claim the document is an oas-config: soul.yaml and skill
      // frontmatter go through the same readers. The file is added by whoever
      // holds the path.
      assert.doesNotMatch(e.message, /oas-config key/);
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
  assert.throws(() => validateConfigShape(parseYamlNested("__proto__: {name: smuggled}\n"), file), /unsupported mapping key "__proto__"/);
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

test("oas init: an inherited-name layer flag is unknown-capability, not a prototype dereference", () => {
  const dir = temp();
  // `oas init` merges three manifest maps for the `--<layer>` lookup. Spreading
  // them into an object literal re-plainified the null prototypes, so
  // `mans["constructor"]` answered Object.prototype.constructor and the run
  // bailed with a LAYER MISMATCH for a capability that does not exist.
  const env = { ...process.env, HOME: temp(), OAS_HOME_DIR: join(temp(), ".oas") };
  for (const k of Object.keys(env)) if (/^(OAS|PI)_/.test(k) && k !== "OAS_HOME_DIR") delete env[k];
  const r = spawnSync(process.execPath, [CLI, "init", "--raw", "--knowledge", "constructor", "--dir", dir, "--json"], { encoding: "utf8", env });
  assert.notEqual(r.status, 0, r.stdout);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.ok, false);
  assert.equal(doc.error.code, "E_UNKNOWN_CAPABILITY", doc.error.message);
  assert.doesNotMatch(doc.error.message, NATIVE_SOURCE);
});

/** A hermetic CLI run: the config/lock walk climbs to `/`, so a developer's own
 * ~/oas-config.yaml must not decide what a case sees. */
function runCli(argv, cwd) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(OAS|PI)_/.test(k)) env[k] = v;
  const home = temp();
  Object.assign(env, { HOME: home, OAS_HOME_DIR: join(home, ".oas") });
  return spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8", env, cwd: cwd || home });
}
/** A Node crash: an uncaught throw prints the source frame and a stack. */
const NODE_STACK = /^\s+at |\bthrow oasError\b|node:internal/m;

test("an unsafe config key is a typed CLI failure, not an uncaught stack", () => {
  const dir = temp();
  write(join(dir, "oas-config.yaml"), "name: demo\n__proto__:\n  polluted: true\n");

  for (const argv of [["doctor", dir], ["use", "acme.x", "--dir", dir]]) {
    const human = runCli(argv, dir);
    assert.notEqual(human.status, 0, human.stdout);
    assert.doesNotMatch(human.stderr, NODE_STACK, `${argv[0]} crashed instead of reporting`);
    assert.equal(human.stderr.trim().split("\n").length, 1, human.stderr);
    assert.match(human.stderr, /^oas: unsupported mapping key "__proto__" in /);
    assert.ok(human.stderr.includes(join(dir, "oas-config.yaml")), "the message must name the offending file");

    const json = runCli([...argv, "--json"], dir);
    assert.notEqual(json.status, 0, json.stdout);
    assert.doesNotMatch(json.stderr, NODE_STACK);
    const doc = JSON.parse(json.stdout);
    assert.equal(json.stdout.trim(), JSON.stringify(doc), "exactly one envelope on stdout");
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.ok, false);
    assert.equal(doc.error.code, "unsafe-config-key", doc.error.message);
    assert.ok(doc.error.message.includes(join(dir, "oas-config.yaml")));
  }
});

test("write paths refuse an unsafe key instead of dropping it and reporting success", () => {
  const dir = temp();
  write(join(dir, ".agents", "capabilities", "owned", "acme.x", "oas.json"),
    JSON.stringify({ capability: "acme.x", version: "1.0.0", description: "cap" }));
  write(join(dir, "oas-config.yaml"), "name: demo\n");

  // The inherited setter swallowed the assignment, so the entry never reached
  // the file — and the command still printed "Activated".
  for (const argv of [
    ["use", "acme.x", "--dir", dir, "--settings", "__proto__=x"],
    ["use", "acme.x", "--dir", dir, "--soul", "__proto__"],
    ["use", "acme.x", "--dir", dir, "--type", "__proto__"],
  ]) {
    const r = runCli(argv, dir);
    assert.notEqual(r.status, 0, `${argv.join(" ")} => ${r.stdout}`);
    assert.doesNotMatch(r.stderr, NODE_STACK);
    assert.match(r.stderr, /^oas: unsupported mapping key "__proto__"/);
    assert.doesNotMatch(r.stdout, /Activated/);
  }
  assert.equal(Object.prototype.x, undefined);
  assert.equal({}.x, undefined);
  // The ordinary write still works, and the refusals left nothing behind.
  const ok = runCli(["use", "acme.x", "--dir", dir, "--settings", "mode=fast"], dir);
  assert.equal(ok.status, 0, ok.stderr);
  const written = readFileSync(join(dir, "oas-config.yaml"), "utf8");
  assert.match(written, /mode: fast/);
  assert.doesNotMatch(written, /__proto__/);
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

test("a poisoned agent-def frontmatter names the FILE, and keeps its own code through spawn", () => {
  const dir = temp();
  write(join(dir, "oas-config.yaml"), "name: demo\n");
  // One real soul, so `oas status` reaches the importable-defs section.
  write(join(dir, "agents", "dev", "soul", "soul.yaml"), "name: dev\n");
  const def = join(dir, ".claude", "agents", "ghost.md");
  write(def, "---\nname: ghost\n__proto__: polluted\ndescription: d\n---\nBody\n");

  // `oas status` walks .claude/agents and .agents/agents from cwd upward. The
  // reader's raw message can only say "a mapping key"; the operator needs the
  // one file among many that carries it.
  const human = runCli(["status", "--dir", dir], dir);
  assert.notEqual(human.status, 0, human.stdout);
  assert.doesNotMatch(human.stderr, NODE_STACK, "status crashed instead of reporting");
  assert.match(human.stderr, /^oas: unsupported mapping key "__proto__" in /);
  assert.ok(human.stderr.includes(def), `the message must name the agent def file: ${human.stderr}`);

  // Through spawn the typed failure keeps ITS OWN code: E_SPAWN_FAILED told an
  // agent consumer the spawn mechanism broke, when the fixable fact is a
  // poisoned document the message already names.
  const json = runCli(["spawn", "ghost", "--dir", dir, "--no-launch", "--json"], dir);
  assert.notEqual(json.status, 0, json.stdout);
  assert.doesNotMatch(json.stderr, NODE_STACK);
  const doc = JSON.parse(json.stdout);
  assert.equal(json.stdout.trim(), JSON.stringify(doc), "exactly one envelope on stdout");
  assert.equal(doc.ok, false);
  assert.equal(doc.error.code, "unsafe-config-key", doc.error.message);
  assert.ok(doc.error.message.includes(def), doc.error.message);
  assert.equal(Object.prototype.polluted, undefined);
});

test("a poisoned --def-file names the file too: the import reader is wrapped as well", () => {
  const dir = temp();
  write(join(dir, "oas-config.yaml"), "name: demo\n");
  mkdirSync(join(dir, "agents"), { recursive: true });
  // Deliberately NOT under .claude/agents — this is the upsertLocalAgent read,
  // not the roster walk.
  const def = join(dir, "defs", "imported.md");
  write(def, "---\nname: imported\n__proto__: polluted\n---\nBody\n");

  const json = runCli(["spawn", "imported", "--def-file", def, "--dir", dir, "--no-launch", "--json"], dir);
  assert.notEqual(json.status, 0, json.stdout);
  assert.doesNotMatch(json.stderr, NODE_STACK);
  const doc = JSON.parse(json.stdout);
  assert.equal(doc.error.code, "unsafe-config-key", doc.error.message);
  assert.ok(doc.error.message.includes(def), doc.error.message);
});

test("the reported filename is the path itself, even when it contains regex substitution syntax", () => {
  // `$&`, `$'`, "$`" and `$1` are substitution syntax in String.replace, so
  // inserting the path as a REPLACEMENT STRING expanded them against the match
  // and corrupted the reported filename. A replacer function passes it as data.
  const weird = "/tmp/$&$'$`$1/oas-config.yaml";
  assert.throws(() => withConfigFile(weird, () => parseYamlNested("__proto__: x\n")), (e) => {
    assert.equal(e.code, "unsafe-config-key");
    assert.ok(e.message.includes(weird), e.message);
    assert.deepEqual(e.provenance, [{ file: weird }]);
    return true;
  });

  // End to end, with a real directory whose name carries the same characters.
  const dir = join(temp(), "$&$'dollar");
  const file = join(dir, "oas-config.yaml");
  write(file, "name: demo\n__proto__:\n  polluted: true\n");
  const r = runCli(["doctor", dir], dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.ok(r.stderr.includes(file), r.stderr);
});

test("a config write refuses text that cannot stay one YAML scalar — no injected document, nothing written", () => {
  const dir = temp();
  write(join(dir, ".agents", "capabilities", "owned", "acme.x", "oas.json"),
    JSON.stringify({ capability: "acme.x", version: "1.0.0", description: "cap" }));
  write(join(dir, "oas-config.yaml"), "name: demo\n");
  const file = join(dir, "oas-config.yaml");
  const before = readFileSync(file, "utf8");

  // THE attack: the value is rendered verbatim onto one `key: value` line, so a
  // newline plus indentation stops being a value and becomes more document —
  // here a whole second capability entry the operator never wrote (which the
  // next read then served, and doctor crashed on).
  const injected = "fast\n    acme.injected:\n      from: owned\n      global: true";
  const refusals = [
    [["use", "acme.x", "--global", "--dir", dir, "--settings", `mode=${injected}`], "unsafe-config-value"],
    [["use", "acme.x", "--global", "--dir", dir, "--settings", `mode=x\rzz`], "unsafe-config-value"],
    [["use", "acme.x", "--global", "--dir", dir, "--settings", "mode=\tindented"], "unsafe-config-value"],
    [["use", "acme.x", "--global", "--dir", dir, "--settings", "mode=| block"], "unsafe-config-value"],
    [["use", "acme.x", "--global", "--dir", dir, "--settings", "mode={a: b}"], "unsafe-config-value"],
    [["use", "acme.x", "--global", "--dir", dir, "--settings", "mode= padded"], "unsafe-config-value"],
    // A KEY is written as a mapping key, so the same text injects the same way.
    [["use", "acme.x", "--global", "--dir", dir, "--settings", `${injected}=x`], "unsafe-config-key"],
    [["use", "acme.x", "--global", "--dir", dir, "--settings", "a:b=x"], "unsafe-config-key"],
    // …and so does a --soul / --type NAME.
    [["use", "acme.x", "--dir", dir, "--soul", "alice\n    acme.injected:\n      global: true"], "unsafe-config-key"],
    [["use", "acme.x", "--dir", dir, "--type", "devs\n    acme.injected:\n      global: true"], "unsafe-config-key"],
    // `oas type add --description` writes its own line too.
    [["type", "add", "devs", "--description", "d\nteam:\n  name: Smuggled"], "unsafe-config-value"],
    // Line breaks OUTSIDE the C0 range. U+2028/U+2029 are excluded by
    // JavaScript's `.`, so the written line no longer matched the reader's own
    // `key: value` regex and `parseYamlNested` DROPPED it — the command
    // reported success for a setting that did not exist afterwards, and the
    // same silent drop on `--disable --soul` is fail-open. U+0085 survives this
    // reader but is a line break to a conforming YAML parser.
    [["use", "acme.x", "--global", "--dir", dir, "--settings", `mode=a\u2028b`], "unsafe-config-value"],
    [["use", "acme.x", "--global", "--dir", dir, "--settings", `mode=a\u2029b`], "unsafe-config-value"],
    [["use", "acme.x", "--global", "--dir", dir, "--settings", `mode=a\u0085b`], "unsafe-config-value"],
    [["use", "acme.x", "--dir", dir, "--soul", `alice\u2028bob`], "unsafe-config-key"],
    [["type", "add", "devs", "--description", `d\u2028e`], "unsafe-config-value"],
    // Two values that were WRITTEN but did not come back: a plain scalar ends
    // at " #" (the rest is a comment the read strips), and `key:` with nothing
    // after it reads back as an empty MAP, not an empty string.
    [["use", "acme.x", "--global", "--dir", dir, "--settings", "mode=a #c"], "unsafe-config-value"],
    [["use", "acme.x", "--global", "--dir", dir, "--settings", "mode="], "unsafe-config-value"],
  ];
  for (const [argv, code] of refusals) {
    const r = runCli(argv, dir);
    assert.notEqual(r.status, 0, `${argv.join(" ")} => ${r.stdout}`);
    assert.doesNotMatch(r.stderr, NODE_STACK, argv.join(" "));
    assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
    assert.doesNotMatch(r.stdout, /Activated|Excluded|Declared/, argv.join(" "));
    assert.equal(readFileSync(file, "utf8"), before, `nothing may be written: ${argv.join(" ")}`);

    const json = runCli([...argv, "--json"], dir);
    assert.notEqual(json.status, 0, json.stdout);
    assert.doesNotMatch(json.stderr, NODE_STACK);
    const doc = JSON.parse(json.stdout);
    assert.equal(json.stdout.trim(), JSON.stringify(doc), "exactly one envelope on stdout");
    assert.equal(doc.ok, false);
    assert.equal(doc.error.code, code, doc.error.message);
    assert.equal(readFileSync(file, "utf8"), before, `--json must not write either: ${argv.join(" ")}`);
  }

  // The other direction: ordinary values, including ones with characters that
  // are only structural in FIRST position, still round-trip.
  const ok = runCli(["use", "acme.x", "--global", "--dir", dir,
    "--settings", "mode=fast", "path=/usr/local/bin", "note=a-b_c.d", "expr=2 > 1", "tag=v1.0#build", "list=a,b"], dir);
  assert.equal(ok.status, 0, ok.stderr);
  const written = readFileSync(file, "utf8");
  assert.doesNotMatch(written, /acme\.injected|Smuggled/, "no refusal leaked into the file");
  const round = parseYamlNested(written).capabilities.additive["acme.x"].settings;
  assert.deepEqual(round, { mode: "fast", path: "/usr/local/bin", note: "a-b_c.d", expr: "2 > 1", tag: "v1.0#build", list: "a,b" });

  const okSoul = runCli(["use", "acme.x", "--dir", dir, "--soul", "alice"], dir);
  assert.equal(okSoul.status, 0, okSoul.stderr);
  assert.equal(parseYamlNested(readFileSync(file, "utf8")).capabilities.additive["acme.x"].souls.alice, true);
  const okType = runCli(["type", "add", "devs", "--description", "The dev family", "--dir", dir], dir);
  assert.equal(okType.status, 0, okType.stderr);
  assert.equal(parseYamlNested(readFileSync(file, "utf8"))["agent-types"].devs.description, "The dev family");
});

test("a directory basename is DATA on every write path: replacement syntax is stored literally", () => {
  // `$&`, `$'`, `` $` `` and `$1` are substitution syntax in String.replace, and
  // all four are legal POSIX filename characters. `oas init --template` seeded
  // the scaffolded name with a replacement STRING, so a directory named `x$&y`
  // persisted `name: xname: <template's name>y` — a corrupted config on disk,
  // not just a corrupted message.
  const base = temp();
  const template = join(base, "template.yaml");
  write(template, "name: template-name\ncapabilities:\n  additive: {}\n");
  for (const name of ["x$&y", "x$`y", "x$'y", "x$1y", "x$$y", "plain"]) {
    const dir = join(base, `run-${Buffer.from(name).toString("hex")}`, name);
    mkdirSync(dir, { recursive: true });
    const r = runCli(["init", "--template", template, "--dir", dir, "--no-tmux-mouse"], dir);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    const written = readFileSync(join(dir, "oas-config.yaml"), "utf8");
    assert.ok(written.includes(`name: ${name}\n`), `${name} was not written literally: ${JSON.stringify(written.split("\n")[1])}`);
    assert.equal(parseYamlNested(written).name, name, `${name} did not read back`);
    assert.doesNotMatch(written, /template-name/, `${name} leaked the template's own name`);
  }
});

test("a directory basename that cannot stay one YAML scalar refuses the whole init", () => {
  const base = temp();
  // THE attack: the scaffolded `name:` line is the one config value that comes
  // from the FILESYSTEM rather than from a flag, and it was written verbatim. A
  // basename carrying a newline plus a top-level block therefore smuggled real
  // configuration — here a `team:` block — into a config the operator never
  // wrote. A `#`-leading basename is the quieter half: it writes a value the
  // next read sees as a comment, i.e. an empty map.
  // No "/" anywhere: a slash would end the basename and defuse the case by
  // accident rather than by the guard.
  const smuggled = "acme\nteam:\n  name: Smuggled";
  for (const [name, why] of [[smuggled, "newline"], ["#acme", "comment introducer"], ["  padded  ", "surrounding whitespace"], ["{a: b}", "flow mapping"]]) {
    const dir = join(base, `run-${Buffer.from(name).toString("hex")}`, name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "oas-config.yaml");

    const r = runCli(["init", "--raw", "--dir", dir, "--no-tmux-mouse"], dir);
    assert.notEqual(r.status, 0, `${why}: init must refuse — ${r.stdout}`);
    assert.doesNotMatch(r.stderr, NODE_STACK, why);
    assert.ok(r.stderr.includes(JSON.stringify(name)), `${why}: the refusal must name the offending basename — ${r.stderr}`);
    assert.equal(existsSync(file), false, `${why}: nothing may be written`);

    const json = runCli(["init", "--raw", "--dir", dir, "--no-tmux-mouse", "--json"], dir);
    assert.notEqual(json.status, 0, json.stdout);
    const doc = JSON.parse(json.stdout);
    assert.equal(doc.ok, false);
    assert.equal(doc.error.code, "unsafe-config-value", doc.error.message);
    assert.equal(existsSync(file), false, `${why}: --json must not write either`);
  }

  // Control: an ordinary basename still scaffolds, and the smuggled text never
  // reaches disk by any route.
  const okDir = join(base, "ordinary-scope");
  mkdirSync(okDir, { recursive: true });
  const ok = runCli(["init", "--raw", "--dir", okDir, "--no-tmux-mouse"], okDir);
  assert.equal(ok.status, 0, ok.stderr);
  const written = readFileSync(join(okDir, "oas-config.yaml"), "utf8");
  assert.equal(parseYamlNested(written).name, "ordinary-scope");
  assert.doesNotMatch(written, /Smuggled/);
});
