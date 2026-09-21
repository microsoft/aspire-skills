import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readWorkflow = name => readFileSync(join(repoRoot, ".github", "workflows", name), "utf8");
const workflows = ["skill-eval.yml", "skill-eval-nightly.yml", "skill-experiment.yml"];
const publishCondition = "if: ${{ !cancelled() && steps.redact.outcome == 'success' }}";
const infrastructureConditions = {
  "skill-eval.yml": "${{ !cancelled() && (steps.changed.outputs.run_full == 'true' || steps.changed.outputs.has_specs == 'true') }}",
  "skill-eval-nightly.yml": "${{ !cancelled() && (steps.evals.outcome == 'success' || steps.evals.outcome == 'failure') }}"
};
const organicInfrastructureCondition =
  "${{ !cancelled() && (steps.organic.outcome == 'success' || steps.organic.outcome == 'failure') }}";
const infrastructureCommands = {
  "skill-eval.yml": [
    'expected_runs="${{ steps.changed.outputs.expected_runs }}"',
    'read -r -a expected_run_args <<< "$expected_runs"',
    'node scripts/check-eval-results.mjs ./results "${expected_run_args[@]}"'
  ].join("\n"),
  "skill-eval-nightly.yml": "node scripts/check-eval-results.mjs ./results ."
};

function runBash(script, cwd, env = {}) {
  const gitBash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
  return spawnSync(process.platform === "win32" && existsSync(gitBash) ? gitBash : "bash", ["-s"], {
    input: script, cwd, encoding: "utf8",
    env: { ...process.env, ...env, BASH_ENV: "" }, timeout: 30_000
  });
}

function guardRecords(verdict) {
  const passed = verdict !== "negative";
  const grade = { passed, score: passed ? 1 : 0, details: [{ passed: true, score: 1 }] };
  if (verdict === "judge-error") grade.details[0].status = "error";
  const evalFilePath = "/repo/skills/router/evals/eval.yaml";
  return [
    {
      type: "trial-result",
      itemId: `${evalFilePath}::main::model::fixture::trial-0`,
      evalName: "router-eval",
      evalFilePath,
      variant: "main",
      model: "model",
      stimulus: "fixture",
      trialIndex: 0,
      totalTrials: 1,
      status: "success",
      gradeResult: grade
    },
    {
      type: "run-summary",
      hadExecutionErrors: false,
      passed,
      evals: [{
        name: "router-eval",
        evalFilePath,
        variant: "main",
        model: "model",
        passed,
        scoringApplied: true,
        stimuliRun: 1,
        stimuliTotal: 1,
        durationMs: 1
      }]
    }
  ];
}

function infrastructureCommand(name, expectedRuns = "router") {
  return getStepRun(readWorkflow(name), "Check evaluation infrastructure")
    .replaceAll("${{ steps.changed.outputs.expected_runs }}", expectedRuns);
}

for (const name of workflows) {
  const workflow = readWorkflow(name);
  const steps = workflow.split(/^      - name: /m).slice(1);

  test(`${name}: only evaluation jobs receive Copilot permission`, () => {
    assert.match(workflow, /^permissions:\r?\n  contents: read\r?\n/m);
    assert.match(workflow, /^    permissions:\r?\n      contents: read\r?\n      copilot-requests: write\r?\n/m);
    assert.equal(workflow.match(/: write\b/g)?.length, 1);
    assert.doesNotMatch(workflow, /secrets\.|preflight|has_token|write-all|secrets: inherit/);
  });

  test(`${name}: token uses runtime auth only in eval and redaction steps`, () => {
    for (const step of steps) {
      const usesToken = step.includes("COPILOT_GITHUB_TOKEN:");
      const runsEval = step.includes("vally eval") || step.includes("vally experiment run");
      const redacts = step.startsWith("Redact evaluation artifacts");
      assert.equal(usesToken, runsEval || redacts, step.split("\n")[0]);
      if (usesToken) {
        assert.match(step, /COPILOT_GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
        assert.doesNotMatch(step, /^\s+(?:GITHUB_TOKEN|GH_TOKEN|GITHUB_COPILOT_API_TOKEN):/m);
      }
      if (runsEval) {
        assert.match(step, /unset GITHUB_TOKEN GH_TOKEN GITHUB_COPILOT_API_TOKEN/);
      }
    }
    assert.doesNotMatch(workflow, /^\s{0,4}env:|(?:TOKEN|token).*>>.*GITHUB_(?:ENV|OUTPUT|PATH)/m);
  });

  test(`${name}: checkout credentials are not persisted and tool versions are pinned`, () => {
    const checkout = steps.find(step => step.startsWith("Checkout"));
    assert.match(checkout, /persist-credentials: false/);
    for (const action of workflow.matchAll(/uses: (\S+)/g)) {
      assert.match(action[1], /@[0-9a-f]{40}$/);
    }
    assert.match(workflow, /npm install --ignore-scripts --prefix "\$tools_dir" @microsoft\/vally-cli@0\.16\.0 @github\/copilot-linux-x64@1\.0\.80/);
  });

  test(`${name}: publishing requires successful redaction even after failed evaluations`, () => {
    const redact = steps.find(step => step.startsWith("Redact evaluation artifacts"));
    assert.match(redact, /id: redact/);
    assert.match(redact, /if: \$\{\{ !cancelled\(\) &&/);
    assert.match(redact, /run: node scripts\/redact-eval-artifacts\.mjs \.\/results/);
    for (const step of steps.filter(step => /^(Upload|Summarize)/.test(step))) {
      assert.ok(step.includes(publishCondition));
      assert.ok(steps.indexOf(step) > steps.indexOf(redact));
    }
    if (name === "skill-experiment.yml") {
      assert.match(redact, /\.\/experiment-output\.txt/);
    }
  });
}

test("PR evaluations exclude forks and Dependabot without privileged PR triggers", () => {
  const workflow = readWorkflow("skill-eval.yml");
  assert.match(workflow, /^  pull_request:/m);
  assert.match(workflow, /^    if: >-\r?\n      github\.event\.pull_request\.head\.repo\.full_name == github\.event\.pull_request\.base\.repo\.full_name &&\r?\n      github\.event\.pull_request\.user\.login != 'dependabot\[bot\]' &&\r?\n      github\.actor != 'dependabot\[bot\]'/m);
  assert.doesNotMatch(workflow, /^\s*(pull_request_target|workflow_run):/m);
  assert.match(workflow, /gh pr diff/);
});

test("scheduled and manual triggers remain unchanged", () => {
  for (const [name, cron] of [["skill-eval-nightly.yml", "0 6 * * 0"], ["skill-experiment.yml", "0 6 * * 6"]]) {
    const workflow = readWorkflow(name);
    assert.ok(workflow.includes(`cron: "${cron}"`));
    assert.match(workflow, /^  workflow_dispatch:/m);
    assert.doesNotMatch(workflow, /^\s*(pull_request|pull_request_target|workflow_run):/m);
  }
});

test("gated evaluations fail closed while organic discovery and baseline remain informational", () => {
  const gate = readWorkflow("skill-eval.yml");
  assert.equal(gate.match(/vally eval \\/g)?.length, gate.match(/--require-pass/g)?.length);
  assert.doesNotMatch(gate, /\|\| true|continue-on-error/);

  const nightly = readWorkflow("skill-eval-nightly.yml");
  const nightlySteps = nightly.split(/^      - name: /m).slice(1);
  const gated = nightlySteps.find(step => step.startsWith("Run nightly evals"));
  const organic = nightlySteps.find(step => step.startsWith("Run organic routing discovery"));
  assert.match(gated, /--require-pass/);
  assert.doesNotMatch(organic, /--require-pass|\|\| true|continue-on-error/);
  assert.match(organic, /--suite organic-discovery/);
  assert.match(organic, /--output-dir \.\/organic-results/);

  const baseline = readWorkflow("skill-experiment.yml");
  assert.match(baseline, /tee experiment-output\.txt \|\| true/);
  assert.doesNotMatch(baseline, /Check evaluation infrastructure/);
});

test("PR evals use retry-eligible single trials while nightly preserves spec sampling", () => {
  const gate = readWorkflow("skill-eval.yml");
  assert.equal(gate.match(/--runs 1/g)?.length, 2);
  assert.equal(gate.match(/--max-retries 2/g)?.length, 2);
  assert.match(gate, /Vally disables per-stimulus retries for multi-trial plans/);

  const nightly = readWorkflow("skill-eval-nightly.yml");
  assert.doesNotMatch(nightly, /--runs\b|--max-retries\b/);
});

test("nightly organic discovery is separately checked, redacted, summarized and uploaded", () => {
  const workflow = readWorkflow("skill-eval-nightly.yml");
  const steps = workflow.split(/^      - name: /m).slice(1);
  const organic = steps.find(step => step.startsWith("Run organic routing discovery"));
  const check = steps.find(step => step.startsWith("Check organic routing infrastructure"));
  const redact = steps.find(step => step.startsWith("Redact evaluation artifacts"));
  const summary = steps.find(step => step.startsWith("Summarize organic routing discovery"));
  const upload = steps.find(step => step.startsWith("Upload organic routing trajectories"));

  assert.ok(organic.includes(`if: ${infrastructureConditions["skill-eval-nightly.yml"]}`));
  assert.ok(check.includes(`if: ${organicInfrastructureCondition}`));
  assert.equal(getStepRun(workflow, "Check organic routing infrastructure").trim(),
    "node scripts/check-eval-results.mjs ./organic-results .");
  assert.ok(steps.indexOf(check) > steps.indexOf(organic));
  assert.ok(steps.indexOf(check) < steps.indexOf(redact));
  assert.match(redact,
    /run: node scripts\/redact-eval-artifacts\.mjs \.\/results \.\/organic-results/);
  assert.ok(summary.includes(publishCondition));
  assert.match(summary, /eval-results\.md/);
  assert.ok(upload.includes(publishCondition));
  assert.match(upload, /name: organic-routing-nightly/);
  assert.match(upload, /path: \.\/organic-results\//);
});

for (const [name, condition] of Object.entries(infrastructureConditions)) {
  test(`${name}: infrastructure errors fail CI without bypassing redaction`, () => {
    const workflow = readWorkflow(name);
    const steps = workflow.split(/^      - name: /m).slice(1);
    const check = steps.find(step => step.startsWith("Check evaluation infrastructure"));
    const redact = steps.find(step => step.startsWith("Redact evaluation artifacts"));
    assert.ok(check);
    assert.ok(check.includes(`if: ${condition}`), "Run after success/failure, but not cancellation or an intentional skip");
    assert.ok(steps.indexOf(check) > steps.findLastIndex(step => step.includes("vally eval")));
    assert.ok(steps.indexOf(check) < steps.indexOf(redact));
    assert.match(redact, /if: \$\{\{ !cancelled\(\) &&/);
    assert.doesNotMatch(check, /env:|TOKEN|continue-on-error|\|\| true/);
    assert.equal(getStepRun(workflow, "Check evaluation infrastructure").trim(),
      infrastructureCommands[name]);
  });

  for (const [scenario, verdict, expectedStatus] of [
    ["valid results", "valid", 0],
    ["passing average with nested judge error", "judge-error", 1],
    ["valid negative verdict", "negative", 0],
    ["missing artifacts after an attempted run", "missing", 1]
  ]) {
    test(`${name}: actual guard command handles ${scenario}`, t => {
      const root = mkdtempSync(join(tmpdir(), "aspire-ci-guard-"));
      t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
      mkdirSync(join(root, "scripts"));
      writeFileSync(join(root, "scripts/check-eval-results.mjs"),
        readFileSync(join(repoRoot, "scripts/check-eval-results.mjs")));
      if (verdict !== "missing") {
        const directory = join(root, "results/router/run");
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "results.jsonl"),
          guardRecords(verdict).map(record => JSON.stringify(record)).join("\n"));
      }
      const result = runBash(infrastructureCommand(name), root);
      assert.ifError(result.error);
      assert.equal(result.status, expectedStatus, result.stderr);
      if (verdict === "judge-error") assert.match(result.stderr, /grading infrastructure error/);
      if (expectedStatus === 0) assert.match(result.stdout, /Checked 1 trials in 1 result files/);
    });
  }
}

test("skill-eval.yml: guard requires every expected scoped run", t => {
  const root = mkdtempSync(join(tmpdir(), "aspire-ci-expected-runs-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/check-eval-results.mjs"),
    readFileSync(join(repoRoot, "scripts/check-eval-results.mjs")));
  const directory = join(root, "results/router/run");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "results.jsonl"),
    guardRecords("valid").map(record => JSON.stringify(record)).join("\n"));

  const result = runBash(infrastructureCommand("skill-eval.yml", "router migration"), root);
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing expected evaluation run: migration/);
});

test("workflow and redaction changes exercise regression coverage", () => {
  const workflow = readWorkflow("bundle-test.yml");
  for (const filter of [".github/workflows/skill-eval*.yml", ".github/workflows/skill-experiment.yml"]) {
    assert.equal(workflow.split(`- "${filter}"`).length - 1, 2);
  }
  const gate = readWorkflow("skill-eval.yml");
  assert.match(gate, /- "scripts\/redact-eval-artifacts\.mjs"/);
  assert.match(gate, /scripts\/redact-eval-artifacts\\\.mjs/);
  for (const path of ["scripts/check-eval-results.mjs", "evals/grade-routing-entry.mjs"]) {
    assert.ok(gate.includes(`- "${path}"`));
    assert.ok(gate.includes(path.replace(".mjs", "\\.mjs")));
  }
  assert.equal(workflow.split('- "evals/grade-routing-entry.mjs"').length - 1, 2);
  assert.equal(workflow.split('- "evals/organic-routing/**"').length - 1, 2);
});

function getStepRun(workflow, name) {
  const step = workflow.replaceAll("\r\n", "\n").split(/^      - name: /m)
    .find(value => value.startsWith(`${name}\n`));
  assert.ok(step, `Missing workflow step: ${name}`);
  const body = step.match(/^        run: \|\n((?: {10}[^\n]*\n|\n)*)/m)?.[1];
  assert.ok(body, `Missing run script: ${name}`);
  return body.replace(/^ {10}/gm, "");
}

for (const changedPath of ["scripts/check-eval-results.mjs", "evals/grade-routing-entry.mjs"]) {
  test(`${changedPath}: a helper-only PR selects the router smoke evaluation`, t => {
    const root = mkdtempSync(join(tmpdir(), "aspire-ci-selection-"));
    t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
    mkdirSync(join(root, "skills/aspire/evals"), { recursive: true });
    writeFileSync(join(root, "skills/aspire/evals/eval.yaml"), "");
    const output = join(root, "outputs");
    const script = getStepRun(readWorkflow("skill-eval.yml"), "Determine changed skill eval specs")
      .replaceAll("${{ github.event.pull_request.number }}", "65")
      .replaceAll("${{ github.repository }}", "microsoft/aspire-skills");
    const result = runBash(`gh() { printf '%s\\n' '${changedPath}'; }\n${script}`, root, { GITHUB_OUTPUT: output });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, "utf8").replaceAll("\r\n", "\n"),
      "run_full=false\nhas_specs=true\nmatched=aspire\nexpected_runs=aspire\n");
  });
}

test("a global eval config change selects one full-suite expected run", t => {
  const root = mkdtempSync(join(tmpdir(), "aspire-ci-full-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const output = join(root, "outputs");
  const script = getStepRun(readWorkflow("skill-eval.yml"), "Determine changed skill eval specs")
    .replaceAll("${{ github.event.pull_request.number }}", "65")
    .replaceAll("${{ github.repository }}", "microsoft/aspire-skills");
  const result = runBash(`gh() { printf '%s\\n' '.vally.yaml'; }\n${script}`, root, { GITHUB_OUTPUT: output });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8").replaceAll("\r\n", "\n"),
    "run_full=true\nhas_specs=false\nexpected_runs=.\n");
});

test("skill lint uses the evaluation workflows' pinned Vally version", () => {
  const script = getStepRun(readWorkflow("skill-lint.yml"), "Install vally CLI");
  assert.deepEqual(script.match(/@microsoft\/vally-cli(?:@[^\s]+)?/g), ["@microsoft/vally-cli@0.16.0"]);
  assert.match(script, /vally --version/);
});

for (const [name, skills, expectedStatus] of [
  ["continues after the first failure", ["a-fail", "b-pass"], 1],
  ["reports every failure", ["a-fail", "b-pass", "c-fail"], 1],
  ["succeeds when all specs pass", ["a-pass", "b-pass"], 0],
  ["rejects an empty spec set", [], 1]
]) {
  test(`eval spec lint ${name}`, () => {
    const root = mkdtempSync(join(tmpdir(), "aspire-eval-lint-"));
    try {
      for (const skill of skills) {
        const directory = join(root, "skills", skill, "evals");
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "eval.yaml"), "");
      }
      const organicDirectory = join(root, "evals", "organic-routing");
      mkdirSync(organicDirectory, { recursive: true });
      writeFileSync(join(organicDirectory, "eval.yaml"), "");
      const result = runBash(`
cd -- "${basename(root)}" || exit 1
vally() {
  if [[ "$#" -ne 3 || "$1" != lint || "$2" != --eval-spec ]]; then
    echo "Unexpected lint arguments" >&2
    return 64
  fi
  printf 'checked:%s\\n' "$3"
  [[ "$3" != skills/*-fail/evals/eval.yaml ]]
}
${getStepRun(readWorkflow("skill-lint.yml"), "Validate eval specs")}
`, dirname(root));
      assert.ifError(result.error);
      assert.equal(result.status, expectedStatus, result.stderr);
      const expectedSpecs = skills.length === 0
        ? []
        : [...skills.map(skill => `skills/${skill}/evals/eval.yaml`),
          "evals/organic-routing/eval.yaml"];
      assert.deepEqual(
        [...result.stdout.matchAll(/^checked:(.*)$/gm)].map(match => match[1]),
        expectedSpecs
      );
      assert.equal(result.stdout.match(/::group::Validating /g)?.length ?? 0, expectedSpecs.length);
      assert.equal(result.stdout.match(/::endgroup::/g)?.length ?? 0, expectedSpecs.length);
      if (skills.length === 0) assert.match(result.stderr, /No eval specs found/);
    }
    finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
