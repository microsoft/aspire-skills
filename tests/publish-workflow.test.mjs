import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
  assert.equal(validation.env.HEAD_COMMIT, "${{ github.event.pull_request.head.sha || github.sha }}");
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
