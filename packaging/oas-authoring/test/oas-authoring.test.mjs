import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "SKILL.md needs YAML frontmatter");
  const name = match[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = match[1].match(/^description:\s*(.*)$/m)?.[1]?.trim();
  return { name, description, raw: match[1] };
}

test("flat capability manifest names all three canonical root skills", () => {
  const outer = JSON.parse(read("oas-package.json"));
  const capability = JSON.parse(read("oas.json"));
  assert.deepEqual(outer.capabilities, ["."]);
  assert.deepEqual(capability.skills, [
    "skills/integration-authoring",
    "skills/skill-craft",
    "skills/soul-craft",
  ]);
  assert.equal(capability.skills.some((path) => path.includes("..")), false);
});

test("packaged Agent Skill names match their directories", () => {
  for (const name of ["integration-authoring", "skill-craft", "soul-craft"]) {
    const skill = read("skills", name, "SKILL.md");
    const meta = frontmatter(skill);
    assert.equal(meta.name, name);
    assert.match(meta.raw, /description:/);
    assert.ok(skill.split("\n").length <= 500, `${name} exceeds the skill-craft size limit`);
  }
});

test("integration delegation uses the public CLI, not private kernel files", () => {
  const skill = read("skills", "integration-authoring", "SKILL.md");
  assert.match(skill, /oas spawn integrations-expert/);
  assert.doesNotMatch(skill, /lib\/core\.mjs/);
  assert.doesNotMatch(skill, /<framework-repo>/);
  assert.match(skill, /\.agents\/capabilities\/owned\/<name>/);
});

test("authoring skills preserve the instruction-skill-knowledge boundary", () => {
  assert.match(read("skills", "skill-craft", "SKILL.md"), /Repeatable procedure.*skill/);
  assert.match(read("skills", "soul-craft", "SKILL.md"), /The three-layer rule/);
});
