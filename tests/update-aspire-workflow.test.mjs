import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";
import {
  applyFrozenProposal, cloneTrustedBase, dockerArguments, freezeBundle, pinPublicationBase, publicationPolicy,
  parseTestResults, prepareVerifiedReview, resolveSource, testResultSummary, validateOutcome, validatePublication, validateReceipt,
  validateReviewReceipt
} from "../scripts/telemetry-workflow.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = join(root, ".github", "workflows", "update-aspire.md");
const markdown = readFileSync(workflowPath, "utf8");
const authored = parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)[1]);
const compiledText = readFileSync(workflowPath.replace(/\.md$/, ".lock.yml"), "utf8");
const compiled = parse(compiledText);
const allowedPath = "src/Aspire.Cli/Agents/Hooks/AgentTelemetryCatalog.cs";

function git(directory, ...args) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: directory, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" }
  }).trim();
}

function write(directory, path, value) {
  mkdirSync(dirname(join(directory, path)), { recursive: true });
  writeFileSync(join(directory, path), value);
}

function commit(directory, message = "fixture") {
  git(directory, "add", ".");
  git(directory, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message);
  return git(directory, "rev-parse", "HEAD");
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "telemetry-policy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo");
  mkdirSync(repo);
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "core.autocrlf", "false");
  write(repo, allowedPath, "baseline\n");
  write(repo, "restore.sh", "#!/bin/sh\nexit 0\n");
  const base = commit(repo);
  const output = join(directory, "telemetry-verified");
  mkdirSync(output);
  const source = {
    number: 123, commit: base, base, aspireBase: base, merged: false,
    branch: "update-aspire-telemetry-pr-123",
    url: "https://github.com/microsoft/aspire-skills/pull/123"
  };
  const policy = { allowed_files: [allowedPath], max_patch_files: 100, max_patch_size: 4096 };
  const checkFiles = (files, configuration) => {
    const disallowed = files.filter(path => !configuration.allowed_files.includes(path));
    return disallowed.length ? { action: "deny", files: disallowed } : { action: "allow" };
  };
  return { directory, repo, base, output, source, policy, checkFiles };
}

function proposal(f, files = { [allowedPath]: "candidate\n" }) {
  git(f.repo, "switch", "--quiet", "--create", f.source.branch);
  for (const [path, content] of Object.entries(files)) write(f.repo, path, content);
  const head = commit(f.repo);
  const bundle = join(f.directory, "input.bundle");
  git(f.repo, "bundle", "create", bundle, `${f.base}..${f.source.branch}`);
  return { ...f, head, bundle };
}

function freeze(f) {
  return freezeBundle({
    directory: f.repo, bundle: f.bundle, source: f.source,
    outputDirectory: f.output, policy: f.policy, checkFiles: f.checkFiles
  });
}

function withRun(t, directory) {
  for (const [name, value] of Object.entries({
    RUNNER_TEMP: directory, GITHUB_RUN_ID: "123456", GITHUB_RUN_ATTEMPT: "2"
  })) {
    const old = process.env[name];
    process.env[name] = value;
    t.after(() => old === undefined ? delete process.env[name] : process.env[name] = old);
  }
}

function artifactFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "telemetry-artifacts-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, "telemetry-verified");
  mkdirSync(output);
  const base = "1".repeat(40);
  return {
    directory, output, head: "3".repeat(40),
    source: {
      number: 123, commit: base, base, aspireBase: base, merged: false,
      branch: "update-aspire-telemetry-pr-123",
      url: "https://github.com/microsoft/aspire-skills/pull/123"
    }
  };
}

function receipt(f, type = "create_pull_request") {
  for (const name of readdirSync(f.output)) rmSync(join(f.output, name));
  const tests = type === "report_incomplete" ? undefined : { total: 1, passed: 1, failed: 0, skipped: 0 };
  const summary = tests ? `${testResultSummary(tests)}\n\n` : "";
  const item = type === "noop"
    ? { type, message: `${summary}Baseline covers the selected source.` }
    : type === "report_incomplete"
      ? { type, reason: "A required update could not be prepared." }
      : { type, branch: f.source.branch, title: "Telemetry", body: `${summary}Changes.` };
  if (tests) writeFileSync(join(f.output, "telemetry-tests.log"), "Isolated fixture test output.");
  if (type === "create_pull_request") {
    const prefix = `aw-microsoft-aspire-${f.source.branch}`;
    writeFileSync(join(f.output, `${prefix}.bundle`), "verified bundle");
    writeFileSync(join(f.output, `${prefix}.patch`), "verified patch");
  }
  writeFileSync(join(f.output, "agent_output.json"), JSON.stringify({ items: [item], errors: [] }));
  return {
    source: f.source, type, tree: "2".repeat(40), ...(tests ? { tests } : {}),
    run: "123456", attempt: "2",
    files: Object.fromEntries(readdirSync(f.output).map(name => [
      name, createHash("sha256").update(readFileSync(join(f.output, name))).digest("hex")
    ]))
  };
}

test("manual runs remain live by default while automatic activation requires a merged source", () => {
  const accepts = new Function("github", `return (${authored.if});`);
  for (const [name, merged, expected] of [
    ["pull_request", true, true], ["pull_request", false, false], ["workflow_dispatch", false, true]
  ]) {
    assert.equal(accepts({
      repository: "microsoft/aspire-skills", event_name: name, event: { pull_request: { merged } }
    }), expected);
  }
  assert.equal(accepts({
    repository: "example/fork", event_name: "workflow_dispatch", event: { pull_request: { merged: false } }
  }), false);
  assert.equal(authored.on.workflow_dispatch.inputs.dry_run.default, false);
});

test("source evidence comes from immutable commits even when a manual PR advances", async t => {
  const f = fixture(t);
  withRun(t, f.directory);
  git(f.repo, "remote", "add", "origin", f.repo);
  git(f.repo, "config", `url.${f.repo.replaceAll("\\", "/")}.insteadOf`, "https://github.com/microsoft/aspire.git");
  write(f.repo, "extensions/example/extension.mjs", "selected\n");
  const head = commit(f.repo);
  write(f.repo, "extensions/example/extension.mjs", "later revision\n");
  commit(f.repo);
  const pr = {
    title: "Selected PR", body: "Untrusted evidence", merged: false,
    head: { sha: head }, base: { ref: "main", sha: f.base, repo: { full_name: "microsoft/aspire-skills" } }
  };
  const github = { rest: { pulls: { get: async () => ({ data: pr }) } } };
  const context = { eventName: "workflow_dispatch", payload: { inputs: { pr_number: "123", dry_run: "true" } } };
  const source = await resolveSource({ github, context, directory: f.repo });
  assert.equal(source.commit, head);
  assert.equal(source.base, f.base);
  const evidence = join(f.directory, "telemetry-source");
  const metadata = JSON.parse(readFileSync(join(evidence, "source-pr.json")));
  assert.deepEqual(metadata, { ...source, dryRun: true });
  const diff = readFileSync(join(evidence, "source-pr.diff"), "utf8");
  assert.match(diff, /\+selected/);
  assert.doesNotMatch(diff, /later revision/);
  assert.deepEqual(JSON.parse(readFileSync(join(evidence, "source-pr-files.json"))), [
    { filename: "extensions/example/extension.mjs", additions: 1, deletions: 0 }
  ]);
});

test("a force-push after the PR metadata snapshot cannot change the pinned inventory or diff", async t => {
  const f = fixture(t);
  withRun(t, f.directory);
  git(f.repo, "remote", "add", "origin", f.repo);
  git(f.repo, "config", `url.${f.repo.replaceAll("\\", "/")}.insteadOf`, "https://github.com/microsoft/aspire.git");
  write(f.repo, "extensions/selected/extension.mjs", "selected revision\n");
  const selected = commit(f.repo);
  let replacement;
  const github = { rest: { pulls: {
    get: async () => {
      const pr = {
        merged: false, head: { sha: selected },
        base: { ref: "main", sha: f.base, repo: { full_name: "microsoft/aspire-skills" } }
      };
      git(f.repo, "switch", "--quiet", "--detach", f.base);
      write(f.repo, "extensions/replacement/extension.mjs", "force-pushed revision\n");
      replacement = commit(f.repo);
      git(f.repo, "update-ref", "refs/heads/main", replacement, selected);
      return { data: pr };
    },
    listFiles: async () => { throw new Error("Mutable PR-files endpoints must not be used."); }
  } } };
  const source = await resolveSource({
    github, context: { eventName: "workflow_dispatch", payload: { inputs: { pr_number: "123" } } },
    directory: f.repo
  });
  assert.equal(git(f.repo, "rev-parse", "main"), replacement);
  assert.equal(git(f.repo, "merge-base", selected, replacement), f.base);
  assert.equal(source.commit, selected);
  const evidence = join(f.directory, "telemetry-source");
  assert.deepEqual(JSON.parse(readFileSync(join(evidence, "source-pr-files.json"))), [
    { filename: "extensions/selected/extension.mjs", additions: 1, deletions: 0 }
  ]);
  const diff = readFileSync(join(evidence, "source-pr.diff"), "utf8");
  assert.match(diff, /\+selected revision/);
  assert.doesNotMatch(diff, /replacement|force-pushed revision/);
});

test("source resolution rejects malformed inputs and mismatched automatic triggers", async t => {
  const directory = mkdtempSync(join(tmpdir(), "telemetry-invalid-source-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const base = "1".repeat(40);
  const pr = {
    merged: true, merge_commit_sha: base,
    base: { ref: "main", repo: { full_name: "microsoft/aspire-skills" } }
  };
  const github = { rest: { pulls: { get: async () => ({ data: pr }) } } };
  for (const value of ["", "0", "01", "-1", "1.5", "1e3", "123\n", "123;echo injected"]) {
    await assert.rejects(resolveSource({
      github, context: { eventName: "workflow_dispatch", payload: { inputs: { pr_number: value } } }, directory
    }), /positive integer/);
  }
  await assert.rejects(resolveSource({
    github, context: { eventName: "pull_request", payload: { pull_request: { number: 123, merge_commit_sha: "a".repeat(40) } } },
    directory
  }), /triggering merge commit/);
  pr.merged = false;
  await assert.rejects(resolveSource({
    github, context: { eventName: "pull_request", payload: { pull_request: { number: 123 } } },     directory
  }), /requires a merged PR/);
  pr.base.ref = "dev";
  await assert.rejects(resolveSource({
    github, context: { eventName: "workflow_dispatch", payload: { inputs: { pr_number: "123" } } }, directory
  }), /must target/);
});

test("contradictory outcomes and forged destinations cannot reach publication", () => {
  const source = { branch: "update-aspire-telemetry-pr-123" };
  const good = { type: "create_pull_request", branch: source.branch, title: "Telemetry", body: "Evidence." };
  for (const item of [
    { ...good, branch: "update-aspire-telemetry-pr-999" },
    { ...good, repo: "example/other" }, { ...good, base: "release/99" },
    { ...good, title: "" }, { type: "noop", message: "" }, { type: "missing_tool" }
  ]) {
    assert.throws(() => validateOutcome({ items: [item] }, source));
  }
  assert.throws(() => validateOutcome({ items: [good, { type: "noop", message: "Contradiction." }] }, source));
  assert.throws(() => validateOutcome({ items: [good], errors: ["failed"] }, source));
  const accepted = validateOutcome({
    items: [{ ...good, draft: false, assignees: ["attacker"], base_commit: "a".repeat(40) }]
  }, source);
  assert.deepEqual(accepted, { ...good, repo: "microsoft/aspire", base: "main" });
});

test("frozen bundle contains one trusted commit and exactly the proposed tree", t => {
  const f = proposal(fixture(t));
  const result = freeze(f);
  const head = git(f.repo, "bundle", "list-heads", join(f.output, result.bundle));
  const commit = head.split(" ")[0];
  assert.equal(result.tree, git(f.repo, "rev-parse", `${f.head}^{tree}`));
  assert.equal(git(f.repo, "rev-parse", `${commit}^`), f.base);
  assert.equal(git(f.repo, "rev-list", "--count", `${f.base}..${commit}`), "1");
  assert.equal(head, `${commit} refs/heads/${f.source.branch}`);
});

test("out-of-policy build scripts are rejected without executing candidate code", t => {
  const f = fixture(t);
  const canary = join(f.directory, "host-code-executed");
  const candidate = proposal(f, { [allowedPath]: "candidate\n", "restore.sh": `touch '${canary}'\n` });
  assert.throws(() => freeze(candidate), /file policy rejected.*restore\.sh/);
  assert.equal(existsSync(canary), false);
  assert.deepEqual(readdirSync(f.output), []);
});

test("symlink changes, different bundle heads, and excessive patches fail before verification", t => {
  const f = proposal(fixture(t));
  assert.throws(() => freeze({ ...f, source: { ...f.source, branch: "update-aspire-telemetry-pr-999" } }), /expected proposal head/);
  assert.throws(() => freeze({ ...f, policy: { ...f.policy, max_patch_size: 0 } }), /patch limit/);
  git(f.repo, "update-index", "--cacheinfo", `120000,${git(f.repo, "rev-parse", `HEAD:${allowedPath}`)},${allowedPath}`);
  git(f.repo, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "symlink");
  const bundle = join(f.directory, "symlink.bundle");
  git(f.repo, "bundle", "create", bundle, `${f.base}..${f.source.branch}`);
  assert.throws(() => freeze({ ...f, bundle }), /file mode/);
});

test("sandbox source reuses the trusted base without its credentials, candidate refs, or shared metadata", t => {
  const f = proposal(fixture(t));
  const workspace = join(f.directory, "sandbox");
  mkdirSync(workspace);
  assert.throws(() => cloneTrustedBase(f.repo, workspace, f.base), /trusted base/);
  assert.deepEqual(readdirSync(workspace), []);
  git(f.repo, "config", "http.https://github.com/.extraheader", "fixture-only-header");
  git(f.repo, "checkout", "--quiet", f.base);
  cloneTrustedBase(f.repo, workspace, f.base);
  assert.equal(git(workspace, "rev-parse", "HEAD"), f.base);
  assert.equal(git(workspace, "rev-list", "--all"), f.base);
  assert.equal(readFileSync(join(workspace, allowedPath), "utf8"), "baseline\n");
  assert.doesNotMatch(git(workspace, "config", "--local", "--list"), /fixture-only-header/);
  assert.equal(git(workspace, "config", "--get", "remote.origin.url"), "https://github.com/microsoft/aspire.git");
  git(workspace, "config", "test.sandbox", "independent");
  assert.doesNotMatch(git(f.repo, "config", "--local", "--list"), /test\.sandbox/);
});

test("frozen patch reproduces the verified tree without escaping its disposable checkout", t => {
  const f = proposal(fixture(t));
  const result = freeze(f);
  const workspace = join(f.directory, "sandbox");
  git(f.directory, "clone", "--quiet", "--no-checkout", f.repo, workspace);
  git(workspace, "checkout", "--quiet", f.base);
  applyFrozenProposal(workspace, join(f.output, result.patch), result.tree);
  assert.equal(readFileSync(join(workspace, allowedPath), "utf8"), "candidate\n");
  assert.equal(git(workspace, "write-tree"), result.tree);
  const patch = join(f.directory, "escape.patch");
  for (const path of ["../outside", "/absolute", "nested/../../outside"]) {
    writeFileSync(patch, `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+escaped\n`);
    assert.throws(() => applyFrozenProposal(workspace, patch, result.tree), /invalid path/i);
  }
  assert.equal(existsSync(join(f.directory, "outside")), false);
});

test("verification restores trusted code separately from offline candidate tests", () => {
  const options = {
    workspace: "/private/source", cache: "/private/cache", name: "test",
    uid: 1001, gid: 1001, base: "a".repeat(40)
  };
  const args = dockerArguments({ ...options, offline: true });
  assert.ok(args.includes("--network=none"));
  assert.match(args.at(-1), /--no-restore/);
  assert.doesNotMatch(args.at(-1), /restore\.sh/);
  assert.throws(() => dockerArguments({ uid: 0, gid: 0 }), /unprivileged/);
  const restore = dockerArguments({ ...options, offline: false });
  assert.ok(restore.includes("--network=bridge"));
  assert.match(restore.at(-1), /restore\.sh/);
  assert.doesNotMatch(restore.at(-1), /dotnet test|git (?:fetch|clone|init)/);
});

test("completed assertion failures produce an explicit result instead of an execution failure", () => {
  const output = [
    "failed Aspire.Cli.Tests.Agents.AgentTelemetryHookTests.AllowlistsMatchCanonicalPowerShellHook",
    "Test run summary: Failed!",
    "  total: 189",
    "  failed: 12",
    "  succeeded: 177",
    "  skipped: 0",
    "  duration: 58s 025ms"
  ].join("\n");
  const tests = parseTestResults(2, output);
  assert.deepEqual(tests, { total: 189, failed: 12, passed: 177, skipped: 0 });
  assert.equal(testResultSummary(tests),
    "**Isolated telemetry tests: FAILED**\n\n177 passed, 12 failed, 0 skipped (189 total).");
  const passed = output.replace("Failed!", "Passed!").replace("failed: 12", "failed: 0")
    .replace("succeeded: 177", "succeeded: 189");
  assert.deepEqual(parseTestResults(0, passed), { total: 189, failed: 0, passed: 189, skipped: 0 });
  for (const [status, log] of [
    [1, "AgentTelemetryHookTests.cs(22,117): error CS9007: Invalid raw string.\nBuild failed."],
    [2, "Build failed."], [0, ""], [7, output], [124, output],
    [0, output], [2, passed], [2, output + "\n" + output],
    [2, output.replace("total: 189", "total: 190")],
    [2, output.replace("  total:", "  error: 1\n  total:")],
    [2, output.replace("  duration: 58s 025ms", "")],
    [0, passed.replace("total: 189", "total: 0").replace("succeeded: 189", "succeeded: 0")],
    [0, passed.replace("succeeded: 189", "succeeded: 0").replace("skipped: 0", "skipped: 189")]
  ]) {
    assert.deepEqual(parseTestResults(status, log), { status: "incomplete", exitCode: status });
  }
  assert.equal(testResultSummary(parseTestResults(1, "Build failed.")),
    "**Isolated telemetry build/tests: NOT COMPLETED**\n\n" +
    "Build/test command exited with code 1. No completed test result was confirmed.");
  for (const status of [null, -1, 125, 126, 127, 256]) {
    assert.throws(() => parseTestResults(status, output), /Isolated verifier execution failed/);
  }
  assert.throws(() => testResultSummary({ status: "incomplete", exitCode: null }), /valid exit code/);
});

test("publication rejects altered artifacts, different source snapshots, and stale run attempts", t => {
  const f = artifactFixture(t);
  withRun(t, f.directory);
  const verified = receipt(f);
  assert.equal(validateReceipt(verified, f.source, f.output).type, "create_pull_request");
  assert.throws(() => validateReceipt({ ...verified, attempt: "1" }, f.source, f.output), /run, and attempt/);
  assert.throws(() => validateReceipt(verified, { ...f.source, commit: "a".repeat(40) }, f.output), /source, run/);
  assert.throws(() => validateReceipt({ ...verified, files: { "../receipt.json": "forged" } }, f.source, f.output), /artifact set/);
  assert.throws(() => validateReceipt({
    ...verified, tests: { total: 1, failed: 1, passed: 0, skipped: 0 }
  }, f.source, f.output), /does not report the recorded test results/);
  const log = join(f.output, "telemetry-tests.log");
  const original = readFileSync(log);
  writeFileSync(log, "Test results changed after review.");
  assert.throws(() => validateReceipt(verified, f.source, f.output), /artifact changed: telemetry-tests.log/);
  writeFileSync(log, original);
  writeFileSync(join(f.output, Object.keys(verified.files).find(name => name.endsWith(".bundle"))), "changed after tests");
  assert.throws(() => validateReceipt(verified, f.source, f.output), /artifact changed/);
});

test("native review replaces raw transports with the frozen proposal and records its exact receipt", t => {
  const f = artifactFixture(t);
  withRun(t, f.directory);
  const verified = receipt(f);
  const directory = join(f.directory, "review-inputs");
  mkdirSync(directory);
  for (const name of ["agent_output.json", "telemetry-tests.log", "aw-unverified.patch", "aw-unverified.bundle"]) {
    writeFileSync(join(directory, name), "unverified");
  }
  write(directory, "aw-prompts/prompt.txt", "Original prompt context.");
  prepareVerifiedReview({ source: f.source, receipt: verified, directory });
  assert.equal(existsSync(join(directory, "aw-unverified.patch")), false);
  assert.equal(existsSync(join(directory, "aw-unverified.bundle")), false);
  for (const name of Object.keys(verified.files)) {
    assert.deepEqual(readFileSync(join(directory, name)), readFileSync(join(f.output, name)));
  }
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "verification-receipt.json"))), verified);
  assert.deepEqual(JSON.parse(readFileSync(join(f.directory, "telemetry-reviewed", "receipt.json"))), verified);
  assert.equal(readFileSync(join(directory, "aw-prompts", "prompt.txt"), "utf8"), "Original prompt context.");
});

test("native review binding rejects missing, stale, mismatched, skipped, and non-successful review", () => {
  const verified = {
    source: { commit: "1".repeat(40) }, tree: "2".repeat(40), type: "create_pull_request",
    run: "123456", attempt: "2", files: { "agent_output.json": "3".repeat(64) }
  };
  const detection = { result: "success", success: "true", conclusion: "success" };
  validateReviewReceipt(verified, structuredClone(verified), detection);
  for (const reviewed of [
    undefined, { ...verified, attempt: "1" },
    { ...verified, files: { "agent_output.json": "4".repeat(64) } }
  ]) {
    assert.throws(() => validateReviewReceipt(verified, reviewed, detection), /Threat review does not match/);
  }
  for (const result of [
    undefined, {}, { ...detection, result: "failure" }, { ...detection, success: "false" },
    { ...detection, conclusion: "skipped" }, { ...detection, conclusion: "warning" }
  ]) {
    assert.throws(() => validateReviewReceipt(verified, verified, result), /successful native threat review/);
  }
});

test("native publisher fetches cannot silently rebase a verified proposal", t => {
  const f = fixture(t);
  const publisher = join(f.directory, "publisher");
  git(f.directory, "clone", "--quiet", "--no-local", f.repo, publisher);
  pinPublicationBase(publisher, f.base);
  write(f.repo, "unrelated.txt", "main advanced\n");
  const advanced = commit(f.repo);
  git(publisher, "fetch", "origin", "main");
  assert.equal(git(publisher, "rev-parse", "origin/main"), f.base);
  assert.equal(git(publisher, "rev-parse", "origin/publication-main"), advanced);
});

test("publication audit requires the actual draft PR to contain the verified tree on its pinned parent", async t => {
  const f = artifactFixture(t);
  withRun(t, f.directory);
  const verified = receipt(f);
  const goodPr = {
    number: 42, html_url: "https://github.com/microsoft/aspire/pull/42", state: "open", draft: true, merged: false,
    body: `${testResultSummary(verified.tests)}\n\nChanges.`,
    base: { ref: "main", repo: { full_name: "microsoft/aspire" } },
    head: { ref: f.source.branch, sha: f.head, repo: { full_name: "microsoft/aspire" } }
  };
  const goodCommit = { sha: f.head, tree: { sha: verified.tree }, parents: [{ sha: f.source.aspireBase }] };
  let pr = goodPr;
  let commit = goodCommit;
  const reads = [];
  const github = { rest: {
    pulls: { get: async parameters => {
      assert.deepEqual(parameters, { owner: "microsoft", repo: "aspire", pull_number: 42 });
      reads.push("PR");
      return { data: pr };
    } },
    git: { getCommit: async parameters => {
      assert.deepEqual(parameters, { owner: "microsoft", repo: "aspire", commit_sha: f.head });
      reads.push("commit");
      return { data: commit };
    } }
  } };
  const audit = values => validatePublication({
    github, source: f.source, receipt: verified, publisherResult: "success",
    staged: false, number: "42", url: goodPr.html_url, ...values
  });
  assert.equal(await audit(), "published");
  for (const [name, change] of [
    ["wrong PR number", () => pr.number = 43],
    ["wrong actual URL", () => pr.html_url += "?unexpected"],
    ["closed PR", () => pr.state = "closed"],
    ["non-draft PR", () => pr.draft = false],
    ["merged PR", () => pr.merged = true],
    ["wrong base repository", () => pr.base.repo.full_name = "example/other"],
    ["wrong base branch", () => pr.base.ref = "release/99"],
    ["fork head", () => pr.head.repo.full_name = "example/fork"],
    ["wrong head branch", () => pr.head.ref += "-other"],
    ["wrong commit", () => commit.sha = "a".repeat(40)],
    ["untested tree", () => commit.tree.sha = "a".repeat(40)],
    ["different parent", () => commit.parents[0].sha = "a".repeat(40)],
    ["merge commit", () => commit.parents.push({ sha: "a".repeat(40) })]
  ]) {
    await t.test(name, async () => {
      pr = structuredClone(goodPr);
      commit = structuredClone(goodCommit);
      change();
      await assert.rejects(audit(), /actual PR does not match|published commit does not match/);
    });
  }
  pr = goodPr;
  commit = goodCommit;
  await assert.rejects(audit({
    github: { rest: { pulls: { get: async () => ({ data: { ...goodPr, body: "Results removed." } }) } } }
  }), /actual PR does not report the recorded test results/);
  for (const values of [
    { number: "", url: "" }, { number: "" }, { url: "" }, { number: "042" }, { number: "42\n" },
    { number: "42", url: "https://github.com/example/other/pull/42" },
    { number: "42", url: `${goodPr.html_url}/` }
  ]) {
    reads.length = 0;
    await assert.rejects(audit(values), /canonical Aspire PR number and URL/);
    assert.deepEqual(reads, []);
  }
  for (const publisherResult of ["failure", "cancelled", "skipped", ""]) {
    await assert.rejects(audit({ publisherResult }), /publisher did not complete successfully/);
  }
});

test("publication audit distinguishes staged previews, verified no-ops, incomplete work, and missing publication", async t => {
  const f = artifactFixture(t);
  withRun(t, f.directory);
  const github = { get rest() { throw new Error("This outcome must not call the GitHub API."); } };
  const audit = (verified, values = {}) => validatePublication({
    github, source: f.source, receipt: verified, publisherResult: "success",
    staged: false, ...values
  });
  let verified = receipt(f, "noop");
  assert.equal(await audit(verified), "noop");
  assert.equal(await audit(verified, { staged: true }), "staged");
  for (const values of [
    { number: "42" }, { url: "https://github.com/microsoft/aspire/pull/42" },
    { staged: true, number: "42", url: "https://github.com/microsoft/aspire/pull/42" }
  ]) {
    await assert.rejects(audit(verified, values), /unexpectedly published a PR/);
  }
  verified = receipt(f, "report_incomplete");
  await assert.rejects(audit(verified), /maintenance is incomplete/);
  await assert.rejects(audit(verified, { staged: true }), /maintenance is incomplete/);
  verified = receipt(f);
  assert.equal(await audit(verified, { staged: true }), "staged");
  await assert.rejects(audit(verified), /did not return a canonical Aspire PR/);
});

test("compiled workflow enforces verifier success, strict detection, and bounded credentials", async () => {
  assert.ok(compiled.jobs.agent.needs.includes("resolve-source"));
  assert.ok(compiled.jobs.safe_outputs.needs.includes("detection"));
  assert.ok(compiled.jobs.safe_outputs.needs.includes("verify-telemetry"));
  assert.match(compiled.jobs.safe_outputs.if, /needs\.detection\.result == 'success'/);
  assert.match(compiled.jobs.safe_outputs.if, /needs\.verify-telemetry\.result == 'success'/);
  const detection = authored["safe-outputs"]["threat-detection"];
  assert.equal(detection["continue-on-error"], false);
  assert.equal(detection["report-as-issue"], false);
  assert.ok(compiled.jobs.detection.needs.includes("verify-telemetry"));
  assert.ok(compiled.jobs.detection.needs.includes("resolve-source"));
  assert.match(compiled.jobs.detection.if, /needs\.verify-telemetry\.result == 'success'/);
  const reviewSteps = compiled.jobs.detection.steps;
  const stage = reviewSteps.findIndex(step => step.with?.script?.includes("prepareVerifiedReview("));
  const record = reviewSteps.findIndex(step => step.with?.name === "telemetry-reviewed-proposal");
  const execution = reviewSteps.findIndex(step => step.id === "detection_agentic_execution");
  assert.ok(stage > reviewSteps.findIndex(step => step.name === "Prepare threat detection files"));
  assert.ok(record > stage && record < execution);
  assert.equal(reviewSteps[execution].env.CUSTOM_PROMPT, detection.prompt);
  const publication = compiled.jobs.safe_outputs.steps.find(step =>
    step.with?.script?.includes("await promoteVerifiedProposal("));
  assert.equal(publication.env.TELEMETRY_DETECTION_SUCCESS, "${{ needs.detection.outputs.detection_success }}");
  assert.equal(publication.env.TELEMETRY_DETECTION_CONCLUSION, "${{ needs.detection.outputs.detection_conclusion }}");
  const validator = compiled.jobs.safe_outputs.steps.find(step => step.with?.path === "_telemetry-tools");
  assert.equal(validator.with.ref, "${{ github.workflow_sha }}");
  assert.equal(validator.with["persist-credentials"], false);
  for (const step of [
    compiled.jobs.detection.steps.find(step => step.id === "detection_agentic_execution"),
    compiled.jobs.detection.steps.find(step => step.env?.DETECTION_AGENTIC_EXECUTION_OUTCOME)
  ]) {
    assert.ok(step);
    assert.equal(step.env.GH_AW_DETECTION_CONTINUE_ON_ERROR, "false");
  }
  for (const name of ["resolve-source", "verify-telemetry", "validate-publication"]) {
    assert.ok(Object.values(compiled.jobs[name].permissions).every(value => ["none", "read"].includes(value)));
  }
  const maximum = { contents: "write", issues: "read", "pull-requests": "write" };
  const rank = { none: 0, read: 1, write: 2 };
  for (const name of ["safe_outputs", "conclusion"]) {
    const permissions = compiled.jobs[name].permissions ?? compiled.permissions;
    assert.ok(permissions && typeof permissions === "object");
    for (const [scope, value] of Object.entries(permissions)) {
      assert.ok(Object.hasOwn(rank, value));
      assert.ok(rank[value] <= rank[maximum[scope] ?? "none"], `${name} token exceeds ${scope} permission ceiling`);
    }
  }
  for (const name of ["agent", "safe_outputs"]) {
    assert.ok(!compiled.jobs[name].steps.some(step => step.run?.includes("./restore.sh")));
  }
  const policy = await publicationPolicy(root);
  assert.equal(policy.max, 1);
  assert.equal(policy.fallback_as_issue, false);
  assert.deepEqual(policy.allowed_base_branches, ["main"]);
});

test("compiled publication audit uses trusted code and read-only destination credentials after native publishing", () => {
  const audit = compiled.jobs["validate-publication"];
  for (const dependency of ["resolve-source", "verify-telemetry", "safe_outputs"]) {
    assert.ok(audit.needs.includes(dependency));
  }
  assert.match(audit.if, /!cancelled\(\).*needs\.verify-telemetry\.result == 'success'/);
  assert.ok(compiled.jobs.conclusion.needs.includes("validate-publication"));
  const checkout = audit.steps.find(step => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ github.workflow_sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const token = audit.steps.find(step => step.id === "publication-read-token");
  assert.equal(token.with.repositories, "aspire");
  assert.equal(token.with["permission-contents"], "read");
  assert.equal(token.with["permission-pull-requests"], "read");
  const validation = audit.steps.find(step => step.with?.script?.includes("validatePublication("));
  assert.equal(validation.env.TELEMETRY_PUBLISHER_RESULT, "${{ needs.safe_outputs.result }}");
  assert.equal(validation.env.TELEMETRY_PR_NUMBER, "${{ needs.safe_outputs.outputs.created_pr_number }}");
  assert.equal(validation.env.TELEMETRY_PR_URL, "${{ needs.safe_outputs.outputs.created_pr_url }}");
  assert.equal(validation.env.TELEMETRY_STAGED, authored["safe-outputs"].staged);
});

test("Linux CI exercises publication against the same pinned runtime as the workflow", () => {
  const ci = parse(readFileSync(join(root, ".github", "workflows", "test.yml"), "utf8"));
  const runtime = steps => steps.find(step => step.uses?.startsWith("github/gh-aw-actions/setup@"));
  assert.equal(runtime(ci.jobs.test.steps).uses, runtime(compiled.jobs.safe_outputs.steps).uses);
  assert.equal(runtime(ci.jobs.test.steps).if, "runner.os == 'Linux'");
  const regression = ci.jobs.test.steps.find(step =>
    step.run?.includes("node --test tests/telemetry-publication/*.test.mjs"));
  assert.ok(regression);
  assert.equal(regression.if, "runner.os == 'Linux'");
  assert.equal(regression.env.GH_AW_ACTIONS_DIR, "${{ runner.temp }}/gh-aw/actions");
  const compiler = ci.jobs.test.steps.find(step => step.uses?.startsWith("github/gh-aw-actions/setup-cli@"));
  assert.equal(compiler.uses, runtime(compiled.jobs.safe_outputs.steps).uses.replace("/setup@", "/setup-cli@"));
  const metadata = JSON.parse(compiledText.split("\n")[0].replace(/^# gh-aw-metadata: /, ""));
  assert.equal(compiler.with.version, metadata.compiler_version);
  assert.equal(compiler.if, "runner.os == 'Linux'");
  const compilation = ci.jobs.test.steps.find(step => step.name === "Compile agentic workflows");
  assert.match(compilation.run, /--purge --validate/);
  assert.doesNotMatch(compilation.run, /--force-refresh-action-pins/);
  const actionTag = runtime(compiled.jobs.safe_outputs.steps).uses.split("@")[1];
  assert.match(actionTag, /^[a-f0-9]{40}$/);
  assert.ok(compilation.run.includes(`--action-tag ${actionTag}`));
  assert.equal(compilation.if, "runner.os == 'Linux'");
  const canary = ci.jobs.test.steps.find(step => step.run === "node tests/telemetry-publication/isolation-canary.mjs");
  assert.ok(canary);
  assert.equal(canary.if, "runner.os == 'Linux'");
  assert.equal(canary["continue-on-error"], undefined);
  const commandCheck = ci.jobs.test.steps.find(step => step.name === "Reject interpreted container commands");
  assert.equal(commandCheck.env.FORGED_CONTAINER_OUTPUT, `\${{ steps.${canary.id}.outputs.forged }}`);
  assert.equal(commandCheck.run, 'test -z "$FORGED_CONTAINER_OUTPUT"');
});

test("Copilot protocol selection uses the fixed, pinned runtime and firewall", () => {
  const runtime = compiled.jobs.safe_outputs.steps.find(step =>
    step.uses?.startsWith("github/gh-aw-actions/setup@")).uses;
  for (const job of ["agent", "detection"]) {
    assert.equal(
      compiled.jobs[job].steps.find(step => step.uses?.startsWith("github/gh-aw-actions/setup@")).uses,
      runtime,
    );
    const scripts = compiled.jobs[job].steps.map(step => step.run ?? "").join("\n");
    for (const role of ["agent", "api-proxy", "squid"]) {
      const image = authored.sandbox.agent.images[role];
      assert.match(image, /@sha256:[a-f0-9]{64}$/);
      assert.ok(image.includes(`:${authored.sandbox.agent.version.replace(/^v/, "")}@sha256:`));
      assert.ok(scripts.includes(image));
    }
    assert.ok(compiled.jobs[job].steps.every(step => !step.env?.COPILOT_PROVIDER_WIRE_API));
  }
});

test("dry-runs have no diagnostic-issue mutation paths and publishing App is target-only", () => {
  const outputs = authored["safe-outputs"];
  assert.equal(outputs["report-failure-as-issue"], false);
  assert.equal(outputs["report-failed-jobs"], false);
  assert.equal(outputs["missing-tool"]["create-issue"], false);
  assert.equal(outputs["report-incomplete"]["create-issue"], false);
  assert.equal(outputs["threat-detection"]["report-as-issue"], false);
  assert.equal(outputs["github-app"], undefined);
  assert.deepEqual(outputs["create-pull-request"]["github-app"].repositories, ["aspire"]);
  assert.ok(!compiled.jobs.conclusion.steps.some(step => step.uses?.startsWith("actions/create-github-app-token@")));
  const research = authored["pre-agent-steps"].find(step => step.id === "github-read-token");
  for (const permission of ["contents", "pull-requests"]) {
    assert.equal(research.with[`permission-${permission}`], "read");
  }
  assert.equal(research.with["permission-issues"], undefined);
  assert.equal(authored.permissions.issues, undefined);
  assert.equal(compiled.jobs.agent.permissions.issues, undefined);
  assert.deepEqual(authored.tools.github.toolsets, ["repos", "pull_requests"]);
  assert.match(markdown, /Do not retrieve source PR [^.]*\bdescriptions\b/);
});
