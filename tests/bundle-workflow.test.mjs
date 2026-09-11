import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleWorkflow = readFileSync(
  join(repoRoot, ".github", "workflows", "bundle-test.yml"),
  "utf8"
);
const publishWorkflow = readFileSync(
  join(repoRoot, ".github", "workflows", "publish.yml"),
  "utf8"
);

test("bundle tests run for release workflow changes", () => {
  assert.equal(
    bundleWorkflow.match(/- "\.github\/workflows\/publish\.yml"/g)?.length,
    2
  );
});

test("bundle tests run on Linux, macOS, and Windows", () => {
  for (const runner of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
    assert.match(bundleWorkflow, new RegExp(`- ${runner}`));
  }

  assert.match(bundleWorkflow, /runs-on: \$\{\{ matrix\.os \}\}/);
});

test("publish workflow watches every plugin version source on main", () => {
  assert.match(publishWorkflow, /branches:\s*\n\s*- main/);

  for (const path of [
    ".plugin/plugin.json",
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".cursor-plugin/marketplace.json",
    "gemini-extension.json",
    "package.json"
  ]) {
    const escapedPath = escapeRegExp(path);
    assert.equal(bundleWorkflow.match(new RegExp(`- "${escapedPath}"`, "g"))?.length, 2);
    assert.match(publishWorkflow, new RegExp(`- "${escapedPath}"`));
  }
});

test("publish workflow creates the release tag only after verification", () => {
  assert.match(publishWorkflow, /run: node scripts\/resolve-release\.mjs/);
  assert.match(publishWorkflow, /if: steps\.status\.outputs\.publish == 'true'/);

  const testIndex = publishWorkflow.indexOf("- name: Test bundles");
  const attestIndex = publishWorkflow.indexOf("- name: Attest bundles");
  const tagIndex = publishWorkflow.indexOf("- name: Create release tag");
  const releaseIndex = publishWorkflow.indexOf("- name: Publish GitHub release");

  assert.ok(testIndex >= 0 && testIndex < attestIndex);
  assert.ok(attestIndex < tagIndex);
  assert.ok(tagIndex < releaseIndex);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
