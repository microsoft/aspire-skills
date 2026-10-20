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
const compiled = parse(readFileSync(join(workflowDirectory, "update-aspire.lock.yml"), "utf8"));

test("release updates allow the publishing App and retain human-role checks", () => {
  const publisher = "aspire-repo-bot[bot]";
  assert.deepEqual(source.on.release.types, ["published"]);
  assert.deepEqual(source.on.bots, [publisher]);

  const membership = compiled.jobs.pre_activation.steps.find(
    (step) => step.id === "check_membership"
  );
  assert.ok(membership, "release activation must check the actor");
  assert.equal(membership.env.GH_AW_ALLOWED_BOTS, publisher);
  assert.equal(membership.env.GH_AW_REQUIRED_ROLES, "admin,maintainer,write");
});

test("safe-output tokens cover downstream PRs and source-repository failure reports", () => {
  const repositories = ["aspire", "aspire-skills"];
  assert.deepEqual(
    [...source["safe-outputs"]["github-app"].repositories].sort(),
    repositories
  );

  for (const job of ["conclusion", "safe_outputs"]) {
    const token = compiled.jobs[job].steps.find(
      (step) => step.id === "safe-outputs-app-token"
    );
    assert.ok(token, `${job} must mint the safe-output App token`);
    assert.equal(token.with.owner, "microsoft");
    assert.deepEqual(token.with.repositories.split(/[\s,]+/).filter(Boolean).sort(), repositories);
    assert.equal(token.with["permission-issues"], "write");
  }
});
