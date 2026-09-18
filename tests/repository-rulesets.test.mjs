import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(root, ".github", "workflows", "test.yml"), "utf8");
const requiredChecks = [
  "Branch check", "Release validation",
  ...["ubuntu-latest", "macos-latest", "windows-latest"].map(os => `Test and build (${os})`)
];

for (const branch of ["main", "dev"]) {
  const ruleset = JSON.parse(readFileSync(join(root, "docs", "rulesets", `${branch}.json`), "utf8"));

  test(`${branch} ruleset is a disabled, exact-branch import preset with no bypass actors`, () => {
    assert.equal(ruleset.name, `Release flow - ${branch}`);
    assert.equal(ruleset.target, "branch");
    assert.equal(ruleset.enforcement, "disabled");
    assert.deepEqual(ruleset.bypass_actors, []);
    assert.deepEqual(ruleset.conditions, { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } });
    assert.deepEqual(ruleset.rules.map(rule => rule.type).sort(),
      ["deletion", "non_fast_forward", "pull_request", "required_status_checks"]);
  });

  test(`${branch} ruleset requires PRs without inventing reviewer requirements`, () => {
    const parameters = ruleset.rules.find(rule => rule.type === "pull_request").parameters;
    assert.deepEqual(parameters.allowed_merge_methods, branch === "main" ? ["merge"] : ["merge", "squash", "rebase"]);
    assert.equal(parameters.required_approving_review_count, 0);
    for (const property of ["dismiss_stale_reviews_on_push", "require_code_owner_review",
      "require_last_push_approval", "required_review_thread_resolution"]) {
      assert.equal(parameters[property], false);
    }
    assert.equal(parameters.required_reviewers, undefined);
  });

  test(`${branch} ruleset requires current branch, release, and matrix checks from GitHub Actions`, () => {
    const parameters = ruleset.rules.find(rule => rule.type === "required_status_checks").parameters;
    assert.equal(parameters.strict_required_status_checks_policy, true);
    assert.deepEqual(parameters.required_status_checks, requiredChecks.map(context => ({ context, integration_id: 15368 })));
    assert.match(workflow, /^    name: Branch check\r?$/m);
    assert.match(workflow, /^    name: Release validation\r?$/m);
    assert.match(workflow, /^    name: Test and build\r?$/m);
    for (const os of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
      assert.ok(workflow.includes(`- ${os}`));
    }
    assert.doesNotMatch(workflow, /^ +paths(?:-ignore)?:/m);
  });
}
