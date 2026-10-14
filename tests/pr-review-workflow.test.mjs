import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const markdown = read(".github/workflows/pr-review.md");
const source = parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)[1]);
const lockText = read(".github/workflows/pr-review.lock.yml");
const workflow = parse(lockText);
const manifest = JSON.parse(/^# gh-aw-manifest: (.+)$/m.exec(lockText)[1]);
const head = "a".repeat(40);
const contextStep = workflow.jobs.review_context.steps.find(step => step.id === "context");
const staleStep = workflow.jobs.safe_outputs.steps.find(step => step.name === "Reject stale findings before commenting");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function pr(overrides = {}) {
  return {
    state: "open",
    head: { sha: head, repo: { full_name: "microsoft/aspire-skills" } },
    base: { ref: "dev" },
    ...overrides
  };
}

function context(number = 69, sha = head) {
  return {
    repo: { owner: "microsoft", repo: "aspire-skills" },
    payload: { pull_request: { number, head: { sha } } }
  };
}

async function runScript(step, data, event = context(), env = {}) {
  const calls = [];
  const outputs = {};
  const github = {
    rest: {
      pulls: {
        get: async args => {
          calls.push(args);
          if (data instanceof Error) throw data;
          return { data };
        }
      }
    }
  };
  const core = { setOutput: (name, value) => { outputs[name] = value; } };
  await new AsyncFunction("github", "context", "core", "process", step.with.script)(
    github, event, core, { env }
  );
  return { calls, outputs };
}

test("review runs from the trusted base workflow for non-draft, same-repository PRs", () => {
  const triggers = {
    pull_request_target: {
      branches: ["main", "dev"],
      types: ["opened", "reopened", "synchronize", "ready_for_review"]
    }
  };
  assert.deepEqual(workflow.on, triggers);
  assert.deepEqual(source.on.pull_request_target, triggers.pull_request_target);
  assert.equal(source.on["status-comment"], false);
  assert.equal(source.on["github-token"], "${{ secrets.GITHUB_TOKEN }}");
  assert.match(workflow.jobs.pre_activation.if, /draft == false/);
  assert.match(workflow.jobs.pre_activation.if, /head\.repo\.full_name == github\.repository/);
  const gate = new Function("github", `return ${source.if};`);
  for (const [draft, repository, expected] of [
    [false, "microsoft/aspire-skills", true],
    [true, "microsoft/aspire-skills", false],
    [false, "contributor/aspire-skills", false]
  ]) {
    assert.equal(gate({
      repository: "microsoft/aspire-skills",
      event: { pull_request: { draft, head: { repo: { full_name: repository } } } }
    }), expected);
  }
  const membership = workflow.jobs.pre_activation.steps.find(step => step.env?.GH_AW_REQUIRED_ROLES);
  assert.equal(membership.env.GH_AW_REQUIRED_ROLES, "admin,maintainer,write");
});

test("activation installs the internal skill without checking out proposed PR code", () => {
  assert.equal(source.checkout, false);
  assert.deepEqual(source.skills, [".github/skills/pr-review"]);
  const checkout = workflow.jobs.activation.steps.find(step => step.uses?.startsWith("actions/checkout@"));
  assert.ok(checkout);
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(checkout.with.ref, undefined, "pull_request_target defaults to the trusted base revision");
  assert.match(checkout.with["sparse-checkout"], /\.github/);
  assert.ok(workflow.jobs.activation.steps.some(step =>
    step.env?.GH_AW_FRONTMATTER_SKILLS === ".github/skills/pr-review"
  ));
  for (const id of ["agent", "review_context", "safe_outputs"]) {
    assert.ok(!workflow.jobs[id].steps.some(step => step.uses?.startsWith("actions/checkout@")));
  }
  assert.doesNotMatch(lockText, /refs\/pull\/.*\/head|ref:.*pull_request\.head/);
});

test("the agent has only repository reads and workflow-token Copilot inference", () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.agent.permissions, {
    actions: "read", checks: "read", contents: "read", "copilot-requests": "write",
    issues: "read", "pull-requests": "read"
  });
  assert.equal(source.tools.bash, false);
  assert.equal(source.tools["cli-proxy"], false);
  assert.equal(source.tools.github["read-only"], true);
  assert.equal(source.tools.github["min-integrity"], "approved");
  assert.deepEqual(source.tools.github["allowed-repos"], ["microsoft/aspire-skills"]);
  assert.equal(source.tools.github["github-token"], "${{ secrets.GITHUB_TOKEN }}");
  const engine = workflow.jobs.agent.steps.find(step => step.id === "agentic_execution");
  assert.equal(engine.env.COPILOT_GITHUB_TOKEN, "${{ github.token }}");
  assert.match(lockText, /"GITHUB_READ_ONLY": "1"/);
  const tools = manifest.mcp_servers.find(server => server.name === "github").tools;
  assert.ok(tools.includes("pull_request_read"));
  assert.ok(tools.includes("get_file_contents"));
  assert.ok(tools.every(tool => !/^(create|update|delete|merge|push|submit|add)_/.test(tool)));
});

test("safe outputs allow one triggering-PR comment, not a review, PR, issue, or release", () => {
  assert.deepEqual(source["safe-outputs"]["add-comment"], { target: "triggering", max: 1 });
  assert.equal(source["safe-outputs"]["github-token"], "${{ secrets.GITHUB_TOKEN }}");
  assert.equal(source["safe-outputs"]["report-failed-jobs"], false);
  assert.equal(source["safe-outputs"]["report-failure-as-issue"], false);
  assert.deepEqual(source["safe-outputs"]["missing-data"], { "create-issue": false });
  assert.deepEqual(source["safe-outputs"]["missing-tool"], { "create-issue": false });
  assert.deepEqual(source["safe-outputs"]["report-incomplete"], { "create-issue": false });
  for (const name of ["GH_AW_MISSING_TOOL_CREATE_ISSUE", "GH_AW_REPORT_INCOMPLETE_CREATE_ISSUE"]) {
    const step = workflow.jobs.conclusion.steps.find(step => step.env?.[name]);
    assert.equal(step.env[name], "false");
  }
  const tools = manifest.mcp_servers.find(server => server.name === "safeoutputs").tools;
  assert.deepEqual(tools.toSorted(), ["add_comment", "missing_data", "missing_tool", "noop"]);
  const job = workflow.jobs.safe_outputs;
  assert.deepEqual(job.permissions, { issues: "write", "pull-requests": "write" });
  assert.ok(job.needs.includes("review_context"));
  assert.ok(job.needs.includes("detection"));
  assert.match(job.if, /needs\.agent\.result == 'success'/);
  assert.match(job.if, /needs\.review_context\.result == 'success'/);
  assert.match(job.if, /needs\.detection\.result == 'success'/);
  assert.ok(job.steps.indexOf(staleStep) < job.steps.findIndex(step => step.id === "process_safe_outputs"));
});

test("actions and container images are pinned in compiler output", () => {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
    }
  }
  for (const container of manifest.containers) {
    assert.match(container.pinned_image, /@sha256:[a-f0-9]{64}$/);
  }
});

test("prompt and skill distinguish findings, duplicate findings, and incomplete reviews", () => {
  const skill = read(".github/skills/pr-review/SKILL.md");
  assert.match(markdown, /automated findings mode/);
  assert.match(skill, /## Automated findings mode/);
  assert.match(markdown, /existing inline[\s\S]*issue comments/);
  assert.match(markdown, /Drop issues already raised/);
  assert.match(markdown, /at exact head `\$\{\{ needs\.review_context\.outputs\.head \}\}`/);
  assert.match(markdown, /never execute PR code/);
  assert.match(markdown, /a permalink to the exact source file and line at that SHA/);
  assert.match(markdown, /use `noop`/);
  assert.match(markdown, /use `missing_data` or `missing_tool`/);
  assert.match(skill, /without interactive triage/);
  assert.match(skill, /Do not ask[\s\S]*approve, request changes, edit code, or merge/);
});

test("review context binds an open PR to its exact head with read-only API calls", async () => {
  const result = await runScript(contextStep, pr());
  assert.deepEqual(result.outputs, { number: "69", head });
  assert.deepEqual(result.calls, [{ owner: "microsoft", repo: "aspire-skills", pull_number: 69 }]);
  assert.deepEqual(workflow.jobs.review_context.permissions, { "pull-requests": "read" });
});

test("review context rejects invalid identifiers, closed PRs, forks, wrong bases, and stale events", async () => {
  for (const number of [undefined, 0, -1, "69", 1.5]) {
    const event = context();
    event.payload.pull_request.number = number;
    await assert.rejects(runScript(contextStep, pr(), event), /PR number is required/);
  }
  await assert.rejects(runScript(contextStep, pr({ state: "closed" })), /no longer open/);
  await assert.rejects(runScript(contextStep, pr({ head: { sha: head, repo: { full_name: "fork/aspire-skills" } } })), /Fork PRs/);
  await assert.rejects(runScript(contextStep, pr({ base: { ref: "feature" } })), /must target main or dev/);
  await assert.rejects(runScript(contextStep, pr(), context(69, "b".repeat(40))), /advanced after this event/);
});

test("publication guard permits only an open PR at the reviewed head", async () => {
  const result = await runScript(staleStep, pr(), context(), { PR_NUMBER: "69", REVIEWED_HEAD: head });
  assert.deepEqual(result.calls, [{ owner: "microsoft", repo: "aspire-skills", pull_number: 69 }]);
  assert.deepEqual(staleStep.env, {
    PR_NUMBER: "${{ needs.review_context.outputs.number }}",
    REVIEWED_HEAD: "${{ needs.review_context.outputs.head }}"
  });
  await assert.rejects(runScript(staleStep, pr({ state: "closed" }), context(), {
    PR_NUMBER: "69", REVIEWED_HEAD: head
  }), /no findings will be posted/);
  await assert.rejects(runScript(staleStep, pr(), context(), {
    PR_NUMBER: "69", REVIEWED_HEAD: "b".repeat(40)
  }), /no findings will be posted/);
});

test("missing context and GitHub API failures fail closed instead of producing a clean review", async () => {
  for (const env of [
    {}, { PR_NUMBER: "0", REVIEWED_HEAD: head }, { PR_NUMBER: "69", REVIEWED_HEAD: "invalid" }
  ]) {
    await assert.rejects(runScript(staleStep, pr(), context(), env), /context is missing or invalid/);
  }
  const error = new Error("GitHub API unavailable");
  await assert.rejects(runScript(contextStep, error), /GitHub API unavailable/);
  await assert.rejects(runScript(staleStep, error, context(), {
    PR_NUMBER: "69", REVIEWED_HEAD: head
  }), /GitHub API unavailable/);
});
