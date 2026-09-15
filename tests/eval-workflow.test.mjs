import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const gitBash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
const bash = process.platform === "win32" && existsSync(gitBash) ? gitBash : "bash";

function readWorkflow(name) {
  return readFileSync(join(repoRoot, ".github", "workflows", name), "utf8").replaceAll("\r\n", "\n");
}

function getStepRun(workflow, name) {
  const step = workflow.split(/^      - name: /m).find(value => value.startsWith(`${name}\n`));
  assert.ok(step, `Missing workflow step: ${name}`);
  const body = step.match(/^        run: \|\n((?: {10}[^\n]*\n|\n)*)/m)?.[1];
  assert.ok(body, `Missing run script: ${name}`);
  return body.replace(/^ {10}/gm, "");
}

for (const [workflowName, installStep] of [
  ["skill-lint.yml", "Install vally CLI"],
  ["skill-eval.yml", "Install vally and Copilot runtime"],
  ["skill-eval-nightly.yml", "Install vally and Copilot runtime"],
  ["skill-experiment.yml", "Install vally and Copilot runtime"]
]) {
  test(`${workflowName} installs and reports the pinned Vally version`, () => {
    const script = getStepRun(readWorkflow(workflowName), installStep);
    assert.deepEqual(script.match(/@microsoft\/vally-cli(?:@[^\s]+)?/g), ["@microsoft/vally-cli@0.16.0"]);
    assert.match(script, /(?:^|\s)(?:vally|"[^"]*\/vally") --version/m);
  });
}

for (const [workflowName, steps] of [
  ["skill-eval.yml", ["Run full ci-gate suite (global change)", "Run CI gate evals"]],
  ["skill-eval-nightly.yml", ["Run nightly evals"]]
]) {
  test(`${workflowName} fails CI on a valid failing eval verdict`, () => {
    const workflow = readWorkflow(workflowName);
    assert.equal(workflow.match(/\bvally eval\b/g)?.length, steps.length);
    for (const step of steps) {
      const script = getStepRun(workflow, step).replace(/\\\n\s*/g, " ");
      const commands = script.split("\n").filter(line => line.trimStart().startsWith("vally eval "));
      assert.equal(commands.length, 1);
      assert.match(commands[0], /\s--require-pass(?:\s|$)/);
    }
  });
}

test("the comparative experiment stays informational", () => {
  const script = getStepRun(readWorkflow("skill-experiment.yml"), "Run skill-lift experiment");
  assert.match(script, /vally experiment run/);
  assert.doesNotMatch(script, /--require-pass/);
});

for (const [name, skills, expectedStatus] of [
  ["continues after the first failure", ["a-fail", "b-pass"], 1],
  ["reports every failure", ["a-fail", "b-pass", "c-fail"], 1],
  ["succeeds only when all specs pass", ["a-pass", "b-pass"], 0],
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

      const script = getStepRun(readWorkflow("skill-lint.yml"), "Validate eval specs");
      // Stdin avoids the WSL launcher's extra expansion of scripts passed with -c.
      const result = spawnSync(bash, ["-s"], {
        input: `
cd -- "${basename(root)}" || exit 1
vally() {
  if [[ "$#" -ne 3 || "$1" != lint || "$2" != --eval-spec ]]; then
    echo "Unexpected lint arguments" >&2
    return 64
  fi
  printf 'checked:%s\\n' "$3"
  if [[ "$3" == skills/*-fail/evals/eval.yaml ]]; then
    echo "Controlled failure: $3" >&2
    return 1
  fi
}
${script}
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
      if (skills.length === 0) {
        assert.match(result.stderr, /No eval specs found/);
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
