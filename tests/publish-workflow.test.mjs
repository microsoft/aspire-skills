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

test("publish workflow publishes tags and only the skills bundle after a release PR merges", () => {
  assert.equal(workflow.name, "Publish release artifacts");
  assert.deepEqual(workflow.on, { pull_request: { branches: ["main"], types: ["closed"] } });
  assert.deepEqual(Object.keys(workflow.jobs), ["release"]);
  const job = workflow.jobs.release;
  assert.match(job.if, /pull_request\.merged == true/);
  assert.match(job.if, /head\.repo\.full_name == github\.repository/);
  assert.match(job.if, /startsWith\(github\.event\.pull_request\.head\.ref, 'release\/'\)/);
  assert.deepEqual(job.permissions, {
    contents: "write", "pull-requests": "read", "id-token": "write", attestations: "write"
  });
  const steps = job.steps;
  const checkout = steps.find(step => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ github.event.pull_request.merge_commit_sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const validate = steps.findIndex(step => step.run?.endsWith(" validate-release"));
  const build = steps.findIndex(step => step.run?.includes("npm run bundle"));
  const attest = steps.findIndex(step => step.uses?.startsWith("actions/attest-build-provenance@"));
  const publish = steps.findIndex(step => step.run?.endsWith(" publish-release"));
  const upload = steps.findIndex(step => step.run?.startsWith("gh release upload"));
  assert.ok(validate >= 0 && validate < build && build < attest && attest < publish && publish < upload);
  assert.match(steps[build].run, /--source-commit "\$RELEASE_COMMIT"/);
  for (const bundle of ["aspire-skills", "aspire-extensions"]) {
    assert.ok(steps[attest].with["subject-path"].includes(`dist/${bundle}-v`));
  }
  assert.ok(steps[upload].run.includes("dist/aspire-skills-v$RELEASE_VERSION.tgz"));
  assert.ok(!steps[upload].run.includes("aspire-extensions"));
  assert.equal(job.env.RELEASE_COMMIT, "${{ github.event.pull_request.merge_commit_sha }}");
  assert.equal(job.env.RELEASE_HEAD, "${{ github.event.pull_request.head.sha }}");
});

test("release dependencies are installed before validation and bundle creation", () => {
  assert.equal(step("Install release dependencies").run, "npm ci --ignore-scripts");
  const names = [
    "Setup Node", "Install release dependencies", "Validate the reviewed release",
    "Build bundles", "Attest bundles", "Publish the immutable tag and GitHub release",
    "Upload skills bundle"
  ];
  const indexes = names.map(name => workflow.jobs.release.steps.findIndex(item => item.name === name));
  assert.ok(indexes.every(index => index >= 0));
  assert.deepEqual(indexes, indexes.toSorted((left, right) => left - right));
});

test("bundle building uses the validated version and exact merged source commit", () => {
  assert.equal(step("Build bundles").env.RELEASE_VERSION, "${{ steps.validate.outputs.version }}");
  const source = "a".repeat(40);
  const result = runStep("Build bundles", { RELEASE_VERSION: "9.9.9", RELEASE_COMMIT: source }, `
npm() {
  printf '<%s>' "$@"
  printf '\\n'
}
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    "run", "bundle", "--", "--version", "9.9.9", "--out", "dist", "--source-commit", source
  ].map(argument => `<${argument}>`).join("") + "\n");
});

test("attestations identify both versioned bundles and uploads use the verified release outputs", () => {
  assert.equal(step("Attest bundles").with["subject-path"].trim(), [
    "dist/aspire-skills-v${{ steps.validate.outputs.version }}.tgz",
    "dist/aspire-extensions-v${{ steps.validate.outputs.version }}.tgz"
  ].join("\n"));
  assert.equal(step("Upload skills bundle").env.RELEASE_TAG, "${{ steps.publish.outputs.tag }}");
  assert.equal(step("Upload skills bundle").env.RELEASE_VERSION, "${{ steps.validate.outputs.version }}");
  assert.equal(workflow.jobs.release.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(workflow.jobs.release.env.PR_NUMBER, "${{ github.event.pull_request.number }}");
});

test("skills-only uploads target the explicit repository and support rerunning publication", () => {
  for (const repository of ["microsoft/aspire-skills", "example/aspire-skills"]) {
    const result = runStep("Upload skills bundle", {
      RELEASE_TAG: "v9.9.9", RELEASE_VERSION: "9.9.9", GITHUB_REPOSITORY: repository
    }, `
gh() {
  printf '<%s>' "$@"
  printf '\\n'
}
`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, [
      "release", "upload", "v9.9.9", "dist/aspire-skills-v9.9.9.tgz",
      "--repo", repository, "--clobber"
    ].map(argument => `<${argument}>`).join("") + "\n");
  }
});

test("bundle build and upload failures fail their workflow steps", () => {
  for (const [name, setup] of [
    ["Build bundles", "npm() { return 17; }"],
    ["Upload skills bundle", "gh() { return 17; }"]
  ]) {
    const result = runStep(name, {
      RELEASE_TAG: "v9.9.9", RELEASE_VERSION: "9.9.9",
      RELEASE_COMMIT: "a".repeat(40), GITHUB_REPOSITORY: "microsoft/aspire-skills"
    }, setup);
    assert.equal(result.status, 17, result.stderr);
  }
});

test("dev source-only checks cover PRs and pushes without release tooling", () => {
  const workflow = parse(read(".github/workflows/test.yml"));
  const job = workflow.jobs["dev-source-check"];
  assert.match(job.if, /github\.event\.pull_request\.base\.ref == 'dev'/);
  assert.match(job.if, /github\.ref == 'refs\/heads\/dev'/);
  assert.ok(job.steps.some(step => step.run === "node scripts/check-dev-tree.mjs"));
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

test("publication uses only the workflow token and never requires a bot secret or PR write permission", () => {
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.jobs.release.permissions["pull-requests"], "read");
  const source = read(".github/workflows/publish.yml");
  assert.doesNotMatch(source, /secrets\.|create-github-app-token|pull_request_target|gh pr create|gh pr merge/);
  assert.equal(workflow.jobs.release.env.GH_TOKEN, "${{ github.token }}");
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
  const found = workflow.jobs.release.steps.find(item => item.name === name);
  assert.ok(found, `Missing publish step: ${name}`);
  return found;
}

function runStep(name, env, setup) {
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
