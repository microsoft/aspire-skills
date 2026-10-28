import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowDirectory = join(repoRoot, ".github", "workflows");
const markdown = readFileSync(join(workflowDirectory, "update-aspire.md"), "utf8");
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
assert.ok(frontmatter, "telemetry update workflow must have frontmatter");
const source = parse(frontmatter[1]);

test("telemetry updates follow the merged-main and manual PR workflow pattern", () => {
  assert.deepEqual(source.on.pull_request.types, ["closed"]);
  assert.deepEqual(source.on.pull_request.branches, ["main"]);
  assert.equal(source.on["stale-check"], false);
  assert.equal(source.on.release, undefined);
  assert.deepEqual(source.on.bots, ["aspire-repo-bot[bot]"]);
  const shouldRun = new Function("github", `return (${source.if});`);
  for (const [eventName, merged, expected] of [
    ["pull_request", true, true],
    ["pull_request", false, false],
    ["workflow_dispatch", false, true]
  ]) {
    assert.equal(shouldRun({
      repository: "microsoft/aspire-skills",
      event_name: eventName,
      event: { pull_request: { merged } }
    }), expected);
  }
  assert.equal(shouldRun({
    repository: "example/fork",
    event_name: "workflow_dispatch",
    event: { pull_request: { merged: false } }
  }), false);
});

test("manual dispatches support an optional dry-run boolean and live runs by default", () => {
  const input = source.on.workflow_dispatch.inputs.pr_number;
  assert.equal(input.required, true);
  assert.equal(input.type, "string");
  assert.equal(source.on.workflow_dispatch.inputs.release_tag, undefined);
  const dryRunInput = source.on.workflow_dispatch.inputs.dry_run;
  assert.equal(dryRunInput.required, false);
  assert.equal(dryRunInput.type, "boolean");
  assert.equal(dryRunInput.default, false);
  assert.equal(source.env.SOURCE_PR_NUMBER, "${{ github.event.pull_request.number || inputs.pr_number }}");
  const dryRunExpression = "${{ github.event_name == 'workflow_dispatch' && inputs.dry_run }}";
  assert.equal(source.env.DRY_RUN, dryRunExpression);
  assert.equal(source["safe-outputs"].staged, dryRunExpression);
  const issueExpressions = [
    source["safe-outputs"]["report-failure-as-issue"],
    source["safe-outputs"]["missing-tool"]["create-issue"],
    source["safe-outputs"]["report-incomplete"]["create-issue"]
  ];
  for (const [eventName, dryRun, staged] of [
    ["workflow_dispatch", false, false],
    ["workflow_dispatch", true, true],
    ["workflow_dispatch", undefined, false],
    ["pull_request", undefined, false],
    ["pull_request", true, false]
  ]) {
    const evaluate = expression => new Function("github", "inputs", `return (${expression.slice(3, -2)});`)(
      { event_name: eventName }, { dry_run: dryRun }
    );
    assert.equal(Boolean(evaluate(source["safe-outputs"].staged)), staged);
    for (const expression of issueExpressions) {
      assert.equal(evaluate(expression), !staged);
    }
  }
  assert.equal(source["safe-outputs"]["report-failed-jobs"], false);
});

async function resolvePrContext({
  value = "123",
  eventName = "workflow_dispatch",
  dryRun = false,
  merged = false,
  headCommit = "a".repeat(40),
  mergeCommit = "c".repeat(40),
  eventCommit = "c".repeat(40),
  base = "main",
  baseRepository = "microsoft/aspire-skills",
  changedFiles = [{
    filename: "extensions/example/extension.mjs",
    status: "modified",
    additions: 2,
    deletions: 1,
    patch: "@@ -1 +1 @@\n-old\n+new"
  }],
  fileCount = changedFiles.length,
  lookupError,
  filesError
} = {}) {
  const step = source["pre-agent-steps"].find(item => item.id === "source-pr");
  assert.ok(step);
  const repository = { owner: "microsoft", repo: "aspire-skills" };
  let result;
  let cachedFiles;
  const github = {
    rest: {
      pulls: {
        async get(parameters) {
          assert.deepEqual(parameters, { ...repository, pull_number: Number(value) });
          if (lookupError) throw lookupError;
          return {
            data: {
              title: "Update extension behavior",
              body: "Adjust the extension's resource command.",
              merged,
              changed_files: fileCount,
              head: { sha: headCommit },
              merge_commit_sha: mergeCommit,
              base: { ref: base, repo: { full_name: baseRepository } },
              html_url: `https://github.com/microsoft/aspire-skills/pull/${value}`
            }
          };
        },
        listFiles() {
          assert.fail("PR files must be fetched with pagination.");
        }
      }
    },
    async paginate(method, parameters) {
      assert.equal(method, github.rest.pulls.listFiles);
      assert.deepEqual(parameters, { ...repository, pull_number: Number(value), per_page: 100 });
      if (filesError) throw filesError;
      return changedFiles;
    }
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction("github", "context", "process", "require", step.with.script)(
    github,
    {
      eventName,
      sha: "b".repeat(40),
      payload: { pull_request: { merge_commit_sha: eventCommit } }
    },
    { env: { SOURCE_PR_NUMBER: value, DRY_RUN: String(dryRun) } },
    moduleName => {
      assert.equal(moduleName, "node:fs");
      return {
        mkdirSync(path, options) {
          assert.equal(path, "/tmp/gh-aw/agent");
          assert.equal(options.recursive, true);
        },
        writeFileSync(path, content) {
          if (path === "/tmp/gh-aw/agent/source-pr.json") {
            result = JSON.parse(content);
          } else {
            assert.equal(path, "/tmp/gh-aw/agent/source-pr-files.json");
            cachedFiles = JSON.parse(content);
          }
        }
      };
    }
  );
  assert.deepEqual(cachedFiles, changedFiles);
  return result;
}

test("manual dispatch accepts an unmerged PR and pins its head rather than the workflow commit", async () => {
  const result = await resolvePrContext();
  assert.equal(result.number, 123);
  assert.equal(result.title, "Update extension behavior");
  assert.equal(result.body, "Adjust the extension's resource command.");
  assert.equal(result.commit, "a".repeat(40));
  assert.equal(result.merged, false);
  assert.equal(result.dryRun, false);
  assert.equal(result.url, "https://github.com/microsoft/aspire-skills/pull/123");
  assert.deepEqual(result.changed_files, [{
    filename: "extensions/example/extension.mjs",
    status: "modified",
    additions: 2,
    deletions: 1
  }]);
});

test("manual dispatch uses the merge commit for a merged source PR", async () => {
  const result = await resolvePrContext({ merged: true });
  assert.equal(result.commit, "c".repeat(40));
  assert.equal(result.merged, true);
});

test("manual dispatch records dry-run mode only when requested", async () => {
  const result = await resolvePrContext({ dryRun: true });
  assert.equal(result.dryRun, true);
});

test("automatic PR runs require the triggering merge and retain live mode", async () => {
  const result = await resolvePrContext({ eventName: "pull_request", merged: true, dryRun: true });
  assert.equal(result.dryRun, false);
  assert.equal(result.commit, "c".repeat(40));
  await assert.rejects(resolvePrContext({ eventName: "pull_request" }), /requires a merged PR/);
  await assert.rejects(resolvePrContext({
    eventName: "pull_request",
    merged: true,
    eventCommit: "d".repeat(40)
  }), /triggering merge commit/);
});

test("source PR context rejects bad numbers, wrong targets, bad commits, and lookup failures", async () => {
  for (const value of ["", "0", "-1", "01", "1.5", "1e3", "123\n", "123;echo injected", "9007199254740992"]) {
    await assert.rejects(resolvePrContext({ value }), /positive integer/);
  }
  await assert.rejects(resolvePrContext({ base: "dev" }), /must target/);
  await assert.rejects(resolvePrContext({ baseRepository: "example/fork" }), /must target/);
  await assert.rejects(resolvePrContext({ headCommit: "not-a-commit" }), /commit SHA/);
  await assert.rejects(resolvePrContext({ merged: true, mergeCommit: null }), /commit SHA/);
  await assert.rejects(resolvePrContext({ lookupError: new Error("PR not found") }), /PR not found/);
  await assert.rejects(resolvePrContext({ fileCount: 2 }), /changed-file list is incomplete/);
  await assert.rejects(resolvePrContext({ filesError: new Error("Cannot read PR files") }), /Cannot read PR files/);
});

test("the assessment covers extensions and requires canonical MCP regression coverage before no-op", () => {
  assert.equal(source.name, "Update Aspire telemetry");
  assert.match(source.description, /skills, extensions/);
  assert.match(markdown, /`skills\/`[\s\S]+`extensions\/`/);
  assert.match(markdown, /`KnownMcpTools\.All`/);
  assert.match(markdown, /offline regression test/);
  assert.match(markdown, /mismatch must[\s\S]+never `noop`/);
});

test("workflow-owned verification requires restore and all telemetry test classes", () => {
  assert.ok(source.network.allowed.includes("dnceng.pkgs.visualstudio.com"));
  assert.ok(!source.network.allowed.includes("*"));
  const step = source["post-steps"].find(item => item.id === "telemetry-verification");
  assert.ok(step);
  assert.equal(step.if, "success()");
  assert.equal(step.shell, "bash");
  assert.equal(step["continue-on-error"], undefined);
  assert.match(step.run, /^set -euo pipefail$/m);
  assert.match(step.run, /XDG_RUNTIME_DIR="\$RUNNER_TEMP\/aspire-telemetry-runtime"/);
  assert.match(step.run, /pwsh -NoLogo -NoProfile -NonInteractive/);
  assert.ok(step.run.indexOf("./restore.sh") < step.run.indexOf("dotnet test"));
  assert.doesNotMatch(step.run, /\|\s*(head|tail|tee)\b|\|\|\s*true/);
  for (const name of [
    "AgentTelemetryCatalogTests", "AgentTelemetryHookTests", "AgentTelemetryCommandTests",
    "TelemetryHookConfiguratorTests", "TelemetryHookInstallerTests", "TelemetryHookScriptTests"
  ]) {
    assert.ok(step.run.includes(`--filter-class '*.${name}'`), `${name} must run`);
  }
  const verification = markdown.split("## Step 4: Write and Verify Telemetry Changes")[1]
    .split("## Step 5:")[0];
  assert.match(verification, /outside the agent sandbox/);
  assert.match(verification, /Do not run restore or this required test suite inside the agent sandbox/);
  assert.match(verification, /failed agent job replaces any proposal or no-op with\s+`report_incomplete`/);
});

test("failed agent or verification jobs replace proposals and no-ops with an incomplete outcome", async () => {
  const step = source["safe-outputs"].steps.find(item => item.id === "telemetry-verification-gate");
  assert.ok(step);
  const shouldRun = new Function("needs", "cancelled", `return (${step.if});`);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const [result, cancelled, expected] of [
    ["success", false, false],
    ["failure", false, true],
    ["cancelled", false, true],
    ["failure", true, false]
  ]) {
    assert.equal(shouldRun({ agent: { result } }, () => cancelled), expected);
    if (!expected) continue;
    for (const type of ["create_pull_request", "noop"]) {
      let output = { items: [{ type }], errors: [] };
      const warnings = [];
      await new AsyncFunction("require", "process", "core", step.with.script)(
        name => {
          assert.equal(name, "node:fs");
          return {
            writeFileSync(path, content) {
              assert.equal(path, "/tmp/gh-aw/agent_output.json");
              output = JSON.parse(content);
            }
          };
        },
        { env: {
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_REPOSITORY: "microsoft/aspire-skills",
          GITHUB_RUN_ID: "123"
        } },
        { warning(message) { warnings.push(message); } }
      );
      assert.equal(output.items.length, 1);
      assert.equal(output.items[0].type, "report_incomplete");
      assert.match(output.items[0].reason, /verification.*failed/);
      assert.match(output.items[0].details, /actions\/runs\/123/);
      assert.deepEqual(output.errors, []);
      assert.equal(warnings.length, 1);
    }
  }
});

test("staged previews get a read-only Aspire checkout without affecting live publication", () => {
  const step = source["safe-outputs"].steps.find(item => item.name === "Checkout Aspire for staged preview");
  assert.ok(step);
  assert.equal(step.uses, "actions/checkout@v6.0.2");
  assert.equal(step.with.repository, "microsoft/aspire");
  assert.equal(step.with.ref, "main");
  assert.equal(step.with["persist-credentials"], false);
  const shouldRun = new Function("env", "needs", `return (${step.if});`);
  for (const [staged, result, expected] of [
    ["true", "success", true],
    ["false", "success", false],
    ["true", "failure", false]
  ]) {
    assert.equal(shouldRun({ GH_AW_SAFE_OUTPUTS_STAGED: staged }, { agent: { result } }), expected);
  }
});

test("repository-scoped App credentials use the configured bot secrets", () => {
  const token = source["pre-agent-steps"].find(step => step.id === "github-read-token");
  assert.ok(token);
  for (const app of [
    source.checkout[0]["github-app"],
    token.with,
    source["safe-outputs"]["github-app"]
  ]) {
    assert.equal(app["client-id"], "${{ secrets.ASPIRE_BOT_APP_ID }}");
    assert.equal(app["private-key"], "${{ secrets.ASPIRE_BOT_PRIVATE_KEY }}");
    assert.equal(app.owner, "microsoft");
  }
  assert.equal(source.tools.github.mode, "gh-proxy");
  assert.equal(source.tools.github["github-token"], "${{ steps.github-read-token.outputs.token }}");
  for (const permission of ["contents", "issues", "pull-requests"]) {
    assert.equal(token.with[`permission-${permission}`], "read");
  }
  assert.deepEqual(source.tools.github["allowed-repos"].toSorted(), ["microsoft/aspire", "microsoft/aspire-skills"]);
  assert.deepEqual(
    token.with.repositories.split(/[\s,]+/).filter(Boolean).sort(),
    ["aspire", "aspire-skills"]
  );
  assert.deepEqual(
    source["safe-outputs"]["github-app"].repositories.toSorted(),
    ["aspire", "aspire-skills"]
  );
});

test("downstream proposals are draft-only and exclude bundle updates", () => {
  assert.equal(source["safe-outputs"]["report-incomplete"].max, 1);
  const publication = source["safe-outputs"]["create-pull-request"];
  assert.equal(publication["target-repo"], "microsoft/aspire");
  assert.equal(publication["base-branch"], "main");
  assert.equal(publication.draft, true);
  assert.equal(publication["title-prefix"], "[telemetry] ");
  assert.deepEqual(publication["allowed-branches"], ["update-aspire-telemetry-*"]);
  assert.equal(publication["protected-files"].policy, "blocked");
  assert.ok(publication["allowed-files"].every(path =>
    !path.includes("AspireSkills") && !path.endsWith(".tgz") && !path.endsWith(".csproj")
  ));
});

test("optional maintenance stays disabled in authored configuration", () => {
  assert.equal(JSON.parse(readFileSync(join(workflowDirectory, "aw.json"), "utf8")).maintenance, false);
});
