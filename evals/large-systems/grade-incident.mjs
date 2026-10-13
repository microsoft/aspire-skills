import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertIncidentResponse } from "./incident-contract.mjs";

const input = JSON.parse(readFileSync(process.env.EVALUATE_GRADER_INPUT, "utf8"));
const topology = JSON.parse(readFileSync(join(process.env.EVALUATE_WORKSPACE, "topology.json"), "utf8"));
try {
  assertIncidentResponse(input, process.argv[2], topology);
} catch (error) {
  // A rejected candidate is a grading verdict, not a grader infrastructure error.
  console.log(JSON.stringify({ name: "incident-contract", kind: "code", passed: false, score: 0, evidence: error.message }));
}
