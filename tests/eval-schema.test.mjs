import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const skills = [
  "aspire",
  "aspire-deployment",
  "aspire-init",
  "aspire-monitoring",
  "aspire-orchestration",
  "aspireify"
];

for (const skill of skills) {
  const specUrl = new URL(`../skills/${skill}/evals/eval.yaml`, import.meta.url);

  test(`${skill} eval grader names are valid and unique`, async () => {
    const source = await readFile(specUrl, "utf8");
    // Guard the canonical specs' block-style grader names without a YAML dependency.
    // Stimulus names are intentionally excluded; vally lint checks the full schema.
    const names = [...source.matchAll(/^ {8}name:\s*(.+)$/gm)]
      .map((match) => match[1].trim().replace(/^(['"])(.*)\1$/, "$2"));

    assert.ok(names.length > 0, "expected named graders in the eval spec");
    for (const name of names) {
      assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `invalid grader name: ${name}`);
      assert.ok(name.length <= 60, `grader name exceeds 60 characters: ${name}`);
    }
    assert.equal(new Set(names).size, names.length, "grader names must be unique across the eval");
  });

  test(`${skill} eval does not use the removed expect_skills constraint`, async () => {
    const source = await readFile(specUrl, "utf8");
    assert.doesNotMatch(source, /^\s*expect_skills\s*:/m,
      "use a skill-invocation grader with config.required instead");
  });
}
