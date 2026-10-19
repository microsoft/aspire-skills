import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(repoRoot, ".github", "workflows", "bundle-test.yml"), "utf8");
const events = parse(workflow).on;

test("bundle tests run for release workflow changes", () => {
  assert.equal(
    workflow.match(/- "\.github\/workflows\/publish\.yml"/g)?.length,
    2
  );
});

test("bundle tests run on Linux, macOS, and Windows", () => {
  for (const runner of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
    assert.match(workflow, new RegExp(`- ${runner}`));
  }

  assert.match(workflow, /runs-on: \$\{\{ matrix\.os \}\}/);
});

test("extension source and plugin mirror changes trigger pull request and main tests", () => {
  assert.equal(workflow.match(/- "extensions\/\*\*"/g)?.length, 2);
  assert.equal(
    workflow.match(/- "\.github\/plugins\/aspire-skills\/extensions\/\*\*"/g)?.length,
    2
  );
});

for (const event of ["pull_request", "push"]) {
  test(`${event} bundle tests cover every release version source`, () => {
    const paths = events[event].paths;
    for (const path of [
      "package.json",
      "package-lock.json",
      ".plugin/plugin.json",
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      ".cursor-plugin/marketplace.json",
      "gemini-extension.json",
      "skills/*/SKILL.md"
    ]) {
      assert.ok(paths.includes(path), `${event} must trigger for ${path}`);
    }
  });
}

test("npm test includes root and nested Aspireify suites without an overridden script", () => {
  const source = readFileSync(join(repoRoot, "package.json"), "utf8");
  assert.equal(source.match(/"test"\s*:/g)?.length, 1);
  assert.equal(
    JSON.parse(source).scripts.test,
    "node --test tests/*.test.mjs tests/aspireify/*.test.mjs"
  );
});

test("bundle workflow runs the shared validation command", () => {
  assert.match(workflow, /run: npm test/);
});
