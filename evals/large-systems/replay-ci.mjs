import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { assertIncidentResponse } from "./incident-contract.mjs";

const [, , resultsPath, sourceCommit] = process.argv;
assert.ok(resultsPath, "Provide the downloaded results.jsonl path");
assert.match(sourceCommit ?? "", /^[0-9a-f]{40}$/, "Provide the exact evaluated commit SHA");
const directory = dirname(resolve(resultsPath));
let accepted = 0;
let rejected = 0;
for (const record of readFileSync(resultsPath, "utf8").split("\n").filter(Boolean).map(JSON.parse)) {
  if (record.type !== "trial-result" || !record.stimulus.startsWith("mon-large-")) continue;
  const caseName = record.stimulus.slice("mon-large-".length);
  const trajectory = record.trajectory;
  assert.ok(trajectory?.diffPath, "Captured trajectory has no persisted workspace diff");
  const diffPath = resolve(directory, trajectory.diffPath);
  const diffRelative = relative(directory, diffPath);
  assert.ok(!isAbsolute(diffRelative) && diffRelative !== ".." && !diffRelative.startsWith(`..${sep}`),
    "Diff escapes the artifact directory");
  trajectory.diff = readFileSync(diffPath, "utf8");
  const sources = Object.fromEntries(["incident.json", "topology.json", "response-contract.md"].map(file => {
    const path = file === "incident.json" ? `incidents/${caseName}.json` : file;
    return [file, execFileSync("git", ["show", `${sourceCommit}:evals/large-systems/${path}`], { encoding: "utf8" })];
  }));
  // Reproduce Vally's disposable-copy relocation, leaving captured events intact.
  trajectory.workDir = resolve(directory, "vally-grade-view-replay");
  try {
    assertIncidentResponse(record, caseName, JSON.parse(sources["topology.json"]), sources);
    accepted++;
    console.log(`${caseName}: accepted`);
  } catch (error) {
    rejected++;
    console.log(`${caseName}: rejected: ${error.message}`);
  }
}
assert.equal(accepted + rejected, 24, "Expected all 24 captured incident trials");
console.log(`Replayed 24 captured structural verdicts: ${accepted} accepted, ${rejected} rejected. Semantic verdicts were not rerun.`);
