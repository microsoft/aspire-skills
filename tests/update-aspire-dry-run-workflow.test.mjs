import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const markdown = readFileSync(join(repoRoot, ".github", "workflows", "update-aspire-dry-run.md"), "utf8");
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
assert.ok(frontmatter);
const source = parse(frontmatter[1]);
const branch = "ellahathaway-temp-telemetry-dry-run";

test("the temporary workflow runs only on its isolated branch", () => {
  assert.deepEqual(source.on.push.branches, [branch]);
  assert.equal(source.on.pull_request, undefined);
  assert.equal(source.on.workflow_dispatch, undefined);
  assert.equal(source.env.SOURCE_PR_NUMBER, "111");
  assert.equal(source.env.DRY_RUN, "true");
  const shouldRun = new Function("github", `return (${source.if});`);
  const github = {
    repository: "microsoft/aspire-skills",
    ref: `refs/heads/${branch}`,
    event_name: "push"
  };
  assert.equal(shouldRun(github), true);
  assert.equal(shouldRun({ ...github, ref: "refs/heads/main" }), false);
  assert.equal(shouldRun({ ...github, repository: "example/fork" }), false);
  assert.equal(shouldRun({ ...github, event_name: "pull_request" }), false);
});

test("publication and diagnostic issues are unconditionally disabled", () => {
  const outputs = source["safe-outputs"];
  assert.equal(outputs.staged, true);
  assert.equal(outputs["github-token"], "${{ secrets.GITHUB_TOKEN }}");
  assert.equal(outputs["github-app"], undefined);
  assert.equal(outputs["report-failure-as-issue"], false);
  assert.equal(outputs["report-failed-jobs"], false);
  assert.equal(outputs["missing-tool"]["create-issue"], false);
  assert.equal(outputs["report-incomplete"]["create-issue"], false);
  assert.equal(outputs["add-comment"], undefined);
  assert.equal(outputs["create-issue"], undefined);
  assert.equal(outputs["create-pull-request"]["fallback-as-issue"], false);
  assert.equal(source.tools.github.mode, "gh-proxy");
  const token = source["pre-agent-steps"].find(step => step.id === "github-read-token");
  for (const permission of ["contents", "issues", "pull-requests"]) {
    assert.equal(token.with[`permission-${permission}`], "read");
  }
});

test("temporary verification runs all required telemetry tests in a fail-fast runner step", () => {
  assert.ok(source.network.allowed.includes("dnceng.pkgs.visualstudio.com"));
  assert.ok(!source.network.allowed.includes("*"));
  const step = source["post-steps"].find(item => item.id === "telemetry-verification");
  assert.ok(step);
  assert.equal(step.if, "success()");
  assert.equal(step.shell, "bash");
  assert.equal(step["continue-on-error"], undefined);
  assert.match(step.run, /^set -euo pipefail$/m);
  assert.match(step.run, /pwsh -NoLogo -NoProfile -NonInteractive/);
  assert.ok(step.run.indexOf("./restore.sh") < step.run.indexOf("dotnet test"));
  for (const name of [
    "AgentTelemetryCatalogTests", "AgentTelemetryHookTests", "AgentTelemetryCommandTests",
    "TelemetryHookConfiguratorTests", "TelemetryHookInstallerTests", "TelemetryHookScriptTests"
  ]) {
    assert.ok(step.run.includes(`--filter-class '*.${name}'`));
  }
  const verification = markdown.split("## Step 4: Write and Verify Telemetry Changes")[1]
    .split("## Step 5:")[0];
  assert.match(verification, /outside the agent sandbox/);
  assert.match(verification, /failed agent job replaces any proposal or no-op with\s+`report_incomplete`/);
});

test("failed verification replaces the staged proposal with an incomplete signal", async () => {
  const step = source["safe-outputs"].steps.find(item => item.id === "telemetry-verification-gate");
  const shouldRun = new Function("needs", "cancelled", `return (${step.if});`);
  assert.equal(shouldRun({ agent: { result: "failure" } }, () => false), true);
  assert.equal(shouldRun({ agent: { result: "success" } }, () => false), false);
  let output;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
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
      GITHUB_RUN_ID: "456"
    } },
    { warning() {} }
  );
  assert.equal(output.items.length, 1);
  assert.equal(output.items[0].type, "report_incomplete");
  assert.match(output.items[0].reason, /verification.*failed/);
  assert.match(output.items[0].details, /actions\/runs\/456/);
});

test("staged output processing checks out the approved Aspire pin without retaining credentials", () => {
  const step = source["safe-outputs"].steps.find(item => item.name === "Checkout Aspire for staged preview");
  assert.equal(step.uses, "actions/checkout@v6.0.2");
  assert.equal(step.with.repository, "microsoft/aspire");
  assert.equal(step.with.ref, "89b715e7941b8e538410210e4b244c8f1d4a95a0");
  assert.equal(step.with["persist-credentials"], false);
});

test("the approved Aspire prerequisite is pinned without bypassing ownership checks", () => {
  assert.equal(source.checkout[0].repository, "microsoft/aspire");
  assert.equal(source.checkout[0].ref, "89b715e7941b8e538410210e4b244c8f1d4a95a0");
  const outputs = source["safe-outputs"]["create-pull-request"];
  assert.equal(outputs["base-branch"], "ellahathaway-hook-only-maintenance");
  assert.deepEqual(outputs["allowed-base-branches"], ["ellahathaway-hook-only-maintenance"]);
  const preflight = source["pre-agent-steps"][0].run;
  assert.match(preflight, /track-telemetry\.sh/);
  assert.match(preflight, /track-telemetry\.ps1/);
  assert.match(preflight, /AspireSkills\/Embedded/);
  assert.match(preflight, /update-aspire-skills-bundle\.yml/);
  assert.match(markdown, /KnownMcpTools\.All/);
  assert.match(markdown, /offline regression test/);
});

test("a push resolves the open release PR to its head and always records dry-run mode", async () => {
  const script = source["pre-agent-steps"].find(step => step.id === "source-pr").with.script;
  const files = [{
    filename: "skills/aspire/SKILL.md",
    status: "modified",
    additions: 1,
    deletions: 1
  }];
  const head = "7d86a04d822b69a26aaa84ed0c3d65bff96c33df";
  const written = new Map();
  const github = {
    rest: {
      pulls: {
        async get(parameters) {
          assert.deepEqual(parameters, { owner: "microsoft", repo: "aspire-skills", pull_number: 111 });
          return {
            data: {
              title: "Release v0.0.5",
              body: "",
              merged: false,
              head: { sha: head },
              base: { ref: "main", repo: { full_name: "microsoft/aspire-skills" } },
              changed_files: files.length,
              html_url: "https://github.com/microsoft/aspire-skills/pull/111"
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
      assert.deepEqual(parameters, {
        owner: "microsoft",
        repo: "aspire-skills",
        pull_number: 111,
        per_page: 100
      });
      return files;
    }
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction("github", "process", "require", script)(
    github,
    { env: source.env },
    name => {
      assert.equal(name, "node:fs");
      return {
        mkdirSync(path, options) {
          assert.equal(path, "/tmp/gh-aw/agent");
          assert.deepEqual(options, { recursive: true });
        },
        writeFileSync(path, content) {
          written.set(path, JSON.parse(content));
        }
      };
    }
  );
  const context = written.get("/tmp/gh-aw/agent/source-pr.json");
  assert.equal(context.number, 111);
  assert.equal(context.commit, head);
  assert.equal(context.merged, false);
  assert.equal(context.dryRun, true);
  assert.deepEqual(written.get("/tmp/gh-aw/agent/source-pr-files.json"), files);
});
