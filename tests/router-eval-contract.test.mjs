import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { assertRoutingEntry } from "../evals/grade-routing-entry.mjs";

const spec = parse(readFileSync(new URL("../skills/aspire/evals/eval.yaml", import.meta.url), "utf8"));
function readSkill(name) {
  const source = readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), "utf8")
    .replaceAll("\r\n", "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source);
  assert.ok(frontmatter, `Missing ${name} frontmatter`);
  const { description } = parse(frontmatter[1]);
  assert.equal(typeof description, "string");
  return { source, description };
}

const named = {
  "router-ordinary-wiring-preserves-136-001": ["aspire"],
  "router-init-001": ["aspire"],
  "router-azdiag-001": ["aspire", "aspire-monitoring"],
  "router-deploy-001": ["aspire-deployment"],
  "router-mon-001": ["aspire-monitoring"],
  "router-orch-001": ["aspire", "aspire-orchestration"],
  "router-package-manager-001": ["aspire"],
  "router-legacy-ts-migrate-135-001": ["aspire-orchestration"]
};
const owners = [["aspire", "aspire-orchestration"], "aspire-deployment", "aspire-monitoring",
  "aspire-orchestration", undefined, "aspireify", "aspireify", "aspire-orchestration",
  "aspire-init", "aspire-deployment"];
for (const [index, owner] of owners.entries()) {
  named[`should_trigger_${String(index + 1).padStart(2, "0")}`] =
    Array.isArray(owner) ? owner : owner ? [owner] : ["aspire"];
}

test("router evaluations retain all cases, executor, run count and threshold", () => {
  const names = [...Object.keys(named), "router-reject-001",
    ...Array.from({ length: 6 }, (_, index) => `should_not_trigger_${String(index + 1).padStart(2, "0")}`)];
  assert.deepEqual(spec.stimuli.map(stimulus => stimulus.name).sort(), names.sort());
  assert.equal(spec.defaults.model, "gpt-5.6-sol-fast");
  assert.equal(spec.defaults.runs, 3);
  assert.equal(spec.defaults.timeout, "180s");
  assert.equal(spec.defaults.judge_model, "gpt-5.6-sol");
  assert.equal(spec.scoring.threshold, 0.7);
});

test("skill metadata requires specialist activation for read-only guidance", () => {
  const router = readSkill("aspire");
  assert.match(router.description, /ProjectResource to DotnetProjectResource migration/);
  assert.match(router.description, /aspire-project-v2-migration/);
  assert.match(router.source, /Adding a new project or integration is ordinary `aspireify` wiring/);
  assert.match(router.source, /eligible 13\.6\+ AppHost/);
});

test("router description is version-neutral", () => {
  const { description } = readSkill("aspire");
  assert.match(description, /Aspire router\./);
  assert.doesNotMatch(description, /\b\d+\.\d+(?:\.\d+)?\b/);
});

test("editor lifecycle guidance requires the available editor tool before CLI fallback", () => {
  const stimulus = spec.stimuli.find(item => item.name === "router-orch-001");
  const rubric = stimulus.rubric.join("\n");
  assert.match(stimulus.prompt, /not a git worktree/);
  assert.match(stimulus.prompt, /editor-first guidance/);
  assert.match(stimulus.prompt, /aspire_apphost_start\s+with mode run/);
  assert.match(stimulus.prompt, /Do not present direct\s+CLI startup as the primary mechanism/);
  assert.match(rubric, /aspire_apphost_start in run mode[\s\S]*aspire wait/);
  assert.match(rubric, /aspire start guidance is explicitly limited to a documented fallback/);
  assert.doesNotMatch(rubric, /aspire_apphost_start in run mode or aspire start/);
});

for (const stimulus of spec.stimuli) {
  test(`${stimulus.name}: read-only intent has real activation and workspace controls`, () => {
    assert.match(stimulus.prompt, /read-only/);
    assert.ok(stimulus.graders.some(grader => grader.type === "diff-empty"));
    const activation = stimulus.graders.find(grader => grader.type === "skill-invocation" || grader.type === "program");
    assert.ok(activation);
    if (activation.type === "program") {
      assert.equal(activation.type, "program");
      assert.deepEqual(activation.config, {
        program: "node", args: [".grader/grade-routing-entry.mjs", ...named[stimulus.name]]
      });
    } else if (named[stimulus.name]) {
      assert.deepEqual(activation.config.required, named[stimulus.name]);
    } else {
      assert.ok(activation.config.disallowed.includes("aspire"));
    }
    if (named[stimulus.name]) {
      assert.match(stimulus.prompt,
        /Before answering, invoke the matching available Aspire skill or skills/);
      assert.match(stimulus.prompt, /do not answer from general knowledge/);
    } else {
      assert.doesNotMatch(stimulus.prompt,
        /Before answering, invoke the matching available Aspire skill or skills/);
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

test("legacy migration requires its owner and requests a conditional authoring handoff", () => {
  const stimulus = spec.stimuli.find(item => item.name === "router-legacy-ts-migrate-135-001");
  assert.match(stimulus.prompt, /not a ProjectResource API migration/);
  assert.match(stimulus.prompt, /aspire update --migrate --yes --non-interactive/);
  assert.match(stimulus.prompt, /clear single-domain command/);
  assert.match(stimulus.prompt, /later conditional handoff/);
  assert.match(stimulus.prompt, /Aspire 13\.5 legacy-entry-point\s+migration guidance/);
  assert.match(stimulus.prompt, /do not substitute unrelated release breaking changes/);
  assert.match(stimulus.prompt, /updates the project's Aspire packages first/);
  assert.match(stimulus.prompt, /migrates\s+apphost\.ts to apphost\.mts/);
  assert.match(stimulus.prompt, /requires approval for both the package update and migration/);
  for (const change of ["package", "Aspire config", "tsconfig", "generated-import", "entry-point"]) {
    assert.ok(stimulus.prompt.includes(change));
  }
  assert.match(stimulus.prompt, /source authoring still needed afterward/);
  assert.doesNotMatch(stimulus.prompt, /\baspireify\b/);
  assert.ok(stimulus.rubric.some(criterion => /names aspireify.*only if/.test(criterion)));
  assert.ok(stimulus.rubric.some(criterion => criterion.includes("--yes --non-interactive")));
  const activation = stimulus.graders.find(grader => grader.type === "skill-invocation");
  assert.deepEqual(activation.config.required, ["aspire-orchestration"]);
  assert.ok(activation.config.disallowed.includes("aspire-project-v2-migration"));
  const accepts = invoked => activation.config.required.every(name => invoked.includes(name))
    && !activation.config.disallowed.some(name => invoked.includes(name));
  assert.equal(accepts(["aspire-orchestration"]), true);
  assert.equal(accepts(["aspire", "aspire-orchestration"]), true);
  assert.equal(accepts(["aspire"]), false);
  assert.match(readSkill("aspire").source,
    /aspire update --migrate --yes --non-interactive/);
});

test("focused router cases keep their ownership boundaries", () => {
  const agentInit = spec.stimuli.find(item => item.name === "router-init-001");
  const agentActivation = agentInit.graders.find(grader => grader.type === "skill-invocation");
  assert.match(agentInit.prompt, /not Copilot cloud-agent/);
  assert.ok(agentActivation.config.disallowed.includes("customize-cloud-agent"));

  const redis = spec.stimuli.find(item => item.name === "should_trigger_06");
  assert.match(redis.prompt, /do not .*start or validate it/);
  assert.ok(redis.rubric.some(criterion => /consuming application resource references/.test(criterion)));
  assert.ok(redis.rubric.some(criterion => /Brief API names or wiring examples are allowed/.test(criterion)));

  const destroy = spec.stimuli.find(item => item.name === "should_trigger_10");
  assert.ok(destroy.rubric.some(criterion => /deployment teardown workflow/.test(criterion)));
  assert.ok(!destroy.rubric.some(criterion => /exact deployment/.test(criterion)));
});
