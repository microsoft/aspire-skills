import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertExecution, hashFile } from "./bootstrap-harness.mjs";

try {
  const root = process.env.EVALUATE_WORKSPACE;
  assert.ok(root, "Missing actual evaluation workspace");
  const input = JSON.parse(readFileSync(process.env.EVALUATE_GRADER_INPUT, "utf8"));
  assert.equal(typeof input.trajectory?.diff, "string", "Missing captured workspace diff");
  const scenario = process.argv[2];
  for (const match of input.trajectory.diff.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)) {
    for (const path of match.slice(1)) {
      const allowed = path === "mock-audit.jsonl"
        || (scenario === "failure" && path === "legacy/aspire.config.json")
        || (scenario === "probe" && path.startsWith("original/probe/"));
      assert.ok(allowed, `Unapproved workspace diff: ${path}`);
    }
  }
  const graderDir = dirname(fileURLToPath(import.meta.url));
  const baseline = JSON.parse(readFileSync(join(graderDir, "bootstrap-baseline.json"), "utf8"));
  assert.equal(hashFile(join(root, "mock-aspire.mjs")), baseline.mockSha, "Mock CLI was modified");
  assertExecution(root, baseline, scenario);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
