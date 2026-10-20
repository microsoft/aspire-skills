import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

test("bundle commands use a GitHub CLI proxy without exposing its App token to the agent", () => {
  const tokenReference = "${{ steps.github-read-token.outputs.token }}";
  assert.equal(source.tools.github.mode, "gh-proxy");
  assert.equal(source.tools.github["github-token"], tokenReference);

  const steps = compiled.jobs.agent.steps;
  const proxy = steps.find((step) => step.run?.includes("start_cli_proxy.sh"));
  assert.ok(proxy, "start the authenticated CLI proxy before running bundle scripts");
  assert.equal(proxy.env.GH_TOKEN, tokenReference);

  const token = steps.find((step) => step.id === "github-read-token");
  assert.ok(token);
  assert.equal(token.with.owner, "microsoft");
  for (const permission of ["contents", "issues", "pull-requests"]) {
    assert.equal(token.with[`permission-${permission}`], "read");
  }
  assert.deepEqual(
    token.with.repositories.split(/[\s,]+/).filter(Boolean).sort(),
    ["aspire", "aspire-skills"]
  );
  assert.ok(steps.indexOf(token) < steps.indexOf(proxy));

  const policy = JSON.parse(proxy.env.CLI_PROXY_POLICY)["allow-only"];
  assert.equal(policy["min-integrity"], source.tools.github["min-integrity"]);
  assert.deepEqual(policy.repos, source.tools.github["allowed-repos"]);

  const execution = steps.find((step) => step.id === "agentic_execution");
  assert.ok(execution);
  assert.ok(steps.indexOf(proxy) < steps.indexOf(execution));
  assert.match(execution.run, /--difc-proxy-host awmg-cli-proxy:18443/);
  assert.match(execution.run, /--exclude-env GH_TOKEN\s/);
  assert.match(execution.run, /--exclude-env GITHUB_MCP_SERVER_TOKEN/);
  assert.notEqual(execution.env?.GH_TOKEN, proxy.env.GH_TOKEN);

  const cleanup = steps.find((step) => step.run?.includes("stop_cli_proxy.sh"));
  assert.ok(cleanup, "stop the CLI proxy even when the agent fails");
  assert.match(cleanup.if, /always\(\)/);
});

test("bundle attestation verification can fetch both trusted roots through the firewall", () => {
  const execution = compiled.jobs.agent.steps.find((step) => step.id === "agentic_execution");
  const domains = /\\"allowDomains\\":(\[[^\]]+\])/.exec(execution.run);
  assert.ok(domains, "the agent must have an explicit firewall domain allowlist");
  const allowedDomains = JSON.parse(domains[1].replace(/\\"/g, '"'));

  for (const host of ["tuf-repo.github.com", "tuf-repo-cdn.sigstore.dev"]) {
    assert.ok(source.network.allowed.includes(host), `${host} must be allowed in the source`);
    assert.ok(allowedDomains.includes(host), `${host} must be allowed in the sandbox`);
  }
});

test("optional maintenance stays disabled in authored configuration and generated workflows", () => {
  const configPath = join(workflowDirectory, "aw.json");
  assert.ok(existsSync(configPath), "disable maintenance through the compiler configuration");
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).maintenance, false);

  for (const workflow of [
    "agentics-maintenance.yml",
    "agentics-maintenance-microsoft-aspire.yml"
  ]) {
    assert.equal(existsSync(join(workflowDirectory, workflow)), false, workflow);
  }
});
