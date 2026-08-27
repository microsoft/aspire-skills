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
