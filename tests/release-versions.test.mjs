import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = path => JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
const version = readJson("package.json").version;

test("package, lockfile, plugin, marketplace, and Gemini versions stay aligned", () => {
  const lockfile = readJson("package-lock.json");
  assert.equal(lockfile.version, version, "lockfile version");
  assert.equal(lockfile.packages[""].version, version, "lockfile root package version");

  for (const path of [".plugin/plugin.json", ".claude-plugin/plugin.json", "gemini-extension.json"]) {
    assert.equal(readJson(path).version, version, path);
  }

  for (const path of [".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json"]) {
    const plugins = readJson(path).plugins;
    const plugin = plugins.find(entry => entry.name === "aspire");
    assert.ok(plugin, `${path} must contain the aspire plugin`);
    assert.equal(plugin.version, version, `${path}: aspire`);
  }
});

test("every shipped skill version matches the package", () => {
  const skillsRoot = join(repoRoot, "skills");
  const skills = readdirSync(skillsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory());
  assert.ok(skills.length > 0, "at least one shipped skill is required");

  for (const skill of skills) {
    const source = readFileSync(join(skillsRoot, skill.name, "SKILL.md"), "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
    assert.ok(frontmatter, `${skill.name} must have frontmatter`);
    assert.equal(parse(frontmatter[1]).metadata.version, version, skill.name);
  }
});
