import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

process.env.GIT_ALLOW_PROTOCOL = "file";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const runtime = process.env.GH_AW_ACTIONS_DIR;
assert.ok(runtime, "Run with GH_AW_ACTIONS_DIR set to the workflow's pinned gh-aw setup directory.");
const compiled = parse(readFileSync(join(root, ".github", "workflows", "update-aspire.lock.yml"), "utf8"));
const steps = compiled.jobs.safe_outputs.steps;
const gateIndex = steps.findIndex(step => step.with?.script?.includes("await promoteVerifiedProposal("));
const publisherIndex = steps.findIndex(step => step.with?.script?.includes("process_safe_outputs.cjs"));
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

function write(directory, filename, content) {
  const path = join(directory, filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
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

async function fixture(t, { outside, telemetry = true, cleanPatch = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "telemetry-publication-"));
  const previousDirectory = process.cwd();
  t.after(() => {
    process.chdir(previousDirectory);
    rmSync(directory, { recursive: true, force: true });
  });
  const agent = join(directory, "agent");
  const publisher = join(directory, "publisher");
  const remote = join(directory, "remote.git");
  const verified = join(directory, "telemetry-verified");
  mkdirSync(agent);
  mkdirSync(verified);
  git(agent, "init", "--quiet", "--initial-branch=main");
  git(agent, "config", "user.name", "Fixture");
  git(agent, "config", "user.email", "fixture@example.invalid");
  write(agent, allowedPath, "baseline\n");
  const base = commit(agent);
  git(directory, "clone", "--quiet", "--bare", agent, remote);
  git(directory, "clone", "--quiet", remote, publisher);
  git(publisher, "remote", "set-url", "origin", target);
  git(publisher, "config", `url.${remote}.insteadOf`, target);
  git(publisher, "config", "user.name", "Fixture");
  git(publisher, "config", "user.email", "fixture@example.invalid");
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
  git(agent, "bundle", "create", join(verified, `${prefix}.bundle`), `${base}..${source.branch}`);
  const patch = git(agent, "diff", "--binary", base, head, ...(cleanPatch ? ["--", allowedPath] : []));
  writeFileSync(join(verified, `${prefix}.patch`), `${patch}\n`);
  const item = { type: "create_pull_request", branch: source.branch, title: "Telemetry fixture", body: "Regression proposal." };
  writeFileSync(join(verified, "agent_output.json"), JSON.stringify({ items: [item], errors: [] }));
  const receipt = {
    source, type: item.type, tree: git(agent, "rev-parse", `${head}^{tree}`), run: "123456", attempt: "1",
    files: Object.fromEntries(readdirSync(verified).map(name => [
      name, createHash("sha256").update(readFileSync(join(verified, name))).digest("hex")
    ]))
  };
  const reviewedReceipt = join(directory, "telemetry-reviewed", "receipt.json");
  write(directory, "telemetry-reviewed/receipt.json", JSON.stringify(receipt));
  mkdirSync(join(directory, "gh-aw"));
  symlinkSync(runtime, join(directory, "gh-aw", "actions"), "dir");
  symlinkSync(root, join(publisher, "_telemetry-tools"), "dir");
  environment(t, {
    RUNNER_TEMP: directory, GITHUB_WORKSPACE: publisher, GITHUB_RUN_ID: receipt.run,
    GITHUB_RUN_ATTEMPT: receipt.attempt, GITHUB_REPOSITORY: "microsoft/aspire-skills",
    GITHUB_SERVER_URL: "https://github.com", GITHUB_TOKEN: "fixture-token",
    GH_AW_WORKFLOW_ID: "update-aspire", GH_AW_SAFE_OUTPUTS_STAGED: "false",
    TELEMETRY_SOURCE: JSON.stringify(source), TELEMETRY_RECEIPT: JSON.stringify(receipt),
    TELEMETRY_DETECTION_RESULT: "success", TELEMETRY_DETECTION_SUCCESS: "true",
    TELEMETRY_DETECTION_CONCLUSION: "success",
    GH_AW_PROMPTS_DIR: process.env.GH_AW_PROMPTS_DIR || join(dirname(runtime), "prompts")
  });
  mkdirSync("/tmp/gh-aw", { recursive: true });
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
          assert.equal(`${parameters.owner}/${parameters.repo}`, "microsoft/aspire-skills");
          return { data: { merged: false, head: { sha: source.commit }, base: {
            ref: "main", repo: { full_name: "microsoft/aspire-skills" }
          } } };
        },
        list: async () => ({ data: [] }),
        create: async parameters => intercept("pulls.create", parameters)
      },
      repos: { get: async () => ({ data: { default_branch: "main", full_name: "microsoft/aspire" } }) },
      git: {
        getRef: async () => ({ data: { object: { sha: base } } }),
        createRef: async parameters => {
          recordWrite("git.createRef", parameters);
          return { data: { ref: parameters.ref, object: { sha: parameters.sha } } };
        },
        updateRef: async parameters => intercept("git.updateRef", parameters)
      },
      issues: { create: async parameters => intercept("issues.create", parameters) }
    },
    graphql: async (_query, { input }) => {
      const [owner, repo] = input.branch.repositoryNameWithOwner.split("/");
      return intercept("createCommitOnBranch", { owner, repo, input });
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
  const context = {
    repo: { owner: "microsoft", repo: "aspire-skills" }, payload: {}, workflow: "Telemetry regression",
    eventName: "workflow_dispatch", runId: Number(receipt.run)
  };
  process.chdir(publisher);
  const remoteRefs = git(remote, "show-ref");
  const publish = async () => {
    await runGate(require, github, core, context, exec, {}, () => github);
    const { publicationPolicy } = await import("../../scripts/telemetry-workflow.mjs");
    const { setupGlobals } = require(join(runtime, "setup_globals.cjs"));
    setupGlobals(core, github, context, exec, {}, () => github);
    const { main } = require(join(runtime, "create_pull_request.cjs"));
    const handler = await main(await publicationPolicy(root));
    const result = await handler(JSON.parse(readFileSync("/tmp/gh-aw/safeoutputs.jsonl", "utf8")), {});
    if (!result.success) throw new Error(`${result.error}\n${logs.join("\n")}`);
    return result;
  };
  return { publish, writes, gitPushes, remote, remoteRefs, verified, prefix, source, receipt, reviewedReceipt };
}

for (const outside of [
  ".github/workflows/publish.yml", ".github/CODEOWNERS",
  "src/Aspire.Cli/Commands/DeployCommand.cs", "tests/Aspire.Cli.Tests/Aspire.Cli.Tests.csproj"
]) {
  test(`publication rejects ${outside} both alone and mixed with valid telemetry`, async t => {
    for (const telemetry of [false, true]) {
      await t.test(telemetry ? "mixed bundle" : "out-of-scope-only bundle", async t => {
        const f = await fixture(t, { outside, telemetry });
        await assert.rejects(f.publish(), error => {
          assert.match(error.message, /Publisher file policy rejected/);
          assert.ok(error.message.includes(outside));
          return true;
        });
        assert.deepEqual(f.writes, []);
        assert.deepEqual(f.gitPushes, []);
        assert.equal(git(f.remote, "show-ref"), f.remoteRefs);
        assert.equal(existsSync(join("/tmp/gh-aw", `${f.prefix}.bundle`)), false);
      });
    }
  });
}

test("publication rejects a mixed bundle even when its companion patch hides the workflow edit", async t => {
  const outside = ".github/workflows/publish.yml";
  const f = await fixture(t, { outside, cleanPatch: true });
  const patch = readFileSync(join(f.verified, `${f.prefix}.patch`), "utf8");
  assert.ok(patch.includes(allowedPath));
  assert.ok(!patch.includes(outside));
  await assert.rejects(f.publish(), /Publisher file policy rejected.*\.github\/workflows\/publish\.yml/);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.gitPushes, []);
  assert.equal(git(f.remote, "show-ref"), f.remoteRefs);
});

for (const mismatch of ["missing", "tree", "source", "attempt", "files"]) {
  test(`publication rejects ${mismatch} native review evidence before any remote write`, async t => {
    const f = await fixture(t);
    if (mismatch === "missing") {
      rmSync(f.reviewedReceipt);
    } else {
      const reviewed = structuredClone(f.receipt);
      if (mismatch === "tree") reviewed.tree = "a".repeat(40);
      if (mismatch === "source") reviewed.source.commit = "a".repeat(40);
      if (mismatch === "attempt") reviewed.attempt = "0";
      if (mismatch === "files") reviewed.files = {};
      writeFileSync(f.reviewedReceipt, JSON.stringify(reviewed));
    }
    await assert.rejects(f.publish(), mismatch === "missing" ? /ENOENT/ : /Threat review does not match/);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.gitPushes, []);
    assert.equal(git(f.remote, "show-ref"), f.remoteRefs);
  });
}

for (const [name, values] of [
  ["failed", { TELEMETRY_DETECTION_RESULT: "failure" }],
  ["unconfirmed", { TELEMETRY_DETECTION_SUCCESS: "" }],
  ["skipped", { TELEMETRY_DETECTION_CONCLUSION: "skipped" }],
  ["warning", { TELEMETRY_DETECTION_CONCLUSION: "warning" }]
]) {
  test(`publication rejects ${name} native detection before any remote write`, async t => {
    const f = await fixture(t);
    environment(t, values);
    await assert.rejects(f.publish(), /successful native threat review/);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.gitPushes, []);
    assert.equal(git(f.remote, "show-ref"), f.remoteRefs);
  });
}

test("valid telemetry reaches the real signed publisher with all remote writes intercepted", async t => {
  const f = await fixture(t);
  await assert.rejects(f.publish(), /Publication write intercepted by regression harness/);
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
  assert.equal(git(f.remote, "show-ref"), f.remoteRefs);
});
