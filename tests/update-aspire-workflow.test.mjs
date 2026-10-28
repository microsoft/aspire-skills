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
