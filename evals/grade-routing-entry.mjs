import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function assertRoutingEntry(input, allowed) {
  assert.ok(allowed.length > 0, "Missing allowed skill entries");
  assert.ok(Array.isArray(input.trajectory?.events), "Missing captured skill-activation evidence");
  const skills = new Set(input.trajectory.events
    .filter(event => event.type === "skill_activation")
    .map(event => event.data?.name));
  assert.ok(allowed.some(name => skills.has(name)), `Expected an actual skill activation: ${allowed.join(" or ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const input = JSON.parse(readFileSync(process.env.EVALUATE_GRADER_INPUT, "utf8"));
    assertRoutingEntry(input, process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Routing entry check failed");
    process.exitCode = 1;
  }
}
