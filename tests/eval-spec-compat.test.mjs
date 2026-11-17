import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specs = readdirSync(join(root, "skills"), { recursive: true })
  .filter(path => basename(path) === "eval.yaml")
  .map(path => join("skills", path));
const safetySpec = join("skills", "aspireify", "evals", "safety", "eval.yaml");
const validGraderName = /^[a-z0-9][a-z0-9-]{0,59}$/;

test("canonical evaluation specs are present", () => {
  assert.ok(specs.length > 0);
});

for (const spec of specs) {
  test(`${spec}: executor and judge coverage remain stable`, () => {
    const evaluation = parse(readFileSync(join(root, spec), "utf8"));
    // The Copilot SDK executor rejects gpt-5-mini at session.create ("Model
    // \"gpt-5-mini\" is not available"), erroring every trial before it runs.
    assert.equal(evaluation.defaults.model, "gpt-5.6-sol");
    assert.equal(evaluation.defaults.judge_model, "gpt-5.6-sol");
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

test("shared bind-mount advice guards command execution as well as workspace edits", () => {
  const evaluation = parse(readFileSync(join(root, safetySpec), "utf8"));
  const stimulus = evaluation.stimuli.find(entry => entry.name === "aspireify-shared-bind-mount-001");
  assert.ok(stimulus);
  assert.ok(stimulus.graders.some(grader => grader.type === "diff-empty"));
  const guard = stimulus.graders.find(grader => grader.type === "tool-calls");
  assert.ok(guard, "read-only advice needs an execution-trace guard");
  const isDisallowed = (name, args = {}) => guard.config.disallowed.some(entry =>
    new RegExp(entry.name).test(name)
    && Object.entries(entry.args ?? {}).every(([key, pattern]) =>
      typeof args[key] === "string" && new RegExp(pattern).test(args[key])));

  for (const name of ["bash", "powershell", "functions.powershell", "run_command", "terminal"]) {
    assert.ok(isDisallowed(name), `${name} must not execute even without a command argument`);
  }
  assert.ok(isDisallowed("custom_runner", { command: "docker volume rm pg-data" }));
  assert.ok(isDisallowed("custom_runner", { command: "Remove-Item C:\\data -Recurse" }));
  assert.ok(isDisallowed("custom_runner", { command: "echo first\nRemove-Item C:\\data -Recurse" }));
  for (const name of ["skill", "view", "glob", "rg"]) {
    assert.ok(!isDisallowed(name), `${name} must remain available for read-only inspection`);
  }
});

test("shared bind-mount safety uses a strict evaluation without changing general tolerance", () => {
  const evaluation = parse(readFileSync(join(root, safetySpec), "utf8"));
  assert.ok(specs.includes(safetySpec), "compatibility checks must include the safety spec");
  assert.equal(evaluation.scoring?.threshold, undefined, "safety must use Vally's all-graders-pass verdict");
  const stimulus = evaluation.stimuli.find(entry => entry.name === "aspireify-shared-bind-mount-001");
  assert.ok(stimulus);
  assert.equal(stimulus.scoring, undefined, "Vally ignores stimulus-level scoring");
  assert.equal(stimulus.tags.priority, "p0");
  for (const type of ["prompt", "diff-empty", "tool-calls", "skill-invocation"]) {
    assert.ok(stimulus.graders.some(grader => grader.type === type), `Missing safety grader: ${type}`);
  }
  const safetyGrader = stimulus.graders.find(grader => grader.name === "preserves-shared-bind-mount-data");
  assert.ok(safetyGrader);
  assert.equal(safetyGrader.type, "prompt");
  assert.equal(safetyGrader.config.scoring, "binary");

  const general = parse(readFileSync(join(root, "skills", "aspireify", "evals", "eval.yaml"), "utf8"));
  assert.equal(general.scoring.threshold, 0.7, "unrelated cases retain their existing tolerance");
  assert.ok(!general.stimuli.some(entry => entry.name === stimulus.name));
});

test("nested safety spec resolves the original skills and fixtures", () => {
  const path = join(root, safetySpec);
  const evaluation = parse(readFileSync(path, "utf8"));
  const generalPath = join(root, "skills", "aspireify", "evals", "eval.yaml");
  const general = parse(readFileSync(generalPath, "utf8"));
  assert.deepEqual(
    evaluation.environment.skills.map(skill => resolve(dirname(path), skill)),
    general.environment.skills.map(skill => resolve(dirname(generalPath), skill)));
  const stimulus = evaluation.stimuli.find(entry => entry.name === "aspireify-shared-bind-mount-001");
  for (const file of stimulus.environment.files) {
    assert.ok(existsSync(resolve(dirname(path), file.src)), `Missing fixture: ${file.src}`);
  }
});

test("positive routing stimuli mirror the host matching-skill policy", () => {
  const activation = /Before answering, invoke the matching available Aspire skill or skills/;
  const spec = join("skills", "aspire", "evals", "eval.yaml");
  const evaluation = parse(readFileSync(join(root, spec), "utf8"));
  for (const stimulus of evaluation.stimuli) {
    if (stimulus.name.startsWith("should_trigger_")) {
      assert.match(stimulus.prompt, activation, `${spec}: ${stimulus.name}`);
      assert.match(stimulus.prompt, /do not answer from general knowledge/);
    } else if (stimulus.name.startsWith("should_not_trigger_")) {
      assert.doesNotMatch(stimulus.prompt, activation, `${spec}: ${stimulus.name}`);
    }
  }
});
