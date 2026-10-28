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
assert.ok(frontmatter, "release update workflow must have frontmatter");
const source = parse(frontmatter[1]);

test("release updates allow the publishing App", () => {
  assert.deepEqual(source.on.release.types, ["published"]);
  assert.deepEqual(source.on.bots, ["aspire-repo-bot[bot]"]);
});

test("manual dispatches support an optional dry-run boolean and live runs by default", () => {
  const input = source.on.workflow_dispatch.inputs.release_tag;
  assert.equal(input.required, true);
  assert.equal(input.type, "string");
  const dryRunInput = source.on.workflow_dispatch.inputs.dry_run;
  assert.equal(dryRunInput.required, false);
  assert.equal(dryRunInput.type, "boolean");
  assert.equal(dryRunInput.default, false);
  assert.equal(source.env.RELEASE_TAG, "${{ github.event.release.tag_name || inputs.release_tag }}");
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
    ["release", undefined, false],
    ["release", true, false]
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

async function resolveReleaseContext({
  tag = "v0.0.4",
  eventName = "workflow_dispatch",
  dryRun = false,
  eventSha = "b".repeat(40),
  commit = "a".repeat(40),
  draft = false,
  lookupError
} = {}) {
  const step = source["pre-agent-steps"].find(item => item.id === "release-context");
  assert.ok(step);
  const repository = { owner: "microsoft", repo: "aspire-skills" };
  let result;
  const github = {
    rest: {
      repos: {
        async getReleaseByTag(parameters) {
          assert.deepEqual(parameters, { ...repository, tag });
          if (lookupError) throw lookupError;
          return { data: { tag_name: tag, draft, html_url: `https://github.com/microsoft/aspire-skills/releases/tag/${tag}` } };
        },
        async getCommit(parameters) {
          assert.deepEqual(parameters, { ...repository, ref: `refs/tags/${tag}` });
          return { data: { sha: commit } };
        }
      }
    }
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction("github", "context", "process", "require", step.with.script)(
    github,
    { eventName, sha: eventSha },
    { env: { RELEASE_TAG: tag, DRY_RUN: String(dryRun) } },
    moduleName => {
      assert.equal(moduleName, "node:fs");
      return {
        mkdirSync(path, options) {
          assert.equal(path, "/tmp/gh-aw/agent");
          assert.equal(options.recursive, true);
        },
        writeFileSync(path, content) {
          assert.equal(path, "/tmp/gh-aw/agent/release-context.json");
          result = JSON.parse(content);
        }
      };
    }
  );
  return result;
}

test("manual dispatch resolves the selected release and defaults to live mode", async () => {
  const result = await resolveReleaseContext();
  assert.equal(result.tag, "v0.0.4");
  assert.equal(result.commit, "a".repeat(40));
  assert.equal(result.dryRun, false);
  assert.equal(result.url, "https://github.com/microsoft/aspire-skills/releases/tag/v0.0.4");
});

test("manual dispatch records dry-run mode only when requested", async () => {
  const result = await resolveReleaseContext({ dryRun: true });
  assert.equal(result.dryRun, true);
});

test("release events retain triggering-commit verification and live mode", async () => {
  const result = await resolveReleaseContext({ eventName: "release", eventSha: "a".repeat(40), dryRun: true });
  assert.equal(result.dryRun, false);
  await assert.rejects(resolveReleaseContext({ eventName: "release" }), /triggering commit/);
});

test("release context rejects invalid tags, drafts, bad commits, and lookup failures", async () => {
  for (const tag of ["", "0.0.4", "v01.0.0", "v1.0.0-01", "v0.0.4\n", "v0.0.4;echo injected"]) {
    await assert.rejects(resolveReleaseContext({ tag }), /SemVer/);
  }
  await assert.rejects(resolveReleaseContext({ draft: true }), /published release/);
  await assert.rejects(resolveReleaseContext({ commit: "not-a-commit" }), /commit SHA/);
  await assert.rejects(resolveReleaseContext({ lookupError: new Error("Release not found") }), /Release not found/);
  const prerelease = await resolveReleaseContext({ tag: "v1.0.0-preview.1+build.7" });
  assert.equal(prerelease.tag, "v1.0.0-preview.1+build.7");
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
  assert.deepEqual(publication["allowed-branches"], ["update-aspire-telemetry-*"]);
  assert.equal(publication["protected-files"].policy, "blocked");
  assert.ok(publication["allowed-files"].every(path =>
    !path.includes("AspireSkills") && !path.endsWith(".tgz") && !path.endsWith(".csproj")
  ));
});

test("optional maintenance stays disabled in authored configuration", () => {
  assert.equal(JSON.parse(readFileSync(join(workflowDirectory, "aw.json"), "utf8")).maintenance, false);
});
