import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import { immutableSha, safeSkillPath } from "./upstream-skill-assessment.mjs";
import { applyPreviewDiff } from "./upstream-skill-patch.mjs";
import {
  allowedPublicationPaths, assertFresh, digest, previewFor,
  publicationBranch, publicationEnvironment, sourceMarker
} from "./validate-upstream-skill-assessment.mjs";

const repo = { owner: "microsoft", repo: "aspire-skills" };
const workflowPath = ".github/workflows/upstream-skill-assessment.yml";

export async function assertProtectedEnvironment(github, defaultBranch) {
  const { data: environment } = await github.rest.repos.getEnvironment({ ...repo, environment_name: publicationEnvironment });
  const reviewers = environment.protection_rules.find(rule => rule.type === "required_reviewers");
  assert.ok(reviewers?.reviewers?.length > 0 && reviewers.prevent_self_review === true,
    "Configure required reviewers and prevent self-review on upstream-skill-publication.");
  assert.equal(environment.can_admins_bypass, false, "Environment administrators must not bypass the preview approval.");
  assert.deepEqual(environment.deployment_branch_policy, { protected_branches: false, custom_branch_policies: true },
    "Restrict the publication environment to the default branch.");
  const { data: policies } = await github.rest.repos.listDeploymentBranchPolicies({ ...repo, environment_name: publicationEnvironment, per_page: 100 });
  assert.equal(policies.total_count, 1, "The publication environment must allow only the default branch.");
  assert.equal(policies.branch_policies[0]?.name, defaultBranch);
  assert.equal(policies.branch_policies[0]?.type, "branch");
}

export async function assertRunBinding(github, binding) {
  const { data: repository } = await github.rest.repos.get(repo);
  const branch = repository.default_branch;
  assert.equal(binding.repository, "microsoft/aspire-skills");
  assert.match(binding.runId, /^[1-9]\d*$/);
  assert.match(binding.attempt, /^[1-9]\d*$/);
  immutableSha(binding.workflowSha);
  assert.equal(binding.headSha, binding.workflowSha);
  assert.equal(binding.workflowRef, `${binding.repository}/${workflowPath}@refs/heads/${branch}`);
  const { data: workflow } = await github.rest.actions.getWorkflow({ ...repo, workflow_id: "upstream-skill-assessment.yml" });
  const { data: run } = await github.rest.actions.getWorkflowRun({ ...repo, run_id: Number(binding.runId) });
  assert.equal(run.repository.full_name, binding.repository);
  assert.equal(run.head_repository.full_name, binding.repository);
  assert.equal(run.workflow_id, workflow.id);
  assert.equal(run.path, workflowPath);
  assert.equal(run.head_branch, branch);
  assert.equal(run.head_sha, binding.workflowSha);
  assert.equal(run.run_attempt, Number(binding.attempt));
  assert.ok(["workflow_dispatch", "schedule"].includes(run.event));
  assert.equal(run.status, "in_progress", "Only the current, in-progress workflow may publish its artifact.");
  await assertProtectedEnvironment(github, branch);
}

export function readPublication(path, expectedDigest, expectedBinding) {
  assert.match(expectedDigest, /^[a-f0-9]{64}$/);
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8 * 1024 * 1024);
  const bytes = readFileSync(path);
  assert.ok(bytes.length <= 8 * 1024 * 1024);
  assert.equal(digest(bytes), expectedDigest, "The reviewed preview artifact changed.");
  const publication = JSON.parse(bytes.toString("utf8"));
  assert.equal(publication.schema, 1);
  assert.deepEqual(publication.binding, expectedBinding);
  assert.equal(publication.target.repository, "microsoft/aspire-skills");
  assert.equal(publication.target.branch, "dev");
  immutableSha(publication.target.sha);
  assert.ok(Array.isArray(publication.items) && publication.items.length > 0 && publication.items.length <= 5);
  assert.equal(new Set(publication.items.map(item => item.report.source.key)).size, publication.items.length);
  for (const item of publication.items) {
    assert.equal(item.status, "validated", "Blocked validation must not reach the writer.");
    assert.match(item.report.source.key, /^[a-f0-9]{64}$/);
    assert.ok(item.report.edits.length > 0 && item.report.edits.length <= 3);
    assert.ok(item.report.edits.every(edit => safeSkillPath(edit.path)));
    assert.ok(item.commands.length >= 8 && item.commands.every(command => command.exitCode === 0));
    assert.ok(Number.isInteger(item.trials) && item.trials > 0);
    const allowed = allowedPublicationPaths(item.report.edits);
    assert.ok(Array.isArray(item.files) && item.files.length >= item.report.edits.length && item.files.length <= allowed.size);
    assert.equal(new Set(item.files.map(file => file.path)).size, item.files.length);
    for (const file of item.files) {
      assert.ok(allowed.has(file.path), "Unapproved publication path.");
      assert.equal(typeof file.content, "string");
      assert.ok(Buffer.byteLength(file.content) <= 256 * 1024);
      assert.equal(file.digest, digest(file.content));
    }
    assert.deepEqual(item.preview, previewFor(item, publication.target, publication.binding),
      "The exact reviewed PR title/body/diff must not change.");
  }
  return publication;
}

export async function verifyPreviewFiles(github, publication) {
  for (const item of publication.items) {
    assert.equal(item.status, "validated");
    const originals = new Map();
    for (const file of item.files) {
      const { data } = await github.rest.repos.getContent({
        ...repo, path: file.path, ref: publication.target.sha
      });
      assert.ok(data.type === "file" && data.path === file.path && data.encoding === "base64" && data.size <= 256 * 1024);
      const content = Buffer.from(data.content, "base64").toString("utf8");
      originals.set(file.path, content);
    }
    const patched = applyPreviewDiff(item.preview.diff, originals);
    for (const file of item.files) assert.equal(patched.get(file.path), file.content, "Outbound content differs from the exact approved diff.");
    for (const edit of item.report.edits) {
      const before = originals.get(edit.path);
      assert.ok(typeof before === "string" && before.split(edit.before).length === 2);
      assert.equal(patched.get(edit.path), before.replace(edit.before, edit.after), "The approved replacement and preview disagree.");
    }
  }
}

export async function findExistingPull(github, source) {
  const branch = publicationBranch(source);
  const matches = new Map();
  const { data: byBranch } = await github.rest.pulls.list({ ...repo, state: "all", head: `microsoft:${branch}`, per_page: 100 });
  assert.ok(byBranch.length < 100, "Ambiguous source branch history requires human triage.");
  for (const pr of byBranch) matches.set(pr.number, pr);
  // The PR body is the durable source ledger even if the source branch was deleted or renamed.
  const { data: search } = await github.rest.search.issuesAndPullRequests({
    q: `repo:microsoft/aspire-skills is:pr in:body "upstream-aspire-source:${source.key}"`, per_page: 100
  });
  assert.equal(search.incomplete_results, false, "Incomplete durable source search.");
  assert.ok(search.total_count <= 100 && search.items.length === search.total_count, "Truncated durable source search.");
  for (const hit of search.items) {
    const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: hit.number });
    if (pr.body?.includes(sourceMarker(source))) matches.set(pr.number, pr);
  }
  assert.ok(matches.size <= 1, "Multiple existing source proposals require maintainer reconciliation.");
  for (const pr of matches.values()) {
    assert.equal(pr.base.repo.full_name, "microsoft/aspire-skills");
    assert.equal(pr.base.ref, "dev");
    assert.equal(pr.head.repo?.full_name, "microsoft/aspire-skills");
    assert.ok(pr.body?.includes(sourceMarker(source)), "An existing source branch belongs to an unrecognized PR.");
    return { number: pr.number, url: pr.html_url, state: pr.state, status: "duplicate" };
  }
  return null;
}

export async function publish({ reader, writer, publication }) {
  await assertRunBinding(reader, publication.binding);
  await verifyPreviewFiles(reader, publication);
  const results = [];
  for (const item of publication.items) {
    const source = item.report.source;
    const existing = await findExistingPull(reader, source);
    if (existing) { results.push({ source: source.key, ...existing }); continue; }
    await assertFresh(reader, publication.target, source);
    const { data: base } = await reader.rest.git.getCommit({ ...repo, commit_sha: publication.target.sha });
    const { data: tree } = await writer.rest.git.createTree({
      ...repo, base_tree: base.tree.sha,
      tree: item.files.map(file => ({ path: file.path, mode: "100644", type: "blob", content: file.content }))
    });
    const identity = {
      name: "Aspire Skills Bot", email: "aspire-skills-bot@users.noreply.github.com", date: publication.assessedAt
    };
    const { data: commit } = await writer.rest.git.createCommit({
      ...repo, tree: tree.sha, parents: [publication.target.sha],
      message: `${item.preview.title}\n\n${sourceMarker(source)}\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`,
      author: identity, committer: identity
    });
    const branch = publicationBranch(source);
    // listMatchingRefs avoids catching unrelated errors as an expected missing branch.
    const { data: refs } = await reader.rest.git.listMatchingRefs({ ...repo, ref: `heads/${branch}` });
    const ref = refs.find(ref => ref.ref === `refs/heads/${branch}`);
    if (ref) {
      const { data: previous } = await reader.rest.git.getCommit({ ...repo, commit_sha: ref.object.sha });
      assert.deepEqual(previous.parents.map(parent => parent.sha), [publication.target.sha], "Existing proposal branch has a different base; do not overwrite it.");
      assert.equal(previous.tree.sha, tree.sha, "Existing proposal branch differs from the reviewed content; do not force-push.");
    } else {
      await writer.rest.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha: commit.sha });
    }
    // Recheck immediately before the outbound PR write; no force pushes or automatic updates.
    const retry = await findExistingPull(reader, source);
    if (retry) { results.push({ source: source.key, ...retry }); continue; }
    await assertFresh(reader, publication.target, source);
    const { data: pr } = await writer.rest.pulls.create({
      ...repo, base: "dev", head: branch, draft: true, maintainer_can_modify: true,
      title: item.preview.title, body: item.preview.body
    });
    results.push({ source: source.key, number: pr.number, url: pr.html_url, state: pr.state, status: "draft-created" });
  }
  return results;
}
