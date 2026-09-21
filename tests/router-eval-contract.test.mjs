import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { assertRoutingEntry } from "../evals/grade-routing-entry.mjs";

const spec = parse(readFileSync(new URL("../skills/aspire/evals/eval.yaml", import.meta.url), "utf8"));
const organicSpec = parse(readFileSync(new URL("../evals/organic-routing/eval.yaml", import.meta.url), "utf8"));
const vallyConfig = parse(readFileSync(new URL("../.vally.yaml", import.meta.url), "utf8"));
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

const organicOwners = {
  "organic-router-overview-001": ["aspire"],
  "organic-init-001": ["aspire-init"],
  "organic-wiring-001": ["aspireify"],
  "organic-orchestration-001": ["aspire-orchestration"],
  "organic-deployment-001": ["aspire-deployment"],
  "organic-monitoring-001": ["aspire-monitoring"],
  "organic-project-v2-migration-001": ["aspire-project-v2-migration"]
};

test("router evaluations retain all cases, executor, run count and threshold", () => {
  const names = [...Object.keys(named), "router-reject-001",
    ...Array.from({ length: 6 }, (_, index) => `should_not_trigger_${String(index + 1).padStart(2, "0")}`)];
  assert.deepEqual(spec.stimuli.map(stimulus => stimulus.name).sort(), names.sort());
  assert.equal(spec.defaults.model, "gpt-5-mini");
  assert.equal(spec.defaults.runs, 3);
  assert.equal(spec.defaults.timeout, "180s");
  assert.equal(spec.defaults.judge_model, "gpt-5.6-sol");
  assert.equal(spec.scoring.threshold, 0.7);
});

test("organic routing measures spontaneous owner selection without a policy preamble", () => {
  assert.equal(organicSpec.defaults.model, "gpt-5-mini");
  assert.equal(organicSpec.defaults.runs, 3);
  assert.equal(organicSpec.scoring.threshold, 1);
  assert.deepEqual(
    organicSpec.stimuli.map(stimulus => stimulus.name).sort(),
    [...Object.keys(organicOwners), "organic-reject-001"].sort()
  );

  const allSkills = ["aspire", "aspire-init", "aspireify", "aspire-project-v2-migration",
    "aspire-orchestration", "aspire-deployment", "aspire-monitoring"];
  for (const stimulus of organicSpec.stimuli) {
    assert.equal(stimulus.tags.priority, "p2");
    assert.equal(stimulus.tags.activation, "organic");
    assert.doesNotMatch(stimulus.prompt,
      /Before answering, invoke the matching available Aspire skill or skills/);
    assert.equal(stimulus.graders.length, 1);
    assert.equal(stimulus.graders[0].type, "skill-invocation");
    if (organicOwners[stimulus.name]) {
      assert.deepEqual(stimulus.graders[0].config.required, organicOwners[stimulus.name]);
    } else {
      assert.deepEqual(stimulus.graders[0].config.disallowed, allSkills);
    }
  }
});

test("organic discovery is outside the gated eval search path and has its own suite", () => {
  assert.equal(vallyConfig.paths.evals, "skills");
  assert.deepEqual(vallyConfig.suites["organic-discovery"], {
    description: "Informational nightly measurement of spontaneous skill activation",
    evals: ["evals/organic-routing/eval.yaml"],
    filter: { activation: "organic" }
  });
});

test("skill metadata requires specialist activation for read-only guidance", () => {
  const router = readSkill("aspire");
  assert.match(router.description, /Use only for explicit Aspire-router requests/);
  assert.match(router.description,
    /Clear single-domain requests MUST load the owning specialist before answering/);
  assert.match(router.description, /Do not answer a specialist-owned request from this router alone/);
  assert.match(router.source, /## Mandatory routing action/);
  assert.match(router.source, /One router skill call is not a handoff/);
  assert.match(router.source,
    /For a clear single-domain request, invoke the owning specialist immediately/);
  assert.match(router.source,
    /This applies equally to execution, planning, explanation, read-only, and how-to requests/);

  for (const name of ["aspire-init", "aspireify", "aspire-orchestration",
    "aspire-deployment", "aspire-monitoring"]) {
    assert.match(readSkill(name).description,
      /Load this skill before answering matching execution, planning, read-only, or how-to requests/,
      `${name} must advertise read-only activation`);
  }
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

test("standalone doctor discovery belongs to orchestration while init keeps its prerequisite check", () => {
  const orchestration = readSkill("aspire-orchestration");
  const init = readSkill("aspire-init");
  const triggers = orchestration.description.split("WHEN:")[1].split("INVOKES:")[0];
  const exclusions = init.description.split("DO NOT USE FOR:")[1].split("INVOKES:")[0];
  const invocations = init.description.split("INVOKES:")[1].split("FOR SINGLE OPERATIONS:")[0];
  assert.match(triggers, /"aspire doctor"/);
  assert.match(triggers, /standalone environment diagnostics/);
  assert.match(exclusions, /standalone aspire doctor diagnostics \(use aspire-orchestration\)/);
  assert.doesNotMatch(invocations, /doctor/);
  assert.match(init.source, /Confirm prerequisites with `aspire doctor`/);
  assert.match(init.source, /even when no AppHost exists/);
});

test("start advice establishes the agent and worktree context before requiring automation flags", () => {
  const stimulus = spec.stimuli.find(item => item.name === "should_trigger_01");
  assert.match(stimulus.prompt, /AI agent/);
  assert.match(stimulus.prompt, /git\s+worktree/);
  const guidance = readSkill("aspire-orchestration").source
    .split("## Read-only guidance\n")[1].split("\n## ")[0];
  for (const flag of ["--apphost", "--non-interactive", "--isolated"]) {
    assert.ok(stimulus.rubric.some(criterion => criterion.includes(flag)));
    assert.ok(guidance.includes(flag));
  }
  assert.match(guidance, /flags are conditional/);
});

test("init advice requests the later wiring boundary without naming the expected handoff in the prompt", () => {
  const stimulus = spec.stimuli.find(item => item.name === "should_trigger_09");
  assert.match(stimulus.prompt, /existing repo with services but no AppHost/);
  assert.match(stimulus.prompt, /workflow handles resource wiring afterward/);
  assert.doesNotMatch(stimulus.prompt, /\baspireify\b/);
  assert.ok(stimulus.rubric.some(criterion => criterion.includes("names aspireify")));
  assert.match(readSkill("aspire-init").source,
    /For read-only `aspire init` guidance,[\s\S]*?explicitly name `aspireify`/);
});

test("legacy migration advice requests a conditional authoring handoff without activating it", () => {
  const stimulus = spec.stimuli.find(item => item.name === "router-legacy-ts-migrate-135-001");
  assert.match(stimulus.prompt, /source authoring still needed afterward/);
  assert.doesNotMatch(stimulus.prompt, /\baspireify\b/);
  assert.ok(stimulus.rubric.some(criterion => /names aspireify.*only if/.test(criterion)));
  const activation = stimulus.graders.find(grader => grader.type === "skill-invocation");
  assert.deepEqual(activation.config.required, ["aspire-orchestration"]);
  assert.ok(activation.config.disallowed.includes("aspireify"));
  assert.match(readSkill("aspire-orchestration").source,
    /Read-only answers must also name the conditional later handoff:[\s\S]*?without loading `aspireify`/);
});
