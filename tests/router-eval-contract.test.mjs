import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { assertRoutingEntry } from "../evals/grade-routing-entry.mjs";

const spec = parse(readFileSync(new URL("../skills/aspire/evals/eval.yaml", import.meta.url), "utf8"));
const named = {
  "router-ordinary-wiring-preserves-136-001": ["aspire", "aspireify"],
  "router-init-001": ["aspire"],
  "router-azdiag-001": ["aspire", "aspire-monitoring"],
  "router-deploy-001": ["aspire-deployment"],
  "router-mon-001": ["aspire-monitoring"],
  "router-orch-001": ["aspire", "aspire-orchestration"],
  "router-package-manager-001": ["aspire", "aspireify"],
  "router-legacy-ts-migrate-135-001": ["aspire-orchestration"]
};
const owners = ["aspire-orchestration", "aspire-deployment", "aspire-monitoring",
  "aspire-orchestration", undefined, "aspireify", "aspireify", "aspire-orchestration",
  "aspire-init", "aspire-deployment"];
for (const [index, owner] of owners.entries()) {
  named[`should_trigger_${String(index + 1).padStart(2, "0")}`] = owner ? [owner] : ["aspire"];
}

test("router evaluations retain all cases, executor, run count and threshold", () => {
  const names = [...Object.keys(named), "router-reject-001",
    ...Array.from({ length: 6 }, (_, index) => `should_not_trigger_${String(index + 1).padStart(2, "0")}`)];
  assert.deepEqual(spec.stimuli.map(stimulus => stimulus.name).sort(), names.sort());
  assert.equal(spec.defaults.model, "gpt-5-mini");
  assert.equal(spec.defaults.runs, 3);
  assert.equal(spec.defaults.judge_model, "gpt-5.6-sol");
  assert.equal(spec.scoring.threshold, 0.7);
});

for (const stimulus of spec.stimuli) {
  test(`${stimulus.name}: read-only intent has real activation and workspace controls`, () => {
    assert.match(stimulus.prompt, /read-only/);
    assert.ok(stimulus.graders.some(grader => grader.type === "diff-empty"));
    const activation = stimulus.graders.find(grader => grader.type === "skill-invocation" || grader.type === "program");
    assert.ok(activation);
    if (stimulus.name === "router-azdiag-001") {
      assert.equal(activation.type, "program");
      assert.deepEqual(activation.config, {
        program: "node", args: [".grader/grade-routing-entry.mjs", ...named[stimulus.name]]
      });
    } else if (named[stimulus.name]) {
      assert.deepEqual(activation.config.required, named[stimulus.name]);
    } else {
      assert.ok(activation.config.disallowed.includes("aspire"));
    }
    const judges = stimulus.graders.filter(grader => grader.type === "prompt");
    if (judges.length) {
      assert.equal(judges.length, 1, "Use one explicit outcome rubric, not repeated default-rubric judgments");
      assert.ok(stimulus.rubric?.length);
      assert.equal(judges[0].config.scoring, "binary");
      assert.equal(judges[0].config.prompt, undefined);
    }
    assert.ok(!stimulus.graders.some(grader => grader.type.startsWith("output-")),
      "Do not confuse a recommendation with an explanatory mention of a prohibited alternative");
    if (stimulus.name.startsWith("should_trigger_")) {
      assert.doesNotMatch(stimulus.prompt, /(?:use|invoke|load) (?:the )?[`'"]?aspire[`'"]? (?:router )?skill/i,
        "Natural trigger cases must not explicitly tell the agent which skill to activate");
    }
  });
}

test("alternative deployed-diagnostic entry requires real activation, not text or an unrelated skill", () => {
  const allowed = ["aspire", "aspire-monitoring"];
  const input = names => ({ trajectory: {
    events: names.map(name => ({ type: "skill_activation", data: { name } }))
  } });
  for (const names of [["aspire"], ["aspire-monitoring"], allowed]) {
    assertRoutingEntry(input(names), allowed);
  }
  for (const value of [input([]), input(["aspire-deployment"]), {},
    { trajectory: { output: "I used aspire-monitoring", events: [] } },
    { trajectory: { events: [{ type: "assistant_message", data: { name: "aspire" } }] } }]) {
    assert.throws(() => assertRoutingEntry(value, allowed));
  }
});

test("ordinary wiring and legacy CLI migration retain resource-migration exclusions", () => {
  for (const name of ["router-ordinary-wiring-preserves-136-001", "router-legacy-ts-migrate-135-001"]) {
    const activation = spec.stimuli.find(stimulus => stimulus.name === name).graders
      .find(grader => grader.type === "skill-invocation");
    assert.ok(activation.config.disallowed.includes("aspire-project-v2-migration"));
  }
});
