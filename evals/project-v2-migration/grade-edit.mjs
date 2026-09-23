import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDiffBoundary, assertEditedFixture, editCases } from "./project-v2-edit-contract.mjs";

let baseline;
try {
  const input = JSON.parse(readFileSync(process.env.EVALUATE_GRADER_INPUT, "utf8"));
  const workspace = process.env.EVALUATE_WORKSPACE;
  if (!workspace || typeof input.trajectory?.diff !== "string") {
    throw new Error("Missing actual workspace or captured diff; configure a diff grader.");
  }
  const { diff } = input.trajectory;
  const caseName = process.argv[2];
  assertDiffBoundary(diff, editCases[caseName]?.files ?? []);
  baseline = mkdtempSync(join(tmpdir(), "project-v2-baseline-"));
  cpSync(join(workspace, "app"), join(baseline, "app"), { recursive: true, dereference: false });
  execFileSync("git", ["apply", "--reverse", "--check", "-"], { cwd: baseline, input: diff });
  execFileSync("git", ["apply", "--reverse", "-"], { cwd: baseline, input: diff });
  assertEditedFixture(join(baseline, "app"), join(workspace, "app"), caseName, diff);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (baseline) rmSync(baseline, { recursive: true, force: true });
}
