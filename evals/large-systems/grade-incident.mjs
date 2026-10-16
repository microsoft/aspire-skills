import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertIncidentResponse } from "./incident-contract.mjs";

const input = JSON.parse(readFileSync(process.env.EVALUATE_GRADER_INPUT, "utf8"));
const sourceFiles = Object.fromEntries(["topology.json", "incident.json", "response-contract.md"]
  .map(file => [file, readFileSync(join(process.env.EVALUATE_WORKSPACE, file), "utf8")]));
const topology = JSON.parse(sourceFiles["topology.json"]);
try {
  assertIncidentResponse(input, process.argv[2], topology, sourceFiles);
} catch (error) {
  // A rejected candidate is a grading verdict, not a grader infrastructure error.
  console.log(JSON.stringify({ name: "incident-contract", kind: "code", passed: false, score: 0, evidence: error.message }));
}
