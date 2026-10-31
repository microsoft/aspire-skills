import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";

const sourceRepository = { owner: "microsoft", repo: "aspire-skills" };
const targetRepository = { owner: "microsoft", repo: "aspire" };
export const verifierImage = "mcr.microsoft.com/dotnet/sdk:10.0-noble@sha256:9c7b6b263d9d4c2e4718e16dae6d75cd8f4b5ccf206f1e7d48a98eb429981b03";
const require = createRequire(import.meta.url);
const workflowDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_TERMINAL_PROMPT: "0"
};

function git(directory, args, options = {}) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "--no-pager", ...args], {
    cwd: directory, env: gitEnvironment, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options
  });
}

function sha(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error("Expected an immutable commit SHA.");
  }
  return value;
}

function digest(path) {
  if (!lstatSync(path).isFile()) throw new Error(`Not a regular artifact file: ${basename(path)}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function text(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${field}.`);
  return value;
}

function containerName() {
  const { GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt } = process.env;
  if (!/^\d+$/.test(run ?? "") || !/^\d+$/.test(attempt ?? "")) {
    throw new Error("Verification requires a workflow run and attempt.");
  }
  return `aspire-telemetry-${run}-${attempt}`;
}

export async function resolveSource({ github, context, directory }) {
  const manual = context.eventName === "workflow_dispatch";
  const value = manual ? context.payload.inputs?.pr_number : String(context.payload.pull_request?.number);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || String(number) !== value) {
    throw new Error("pr_number must be a positive integer.");
  }
  const { data: pr } = await github.rest.pulls.get({ ...sourceRepository, pull_number: number });
  if (pr.base.ref !== "main" || pr.base.repo.full_name !== "microsoft/aspire-skills") {
    throw new Error("The source PR must target microsoft/aspire-skills main.");
  }
  if (!manual && !pr.merged) throw new Error("Automatic telemetry review requires a merged PR.");
  const commit = sha(pr.merged ? pr.merge_commit_sha : pr.head.sha);
  if (!manual && commit !== context.payload.pull_request.merge_commit_sha) {
    throw new Error("The source PR no longer matches the triggering merge commit.");
  }
  const baseHead = sha(pr.base.sha);
  git(directory, ["fetch", "--no-tags", "origin", baseHead, commit]);
  const base = sha(git(directory, pr.merged
    ? ["rev-parse", `${commit}^1`]
    : ["merge-base", baseHead, commit]).trim());
  const files = git(directory, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", base, commit])
    .split("\0").filter(Boolean).map(record => {
      const [added, deleted, ...path] = record.split("\t");
      return {
        filename: path.join("\t"),
        additions: added === "-" ? null : Number(added),
        deletions: deleted === "-" ? null : Number(deleted)
      };
    });
  const aspireBase = sha(git(directory, [
    "ls-remote", "https://github.com/microsoft/aspire.git", "refs/heads/main"
  ]).trim().split(/\s+/)[0]);
  const source = {
    number, commit, base, aspireBase, merged: pr.merged,
    branch: `update-aspire-telemetry-pr-${number}`,
    url: `https://github.com/microsoft/aspire-skills/pull/${number}`
  };
  const output = join(process.env.RUNNER_TEMP, "telemetry-source");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "source-pr.json"), JSON.stringify({
    ...source, dryRun: manual && [true, "true"].includes(context.payload.inputs?.dry_run)
  }));
  writeFileSync(join(output, "source-pr-files.json"), JSON.stringify(files));
  writeFileSync(join(output, "source-pr.diff"), git(directory, [
    "diff", "--no-ext-diff", "--no-textconv", "--no-renames", base, commit
  ]));
  return source;
}

export function validateOutcome(output, source) {
  if (!Array.isArray(output.items) || output.items.length !== 1 ||
      (output.errors !== undefined && (!Array.isArray(output.errors) || output.errors.length))) {
    throw new Error("Expected exactly one conclusive safe output without errors.");
  }
  const [item] = output.items;
  if (item.type === "create_pull_request") {
    if (item.branch !== source.branch ||
        (item.repo !== undefined && item.repo !== "microsoft/aspire") ||
        (item.base !== undefined && item.base !== "main")) {
      throw new Error("Proposal does not match the trusted source branch and destination.");
    }
    return {
      type: item.type, title: text(item.title, "PR title"), body: text(item.body, "PR body"),
      branch: source.branch, repo: "microsoft/aspire", base: "main"
    };
  }
  if (item.type === "noop") return { type: item.type, message: text(item.message, "no-op explanation") };
  if (item.type === "report_incomplete") {
    return {
      type: item.type, reason: text(item.reason, "incomplete reason"),
      ...(item.details === undefined ? {} : { details: text(item.details, "incomplete details") })
    };
  }
  throw new Error(`Unsupported terminal outcome: ${item.type}`);
}

export async function publicationPolicy(directory = workflowDirectory) {
  const { parse } = await import("yaml");
  const compiled = parse(readFileSync(join(directory, ".github", "workflows", "update-aspire.lock.yml"), "utf8"));
  const handler = compiled.jobs.safe_outputs.steps.find(step => step.id === "process_safe_outputs");
  const policy = JSON.parse(handler.env.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG).create_pull_request;
  if (policy["target-repo"] !== "microsoft/aspire" || policy.base_branch !== "main" ||
      policy.draft !== true || policy.protected_files_policy !== "blocked" || !policy.allowed_files?.length ||
      !Number.isSafeInteger(policy.max_patch_files) || policy.max_patch_files <= 0 ||
      !Number.isSafeInteger(policy.max_patch_size) || policy.max_patch_size <= 0) {
    throw new Error("Compiled publisher policy is not the restricted telemetry policy.");
  }
  return policy;
}

export function inspectProposal({ directory, base, head, policy, checkFiles }) {
  sha(base);
  sha(head);
  const raw = git(directory, [
    "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--raw", "-z", base, head
  ]).split("\0");
  const files = [];
  for (let index = 0; index < raw.length - 1; index += 2) {
    const [oldMode, newMode] = raw[index].slice(1).split(" ");
    const filename = raw[index + 1];
    if (!["000000", "100644", "100755"].includes(oldMode) ||
        !["000000", "100644", "100755"].includes(newMode) ||
        (newMode !== "000000" && newMode !== oldMode && newMode !== "100644")) {
      throw new Error(`Unsupported file mode in proposal: ${filename}`);
    }
    files.push(filename);
  }
  if (!files.length || files.length > policy.max_patch_files) {
    throw new Error("Proposal is empty or exceeds the publisher's file limit.");
  }
  const protection = checkFiles(files, policy);
  if (protection.action !== "allow") throw new Error(`Publisher file policy rejected: ${protection.files.join(", ")}`);
  const patch = git(directory, [
    "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", base, head
  ]);
  if (patch.includes("\nGIT binary patch\n") || Buffer.byteLength(patch) > policy.max_patch_size * 1024) {
    throw new Error("Proposal contains binary content or exceeds the publisher's patch limit.");
  }
  const tree = sha(git(directory, ["rev-parse", `${head}^{tree}`]).trim());
  return { tree, patch };
}

export function freezeBundle({ directory, bundle, source, outputDirectory, policy, checkFiles }) {
  sha(source.aspireBase);
  if (!lstatSync(bundle).isFile()) throw new Error("Proposal bundle must be a regular file.");
  git(directory, ["bundle", "verify", bundle]);
  const heads = git(directory, ["bundle", "list-heads", bundle]).trim().split("\n").map(line => line.split(" "));
  if (!heads.length || heads.some(([oid, ref]) =>
    oid !== heads[0][0] || !["HEAD", `refs/heads/${source.branch}`].includes(ref))) {
    throw new Error("Bundle must contain only the expected proposal head.");
  }
  const head = sha(heads[0][0]);
  git(directory, ["fetch", "--no-tags", bundle, `${heads[0][1]}:refs/telemetry/proposal`]);
  git(directory, ["merge-base", "--is-ancestor", source.aspireBase, head]);
  const { tree, patch } = inspectProposal({ directory, base: source.aspireBase, head, policy, checkFiles });
  const commit = sha(git(directory, ["-c", "commit.gpgsign=false", "commit-tree", tree, "-p", source.aspireBase], {
    input: `Update Aspire telemetry for aspire-skills PR #${source.number}\n`,
    env: {
      ...gitEnvironment,
      GIT_AUTHOR_NAME: "Aspire telemetry workflow", GIT_COMMITTER_NAME: "Aspire telemetry workflow",
      GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
      GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com"
    }
  }).trim());
  git(directory, ["update-ref", `refs/heads/${source.branch}`, commit]);
  const name = `aw-microsoft-aspire-${source.branch}`;
  const bundlePath = join(outputDirectory, `${name}.bundle`);
  git(directory, ["bundle", "create", bundlePath, `${source.aspireBase}..refs/heads/${source.branch}`]);
  writeFileSync(join(outputDirectory, `${name}.patch`), patch);
  return { tree, bundle: basename(bundlePath), patch: `${name}.patch` };
}

export function applyFrozenProposal(directory, patch, tree) {
  git(directory, ["apply", "--index", patch]);
  if (git(directory, ["write-tree"]).trim() !== sha(tree) ||
      git(directory, ["diff", "--no-ext-diff", "--no-textconv", "--name-only"]).trim()) {
    throw new Error("Candidate workspace does not match the frozen proposal tree.");
  }
}

export function cloneTrustedBase(directory, workspace, base) {
  if (git(directory, ["rev-parse", "HEAD"]).trim() !== sha(base)) {
    throw new Error("Verification source must be checked out at the trusted base.");
  }
  git(directory, ["clone", "--no-local", "--no-checkout", "--single-branch", "--no-tags", directory, workspace]);
  git(workspace, ["remote", "set-url", "origin", "https://github.com/microsoft/aspire.git"]);
  git(workspace, ["checkout", "--detach", base]);
}

export function dockerArguments({ workspace, cache, name, offline, uid, gid, base }) {
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid < 0) {
    throw new Error("Verification must run as an unprivileged user.");
  }
  const environment = [
    "PATH=/src/.dotnet:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME=/cache/home", "DOTNET_CLI_HOME=/cache/home", "NUGET_PACKAGES=/cache/packages",
    "NUGET_HTTP_CACHE_PATH=/cache/http", "DOTNET_INSTALL_DIR=/src/.dotnet",
    "DOTNET_CLI_TELEMETRY_OPTOUT=1", "POWERSHELL_TELEMETRY_OPTOUT=1",
    "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0",
    `ASPIRE_VERIFIED_BASE=${sha(base)}`
  ];
  const command = offline
    ? [
      "mkdir -m 700 /tmp/aspire-runtime",
      "export XDG_RUNTIME_DIR=/tmp/aspire-runtime",
      "pwsh -NoLogo -NoProfile -NonInteractive -Command '$ErrorActionPreference = \"Stop\"; $PSVersionTable.PSVersion'",
      "dotnet test --project tests/Aspire.Cli.Tests/Aspire.Cli.Tests.csproj --no-restore --no-launch-profile -- " +
      ["AgentTelemetryCatalogTests", "AgentTelemetryHookTests", "AgentTelemetryCommandTests",
        "TelemetryHookConfiguratorTests", "TelemetryHookScriptTests"]
        .map(name => `--filter-class '*.${name}'`).join(" ") +
      " --filter-not-trait quarantined=true --filter-not-trait outerloop=true"
    ].join("\n")
    : [
      'test "$(git rev-parse HEAD)" = "$ASPIRE_VERIFIED_BASE"',
      "./restore.sh",
      "test -x .dotnet/dotnet",
      ".dotnet/dotnet --info",
      "pwsh -NoLogo -NoProfile -NonInteractive -Command '$ErrorActionPreference = \"Stop\"; $PSVersionTable.PSVersion'"
    ].join("\n");
  return [
    "run", "--rm", "--pull=never", "--platform=linux/amd64", "--name", name,
    `--network=${offline ? "none" : "bridge"}`, `--user=${uid}:${gid}`,
    "--cap-drop=ALL", "--security-opt=no-new-privileges=true", "--read-only", "--pids-limit=1024",
    "--ulimit=core=0", "--tmpfs=/tmp:rw,nosuid,nodev,exec",
    "--mount", `type=bind,src=${workspace},dst=/src`,
    "--mount", `type=bind,src=${cache},dst=/cache`,
    "--workdir=/src", "--entrypoint=/usr/bin/env", verifierImage,
    "-i", ...environment, "/bin/bash", "-euo", "pipefail", "-c", command
  ];
}

export function cleanupContainer() {
  const result = spawnSync("docker", ["rm", "--force", containerName()], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !/No such container/i.test(result.stderr)) {
    throw new Error(`Verifier cleanup failed: ${result.stderr}`);
  }
}

function completeTestCounts(tests) {
  return Boolean(tests) && ["total", "failed", "passed", "skipped"].every(name =>
    Number.isSafeInteger(tests[name]) && tests[name] >= 0) &&
      tests.total === tests.failed + tests.passed + tests.skipped && tests.failed + tests.passed > 0;
}

export function testResultSummary(tests) {
  if (tests?.status === "incomplete") {
    if (!Number.isSafeInteger(tests.exitCode) || tests.exitCode < 0 || tests.exitCode > 255) {
      throw new Error("Isolated build/test diagnostics require a valid exit code.");
    }
    return "**Isolated telemetry build/tests: NOT COMPLETED**\n\n" +
      `Build/test command exited with code ${tests.exitCode}. No completed test result was confirmed.`;
  }
  if (!completeTestCounts(tests)) {
    throw new Error("Isolated tests require complete, nonempty result counts.");
  }
  return `**Isolated telemetry tests: ${tests.failed ? "FAILED" : "PASSED"}**\n\n` +
    `${tests.passed} passed, ${tests.failed} failed, ${tests.skipped} skipped (${tests.total} total).`;
}

export function parseTestResults(exitCode, output) {
  if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255 || [125, 126, 127].includes(exitCode)) {
    throw new Error(`Isolated verifier execution failed (exit ${exitCode}).`);
  }
  const incomplete = { status: "incomplete", exitCode };
  const summaries = [...stripVTControlCharacters(output).matchAll(
    /^Test run summary: (Passed!|Failed!)\r?\n[ \t]+total: (\d+)\r?\n[ \t]+failed: (\d+)\r?\n[ \t]+succeeded: (\d+)\r?\n[ \t]+skipped: (\d+)\r?\n[ \t]+duration: [^\r\n]+/gm
  )];
  if (![0, 2].includes(exitCode) || summaries.length !== 1) {
    return incomplete;
  }
  const [, verdict, total, failed, passed, skipped] = summaries[0];
  const tests = { total: Number(total), failed: Number(failed), passed: Number(passed), skipped: Number(skipped) };
  if (!completeTestCounts(tests) ||
      (tests.failed > 0) !== (exitCode === 2) || verdict !== (tests.failed ? "Failed!" : "Passed!")) {
    return incomplete;
  }
  return tests;
}

export function runContainer(options) {
  const stop = randomUUID();
  process.stdout.write(`::stop-commands::${stop}\n`);
  try {
    const result = spawnSync("docker", dockerArguments(options), {
      stdio: options.offline ? ["ignore", "pipe", "pipe"] : "inherit",
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 25 * 60 * 1000
    });
    const log = (result.stdout ?? "") + (result.stderr ?? "");
    if (options.offline) {
      process.stdout.write(log);
    }
    if (result.error) throw result.error;
    if (options.offline) {
      return { tests: parseTestResults(result.status, result.stdout), log };
    }
    if (result.status !== 0) throw new Error(`Isolated restore failed (${result.status}).`);
  } finally {
    process.stdout.write(`::${stop}::\n`);
    cleanupContainer();
  }
}

export async function verifyTelemetry({ directory, source }) {
  const repo = join(directory, "_aspire");
  const artifactDirectory = "/tmp/gh-aw";
  const outputDirectory = join(process.env.RUNNER_TEMP, "telemetry-verified");
  mkdirSync(outputDirectory);
  const policy = await publicationPolicy(directory);
  const actions = join(process.env.RUNNER_TEMP, "gh-aw", "actions");
  const { checkFileProtectionPostApply } = require(join(actions, "manifest_file_helpers.cjs"));
  const { resolveTransportPaths } = require(join(actions, "resolve_transport_paths.cjs"));
  const item = validateOutcome(JSON.parse(readFileSync(join(artifactDirectory, "agent_output.json"), "utf8")), source);
  let proposal;
  let tests;
  if (item.type === "create_pull_request") {
    const transport = resolveTransportPaths(item, "microsoft/aspire");
    if (!transport.bundlePath) throw new Error("A proposal must include a Git bundle; patch fallback is disabled.");
    proposal = freezeBundle({
      directory: repo, bundle: transport.bundlePath, source, outputDirectory, policy,
      checkFiles: checkFileProtectionPostApply
    });
  }
  if (item.type !== "report_incomplete") {
    const isolated = mkdtempSync(join(process.env.RUNNER_TEMP, "telemetry-isolation-"));
    const workspace = join(isolated, "src");
    const cache = join(isolated, "cache");
    for (const path of [workspace, cache, join(cache, "home")]) mkdirSync(path);
    cloneTrustedBase(repo, workspace, source.aspireBase);
    execFileSync("docker", ["pull", "--platform=linux/amd64", verifierImage], { stdio: "inherit" });
    const options = {
      workspace, cache, name: containerName(), uid: process.getuid(), gid: process.getgid(),
      base: source.aspireBase
    };
    runContainer({ ...options, offline: false });
    if (proposal) applyFrozenProposal(workspace, join(outputDirectory, proposal.patch), proposal.tree);
    const result = runContainer({ ...options, offline: true });
    tests = result.tests;
    writeFileSync(join(outputDirectory, "telemetry-tests.log"), result.log);
  }
  const tree = proposal?.tree ?? sha(git(repo, ["rev-parse", `${sha(source.aspireBase)}^{tree}`]).trim());
  if (tests) {
    const field = proposal ? "body" : "message";
    const runUrl = `https://github.com/microsoft/aspire-skills/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}`;
    item[field] = `${testResultSummary(tests)}\n\n` +
      `[Full test output](${runUrl}) (verify-telemetry job). One build/test attempt; no automatic repair or retry.\n\n${item[field]}`;
  }
  if (proposal) {
    item.body += `\n\n### Workflow provenance\nSource: ${source.url}\nSource commit: \`${source.commit}\`\nAspire base: \`${source.aspireBase}\`\nTested tree: \`${tree}\`\n`;
  }
  writeFileSync(join(outputDirectory, "agent_output.json"), JSON.stringify({ items: [item], errors: [] }));
  return {
    source, tree, type: item.type, ...(tests ? { tests } : {}),
    run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
    files: Object.fromEntries(readdirSync(outputDirectory).map(name => [name, digest(join(outputDirectory, name))]))
  };
}

export function validateReceipt(receipt, source, directory) {
  if (JSON.stringify(receipt.source) !== JSON.stringify(source) ||
      receipt.run !== process.env.GITHUB_RUN_ID || receipt.attempt !== process.env.GITHUB_RUN_ATTEMPT) {
    throw new Error("Verification receipt does not match this source, run, and attempt.");
  }
  const names = Object.keys(receipt.files);
  const prefix = `aw-microsoft-aspire-${source.branch}`;
  const expected = receipt.type === "create_pull_request"
    ? ["agent_output.json", `${prefix}.bundle`, `${prefix}.patch`]
    : ["agent_output.json"];
  if (receipt.type !== "report_incomplete") expected.push("telemetry-tests.log");
  if (names.toSorted().join("\0") !== expected.toSorted().join("\0")) {
    throw new Error("Verification receipt has an unexpected artifact set.");
  }
  for (const name of names) {
    if (digest(join(directory, name)) !== receipt.files[name]) throw new Error(`Verified artifact changed: ${name}`);
  }
  const item = validateOutcome(JSON.parse(readFileSync(join(directory, "agent_output.json"), "utf8")), source);
  if (item.type !== receipt.type) throw new Error("Verified outcome changed.");
  if (item.type !== "report_incomplete") {
    const field = item.type === "create_pull_request" ? "body" : "message";
    if (!item[field].startsWith(`${testResultSummary(receipt.tests)}\n\n`)) {
      throw new Error("Verified outcome does not report the recorded test results.");
    }
  }
  sha(receipt.tree);
  return item;
}

export function prepareVerifiedReview({ source, receipt, directory }) {
  const verified = join(process.env.RUNNER_TEMP, "telemetry-verified");
  validateReceipt(receipt, source, verified);
  for (const name of readdirSync(directory)) {
    if (["agent_output.json", "telemetry-tests.log"].includes(name) || /^aw-.+\.(patch|bundle)$/.test(name)) {
      rmSync(join(directory, name));
    }
  }
  for (const name of Object.keys(receipt.files)) {
    copyFileSync(join(verified, name), join(directory, name));
  }
  const record = JSON.stringify(receipt);
  writeFileSync(join(directory, "verification-receipt.json"), record);
  const reviewed = join(process.env.RUNNER_TEMP, "telemetry-reviewed");
  mkdirSync(reviewed);
  writeFileSync(join(reviewed, "receipt.json"), record);
}

export function validateReviewReceipt(receipt, reviewedReceipt, detection) {
  if (!isDeepStrictEqual(receipt, reviewedReceipt)) {
    throw new Error("Threat review does not match the verified source, artifacts, and run.");
  }
  if (detection?.result !== "success" || detection.success !== "true" || detection.conclusion !== "success") {
    throw new Error("Publication requires a successful native threat review of the frozen proposal.");
  }
}

export function pinPublicationBase(directory, base) {
  // The pinned gh-aw handler refetches main before signed replay against origin/main.
  // https://github.com/github/gh-aw-actions/blob/866158eb5c6cbfd3c614104e3d3d6634e246d220/setup/js/create_pull_request.cjs#L1792-L1806
  git(directory, ["update-ref", "refs/remotes/origin/main", sha(base)]);
  git(directory, ["config", "--replace-all", "remote.origin.fetch",
    "+refs/heads/main:refs/remotes/origin/publication-main"]);
}

export async function promoteVerifiedProposal({ github, directory, source, receipt, reviewedReceipt, detection }) {
  const verified = join(process.env.RUNNER_TEMP, "telemetry-verified");
  const item = validateReceipt(receipt, source, verified);
  validateReviewReceipt(receipt, reviewedReceipt, detection);
  const { data: pr } = await github.rest.pulls.get({ ...sourceRepository, pull_number: source.number });
  if (pr.base.ref !== "main" || pr.base.repo.full_name !== "microsoft/aspire-skills" ||
      (pr.merged ? pr.merge_commit_sha : pr.head.sha) !== source.commit) {
    throw new Error("Source PR advanced after the immutable snapshot; run verification again.");
  }
  if (item.type === "create_pull_request") {
    const prefix = `aw-microsoft-aspire-${source.branch}`;
    const bundle = join(verified, `${prefix}.bundle`);
    git(directory, ["fetch", "--no-tags", bundle, `refs/heads/${source.branch}:refs/telemetry/verified`]);
    if (git(directory, ["rev-parse", "refs/telemetry/verified^{tree}"]).trim() !== receipt.tree ||
        git(directory, ["rev-parse", "refs/telemetry/verified^"]).trim() !== source.aspireBase ||
        git(directory, ["rev-list", "--count", `${source.aspireBase}..refs/telemetry/verified`]).trim() !== "1") {
      throw new Error("Published bundle must contain exactly the tested tree on the verified base.");
    }
    pinPublicationBase(directory, source.aspireBase);
  }
  const artifactDirectory = "/tmp/gh-aw";
  for (const name of Object.keys(receipt.files)) copyFileSync(join(verified, name), join(artifactDirectory, name));
  writeFileSync(join(artifactDirectory, "safeoutputs.jsonl"), `${JSON.stringify(item)}\n`);
}

export async function validatePublication({ github, source, receipt, publisherResult, staged, number = "", url = "" }) {
  const verified = join(process.env.RUNNER_TEMP, "telemetry-verified");
  const item = validateReceipt(receipt, source, verified);
  if (publisherResult !== "success") throw new Error("The native publisher did not complete successfully.");
  if (item.type === "report_incomplete") throw new Error(`Telemetry maintenance is incomplete: ${item.reason}`);
  if (staged || item.type === "noop") {
    if (number !== "" || url !== "") throw new Error("A staged or no-op outcome unexpectedly published a PR.");
    return staged ? "staged" : "noop";
  }
  const parsed = Number(number);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== number ||
      url !== `https://github.com/microsoft/aspire/pull/${parsed}`) {
    throw new Error("The native publisher did not return a canonical Aspire PR number and URL.");
  }
  const { data: pr } = await github.rest.pulls.get({ ...targetRepository, pull_number: parsed });
  if (pr.number !== parsed || pr.html_url !== url || pr.state !== "open" || pr.draft !== true || pr.merged !== false ||
      pr.base?.repo?.full_name !== "microsoft/aspire" || pr.base.ref !== "main" ||
      pr.head?.repo?.full_name !== "microsoft/aspire" || pr.head.ref !== source.branch) {
    throw new Error("The actual PR does not match the expected draft, repository, and branches.");
  }
  if (!pr.body?.includes(`${testResultSummary(receipt.tests)}\n\n`)) {
    throw new Error("The actual PR does not report the recorded test results.");
  }
  const head = sha(pr.head.sha);
  const { data: commit } = await github.rest.git.getCommit({ ...targetRepository, commit_sha: head });
  if (commit.sha !== head || commit.tree?.sha !== receipt.tree ||
      commit.parents?.length !== 1 || commit.parents[0].sha !== source.aspireBase) {
    throw new Error("The published commit does not match the verified tree and base.");
  }
  return "published";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "cleanup") throw new Error("Only the cleanup command is supported.");
  cleanupContainer();
}
