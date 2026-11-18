import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { buildCatalog } from "../scripts/build-opencode-catalog.mjs";
import { Repository } from "../scripts/release-git.mjs";
import { finishAssessment, prepareAssessment, skillDocuments, sourceIdentity } from "../scripts/upstream-skill-assessment.mjs";
import {
  assertFresh, bindingFromEnvironment, digest, execute, previewFor,
  publicationBranch, sourceMarker, validateCandidates, validationPlan
} from "../scripts/validate-upstream-skill-assessment.mjs";
import {
  assertProtectedEnvironment, assertRunBinding, findExistingPull, publish, readPublication, verifyPreviewFiles
} from "../scripts/publish-upstream-skill-assessment.mjs";
import { applyPreviewDiff } from "../scripts/upstream-skill-patch.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clock = "2026-11-18T12:00:00.000Z";
const sha = "a".repeat(40);
const workflowSha = "b".repeat(40);
const sourcePath = "src/Aspire.Hosting/Terminal.cs";
const testPath = "tests/Aspire.Hosting.Tests/TerminalTests.cs";
const skillPath = "skills/fixture/SKILL.md";
const sourceText = "public Terminal WithTerminal(string command) { return new Terminal(command); }\n";
const testText = "public void PreservesCommand() { Assert.Equal(command, terminal.Command); }\n";
const original = "---\nname: fixture\ndescription: Terminal guidance for deterministic validation tests.\nlicense: MIT\n---\n\n# Fixture\n\nCurrent terminal guidance.\n";
const binding = {
  repository: "microsoft/aspire-skills", runId: "123", attempt: "2", workflowSha,
  headSha: workflowSha,
  workflowRef: "microsoft/aspire-skills/.github/workflows/upstream-skill-assessment.yml@refs/heads/main"
};
const sourcePr = {
  number: 77, merged: true, state: "closed", merge_commit_sha: sha,
  merged_at: "2026-11-18T10:00:00Z", changed_files: 2,
  base: { ref: "main", sha: "c".repeat(40), repo: { full_name: "microsoft/aspire" } },
  head: { sha: "d".repeat(40) }, title: "Terminal API update", body: "Untrusted evidence."
};
const source = sourceIdentity(sourcePr);
const modelDraft = {
  status: "draft", reason: "The implementation and tests establish the command contract.", api: "WithTerminal",
  citations: [{ path: sourcePath, quote: sourceText.trim() }, { path: testPath, quote: testText.trim() }],
  edits: [{ path: skillPath, before: "Current terminal guidance.", after: "Proposed terminal guidance." }]
};

function scratch(t) {
  const directory = join(root, ".test-artifacts");
  mkdirSync(directory, { recursive: true });
  const path = mkdtempSync(join(directory, "upstream-publication-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function fixture(t) {
  const directory = scratch(t);
  const repositoryRoot = join(directory, "repository");
  mkdirSync(repositoryRoot);
  assert.equal(execute(["git", "init", "--quiet"], { cwd: repositoryRoot, env: process.env }).exitCode, 0);
  const repo = new Repository(repositoryRoot);
  write(repositoryRoot, skillPath, original);
  write(repositoryRoot, "skills/fixture/evals/eval.yaml", "name: offline-fixture\n");
  write(repositoryRoot, ".gitignore", ".upstream-results/\n.upstream-tmp/\nnode_modules/\n");
  write(repositoryRoot, "package.json", JSON.stringify({
    name: "offline-upstream-fixture", version: "1.0.0", private: true, type: "module",
    scripts: { test: "node --test tests/*.test.mjs", catalog: "node scripts/build-opencode-catalog.mjs", "catalog:check": "node scripts/check-opencode-catalog.mjs" }
  }));
  write(repositoryRoot, "package-lock.json", '{"name":"offline-upstream-fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"offline-upstream-fixture","version":"1.0.0"}}}');
  write(repositoryRoot, "tests/guidance.test.mjs", `import { readFileSync } from "node:fs"; import assert from "node:assert/strict"; import test from "node:test"; test("actual candidate guidance", () => assert.match(readFileSync("${skillPath}", "utf8"), /Proposed terminal guidance/));`);
  mkdirSync(join(repositoryRoot, "scripts"));
  for (const script of ["build-opencode-catalog.mjs", "check-opencode-catalog.mjs", "release-git.mjs", "release-catalog.mjs", "check-eval-results.mjs"]) {
    cpSync(join(root, "scripts", script), join(repositoryRoot, "scripts", script));
  }
  buildCatalog(repositoryRoot);
  repo.run(["add", "."]);
  repo.run(["commit", "--quiet", "-m", "test: create offline fixture\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"]);
  return { directory, root: repositoryRoot, repo, target: { repository: binding.repository, branch: "dev", sha: repo.sha("HEAD") } };
}

function githubApi(target, originals = new Map([[skillPath, original]])) {
  const calls = [];
  const prs = [];
  const refs = [];
  let branchSha = target.sha;
  const environment = {
    can_admins_bypass: false,
    protection_rules: [{ type: "required_reviewers", prevent_self_review: true, reviewers: [{ type: "Team", reviewer: { id: 1 } }] }],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
  };
  const run = {
    repository: { full_name: binding.repository }, head_repository: { full_name: binding.repository },
    workflow_id: 1, path: ".github/workflows/upstream-skill-assessment.yml", head_branch: "main",
    head_sha: workflowSha, run_attempt: 2, event: "workflow_dispatch", status: "in_progress"
  };
  const reader = { rest: {
    repos: {
      get: async () => ({ data: { default_branch: "main" } }),
      getBranch: async () => ({ data: { commit: { sha: branchSha } } }),
      getEnvironment: async () => ({ data: environment }),
      listDeploymentBranchPolicies: async () => ({ data: { total_count: 1, branch_policies: [{ name: "main", type: "branch" }] } }),
      getContent: async ({ path, repo }) => {
        const content = repo === "aspire-skills" ? originals.get(path) : path === sourcePath ? sourceText : testText;
        assert.equal(typeof content, "string", `Missing mocked immutable blob: ${path}`);
        return { data: { type: "file", path, sha, encoding: "base64", size: Buffer.byteLength(content), content: Buffer.from(content).toString("base64") } };
      }
    },
    actions: {
      getWorkflow: async () => ({ data: { id: 1 } }),
      getWorkflowRun: async () => ({ data: run })
    },
    pulls: {
      get: async request => ({ data: request.repo === "aspire" ? sourcePr : prs.find(pr => pr.number === request.pull_number) }),
      listFiles: async () => ({ data: [sourcePath, testPath].map(filename => ({ filename, status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" })) }),
      list: async request => {
        calls.push(["list", request]);
        return { data: prs.filter(pr => `microsoft:${pr.head.ref}` === request.head) };
      }
    },
    search: { issuesAndPullRequests: async request => {
      calls.push(["search", request]);
      return { data: { incomplete_results: false, total_count: prs.length, items: prs.map(pr => ({ number: pr.number })) } };
    } },
    git: {
      getCommit: async request => ({ data: { tree: { sha: request.commit_sha === target.sha ? "e".repeat(40) : "f".repeat(40) }, parents: [{ sha: target.sha }] } }),
      listMatchingRefs: async () => ({ data: refs })
    }
  } };
  const writer = { rest: {
    git: {
      createTree: async request => { calls.push(["tree", request]); return { data: { sha: "f".repeat(40) } }; },
      createCommit: async request => { calls.push(["commit", request]); return { data: { sha: "1".repeat(40) } }; },
      createRef: async request => {
        calls.push(["ref", request]); refs.push({ ref: request.ref, object: { sha: request.sha } });
        return { data: {} };
      }
    },
    pulls: { create: async request => {
      calls.push(["create", request]);
      const pr = {
        number: 12, state: "open", html_url: "https://github.com/microsoft/aspire-skills/pull/12",
        body: request.body, base: { ref: "dev", repo: { full_name: binding.repository } },
        head: { ref: request.head, repo: { full_name: binding.repository } }
      };
      prs.push(pr);
      return { data: pr };
    } }
  } };
  return { reader, writer, calls, prs, refs, environment, run, advance: () => { branchSha = "9".repeat(40); } };
}

async function assessment(fixture, github) {
  const prepared = await prepareAssessment({
    github, inputs: { pr_number: "77" }, now: clock, targetSha: fixture.target.sha, documents: skillDocuments(fixture.root)
  });
  const responses = [{ status: "inspect", paths: [skillPath] }, modelDraft];
  const review = await finishAssessment(prepared, async () => JSON.stringify(responses.shift()));
  return { prepared, review };
}

function offlineResults(work, skill) {
  const evalFilePath = join(work, `skills/${skill}/evals/eval.yaml`);
  const common = { evalFilePath, variant: "main", model: "offline-contract-fixture" };
  const records = [
    { type: "trial-result", ...common, evalName: "offline-fixture", stimulus: "offline-only", status: "success", gradeResult: { passed: true, score: 1 } },
    { type: "run-summary", hadExecutionErrors: false, evals: [{ ...common, name: "offline-fixture", stimuliRun: 1, stimuliTotal: 1 }] }
  ];
  write(work, `.upstream-results/${skill}/run/results.jsonl`, records.map(record => JSON.stringify(record)).join("\n"));
}

// Only the model and optional lint CLI are substituted; git, Node tests and catalogs really run.
function offlineCommands(command, options) {
  assert.equal(options.env.GH_TOKEN, undefined);
  assert.equal(options.env.GITHUB_TOKEN, undefined);
  assert.equal(options.env.WRITER_TOKEN, undefined);
  if (command[0] === "vally") {
    if (command[1] === "eval") offlineResults(options.cwd, "fixture");
    return { exitCode: 0, output: "OFFLINE CONTRACT FIXTURE: no hosted model request was made.\n" };
  }
  return execute(command, options);
}

async function validatedFixture(t, runCommand = offlineCommands) {
  const data = fixture(t);
  const api = githubApi(data.target, new Map([...data.repo.files(data.target.sha)].map(([path]) =>
    [path, data.repo.read(data.target.sha, path).toString("utf8")])));
  const { prepared, review } = await assessment(data, api.reader);
  const output = join(data.directory, "validation");
  const result = await validateCandidates({
    root: data.root, output, prepared, review, binding, github: api.reader, runCommand
  });
  return { ...data, ...api, ...result, output, prepared, review };
}

function publisherFixture(t) {
  const output = scratch(t);
  const target = { repository: binding.repository, branch: "dev", sha };
  const api = githubApi(target);
  const content = original.replace(modelDraft.edits[0].before, modelDraft.edits[0].after);
  const oldLines = original.trimEnd().split("\n");
  const newLines = content.trimEnd().split("\n");
  const item = {
    status: "validated", report: { source, ...modelDraft }, skills: ["fixture"], trials: 1,
    commands: Array.from({ length: 10 }, (_, index) => ({ command: ["offline-contract-command", String(index)], exitCode: 0 })),
    files: [{ path: skillPath, content, digest: digest(content) }],
    diff: [
      `diff --git a/${skillPath} b/${skillPath}`, "index 1111111..2222222 100644",
      `--- a/${skillPath}`, `+++ b/${skillPath}`,
      `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
      ...oldLines.map(line => `-${line}`), ...newLines.map(line => `+${line}`), ""
    ].join("\n")
  };
  item.preview = previewFor(item, target, binding);
  const publication = { schema: 1, binding, target, assessedAt: clock, items: [item] };
  const json = JSON.stringify(publication);
  writeFileSync(join(output, "publication.json"), json);
  return { ...api, output, target, publication, digest: digest(json) };
}

test("offline end-to-end contract applies exact docs in an isolated pinned clone, really tests and regenerates committed catalogs, then publishes only via mocked APIs", async t => {
  const data = await validatedFixture(t);
  const item = data.publication.items[0];
  assert.equal(item.status, "validated");
  assert.equal(data.review.state.entries.length, 0, "Draft proposals must remain retryable until a durable PR exists.");
  assert.equal(item.trials, 1);
  assert.equal(readFileSync(join(data.root, skillPath), "utf8"), original);
  assert.equal(data.repo.run(["status", "--porcelain"]), "");
  assert.equal(existsSync(join(data.output, `checkout-${source.key}`)), false);
  assert.match(item.diff, /Proposed terminal guidance/);
  assert.equal(item.files.length, 5, "Canonical Markdown, two catalog mirrors and two indexes must change together.");
  assert.match(item.preview.body, /shipping version unconfirmed/);
  assert.match(item.preview.body, /Actual isolated validation/);
  assert.match(item.preview.body, new RegExp(source.url));
  const publication = readPublication(join(data.output, "publication.json"), data.digest, binding);
  assert.deepEqual(publication, data.publication);
  assert.ok(readFileSync(join(data.output, "preview.txt"), "utf8").includes(item.preview.diff));
  const result = await publish({ reader: data.reader, writer: data.writer, publication });
  assert.equal(result[0].status, "draft-created");
  const request = data.calls.find(([kind]) => kind === "create")[1];
  assert.equal(request.draft, true);
  assert.equal(request.base, "dev");
  assert.equal(request.title, item.preview.title);
  assert.equal(request.body, item.preview.body);
  assert.equal(request.head, publicationBranch(source));
  assert.ok(data.calls.find(([kind]) => kind === "tree")[1].tree.every(file => file.mode === "100644"));
});

test("actual command failure is persistent and retryable; no pretend eval or publish success", async t => {
  const data = await validatedFixture(t, (command, options) => command[0] === "vally"
    ? { exitCode: 17, output: "model/lint setup unavailable" } : execute(command, options));
  assert.equal(data.publication.items[0].status, "blocked");
  assert.equal(data.publication.items[0].preview, undefined);
  assert.equal(data.review.state.entries.length, 0);
  assert.match(readFileSync(join(data.output, "preview.txt"), "utf8"), /BLOCKED/);
  assert.throws(() => readPublication(join(data.output, "publication.json"), data.digest, binding), /Blocked validation/);
  assert.equal(data.calls.some(([kind]) => kind === "create"), false);
});

test("missing and dishonest model result artifacts fail closed and isolated clones are cleaned", async t => {
  for (const mode of ["missing", "failed-grade", "uncovered-spec"]) {
    const data = fixture(t);
    const api = githubApi(data.target);
    const { prepared, review } = await assessment(data, api.reader);
    const output = join(data.directory, mode);
    await assert.rejects(validateCandidates({
      root: data.root, output, prepared, review, binding, github: api.reader,
      runCommand: (command, options) => {
        if (command[0] === "vally") {
          if (command[1] === "eval" && mode !== "missing") {
            offlineResults(options.cwd, "fixture");
            const file = join(options.cwd, ".upstream-results/fixture/run/results.jsonl");
            const records = readFileSync(file, "utf8").split("\n").map(line => JSON.parse(line));
            if (mode === "failed-grade") records[0].gradeResult.passed = false;
            else for (const record of records) {
              if (record.evalFilePath) record.evalFilePath = "skills/other/evals/eval.yaml";
              if (record.evals) record.evals[0].evalFilePath = "skills/other/evals/eval.yaml";
            }
            writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n"));
          }
          return { exitCode: 0, output: "OFFLINE malformed-result fixture" };
        }
        if ((command[0] === "node" && command[1] === "scripts/check-eval-results.mjs") ||
            (command[0] === "npm" && ["ci", "test"].includes(command[1]))) {
          return { exitCode: 0, output: "Offline unit substitute; the end-to-end contract separately runs these commands." };
        }
        return execute(command, options);
      }
    }), /Missing evaluation|grade failed|did not cover/);
    assert.equal(existsSync(join(output, `checkout-${source.key}`)), false);
    assert.equal(existsSync(join(output, "publication.json")), false);
  }
});

test("stale dev/source guards reject work before applying it", async t => {
  const data = fixture(t);
  const api = githubApi(data.target);
  await assertFresh(api.reader, data.target, source);
  api.advance();
  await assert.rejects(assertFresh(api.reader, data.target, source), /dev advanced/);
  const other = githubApi(data.target);
  await assert.rejects(assertFresh(other.reader, data.target, { ...source, branch: "release/unknown" }), /upstream source changed/);
});

test("durable dedup includes open and closed PRs even without any state artifacts and suppresses further analysis", async t => {
  const data = publisherFixture(t);
  await publish({ reader: data.reader, writer: data.writer, publication: data.publication });
  for (const state of ["open", "closed"]) {
    data.prs[0].state = state;
    const existing = await findExistingPull(data.reader, source);
    assert.equal(existing.number, 12);
    const result = await publish({ reader: data.reader, writer: data.writer, publication: data.publication });
    assert.equal(result[0].status, "duplicate");
    const prepared = await prepareAssessment({
      github: data.reader, inputs: { pr_number: "77", reassess: "true" }, now: clock,
      targetSha: data.target.sha, documents: { [skillPath]: original },
      findPublished: source => findExistingPull(data.reader, source)
    });
    assert.equal(prepared.sources.length, 0);
    assert.equal(prepared.reports[0].proposal.number, 12);
  }
  data.prs[0].head.ref = "maintainer/renamed-proposal";
  assert.equal((await findExistingPull(data.reader, source)).number, 12, "The durable source marker survives a branch rename.");
  assert.equal(data.calls.filter(([kind]) => kind === "create").length, 1);
  assert.ok(data.calls.filter(([kind]) => kind === "list").every(([, request]) => request.state === "all"));
});

test("publisher resumes an orphaned branch after PR transport failure without force pushes", async t => {
  const data = publisherFixture(t);
  const originalCreate = data.writer.rest.pulls.create;
  data.writer.rest.pulls.create = async () => { throw new Error("transport unavailable"); };
  await assert.rejects(publish({ reader: data.reader, writer: data.writer, publication: data.publication }), /transport/);
  assert.equal(data.refs.length, 1);
  data.writer.rest.pulls.create = originalCreate;
  const results = await publish({ reader: data.reader, writer: data.writer, publication: data.publication });
  assert.equal(results[0].status, "draft-created");
  assert.equal(data.calls.filter(([kind]) => kind === "ref").length, 1);
  assert.equal(data.writer.rest.git.updateRef, undefined);
});

test("publication fails closed when durable search is incomplete or an orphan branch was edited", async t => {
  const data = publisherFixture(t);
  data.refs.push({ ref: `refs/heads/${publicationBranch(source)}`, object: { sha: "2".repeat(40) } });
  data.reader.rest.git.getCommit = async () => ({ data: { tree: { sha: "3".repeat(40) }, parents: [{ sha: data.target.sha }] } });
  await assert.rejects(publish({ reader: data.reader, writer: data.writer, publication: data.publication }), /differs from the reviewed content/);
  data.reader.rest.search.issuesAndPullRequests = async () => ({ data: { incomplete_results: true } });
  await assert.rejects(findExistingPull(data.reader, source), /Incomplete durable source search/);
  assert.equal(data.calls.some(([kind]) => kind === "create"), false);
});

test("approval preflight enforces real required reviewers, no bypass and the exact default branch", async () => {
  const api = githubApi({ sha });
  await assertProtectedEnvironment(api.reader, "main");
  for (const mutate of [
    () => { api.environment.protection_rules = []; },
    () => { api.environment.protection_rules[0].prevent_self_review = false; },
    () => { api.environment.can_admins_bypass = true; },
    () => { api.environment.deployment_branch_policy.custom_branch_policies = false; }
  ]) {
    const previous = structuredClone(api.environment);
    mutate();
    await assert.rejects(assertProtectedEnvironment(api.reader, "main"));
    Object.assign(api.environment, previous);
  }
  await assert.rejects(assertProtectedEnvironment(api.reader, "dev"));
  api.reader.rest.repos.getEnvironment = async () => { throw new Error("404 environment is not configured"); };
  await assert.rejects(assertProtectedEnvironment(api.reader, "main"), /404/);
});

test("the validation plan scopes all nested affected-skill specs and checks the new catalog commit", () => {
  const plan = validationPlan(root, [{ path: "skills/aspireify/SKILL.md" }]);
  const evaluation = plan.find(command => command[0] === "vally" && command[1] === "eval");
  assert.ok(evaluation.includes("skills/aspireify/evals/eval.yaml"));
  assert.ok(evaluation.includes("skills/aspireify/evals/safety/eval.yaml"));
  assert.ok(evaluation.includes("--require-pass"));
  assert.ok(evaluation.includes("priority=p0,p1"));
  assert.ok(plan.findIndex(command => command.includes("commit")) < plan.findIndex(command => command.includes("catalog:check")));
  assert.ok(!plan.some(command => command.join(" ").includes("skills/aspire-terminals/evals")));
});

test("writer authenticates artifact origin, workflow, run, attempt and SHA and refuses changed previews", async t => {
  const data = publisherFixture(t);
  await assertRunBinding(data.reader, binding);
  for (const change of [
    { head_sha: "1".repeat(40) }, { run_attempt: 1 }, { event: "pull_request" },
    { head_branch: "dev" }, { workflow_id: 2 }, { status: "completed" },
    { head_repository: { full_name: "fork/aspire-skills" } }
  ]) {
    const previous = structuredClone(data.run);
    Object.assign(data.run, change);
    await assert.rejects(assertRunBinding(data.reader, binding));
    Object.assign(data.run, previous);
  }
  assert.throws(() => readPublication(join(data.output, "publication.json"), "0".repeat(64), binding), /artifact changed/);
  assert.throws(() => readPublication(join(data.output, "publication.json"), data.digest, { ...binding, attempt: "3" }));
  const changed = structuredClone(data.publication);
  changed.items[0].preview.body += "\nUnapproved addition";
  const content = JSON.stringify(changed);
  writeFileSync(join(data.output, "changed.json"), content);
  assert.throws(() => readPublication(join(data.output, "changed.json"), digest(content), binding), /exact reviewed PR/);
});

test("workflow requires the artifact-linked approval before obtaining a repository-scoped writer; writer runs no generated code or models", () => {
  const workflow = parse(readFileSync(join(root, ".github/workflows/upstream-skill-assessment.yml"), "utf8"));
  const writer = workflow.jobs.publish;
  assert.deepEqual(writer.needs, ["assess", "publication-gate"]);
  assert.equal(writer.environment.name, "upstream-skill-publication");
  assert.match(writer.environment.url, /preview-url/);
  assert.equal(writer.permissions["copilot-requests"], undefined);
  assert.equal(writer.permissions.contents, "read");
  assert.equal(writer.steps.some(step => step.run), false);
  const tokenIndex = writer.steps.findIndex(step => step.id === "writer");
  assert.ok(writer.steps.findIndex(step => step.name?.startsWith("Verify same-run")) < tokenIndex);
  assert.ok(writer.steps.every(step => !JSON.stringify(step).includes("COPILOT_GITHUB_TOKEN")));
  const script = readFileSync(join(root, "scripts/publish-upstream-skill-assessment.mjs"), "utf8");
  assert.doesNotMatch(script, /execFile|spawn|eval\(|updateRef|pulls\.update|pulls\.merge/);
  assert.match(workflow.jobs["publication-gate"].steps.at(-1).with.script, /UPSTREAM_SKILL_PUBLISH_ENABLED|PUBLISH_ENABLED/);
  const validation = workflow.jobs.assess.steps.find(step => step.id === "validate").with.script;
  assert.match(validation, /validateCandidates/);
  assert.match(validation, /root: join\(process.env.GITHUB_WORKSPACE, ".test-artifacts", "upstream-skills-base"\)/,
    "Clone the already-fetched pinned dev checkout, not a workflow checkout that may lack a newer dev object.");
});

test("binding derives only immutable same-repository workflow identity", () => {
  const env = {
    GITHUB_REPOSITORY: binding.repository, GITHUB_RUN_ID: binding.runId, GITHUB_RUN_ATTEMPT: binding.attempt,
    GITHUB_WORKFLOW_SHA: workflowSha, GITHUB_SHA: workflowSha, GITHUB_WORKFLOW_REF: binding.workflowRef
  };
  assert.deepEqual(bindingFromEnvironment(env), binding);
  assert.throws(() => bindingFromEnvironment({ ...env, GITHUB_SHA: sha }));
  assert.equal(sourceMarker(source), `<!-- upstream-aspire-source:${source.key} -->`);
});

test("the pure-data preview applier handles context, multiple hunks and missing final newlines and rejects incomplete or deceptive patches", () => {
  const path = skillPath;
  const prefix = `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n`;
  const diff = prefix + "@@ -1,2 +1,2 @@\n context\n-old\n+new\n@@ -5 +5 @@\n-last\n\\ No newline at end of file\n+last-new\n\\ No newline at end of file\n";
  const originals = new Map([[path, "context\nold\nthird\nfourth\nlast"]]);
  assert.equal(applyPreviewDiff(diff, originals).get(path), "context\nnew\nthird\nfourth\nlast-new");
  for (const invalid of [
    diff.replace("+1,2", "+2,2"), diff.replace(" context", " wrong"),
    diff.replace("-old", "-invented"), diff.replace("+new\n", ""), diff.replace("100644", "100755"),
    diff.replace(`b/${path}\n`, "b/outside\n"), diff + prefix, diff.slice(0, -1)
  ]) assert.throws(() => applyPreviewDiff(invalid, originals));
  assert.equal(applyPreviewDiff(prefix + "@@ -0,0 +1 @@\n+new\n", new Map([[path, ""]])).get(path), "new\n");
});

test("a checksummed artifact cannot publish files different from its reviewed patch", async t => {
  const data = publisherFixture(t);
  await verifyPreviewFiles(data.reader, data.publication);
  data.publication.items[0].files[0].content += "Unapproved guidance";
  await assert.rejects(verifyPreviewFiles(data.reader, data.publication), /Outbound content differs/);
  assert.equal(data.calls.some(([kind]) => kind === "create"), false);
});
