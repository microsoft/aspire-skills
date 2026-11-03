import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

test("tests cover release PRs without duplicate release-branch push runs", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8"));

  assert.deepEqual(workflow.on, {
    pull_request: { branches: ["main", "dev", "release/**"] },
    push: { branches: ["main", "dev"] }
  });
  assert.deepEqual(workflow.jobs.test.strategy.matrix.os, [
    "ubuntu-latest", "macos-latest", "windows-latest"
  ]);
});
