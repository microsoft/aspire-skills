import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";

function read(path) {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
}

const workflow = parse(read(".github/workflows/publish.yml"));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const bash = resolveBash();

function resolveBash() {
  if (process.platform !== "win32") return "bash";
  const git = spawnSync("git", ["--exec-path"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(git.error, undefined, git.error?.message);
  assert.equal(git.status, 0, git.stderr);
  const gitRoot = resolve(git.stdout.trim(), "..", "..", "..");
  const candidates = [
    join(gitRoot, "bin", "bash.exe"),
    join(gitRoot, "usr", "bin", "bash.exe"),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
  ];
  const executable = candidates.find(path => existsSync(path));
  assert.ok(executable, "Windows workflow tests require Git Bash, not the WSL Bash launcher.");
  return executable;
}

test("manual inputs are only bundle checkboxes, defaulting to skills", () => {
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ["include_skills", "include_extensions"]);
  for (const [bundle, defaultValue] of [["skills", true], ["extensions", false]]) {
    assert.deepEqual(inputs[`include_${bundle}`], {
      description: `Include aspire-${bundle}`, type: "boolean", default: defaultValue
    });
  }
});

test("tag pushes upload skills while manual runs honor both checkbox values", () => {
  const env = step("Publish GitHub release").env;
  assert.equal(env.INCLUDE_SKILLS, "${{ github.event_name == 'push' || inputs.include_skills }}");
  assert.equal(env.INCLUDE_EXTENSIONS, "${{ github.event_name == 'workflow_dispatch' && inputs.include_extensions }}");
});

test("an empty manual selection fails before checkout", () => {
  assert.equal(
    step("Validate bundle selection").if,
    "${{ github.event_name == 'workflow_dispatch' && !inputs.include_skills && !inputs.include_extensions }}"
  );
  const steps = workflow.jobs.publish.steps;
  assert.ok(steps.findIndex(item => item.name === "Validate bundle selection") <
    steps.findIndex(item => item.name === "Checkout"));
  const result = runStep("Validate bundle selection");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::Select at least one bundle/);
});

test("release dependencies are installed before tests and bundle creation", () => {
  assert.equal(step("Install test dependencies").run, "npm ci --ignore-scripts");
  const indexes = ["Setup Node", "Install test dependencies", "Test bundles", "Build bundles"]
    .map(name => workflow.jobs.publish.steps.findIndex(item => item.name === name));
  assert.ok(indexes.every(index => index >= 0));
  assert.deepEqual(indexes, indexes.toSorted((left, right) => left - right));
});

for (const selection of [
  { name: "skills only", skills: "true", extensions: "false", assets: ["dist/aspire-skills-v9.9.9.tgz"] },
  { name: "extensions only", skills: "false", extensions: "true", assets: ["dist/aspire-extensions-v9.9.9.tgz"] },
  { name: "both bundles", skills: "true", extensions: "true", assets: ["dist/aspire-skills-v9.9.9.tgz", "dist/aspire-extensions-v9.9.9.tgz"] }
]) {
  test(`${selection.name} uploads only the selected assets to new and existing releases`, () => {
    for (const releaseExists of [true, false]) {
      const result = runStep("Publish GitHub release", {
        TAG_NAME: "v9.9.9", VERSION: "9.9.9",
        SKILLS_ASSET: "dist/aspire-skills-v9.9.9.tgz",
        EXTENSIONS_ASSET: "dist/aspire-extensions-v9.9.9.tgz",
        INCLUDE_SKILLS: selection.skills, INCLUDE_EXTENSIONS: selection.extensions,
        RELEASE_EXISTS_STATUS: releaseExists ? "0" : "1"
      }, `
gh() {
  if [[ "$1 $2" == "release view" ]]; then
    return "$RELEASE_EXISTS_STATUS"
  fi
  printf '<%s>' "$@"
  printf '\\n'
}
`);
      assert.equal(result.status, 0, result.stderr);
      const expected = releaseExists
        ? ["release", "upload", "v9.9.9", ...selection.assets, "--clobber"]
        : ["release", "create", "v9.9.9", ...selection.assets, "--verify-tag", "--title", "v9.9.9", "--notes", "Aspire bundles 9.9.9"];
      assert.equal(result.stdout, `${expected.map(argument => `<${argument}>`).join("")}\n`);
    }
  });
}

test("catalog parity runs unconditionally for every PR, supported pushes, and merge groups", () => {
  const workflow = parse(read(".github/workflows/catalog-check.yml"));
  assert.ok(Object.hasOwn(workflow.on, "merge_group"));
  assert.equal(workflow.on.pull_request.branches, undefined);
  assert.equal(workflow.on.pull_request.paths, undefined);
  assert.deepEqual(workflow.on.push, { branches: ["main", "dev", "release/**"] });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const job = workflow.jobs["catalog-check"];
  assert.equal(job.name, "OpenCode catalog check");
  assert.equal(job.if, undefined);
  assert.ok(job.steps.every(step => step.if === undefined && step["continue-on-error"] === undefined));
  const checkout = job.steps.find(step => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ github.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  assert.ok(job.steps.some(step => step.run === "npm run catalog:check"));
});

test("release PR checks use trusted main tooling on the exact reviewed head", () => {
  const workflow = parse(read(".github/workflows/test.yml"));
  const job = workflow.jobs["release-validation"];
  assert.deepEqual(job.permissions, { contents: "read", "pull-requests": "read" });
  const main = job.steps.find(step => step.with?.path === "tooling");
  assert.equal(main.with.ref, "main");
  assert.equal(main.with["persist-credentials"], false);
  const validation = job.steps.find(step => step.run?.includes("release.mjs"));
  assert.match(validation.run, /tooling\/scripts\/release\.mjs/);
  assert.equal(validation.env.HEAD_COMMIT, "${{ github.event.pull_request.head.sha || github.sha }}");
});

test("backported release fixes receive CI on PRs and pushes", () => {
  const workflow = parse(read(".github/workflows/test.yml"));
  assert.deepEqual(workflow.on.pull_request.branches, ["main", "dev", "release/**"]);
  assert.deepEqual(workflow.on.push.branches, ["main", "dev", "release/**"]);
  const guard = workflow.jobs["branch-check"].steps.find(step => step.run);
  const result = spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", guard.run], {
    cwd: repoRoot, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, BASH_ENV: "", TARGET_BRANCH: "release/0.0.5", HEAD_BRANCH: "backport/fix-to-release" }
  });
  assert.equal(result.status, 0, result.stderr);
});

test("bootstrap exception requires published 0.0.4 and disappears once trusted tooling exists", t => {
  const root = mkdtempSync(join(tmpdir(), "release-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  mkdirSync(join(root, "tooling"));
  const workflow = parse(read(".github/workflows/test.yml"));
  const validation = workflow.jobs["release-validation"].steps.find(step => step.run?.includes("release.mjs"));
  const env = {
    ...process.env, BASH_ENV: "", GITHUB_WORKSPACE: root.replaceAll("\\", "/"),
    GITHUB_REPOSITORY: "microsoft/aspire-skills",
    TARGET_BRANCH: "main", HEAD_BRANCH: "ellahathaway-release-workflow-bootstrap", SAME_REPOSITORY: "true"
  };
  const run = (overrides = {}, setup = 'git() { return 0; }\ngh() { printf "false"; }') => spawnSync(
    bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", `${setup}\n${validation.run}`],
    { cwd: repoRoot, encoding: "utf8", timeout: 10_000, env: { ...env, ...overrides } }
  );
  writeFileSync(join(root, "tooling", "package.json"), '{"version":"0.0.4"}');
  const accepted = run();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /One-time infrastructure bootstrap/);
  for (const overrides of [
    { SAME_REPOSITORY: "false" }, { HEAD_BRANCH: "feature/unreviewed" }, { TARGET_BRANCH: "dev" }
  ]) {
    const rejected = run(overrides);
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stdout, /Trusted main release tooling is missing/);
  }
  writeFileSync(join(root, "tooling", "package.json"), '{"version":"0.0.3"}');
  assert.equal(run().status, 1);
  writeFileSync(join(root, "tooling", "package.json"), '{"version":"0.0.4"}');
  assert.equal(run({}, 'git() { return 17; }').status, 17);
  assert.equal(run({}, 'git() { return 0; }\ngh() { printf "true"; }').status, 1);
  assert.equal(run({}, 'git() { return 0; }\ngh() { return 17; }').status, 1);
  const trusted = join(root, "tooling", "scripts", "release.mjs");
  mkdirSync(dirname(trusted), { recursive: true });
  writeFileSync(trusted, 'console.error("Trusted policy rejected bootstrap"); process.exitCode = 19;\n');
  const checked = run();
  assert.equal(checked.status, 19, checked.stderr);
  assert.doesNotMatch(checked.stdout, /One-time infrastructure bootstrap/);
});

function step(name) {
  const found = workflow.jobs.publish.steps.find(item => item.name === name);
  assert.ok(found, `Missing publish step: ${name}`);
  return found;
}

function runStep(name, env = {}, setup = "") {
  const result = spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c",
    `${setup}\n${step(name).run}`], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, ...env, BASH_ENV: "" }
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}
