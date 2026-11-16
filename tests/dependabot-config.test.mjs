import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("dependabot updates target dev because main only accepts release branches", () => {
  const config = parse(readFileSync(join(repoRoot, ".github", "dependabot.yml"), "utf8"));
  const releaseGuard = readFileSync(join(repoRoot, ".github", "workflows", "release-branch-check.yml"), "utf8");

  assert.match(releaseGuard, /PRs into main must come from a release\/<version> branch/);
  assert.ok(Array.isArray(config.updates) && config.updates.length > 0);
  for (const update of config.updates) {
    assert.equal(update["target-branch"], "dev", `${update["package-ecosystem"]} updates must target dev`);
  }
});
