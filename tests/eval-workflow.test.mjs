import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readWorkflow = name => readFileSync(join(repoRoot, ".github", "workflows", name), "utf8");
const workflows = ["skill-eval.yml", "skill-eval-nightly.yml", "skill-experiment.yml"];
const publishCondition = "if: ${{ !cancelled() && steps.redact.outcome == 'success' }}";
const infrastructureConditions = {
  "skill-eval.yml": "${{ !cancelled() && (steps.changed.outputs.run_full == 'true' || steps.changed.outputs.has_specs == 'true') }}",
  "skill-eval-nightly.yml": "${{ !cancelled() && (steps.evals.outcome == 'success' || steps.evals.outcome == 'failure') }}"
};
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
  const useGitBash = process.platform === "win32" && existsSync(gitBash);
  const toBashPath = value => {
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(value);
    if (!match) return value;
    const root = useGitBash ? `/${match[1].toLowerCase()}` : `/mnt/${match[1].toLowerCase()}`;
    return `${root}/${match[2].replaceAll("\\", "/")}`;
  };
  const quote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;
  const exports = Object.entries(env)
    .map(([name, value]) => `export ${name}=${quote(toBashPath(String(value)))}`)
    .join("\n");
  const nodeShim = process.platform === "win32"
    ? `node() { "${toBashPath(realpathSync(process.execPath))}" "$@"; }\n`
    : "";
  return spawnSync(useGitBash ? gitBash : "bash", ["-s"], {
    input: `${nodeShim}${exports}\n${script}`, cwd, encoding: "utf8",
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

test("PR evaluations allow Dependabot authors but exclude forks and Dependabot actors without privileged triggers", () => {
  const workflow = readWorkflow("skill-eval.yml");
  assert.match(workflow, /^  pull_request:/m);
  assert.equal(parse(workflow).jobs.eval.if,
    "github.event.pull_request.head.repo.full_name == github.event.pull_request.base.repo.full_name && github.actor != 'dependabot[bot]'");
  assert.doesNotMatch(workflow, /^\s*(pull_request_target|workflow_run):/m);
  assert.match(workflow, /gh api --paginate \\\r?\n\s+"repos\/\$\{\{ github\.repository \}\}\/pulls\/\$\{\{ github\.event\.pull_request\.number \}\}\/files\?per_page=100"/);
  assert.doesNotMatch(workflow, /gh pr diff/);
});

test("scheduled and manual triggers remain unchanged", () => {
  for (const [name, cron] of [["skill-eval-nightly.yml", "0 6 * * 0"], ["skill-experiment.yml", "0 6 * * 6"]]) {
    const workflow = readWorkflow(name);
    assert.ok(workflow.includes(`cron: "${cron}"`));
    assert.match(workflow, /^  workflow_dispatch:/m);
    assert.doesNotMatch(workflow, /^\s*(pull_request|pull_request_target|workflow_run):/m);
  }
});

test("gated evaluations fail closed while the comparative baseline remains informational", () => {
  const gate = readWorkflow("skill-eval.yml");
  assert.equal(gate.match(/vally eval \\/g)?.length, gate.match(/--require-pass/g)?.length);
  assert.doesNotMatch(gate, /\|\| true|continue-on-error/);

  const nightly = readWorkflow("skill-eval-nightly.yml");
  const nightlySteps = nightly.split(/^      - name: /m).slice(1);
  const gated = nightlySteps.find(step => step.startsWith("Run nightly evals"));
  assert.match(gated, /--require-pass/);
  assert.doesNotMatch(nightly, /\|\| true|continue-on-error/);

  const baseline = readWorkflow("skill-experiment.yml");
  assert.match(baseline, /tee experiment-output\.txt \|\| true/);
  assert.doesNotMatch(baseline, /Check evaluation infrastructure/);
});

test("PR evals use retry-eligible single trials while nightly preserves spec sampling", () => {
  const gate = readWorkflow("skill-eval.yml");
  assert.equal(gate.match(/--runs 1/g)?.length, 2);
  assert.equal(gate.match(/--max-retries 2/g)?.length, 2);
  assert.equal(gate.match(/--workers 1/g)?.length, 2);
  assert.match(gate, /Vally disables per-stimulus retries for multi-trial plans/);

  const nightly = readWorkflow("skill-eval-nightly.yml");
  assert.doesNotMatch(nightly, /--runs\b|--max-retries\b/);
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

test("redaction and grading infrastructure stay covered by the eval workflow", () => {
  const gate = readWorkflow("skill-eval.yml");
  assert.match(gate, /- "scripts\/redact-eval-artifacts\.mjs"/);
  assert.match(gate, /scripts\/redact-eval-artifacts\\\.mjs/);
  for (const path of ["scripts/check-eval-results.mjs", "evals/grade-routing-entry.mjs"]) {
    assert.ok(gate.includes(`- "${path}"`));
    assert.ok(gate.includes(path.replace(".mjs", "\\.mjs")));
  }
});

function getStepRun(workflow, name) {
  const step = workflow.replaceAll("\r\n", "\n").split(/^      - name: /m)
    .find(value => value.startsWith(`${name}\n`));
  assert.ok(step, `Missing workflow step: ${name}`);
  const body = step.match(/^        run: \|\n((?: {10}[^\n]*\n|\n)*)/m)?.[1];
  assert.ok(body, `Missing run script: ${name}`);
  return body.replace(/^ {10}/gm, "");
}

function runChangedSpecSelection(t, changedPaths, specs) {
  const root = mkdtempSync(join(tmpdir(), "aspire-ci-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  for (const spec of specs) {
    const path = join(root, "skills", spec);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }
  const output = join(root, "outputs");
  const script = getStepRun(readWorkflow("skill-eval.yml"), "Determine changed skill eval specs")
    .replaceAll("${{ github.event.pull_request.number }}", "65")
    .replaceAll("${{ github.repository }}", "microsoft/aspire-skills");
  const changed = changedPaths.map(path => `'${path}'`).join(" ");
  const result = runBash(`gh() { printf '%s\\n' ${changed}; }\n${script}`, root,
    { GITHUB_OUTPUT: output.replaceAll("\\", "/") });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(output, "utf8").replaceAll("\r\n", "\n");
}

for (const changedPath of [".github/workflows/skill-eval.yml", "scripts/check-eval-results.mjs", "evals/grade-routing-entry.mjs"]) {
  test(`${changedPath}: an eval-infrastructure-only PR selects the router smoke evaluation`, t => {
    assert.equal(runChangedSpecSelection(t, [changedPath], ["aspire/evals/eval.yaml"]),
      "run_full=false\nhas_specs=true\nmatched=aspire\nexpected_runs=aspire\n");
  });
}

test("routing helper changes add the router smoke eval to another changed skill", t => {
  assert.equal(runChangedSpecSelection(t,
    ["evals/grade-routing-entry.mjs", "skills/aspire-init/SKILL.md"],
    ["aspire/evals/eval.yaml", "aspire-init/evals/eval.yaml"]),
  "run_full=false\nhas_specs=true\nmatched=aspire-init aspire\nexpected_runs=aspire-init aspire\n");
});

test("routing helper changes de-duplicate an explicitly changed router spec", t => {
  assert.equal(runChangedSpecSelection(t,
    ["evals/grade-routing-entry.mjs", "skills/aspire/SKILL.md"],
    ["aspire/evals/eval.yaml"]),
  "run_full=false\nhas_specs=true\nmatched=aspire\nexpected_runs=aspire\n");
});

test("an ordinary skill-only change selects only that skill", t => {
  assert.equal(runChangedSpecSelection(t, ["skills/aspire-init/SKILL.md"], ["aspire-init/evals/eval.yaml"]),
    "run_full=false\nhas_specs=true\nmatched=aspire-init\nexpected_runs=aspire-init\n");
});

test("a nested-only eval selects its owning skill", t => {
  assert.equal(runChangedSpecSelection(t, ["skills/aspireify/evals/safety/eval.yaml"],
    ["aspireify/evals/safety/eval.yaml"]),
  "run_full=false\nhas_specs=true\nmatched=aspireify\nexpected_runs=aspireify\n");
});

test("root and nested eval changes select the owning skill once", t => {
  assert.equal(runChangedSpecSelection(t,
    ["skills/aspireify/evals/eval.yaml", "skills/aspireify/evals/safety/eval.yaml"],
    ["aspireify/evals/eval.yaml", "aspireify/evals/safety/eval.yaml"]),
  "run_full=false\nhas_specs=true\nmatched=aspireify\nexpected_runs=aspireify\n");
});

for (const [name, failingSpec, expectedStatus] of [
  ["passes when both specs pass", "", 0],
  ["fails when the strict safety spec fails", "skills/aspireify/evals/safety/eval.yaml", 1],
  ["fails when the general spec fails", "skills/aspireify/evals/eval.yaml", 1]
]) {
  test(`scoped PR execution includes root and nested specs and ${name}`, t => {
    const root = mkdtempSync(join(tmpdir(), "aspire-ci-nested-evals-"));
    t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
    const specs = ["skills/aspireify/evals/eval.yaml", "skills/aspireify/evals/safety/eval.yaml"];
    for (const spec of [...specs, "skills/aspire-init/evals/eval.yaml"]) {
      mkdirSync(dirname(join(root, spec)), { recursive: true });
      writeFileSync(join(root, spec), "");
    }
    const script = getStepRun(readWorkflow("skill-eval.yml"), "Run CI gate evals")
      .replaceAll("${{ steps.changed.outputs.matched }}", "aspireify");
    const result = runBash(`
vally() {
  printf 'argument:%s\\n' "$@"
  for argument; do
    if [[ "$argument" = "${failingSpec}" ]]; then return 1; fi
  done
  return 0
}
${script}`, root);
    assert.ifError(result.error);
    assert.equal(result.status, expectedStatus, result.stderr);
    const args = [...result.stdout.matchAll(/^argument:(.*)$/gm)].map(match => match[1]);
    const selectedSpecs = args.flatMap((arg, index) => arg === "--eval-spec" ? [args[index + 1]] : []);
    assert.deepEqual(selectedSpecs.sort(), [...specs].sort());
    assert.ok(args.includes("--require-pass"));
  });
}

test("scoped PR execution rejects missing specs rather than running the full suite", t => {
  const root = mkdtempSync(join(tmpdir(), "aspire-ci-missing-specs-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const script = getStepRun(readWorkflow("skill-eval.yml"), "Run CI gate evals")
    .replaceAll("${{ steps.changed.outputs.matched }}", "aspireify");
  const result = runBash(`vally() { echo "unexpected-eval"; }\n${script}`, root);
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /no match/);
  assert.doesNotMatch(result.stdout, /unexpected-eval/);
});

test("a PR whose diff exceeds GitHub's 20,000-line limit still selects its changed specs", t => {
  const root = mkdtempSync(join(tmpdir(), "aspire-ci-large-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  mkdirSync(join(root, "skills", "aspire-init", "evals"), { recursive: true });
  writeFileSync(join(root, "skills", "aspire-init", "evals", "eval.yaml"), "");
  const output = join(root, "outputs");
  const script = getStepRun(readWorkflow("skill-eval.yml"), "Determine changed skill eval specs")
    .replaceAll("${{ github.event.pull_request.number }}", "111")
    .replaceAll("${{ github.repository }}", "microsoft/aspire-skills");
  // Mirrors the real CLI for release PR #111: the diff endpoint rejects the
  // oversized diff, while the paginated PR files endpoint still lists paths.
  const gh = `gh() {
  if [ "$1 $2" = "pr diff" ]; then
    echo "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)" >&2
    return 1
  fi
  case " $* " in
    *" --paginate "*"repos/microsoft/aspire-skills/pulls/111/files"*)
      printf '%s\\n' 'README.md' 'skills/aspire-init/SKILL.md'; return 0 ;;
  esac
  echo "unexpected gh invocation: $*" >&2
  return 2
}`;
  const result = runBash(`${gh}\n${script}`, root, { GITHUB_OUTPUT: output.replaceAll("\\", "/") });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8").replaceAll("\r\n", "\n"),
    "run_full=false\nhas_specs=true\nmatched=aspire-init\nexpected_runs=aspire-init\n");
});

test("a global eval config change selects one full-suite expected run", t => {
  const root = mkdtempSync(join(tmpdir(), "aspire-ci-full-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const output = join(root, "outputs");
  const script = getStepRun(readWorkflow("skill-eval.yml"), "Determine changed skill eval specs")
    .replaceAll("${{ github.event.pull_request.number }}", "65")
    .replaceAll("${{ github.repository }}", "microsoft/aspire-skills");
  const result = runBash(`gh() { printf '%s\\n' '.vally.yaml'; }\n${script}`, root,
    { GITHUB_OUTPUT: output.replaceAll("\\", "/") });
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

for (const [name, specs, expectedStatus] of [
  ["continues after the first failure", ["a-fail/evals/eval.yaml", "b-pass/evals/eval.yaml"], 1],
  ["reports every failure", ["a-fail/evals/eval.yaml", "b-pass/evals/eval.yaml", "c-fail/evals/eval.yaml"], 1],
  ["succeeds when all specs pass", ["a-pass/evals/eval.yaml", "b-pass/evals/eval.yaml"], 0],
  ["includes nested specs", ["a-pass/evals/eval.yaml", "a-pass/evals/safety/eval.yaml", "b-pass/evals/eval.yaml"], 0],
  ["reports nested failures", ["a-pass/evals/eval.yaml", "a-pass/evals/safety-fail/eval.yaml", "b-pass/evals/eval.yaml"], 1],
  ["rejects an empty spec set", [], 1]
]) {
  test(`eval spec lint ${name}`, () => {
    const root = mkdtempSync(join(tmpdir(), "aspire-eval-lint-"));
    try {
      for (const spec of specs) {
        const path = join(root, "skills", spec);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "");
      }
      const result = runBash(`
cd -- "${basename(root)}" || exit 1
vally() {
  if [[ "$#" -ne 3 || "$1" != lint || "$2" != --eval-spec ]]; then
    echo "Unexpected lint arguments" >&2
    return 64
  fi
  printf 'checked:%s\\n' "$3"
  [[ "$3" != skills/*-fail/evals/eval.yaml && "$3" != */safety-fail/eval.yaml ]]
}
${getStepRun(readWorkflow("skill-lint.yml"), "Validate eval specs")}
`, dirname(root));
      assert.ifError(result.error);
      assert.equal(result.status, expectedStatus, result.stderr);
      const expectedSpecs = specs.map(spec => `skills/${spec}`);
      assert.deepEqual(
        [...result.stdout.matchAll(/^checked:(.*)$/gm)].map(match => match[1]),
        expectedSpecs
      );
      assert.equal(result.stdout.match(/::group::Validating /g)?.length ?? 0, expectedSpecs.length);
      assert.equal(result.stdout.match(/::endgroup::/g)?.length ?? 0, expectedSpecs.length);
      if (specs.length === 0) assert.match(result.stderr, /No eval specs found/);
    }
    finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
