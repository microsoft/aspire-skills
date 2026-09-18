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

test("gate and nightly evaluations fail closed while baseline remains informational", () => {
  for (const name of ["skill-eval.yml", "skill-eval-nightly.yml"]) {
    const workflow = readWorkflow(name);
    assert.equal(workflow.match(/vally eval \\/g)?.length, workflow.match(/--require-pass/g)?.length);
    assert.doesNotMatch(workflow, /\|\| true|continue-on-error/);
  }
  const baseline = readWorkflow("skill-experiment.yml");
  assert.match(baseline, /tee experiment-output\.txt \|\| true/);
});

test("workflow and redaction changes exercise regression coverage", () => {
  const workflow = readWorkflow("bundle-test.yml");
  for (const filter of [".github/workflows/skill-eval*.yml", ".github/workflows/skill-experiment.yml"]) {
    assert.equal(workflow.split(`- "${filter}"`).length - 1, 2);
  }
  const gate = readWorkflow("skill-eval.yml");
  assert.match(gate, /- "scripts\/redact-eval-artifacts\.mjs"/);
  assert.match(gate, /scripts\/redact-eval-artifacts\\\.mjs/);
});

function getStepRun(workflow, name) {
  const step = workflow.replaceAll("\r\n", "\n").split(/^      - name: /m)
    .find(value => value.startsWith(`${name}\n`));
  assert.ok(step, `Missing workflow step: ${name}`);
  const body = step.match(/^        run: \|\n((?: {10}[^\n]*\n|\n)*)/m)?.[1];
  assert.ok(body, `Missing run script: ${name}`);
  return body.replace(/^ {10}/gm, "");
}

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
      const gitBash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
      const bash = process.platform === "win32" && existsSync(gitBash) ? gitBash : "bash";
      const result = spawnSync(bash, ["-s"], {
        input: `
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
`,
        cwd: dirname(root),
        encoding: "utf8",
        env: { ...process.env, BASH_ENV: "" },
        timeout: 30_000
      });
      assert.ifError(result.error);
      assert.equal(result.status, expectedStatus, result.stderr);
      assert.deepEqual(
        [...result.stdout.matchAll(/^checked:(.*)$/gm)].map(match => match[1]),
        skills.map(skill => `skills/${skill}/evals/eval.yaml`)
      );
      assert.equal(result.stdout.match(/::group::Validating /g)?.length ?? 0, skills.length);
      assert.equal(result.stdout.match(/::endgroup::/g)?.length ?? 0, skills.length);
      if (skills.length === 0) assert.match(result.stderr, /No eval specs found/);
    }
    finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
