import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillSpecs = readdirSync(join(root, "skills"), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => join("skills", entry.name, "evals", "eval.yaml"))
  .filter(path => existsSync(join(root, path)));
const specs = [...skillSpecs, join("evals", "organic-routing", "eval.yaml")];
const validGraderName = /^[a-z0-9][a-z0-9-]{0,59}$/;

test("canonical evaluation specs are present", () => {
  assert.ok(specs.length > 0);
});

for (const spec of specs) {
  test(`${spec}: the judge is explicit without changing executor coverage`, () => {
    const evaluation = parse(readFileSync(join(root, spec), "utf8"));
    assert.equal(evaluation.defaults.judge_model, "gpt-5.6-sol");
    assert.equal(evaluation.defaults.model,
      spec.includes("aspire-project-v2-migration") ? "gpt-5.6-sol-fast" : "gpt-5-mini");
  });

  test(`${spec}: explicit grader names are compatible with Vally 0.16.0`, () => {
    const lines = readFileSync(join(root, spec), "utf8").split(/\r?\n/);
    let graderIndent;
    let count = 0;
    const names = new Set();
    for (const line of lines) {
      if (/^\s*(#.*)?$/.test(line)) continue;
      assert.doesNotMatch(line, /^\s*(?:expect_skills|reject_skills):/);
      const indent = line.match(/^ */)[0].length;
      if (graderIndent !== undefined && indent <= graderIndent) graderIndent = undefined;
      if (/^\s*graders:\s*$/.test(line)) {
        graderIndent = indent;
        continue;
      }
      if (graderIndent === undefined) continue;
      const match = line.match(/^\s*(?:- )?name:\s*(\S+)\s*$/);
      if (match && (indent === graderIndent + 2 || indent === graderIndent + 4)) {
        assert.match(match[1], validGraderName);
        assert.ok(!names.has(match[1]), `Duplicate grader name: ${match[1]}`);
        names.add(match[1]);
        count++;
      }
    }
    assert.ok(count > 0, `No explicit grader names checked in ${spec}`);
  });
}

test("grader names in the authoring examples use the supported spelling", () => {
  const guide = readFileSync(join(root, "evals", "AUTHORING.md"), "utf8");
  for (const match of guide.matchAll(/\bname: ([a-z0-9_-]+)/g)) {
    assert.match(match[1], validGraderName);
  }
});

test("positive routing stimuli mirror the host matching-skill policy", () => {
  const activation = /Before answering, invoke the matching available Aspire skill or skills/;
  for (const spec of specs) {
    const evaluation = parse(readFileSync(join(root, spec), "utf8"));
    for (const stimulus of evaluation.stimuli) {
      if (stimulus.name.startsWith("should_trigger_")) {
        assert.match(stimulus.prompt, activation, `${spec}: ${stimulus.name}`);
        assert.match(stimulus.prompt, /do not answer from general knowledge/);
      } else if (stimulus.name.startsWith("should_not_trigger_")) {
        assert.doesNotMatch(stimulus.prompt, activation, `${spec}: ${stimulus.name}`);
      }
    }
  }
});
