import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { compareVersions, parseVersion, updateVersion } from "../scripts/release-versions.mjs";

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

test("version updates preserve formatting and unrelated version-like text", () => {
  const input = Buffer.from('{\r\n  "version": "0.0.4", "description": "0.0.4"\r\n}\r\n');
  assert.equal(updateVersion(input, "package.json", "0.0.5").toString(),
    '{\r\n  "version": "0.0.5", "description": "0.0.4"\r\n}\r\n');
});

test("the release branch check accepts a branch for every valid release version", () => {
  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release-branch-check.yml"), "utf8");
  const pattern = new RegExp(/=~ (\^release\/\S+\$) \]\]/.exec(workflow)[1]);
  for (const value of ["0.0.5", "0.0.5-rc.1", "0.0.5+build.1", "0.0.5-rc.1+build.1"]) {
    parseVersion(value);
    assert.match(`release/${value}`, pattern);
  }
  for (const value of ["release/v0.0.5", "release/0.0.5/extra", "feature/0.0.5", "release/0.0"]) {
    assert.doesNotMatch(value, pattern);
  }
});

test("development versions use SemVer ordering and reject malformed inputs", () => {
  assert.equal(compareVersions("0.0.5", "0.0.4"), 1);
  assert.equal(compareVersions("0.0.5-preview.1", "0.0.5"), -1);
  assert.equal(compareVersions("0.0.5+build", "0.0.5"), 0);
  for (const value of ["v0.0.5", "0.0.5\n", "01.0.0"]) assert.throws(() => parseVersion(value));
});
