import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { freezeBundle, publicationPolicy, verifyTelemetry } from "../../scripts/telemetry-workflow.mjs";

process.env.GIT_ALLOW_PROTOCOL = "file";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const runtime = process.env.GH_AW_ACTIONS_DIR;
assert.ok(runtime, "Run with GH_AW_ACTIONS_DIR set to the workflow's pinned gh-aw setup directory.");
const compiled = parse(readFileSync(join(root, ".github", "workflows", "update-aspire.lock.yml"), "utf8"));
const steps = compiled.jobs.safe_outputs.steps;
const checkoutIndex = steps.findIndex(step => step.name === "Checkout trusted Aspire publication base");
const gateIndex = steps.findIndex(step => step.with?.script?.includes("await promoteVerifiedProposal("));
const publisherIndex = steps.findIndex(step => step.with?.script?.includes("process_safe_outputs.cjs"));
assert.ok(checkoutIndex >= 0 && checkoutIndex < gateIndex, "The publication fixture requires a real target checkout before the gate.");
const checkout = steps[checkoutIndex];
assert.equal(checkout.env.TELEMETRY_ASPIRE_BASE, "${{ needs.resolve-source.outputs.aspire-base }}");
assert.ok(gateIndex >= 0 && publisherIndex > gateIndex, "The compiled publication gate must precede the native publisher.");
const gate = steps[gateIndex];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runGate = new AsyncFunction("require", "github", "core", "context", "exec", "io", "getOctokit", gate.with.script);
const allowedPath = "src/Aspire.Cli/Agents/Hooks/AgentTelemetryCatalog.cs";
const target = "https://github.com/microsoft/aspire.git";

function git(directory, ...args) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: directory, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
  }).trim();
}

function write(directory, filename, content, options) {
  const path = join(directory, filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, options);
}

function commit(directory) {
  git(directory, "add", ".");
  git(directory, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Telemetry regression fixture");
  return git(directory, "rev-parse", "HEAD");
}

function environment(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => previous === undefined ? delete process.env[name] : process.env[name] = previous);
  }
}

function proposalFixture(t, { outside, telemetry = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "telemetry-publication-"));
  const previousDirectory = process.cwd();
  t.after(() => {
    process.chdir(previousDirectory);
    rmSync(directory, { recursive: true, force: true });
  });
  const agent = join(directory, "agent");
  const verified = join(directory, "telemetry-verified");
  mkdirSync(agent);
  git(agent, "init", "--quiet", "--initial-branch=main");
  git(agent, "config", "user.name", "Fixture");
  git(agent, "config", "user.email", "fixture@example.invalid");
  write(agent, allowedPath, "baseline\n");
  const base = commit(agent);
  const number = Number.parseInt(randomUUID().slice(0, 6), 16) + 1;
  const source = {
    number, commit: base, base, aspireBase: base, merged: false,
    branch: `update-aspire-telemetry-pr-${number}`,
    url: `https://github.com/microsoft/aspire-skills/pull/${number}`
  };
  git(agent, "switch", "--quiet", "--create", source.branch);
  if (telemetry) write(agent, allowedPath, "candidate\n");
  if (outside) write(agent, outside, "out-of-scope fixture\n");
  const head = commit(agent);
  const files = git(agent, "diff", "--name-only", base, head).split("\n");
  if (telemetry) assert.ok(files.includes(allowedPath));
  if (outside) assert.ok(files.includes(outside));
  const prefix = `aw-microsoft-aspire-${source.branch}`;
  const bundle = join(directory, `${prefix}.bundle`);
  git(agent, "bundle", "create", bundle, `${base}..${source.branch}`);
  const verify = async () => {
    mkdirSync(verified);
    const { checkFileProtectionPostApply } = require(join(runtime, "manifest_file_helpers.cjs"));
    return freezeBundle({
      directory: agent, bundle, source, outputDirectory: verified,
      policy: await publicationPolicy(root), checkFiles: checkFileProtectionPostApply
    });
  };
  return { directory, agent, verified, base, source, prefix, bundle, verify };
}

async function fixture(t, { staged = false, failed = false } = {}) {
  const { directory, agent, verified, base, source, prefix, bundle } = proposalFixture(t);
  const publisher = join(directory, "publisher");
  const shims = join(directory, "shims");
  const containerCalls = join(directory, "docker.log");
  const total = 189;
  const failures = failed ? 12 : 0;
  write(directory, "shims/docker", `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$1" >> "$FAKE_DOCKER_LOG"
if [[ "$1" != run || " $* " != *" --network=none "* ]]; then exit 0; fi
printf 'Test run summary: ${failed ? "Failed!" : "Passed!"}\\n  total: ${total}\\n  failed: ${failures}\\n  succeeded: ${total - failures}\\n  skipped: 0\\n  duration: 1ms\\n'
exit ${failed ? 2 : 0}
`, { mode: 0o755 });
  write(directory, ".github/workflows/update-aspire.lock.yml",
    readFileSync(join(root, ".github", "workflows", "update-aspire.lock.yml")));
  mkdirSync(join(directory, "gh-aw"));
  symlinkSync(runtime, join(directory, "gh-aw", "actions"), "dir");
  symlinkSync(agent, join(directory, "_aspire"), "dir");
  environment(t, {
    RUNNER_TEMP: directory, GITHUB_WORKSPACE: publisher, GITHUB_RUN_ID: "123456",
    GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY: "microsoft/aspire-skills",
    GITHUB_SERVER_URL: "https://github.com", GITHUB_TOKEN: "fixture-token",
    GH_AW_WORKFLOW_ID: "update-aspire", GH_AW_SAFE_OUTPUTS_STAGED: String(staged),
    TELEMETRY_SOURCE: JSON.stringify(source),
    TELEMETRY_DETECTION_RESULT: "success", TELEMETRY_DETECTION_SUCCESS: "true",
    TELEMETRY_DETECTION_CONCLUSION: "success",
    PATH: `${shims}:${process.env.PATH}`, FAKE_DOCKER_LOG: containerCalls,
    GH_AW_PROMPTS_DIR: process.env.GH_AW_PROMPTS_DIR || join(dirname(runtime), "prompts")
  });
  mkdirSync("/tmp/gh-aw", { recursive: true });
  const inputNames = ["agent_output.json", `${prefix}.bundle`, `${prefix}.patch`];
  for (const name of inputNames) assert.equal(existsSync(join("/tmp/gh-aw", name)), false);
  t.after(() => {
    for (const name of inputNames) rmSync(join("/tmp/gh-aw", name), { force: true });
  });
  write("/tmp/gh-aw", "agent_output.json", JSON.stringify({ items: [{
    type: "create_pull_request", branch: source.branch, title: "Telemetry fixture", body: "Regression proposal."
  }], errors: [] }));
  write("/tmp/gh-aw", `${prefix}.bundle`, readFileSync(bundle));
  write("/tmp/gh-aw", `${prefix}.patch`, git(agent, "diff", "--binary", base, source.branch));
  git(agent, "switch", "--quiet", "main");
  const receipt = await verifyTelemetry({ directory, source });
  for (const name of inputNames) rmSync(join("/tmp/gh-aw", name));
  environment(t, { TELEMETRY_RECEIPT: JSON.stringify(receipt) });
  const head = git(agent, "rev-parse", source.branch);
  const remote = join(directory, "remote.git");
  git(directory, "clone", "--quiet", "--bare", "--single-branch", "--branch", "main", agent, remote);
  mkdirSync(publisher);
  const prepareCheckout = () => execFileSync("bash", ["-euo", "pipefail", "-c", checkout.run], {
    cwd: publisher, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env, ...checkout.env, TELEMETRY_ASPIRE_BASE: base,
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`, GIT_CONFIG_VALUE_0: target
    }
  });
  prepareCheckout();
  assert.equal(git(publisher, "rev-parse", "HEAD"), base);
  assert.equal(git(publisher, "remote", "get-url", "origin"), target);
  git(publisher, "config", `url.${remote}.insteadOf`, target);
  git(publisher, "config", "user.name", "Fixture");
  git(publisher, "config", "user.email", "fixture@example.invalid");
  const reviewedReceipt = join(directory, "telemetry-reviewed", "receipt.json");
  write(directory, "telemetry-reviewed/receipt.json", JSON.stringify(receipt));
  write(publisher, "_telemetry-tools/scripts/telemetry-workflow.mjs",
    readFileSync(join(root, "scripts", "telemetry-workflow.mjs")));
  const promotedFiles = [...Object.keys(receipt.files), "safeoutputs.jsonl"];
  for (const name of promotedFiles) {
    assert.equal(existsSync(join("/tmp/gh-aw", name)), false, `Refusing to overwrite an existing publication artifact: ${name}`);
  }
  t.after(() => {
    for (const name of promotedFiles) rmSync(join("/tmp/gh-aw", name), { force: true });
  });
  const writes = [];
  const gitPushes = [];
  const logs = [];
  const outputs = {};
  const sourcePr = { merged: false, head: { sha: source.commit }, base: {
    ref: "main", repo: { full_name: "microsoft/aspire-skills" }
  } };
  let publishedPr;
  const recordWrite = (operation, parameters) => {
    assert.equal(`${parameters.owner}/${parameters.repo}`, "microsoft/aspire");
    writes.push({ operation, parameters });
  };
  const intercept = (operation, parameters) => {
    recordWrite(operation, parameters);
    throw Object.assign(new Error("Publication write intercepted by regression harness"), { status: 400 });
  };
  const github = {
    hook: { before() {} },
    rest: {
      pulls: {
        get: async parameters => {
          if (parameters.repo === "aspire-skills") return { data: sourcePr };
          assert.equal(`${parameters.owner}/${parameters.repo}`, "microsoft/aspire");
          assert.equal(parameters.pull_number, publishedPr.number);
          return { data: publishedPr };
        },
        list: async () => ({ data: [] }),
        create: async parameters => {
          recordWrite("pulls.create", parameters);
          publishedPr = {
            number: 42, html_url: "https://github.com/microsoft/aspire/pull/42",
            id: 42, node_id: "PR_fixture", state: "open", merged: false, draft: parameters.draft,
            body: parameters.body,
            base: { ref: parameters.base, repo: { full_name: "microsoft/aspire" } },
            head: { ref: parameters.head, sha: head, repo: { full_name: "microsoft/aspire" } }
          };
          return { data: publishedPr };
        }
      },
      repos: { get: async () => ({ data: { default_branch: "main", full_name: "microsoft/aspire" } }) },
      git: {
        getCommit: async parameters => {
          assert.deepEqual(parameters, { owner: "microsoft", repo: "aspire", commit_sha: head });
          return { data: { sha: head, tree: { sha: receipt.tree }, parents: [{ sha: base }] } };
        },
        createRef: async parameters => {
          recordWrite("git.createRef", parameters);
          return { data: { ref: parameters.ref, object: { sha: parameters.sha } } };
        },
        updateRef: async parameters => intercept("git.updateRef", parameters)
      },
      issues: {
        create: async parameters => intercept("issues.create", parameters),
        addLabels: async parameters => {
          recordWrite("issues.addLabels", parameters);
          return { data: parameters.labels.map(name => ({ name })) };
        }
      }
    },
    graphql: async (_query, { input }) => {
      const [owner, repo] = input.branch.repositoryNameWithOwner.split("/");
      recordWrite("createCommitOnBranch", { owner, repo, input });
      return { createCommitOnBranch: { commit: { oid: head } } };
    }
  };
  const execute = async (command, args = [], options = {}) => {
    assert.equal(command, "git");
    if (args.includes("push")) {
      gitPushes.push(args);
      throw new Error("Git push intercepted by regression harness");
    }
    const result = spawnSync(command, args, {
      cwd: options.cwd || publisher, encoding: "utf8",
      env: {
        ...process.env, ...options.env,
        GIT_ALLOW_PROTOCOL: "file", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null"
      }
    });
    if (result.error) throw result.error;
    if (result.stdout) options.listeners?.stdout?.(Buffer.from(result.stdout));
    if (result.stderr) options.listeners?.stderr?.(Buffer.from(result.stderr));
    if (result.status !== 0 && !options.ignoreReturnCode) throw new Error(result.stderr || result.stdout);
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const exec = {
    getExecOutput: execute,
    exec: async (...args) => (await execute(...args)).exitCode
  };
  const core = Object.fromEntries(["debug", "error", "info", "warning", "notice"].map(name => [
    name, message => logs.push(String(message))
  ]));
  core.setOutput = (name, value) => outputs[name] = value;
  core.summary = {
    addRaw(content) { logs.push(content); return this; },
    async write() { return this; }
  };
  const context = {
    repo: { owner: "microsoft", repo: "aspire-skills" }, payload: {}, workflow: "Telemetry regression",
    eventName: "workflow_dispatch", runId: Number(receipt.run)
  };
  process.chdir(publisher);
  const remoteRefs = git(remote, "show-ref");
  const publish = async () => {
    await runGate(require, github, core, context, exec, {}, () => github);
    const { setupGlobals } = require(join(runtime, "setup_globals.cjs"));
    setupGlobals(core, github, context, exec, {}, () => github);
    const { main } = require(join(runtime, "create_pull_request.cjs"));
    const handler = await main(await publicationPolicy(root));
    const result = await handler(JSON.parse(readFileSync("/tmp/gh-aw/safeoutputs.jsonl", "utf8")), {});
    if (!result.success) throw new Error(`${result.error}\n${logs.join("\n")}`);
    const { emitSafeOutputActionOutputs } = require(join(runtime, "safe_outputs_action_outputs.cjs"));
    emitSafeOutputActionOutputs({ results: [{ success: true, type: "create_pull_request", result }] });
    return result;
  };
  const audit = async (values = {}) => {
    const step = compiled.jobs["validate-publication"].steps.find(step =>
      step.with?.script?.includes("validatePublication("));
    const run = new AsyncFunction("github", "core", step.with.script);
    const auditEnvironment = {
      TELEMETRY_PUBLISHER_RESULT: "success", TELEMETRY_STAGED: String(staged),
      TELEMETRY_PR_NUMBER: outputs.created_pr_number ?? "", TELEMETRY_PR_URL: outputs.created_pr_url ?? "",
      GITHUB_WORKSPACE: root, ...values
    };
    const previous = Object.fromEntries(Object.keys(auditEnvironment).map(name => [name, process.env[name]]));
    Object.assign(process.env, auditEnvironment);
    try {
      await run(github, core);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };
  return {
    publish, audit, outputs, writes, gitPushes, remote, remoteRefs, verified, prefix, source,
    sourcePr, head, agent, publisher, prepareCheckout, receipt, reviewedReceipt, containerCalls
  };
}

for (const [outside, telemetry] of [
  [".github/workflows/publish.yml", false], [".github/workflows/publish.yml", true],
  [".github/CODEOWNERS", true], ["src/Aspire.Cli/Commands/DeployCommand.cs", true],
  ["tests/Aspire.Cli.Tests/Aspire.Cli.Tests.csproj", true]
]) {
  test(`verification rejects ${outside} ${telemetry ? "mixed with telemetry" : "alone"} before issuing a receipt`, async t => {
    const f = proposalFixture(t, { outside, telemetry });
    await assert.rejects(f.verify(), error => {
      assert.match(error.message, /Publisher file policy rejected/);
      assert.ok(error.message.includes(outside));
      return true;
    });
    assert.deepEqual(readdirSync(f.verified), []);
  });
}

test("verification rejects a mixed bundle even when its companion patch hides the workflow edit", async t => {
  const outside = ".github/workflows/publish.yml";
  const f = proposalFixture(t, { outside });
  const patch = git(f.agent, "diff", "--binary", f.base, f.source.branch, "--", allowedPath);
  assert.ok(patch.includes(allowedPath));
  assert.ok(!patch.includes(outside));
  const inputs = "/tmp/gh-aw";
  const names = ["agent_output.json", `${f.prefix}.bundle`, `${f.prefix}.patch`];
  for (const name of names) assert.equal(existsSync(join(inputs, name)), false);
  t.after(() => {
    for (const name of names) rmSync(join(inputs, name), { force: true });
  });
  write(inputs, `${f.prefix}.bundle`, readFileSync(f.bundle));
  write(inputs, `${f.prefix}.patch`, patch);
  write(inputs, "agent_output.json", JSON.stringify({ items: [{
    type: "create_pull_request", branch: f.source.branch, title: "Telemetry fixture", body: "Regression proposal."
  }], errors: [] }));
  write(f.directory, ".github/workflows/update-aspire.lock.yml",
    readFileSync(join(root, ".github", "workflows", "update-aspire.lock.yml")));
  mkdirSync(join(f.directory, "gh-aw"));
  symlinkSync(runtime, join(f.directory, "gh-aw", "actions"), "dir");
  symlinkSync(f.agent, join(f.directory, "_aspire"), "dir");
  environment(t, { RUNNER_TEMP: f.directory });
  await assert.rejects(
    verifyTelemetry({ directory: f.directory, source: f.source }),
    /Publisher file policy rejected.*\.github\/workflows\/publish\.yml/
  );
  assert.deepEqual(readdirSync(f.verified), []);
});

test("the compiled promotion guard binds review evidence and detector success before any remote write", async t => {
  const f = await fixture(t);
  writeFileSync(f.reviewedReceipt, JSON.stringify({ ...f.receipt, tree: "a".repeat(40) }));
  await assert.rejects(f.publish(), /Threat review does not match/);
  writeFileSync(f.reviewedReceipt, JSON.stringify(f.receipt));
  environment(t, { TELEMETRY_DETECTION_RESULT: "failure" });
  await assert.rejects(f.publish(), /successful native threat review/);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.gitPushes, []);
  assert.equal(git(f.remote, "show-ref"), f.remoteRefs);
});

test("native signed publication preserves the verified draft after unrelated main advancement", async t => {
  const f = await fixture(t);
  git(f.publisher, "remote", "set-url", "origin", "https://x-access-token:fixture-token@github.com/microsoft/aspire.git");
  f.prepareCheckout();
  git(f.publisher, "remote", "set-url", "origin", target);
  git(f.agent, "switch", "--quiet", "main");
  write(f.agent, "unrelated.txt", "unrelated main change\n");
  const advanced = commit(f.agent);
  git(f.remote, "fetch", "--quiet", f.agent, `${advanced}:refs/heads/main`);
  const before = git(f.remote, "show-ref");
  const result = await f.publish();
  const signedCommit = f.writes.find(write => write.operation === "createCommitOnBranch");
  assert.ok(signedCommit, "The valid proposal must reach the native signed-commit publisher.");
  const { input } = signedCommit.parameters;
  assert.deepEqual(input.branch, {
    repositoryNameWithOwner: "microsoft/aspire", branchName: f.source.branch
  });
  assert.equal(input.expectedHeadOid, f.source.aspireBase);
  assert.deepEqual(input.fileChanges.additions.map(file => file.path), [allowedPath]);
  assert.equal(Buffer.from(input.fileChanges.additions[0].contents, "base64").toString(), "candidate\n");
  assert.deepEqual(input.fileChanges.deletions, []);
  assert.equal(result.number, 42);
  assert.deepEqual(f.outputs, {
    created_pr_number: "42", created_pr_url: "https://github.com/microsoft/aspire/pull/42"
  });
  const request = f.writes.find(write => write.operation === "pulls.create").parameters;
  assert.equal(request.head, f.source.branch);
  assert.equal(request.base, "main");
  assert.equal(request.draft, true);
  assert.ok(f.writes.some(write => write.operation === "createCommitOnBranch"));
  const writes = structuredClone(f.writes);
  await f.audit();
  assert.deepEqual(f.writes, writes);
  await assert.rejects(f.audit({ TELEMETRY_PR_URL: "" }), /canonical Aspire PR number and URL/);
  assert.equal(git(f.publisher, "rev-parse", "origin/main"), f.source.aspireBase);
  assert.equal(git(f.publisher, "rev-parse", "origin/publication-main"), advanced);
  assert.equal(git(f.remote, "show", "main:unrelated.txt"), "unrelated main change");
  assert.deepEqual(f.gitPushes, []);
  assert.equal(git(f.remote, "show-ref"), before);
});

test("native staged publication previews the same verified proposal without any remote mutation", async t => {
  const f = await fixture(t, { staged: true });
  const result = await f.publish();
  assert.equal(result.staged, true);
  assert.deepEqual(f.outputs, {});
  await f.audit();
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.gitPushes, []);
  assert.equal(git(f.remote, "show-ref"), f.remoteRefs);
});

test("completed functional failures remain visible on the native draft without changing its tested tree", async t => {
  const f = await fixture(t, { failed: true });
  await f.publish();
  const request = f.writes.find(write => write.operation === "pulls.create").parameters;
  assert.equal(request.draft, true);
  assert.ok(request.body.includes(
    "**Isolated telemetry tests: FAILED**\n\n177 passed, 12 failed, 0 skipped (189 total).\n\n"
  ));
  assert.ok(request.body.indexOf("**Isolated telemetry tests: FAILED**") < request.body.indexOf("Regression proposal."));
  await f.audit();
  assert.equal(f.writes.filter(write => write.operation === "pulls.create").length, 1);
  assert.deepEqual(readFileSync(f.containerCalls, "utf8").trim().split("\n"), ["pull", "run", "rm", "run", "rm"]);
  assert.deepEqual(f.gitPushes, []);
});

test("final promotion rejects a late source PR change after review with zero remote mutations", async t => {
  const f = await fixture(t);
  f.sourcePr.head.sha = f.head;
  await assert.rejects(f.publish(), /Source PR advanced/);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.gitPushes, []);
  assert.equal(git(f.remote, "show-ref"), f.remoteRefs);
  assert.equal(existsSync(join("/tmp/gh-aw", `${f.prefix}.bundle`)), false);
});
