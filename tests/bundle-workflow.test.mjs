import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(repoRoot, ".github", "workflows", "bundle-test.yml"), "utf8");

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

test("npm test includes root and nested Aspireify suites without an overridden script", () => {
  const source = readFileSync(join(repoRoot, "package.json"), "utf8");
  assert.equal(source.match(/"test"\s*:/g)?.length, 1);
  assert.equal(
    JSON.parse(source).scripts.test,
    "node --test tests/*.test.mjs tests/aspireify/*.test.mjs"
  );
  assert.match(workflow, /run: npm test/);
});
