import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { job, script, step } from "./helpers/workflow-source.mjs";
import { sourceInventory } from "./helpers/workflow-snapshot.mjs";
import { parseVersion } from "../scripts/release-version.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skip = process.env.RELEASE_WORKFLOW_E2E_CHILD === "1"
  ? "RELEASE_WORKFLOW_E2E_CHILD: do not recurse during the trusted npm test step"
  : process.platform !== "linux" ? "This local workflow rehearsal runs on Linux/WSL." : false;
const canonicalManifests = [
  "package.json", ".plugin/plugin.json", ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json", "gemini-extension.json"
];
const fakeToken = "fixture-installation-token-not-a-credential";
const read = path => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
const within = (root, path) => {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
};

function command(executable, args, cwd, env, input) {
  const result = spawnSync(executable, args, { cwd, env, input, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${executable} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}

function snapshot(destination) {
  // Windows Git can export this read-only listing when WSL cannot read its worktree pointer.
  const { modes, paths, fileMode } = process.env.RELEASE_WORKFLOW_E2E_INDEX
    ? JSON.parse(read(process.env.RELEASE_WORKFLOW_E2E_INDEX)) : sourceInventory(repoRoot);
  let count = 0;
  for (const path of new Set(paths)) {
    if (path.split("/").some(part => [".git", "dist", "node_modules"].includes(part))
      || /^\.release-workflow-test-|^\.workflow-tests?[-/]/.test(path)) continue;
    const source = resolve(repoRoot, path);
    assert.ok(within(repoRoot, source), `Unsafe snapshot path: ${path}`);
    const info = lstatSync(source, { throwIfNoEntry: false });
    if (!info) continue; // Uncommitted deletions are part of the snapshot.
    for (let parent = dirname(source); parent !== repoRoot; parent = dirname(parent)) {
      assert.ok(!lstatSync(parent).isSymbolicLink(), `Refusing to traverse a source symlink: ${path}`);
    }
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    if (info.isSymbolicLink() || modes[path] === "120000") {
      const link = info.isSymbolicLink() ? readlinkSync(source) : readFileSync(source, "utf8");
      assert.ok(!isAbsolute(link) && within(repoRoot, resolve(dirname(source), link)), `Outside snapshot symlink: ${path}`);
      symlinkSync(link, target);
    } else {
      assert.ok(info.isFile(), `Unsupported snapshot entry: ${path}`);
      copyFileSync(source, target);
      chmodSync(target, modes[path] === "100755" || (!Object.hasOwn(modes, path) && fileMode && (info.mode & 0o111)) ? 0o755 : 0o644);
    }
    count++;
  }
  return count;
}

// This is deliberately a small reader for the workflow's scalar mappings, not a YAML interpreter.
function values(source, indent) {
  return Object.fromEntries([...source.matchAll(new RegExp(`^ {${indent}}([\\w-]+): (.+)$`, "gm"))]
    .map(([, name, value]) => [name, value]));
}

function interpolate(value, context) {
  return value.replace(/\$\{\{ ([\w.-]+) \}\}/g, (_, path) => {
    const result = path.split(".").reduce((value, key) => value?.[key], context);
    assert.ok(result === undefined || ["string", "boolean"].includes(typeof result), path);
    return result ?? "";
  });
}

function enabled(section, context) {
  return values(section, 4).if.split(" && ").every(condition => {
    const equal = /^([\w.-]+) == '([^']+)'$/.exec(condition);
    if (equal) return interpolate(`\${{ ${equal[1]} }}`, context) === equal[2];
    assert.match(condition, /^![\w.-]+$/);
    return interpolate(`\${{ ${condition.slice(1)} }}`, context) === "false";
  });
}

function outputFile(path) {
  const result = {};
  for (const line of read(path).trim().split("\n").filter(Boolean)) {
    const match = /^([\w-]+)=(.*)$/.exec(line);
    assert.ok(match && !Object.hasOwn(result, match[1]), `Invalid or duplicate workflow output: ${line}`);
    result[match[1]] = match[2];
  }
  return result;
}

function logEntries(path) {
  return existsSync(path) ? read(path).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}

function installFakes(root, realGit) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "node"), `#!/bin/sh
set -eu
if [ "\${1-}" = --test ]; then
  exec "$REHEARSAL_NODE" --test-concurrency=1 "$@"
fi
exec "$REHEARSAL_NODE" "$@"
`, { mode: 0o755 });
  writeFileSync(join(bin, "git"), `#!/bin/sh
set -eu
export GIT_ALLOW_PROTOCOL=file
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
case "$(pwd -P)/" in "$REHEARSAL_ROOT/"*) ;; *) echo "Git operation outside rehearsal" >&2; exit 97 ;; esac
for arg in "$@"; do
  if [ "$arg" = push ] || [ "$arg" = ls-remote ]; then
    exec "$REHEARSAL_NODE" "$REHEARSAL_ROOT/remote-guard.mjs" "$@"
  fi
done
exec "$REHEARSAL_GIT" -c protocol.allow=never -c protocol.file.allow=always "$@"
`, { mode: 0o755 });
  writeFileSync(join(root, "remote-guard.mjs"), `
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const at = args.findIndex(arg => arg === "push" || arg === "ls-remote");
const tail = args.slice(at);
const pushing = tail[0] === "push";
const ref = "refs/heads/release/" + process.env.RELEASE_VERSION;
const expected = pushing
  ? ["push", "--force-with-lease=" + ref + ":", "origin", "refs/heads/release/candidate:" + ref]
  : ["ls-remote", "--heads", "origin", ref];
const remote = spawnSync(process.env.REHEARSAL_GIT,
  [...args.slice(0, at), "remote", "get-url", ...(pushing ? ["--push"] : []), "--all", "origin"], { encoding: "utf8" });
if (remote.status !== 0 || remote.stdout.trim() !== process.env.REHEARSAL_ORIGIN
  || JSON.stringify(tail) !== JSON.stringify(expected)
  || !/^refs\\/heads\\/release\\/[0-9][0-9A-Za-z.+-]*$/.test(ref)) {
  console.error("Refusing remote operation: only create-only release operations at the exact fixture origin are allowed.");
  process.exit(97);
}
if (pushing) {
  appendFileSync(process.env.REHEARSAL_PUSH_LOG,
    JSON.stringify({ remote: remote.stdout.trim(), refspec: tail[3], lease: tail[1] }) + "\\n");
}
const result = spawnSync(process.env.REHEARSAL_GIT,
  ["-c", "protocol.allow=never", "-c", "protocol.file.allow=always", ...args], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`);
  writeFileSync(join(bin, "gh"), `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "api" && args.length === 4 && args[2] === "--jq" && args[3] === ".permission") {
  const match = /^repos\\/microsoft\\/aspire-skills\\/collaborators\\/(original|rerunner)\\/permission$/.exec(args[1]);
  if (!match || process.env.GH_TOKEN !== "fixture-read-token") process.exit(96);
  const role = process.env[match[1] === "original" ? "ROLE_ORIGINAL" : "ROLE_RERUNNER"];
  appendFileSync(process.env.REHEARSAL_GH_LOG, JSON.stringify({ kind: "permission", actor: match[1], role }) + "\\n");
  if (role === "api-error") { console.error("Simulated permission API failure"); process.exit(1); }
  console.log(role);
} else if (args[0] === "pr" && args[1] === "create") {
  if (process.env.GH_TOKEN !== "${fakeToken}") process.exit(96);
  const body = readFileSync(args[args.indexOf("--body-file") + 1], "utf8");
  appendFileSync(process.env.REHEARSAL_GH_LOG, JSON.stringify({ kind: "pr", args, body }) + "\\n");
  console.log("Recorded fixture-only draft PR; no GitHub API request was made.");
} else {
  console.error("Unexpected gh command in local rehearsal");
  process.exit(96);
}
`, { mode: 0o755 });
  return {
    PATH: [bin, dirname(process.execPath), process.env.RELEASE_WORKFLOW_E2E_TOOL_PATH, "/usr/bin", "/bin"].filter(Boolean).join(delimiter),
    HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "file",
    GIT_AUTHOR_NAME: "Workflow Rehearsal", GIT_AUTHOR_EMAIL: "rehearsal@example.invalid",
    GIT_COMMITTER_NAME: "Workflow Rehearsal", GIT_COMMITTER_EMAIL: "rehearsal@example.invalid",
    GIT_AUTHOR_DATE: "2026-09-17T12:00:00Z", GIT_COMMITTER_DATE: "2026-09-17T12:00:00Z",
    REHEARSAL_ROOT: root, REHEARSAL_GIT: realGit, REHEARSAL_NODE: process.execPath,
    REHEARSAL_ORIGIN: join(root, "origin.git"), REHEARSAL_PUSH_LOG: join(root, "pushes.jsonl"),
    REHEARSAL_GH_LOG: join(root, "gh.jsonl"), ROLE_ORIGINAL: "write", ROLE_RERUNNER: "maintain",
    RELEASE_WORKFLOW_E2E_CHILD: "1", ASPIRE_CLI_TELEMETRY_OPTOUT: "1",
    POWERSHELL_TELEMETRY_OPTOUT: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    npm_config_cache: join(root, "npm-cache"), npm_config_update_notifier: "false",
    npm_config_audit: "false", npm_config_fund: "false"
  };
}

async function runStep(section, name, context, env, { fail = false } = {}) {
  const definition = step(section, name);
  const own = values(definition, 8);
  const mapped = Object.fromEntries(Object.entries(values(definition, 10))
    .map(([key, value]) => [key, interpolate(value, context)]));
  const output = join(context.runner.temp, `${own.id ?? name.replaceAll(" ", "-")}.out`);
  writeFileSync(output, "");
  const result = await new Promise((resolve, reject) => {
    const child = spawn("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script(section, name)], {
      cwd: join(context.github.workspace, own["working-directory"] ?? ""),
      env: { ...env, ...mapped, GITHUB_WORKSPACE: context.github.workspace, GITHUB_OUTPUT: output },
      detached: true, stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      process.kill(-child.pid, "SIGKILL");
    }, 240_000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
  assert.equal(result.signal, null, `${name} timed out`);
  assert.equal(result.status === 0, !fail, `${name}\n${result.stdout.slice(-16_000)}\n${result.stderr.slice(-8_000)}`);
  assert.ok(!result.stdout.includes(fakeToken) && !result.stderr.includes(fakeToken), "Token leaked to workflow logs");
  if (own.id && !fail) context.steps[own.id] = { outputs: outputFile(output) };
  return result;
}

test("rehearsal Node launcher serializes only nested test-runner invocations", {
  skip: process.platform !== "linux" ? "The isolated rehearsal runs on Linux." : false
}, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aspire-workflow-node-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = installFakes(root, "unused-fixture-git");
  const capture = join(root, "capture-node");
  writeFileSync(capture, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  for (const args of [
    ["--test", "--test-skip-pattern=^local release workflow rehearsal", "tests/example.test.mjs"],
    ["scripts/release.mjs", "prepare"],
    ["--version"]
  ]) {
    const actual = command("node", args, root, { ...env, REHEARSAL_NODE: capture });
    const expected = args[0] === "--test" ? ["--test-concurrency=1", ...args] : args;
    assert.equal(actual, expected.join("\n"));
  }
});

test("local release workflow rehearsal (Actions service steps are simulated)", { skip, timeout: 600_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aspire-workflow-e2e-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const realGit = command("bash", ["--noprofile", "--norc", "-c", "command -v git"], repoRoot, process.env);
  const env = installFakes(root, realGit);
  for (const path of [env.HOME, env.TMPDIR]) mkdirSync(path);
  command("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], root, env);
  const git = (cwd, ...args) => command("git", args, cwd, env);
  const seed = join(root, "snapshot");
  mkdirSync(seed);
  const count = snapshot(seed);
  const save = message => {
    git(seed, "add", "--all");
    git(seed, "-c", "commit.gpgsign=false", "commit", "-qm", message,
      "-m", "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>");
    return git(seed, "rev-parse", "HEAD");
  };
  git(seed, "init", "-q", "--initial-branch=main");
  // The existing provenance regression requires older hook bytes in the root commit.
  for (const path of ["hooks/scripts/track-telemetry.sh", "hooks/scripts/track-telemetry.ps1"]) {
    const oid = command("git", ["hash-object", "-w", "--stdin"], seed, env, "Historical fixture hook, never executed.\n");
    git(seed, "update-index", "--add", "--cacheinfo", `100644,${oid},${path}`);
  }
  git(seed, "-c", "commit.gpgsign=false", "commit", "-qm", "Historical fixture hooks before the current snapshot",
    "-m", "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>");
  const base = save("Snapshot the current uncommitted implementation for rehearsal");
  const mainChangelog = read(join(seed, "CHANGELOG.md"));
  const sourceVersion = JSON.parse(read(join(seed, "package.json"))).version;
  const { core: [major, minor, patch] } = parseVersion(sourceVersion);
  const version = existsSync(join(seed, "opencode")) ? sourceVersion : `${major}.${minor}.${patch + 1n}`;
  assert.doesNotMatch(mainChangelog, /^## .*Unreleased$/m);
  git(seed, "switch", "-qc", "dev");
  rmSync(join(seed, "CHANGELOG.md"));
  rmSync(join(seed, "opencode"), { recursive: true, force: true });
  const source = save("Keep release-owned changelog and catalogs on main");
  git(seed, "switch", "main");
  git(root, "clone", "--bare", "--no-local", seed, env.REHEARSAL_ORIGIN);
  const originalRefs = git(env.REHEARSAL_ORIGIN, "show-ref", "--heads");
  const workflow = read(join(seed, ".github", "workflows", "release-aspire-skills.yml"));
  const prepare = job(workflow, "prepare");
  const publish = job(workflow, "publish");
  const contextFor = name => {
    const workspace = join(root, `${name} runner`);
    const temp = join(root, `${name} temp`);
    mkdirSync(workspace);
    mkdirSync(temp);
    return {
      github: { workspace, sha: base, repository: "microsoft/aspire-skills", repository_owner: "microsoft",
        ref: "refs/heads/main", event_name: "workflow_dispatch", actor: "original", triggering_actor: "rerunner",
        token: "fixture-read-token", run_id: "7001", run_attempt: "1", event: { repository: { name: "aspire-skills" } } },
      runner: { temp }, inputs: { source_commit: "", release_version: version, dry_run: true }, steps: {},
      secrets: { ASPIRE_BOT_APP_ID: "fixture-client-id", ASPIRE_BOT_PRIVATE_KEY: "fixture-private-key-not-a-credential" }
    };
  };
  const checkout = (section, name, context) => {
    const config = values(step(section, name), 10);
    assert.equal(config["persist-credentials"], "false");
    assert.equal(config["fetch-depth"], "0");
    const target = resolve(context.github.workspace, config.path);
    assert.ok(within(context.github.workspace, target), "Checkout must remain in its disposable runner");
    git(root, "clone", "--quiet", "--no-local", "--branch", "main", env.REHEARSAL_ORIGIN, target);
    const ref = interpolate(config.ref, context);
    if (ref !== "main") git(target, "switch", "--detach", ref);
    assert.equal(git(target, "remote", "get-url", "--push", "origin"), env.REHEARSAL_ORIGIN);
    return target;
  };
  const assertNoPublication = () => {
    assert.equal(git(env.REHEARSAL_ORIGIN, "show-ref", "--heads"), originalRefs);
    assert.equal(logEntries(env.REHEARSAL_PUSH_LOG).length, 0);
    assert.equal(logEntries(env.REHEARSAL_GH_LOG).filter(item => item.kind === "pr").length, 0);
  };

  const prepared = contextFor("prepare");
  assert.equal(enabled(prepare, prepared), true);
  await runStep(prepare, "Check release permissions", prepared, env);
  const tooling = checkout(prepare, "Checkout trusted tooling", prepared);
  const candidateRepo = checkout(prepare, "Checkout candidate repository", prepared);
  await runStep(prepare, "Resolve source and base once", prepared, env);
  assert.deepEqual(prepared.steps.resolve.outputs, { source, base, version });
  const tested = await runStep(prepare, "Test trusted tooling", prepared, env);
  assert.match(tested.stdout, /--test-skip-pattern="\^local release workflow rehearsal"/);
  t.diagnostic(`Trusted tooling npm test completed:\n${tested.stdout.trim().split("\n").slice(-8).join("\n")}`);
  await runStep(prepare, "Prepare and verify release candidate", prepared, env);
  const outputDefinitions = prepare.split("    outputs:\n")[1]?.split("    steps:\n")[0];
  assert.ok(outputDefinitions, "The preparation job must declare its output contract");
  const outputs = Object.fromEntries(Object.entries(values(outputDefinitions, 6))
    .map(([name, value]) => [name, interpolate(value, prepared)]));
  assert.deepEqual(Object.keys(outputs).sort(), ["base", "candidate", "source", "version"]);
  assert.equal(outputs.version, version);
  const candidate = outputs.candidate;
  const upload = step(prepare, "Upload checked release bundle and PR body");
  const payload = upload.match(/^          path: \|\n((?:            .+\n)+)/m)?.[1]
    .trim().split("\n").map(line => line.trim());
  assert.ok(payload);
  assert.deepEqual(payload.map(path => basename(path)).sort(), ["pr-body.md", "release.bundle", "release.json"]);
  const artifactName = interpolate(values(upload, 10).name, prepared);
  const transport = join(root, artifactName);
  mkdirSync(transport);
  for (const path of payload) {
    const from = resolve(prepared.github.workspace, path);
    assert.ok(within(prepared.github.workspace, from), "Artifact must belong to the preparation runner");
    assert.ok(lstatSync(from).isFile());
    copyFileSync(from, join(transport, basename(path)));
  }
  assert.deepEqual(JSON.parse(read(join(transport, "release.json"))), { source, base, candidate, version });
  assert.equal(git(candidateRepo, "bundle", "list-heads", join(transport, "release.bundle")),
    `${candidate} refs/heads/release/candidate`);
  assert.equal(git(candidateRepo, "show", "-s", "--format=%P", candidate), `${base} ${source}`);
  const metadata = `<!-- aspire-skills-release source=${source} base=${base} version=${version} source-version=${sourceVersion} base-version=${sourceVersion} -->`;
  const body = read(join(transport, "pr-body.md"));
  assert.equal(body.split(metadata).length, 2);
  assert.match(body, /merge commit, not squash or rebase/);
  const changelog = read(join(candidateRepo, "CHANGELOG.md"));
  assert.ok(changelog.includes(metadata));
  assert.ok(changelog.slice(changelog.search(/^## /m)).startsWith(`## v${version} - `));
  assert.ok(changelog.includes("Keep release-owned changelog and catalogs on main"));
  const historyStart = mainChangelog.search(/^## /m);
  assert.ok(historyStart >= 0, "The baseline must contain released history");
  assert.ok(changelog.endsWith(mainChangelog.slice(historyStart)), "Released history must be preserved");
  assert.doesNotMatch(changelog, /^## .*Unreleased$/m);
  for (const path of canonicalManifests) {
    const json = JSON.parse(read(join(candidateRepo, path)));
    assert.equal(path.endsWith("/marketplace.json") ? json.plugins.find(plugin => plugin.name === "aspire").version : json.version, version);
  }
  for (const name of readdirSync(join(tooling, "skills"))) {
    const match = read(join(candidateRepo, "skills", name, "SKILL.md"))
      .match(/^  version:[ \t]*(?:"([^"]+)"|'([^']+)'|(\S+))/m);
    assert.equal(match?.[1] ?? match?.[2] ?? match?.[3], version);
  }
  for (const format of ["v1", "v2"]) {
    const catalog = join(candidateRepo, "opencode", format);
    const index = JSON.parse(read(join(catalog, "index.json")));
    assert.deepEqual(index.skills.map(item => item.name).sort(), readdirSync(join(tooling, "skills")).sort());
    for (const skill of index.skills) {
      const manifest = skill.files.map(path => [path, createHash("sha512").update(readFileSync(join(catalog, skill.name, path))).digest("hex")]);
      assert.equal(skill.version, `sha512-${createHash("sha512").update(JSON.stringify(manifest)).digest("hex")}`);
    }
  }
  assert.equal(enabled(publish, prepared), false);
  assertNoPublication();
  t.diagnostic(`Dry run: ${count} current working-tree files snapshotted; source/base resolved once; release version ${version}, source/base version ${sourceVersion}; three checked artifacts, no publication.`);

  const publishContext = name => {
    const context = contextFor(name);
    context.inputs.dry_run = false;
    context.needs = { prepare: { outputs } };
    assert.equal(enabled(publish, context), true);
    return context;
  };
  for (const [role, value] of [["ROLE_ORIGINAL", "read"], ["ROLE_RERUNNER", "api-error"]]) {
    const denied = publishContext(`denied-${role}`);
    const result = await runStep(publish, "Check release permissions", denied, { ...env, [role]: value }, { fail: true });
    assert.match(result.stdout + result.stderr, /::error::/);
    assert.equal(existsSync(join(denied.github.workspace, "tooling")), false);
    assertNoPublication();
  }
  const receivingRunner = async name => {
    const context = publishContext(name);
    await runStep(publish, "Check release permissions", context, env);
    checkout(publish, "Checkout trusted tooling", context);
    const receiver = checkout(publish, "Checkout receiver repository", context);
    const download = values(step(publish, "Download checked release artifact"), 10);
    assert.equal(interpolate(download.name, context), artifactName);
    const destination = interpolate(download.path, context);
    assert.ok(within(context.runner.temp, resolve(destination)), "Download must remain in its disposable runner");
    mkdirSync(destination);
    for (const name of readdirSync(transport)) {
      copyFileSync(join(transport, name), join(destination, name));
      assert.deepEqual(readFileSync(join(destination, name)), readFileSync(join(transport, name)));
    }
    return { context, receiver, destination };
  };
  const tampered = await receivingRunner("tampered");
  writeFileSync(join(tampered.destination, "pr-body.md"), "\nTampered transport body.\n", { flag: "a" });
  const rejected = await runStep(publish, "Receive and verify without executing candidate code", tampered.context, env, { fail: true });
  assert.match(rejected.stderr, /PR body artifact has been modified/);
  assert.equal(git(tampered.receiver, "rev-parse", "HEAD"), base);
  assert.equal(tampered.context.steps["app-token"], undefined);
  assertNoPublication();

  const received = await receivingRunner("publish");
  await runStep(publish, "Receive and verify without executing candidate code", received.context, env);
  assert.deepEqual(received.context.steps.verify.outputs, { source, base, candidate, version });
  assert.equal(git(received.receiver, "rev-parse", "HEAD"), base);
  assert.equal(git(received.receiver, "status", "--porcelain"), "");
  assert.equal(read(join(received.receiver, "CHANGELOG.md")), mainChangelog);
  assert.equal(git(received.receiver, "rev-parse", "refs/heads/release/candidate"), candidate);
  await runStep(publish, "Check GitHub App prerequisites", received.context, env);
  const tokenInputs = Object.fromEntries(Object.entries(values(step(publish, "Create short-lived repository publication token"), 10))
    .map(([key, value]) => [key, interpolate(value, received.context)]));
  assert.equal(tokenInputs["client-id"], received.context.secrets.ASPIRE_BOT_APP_ID);
  assert.equal(tokenInputs["private-key"], received.context.secrets.ASPIRE_BOT_PRIVATE_KEY);
  assert.equal(tokenInputs.repositories, "aspire-skills");
  assert.equal(tokenInputs["permission-contents"], "write");
  assert.equal(tokenInputs["permission-pull-requests"], "write");
  assert.equal(tokenInputs["permission-workflows"], "");
  received.context.steps["app-token"] = { outputs: { token: fakeToken } };

  git(received.receiver, "remote", "set-url", "origin", "https://github.com/microsoft/aspire-skills.git");
  const blockedLookup = await runStep(publish, "Push release branch and open draft PR", received.context, env, { fail: true });
  assert.match(blockedLookup.stderr, /Refusing remote operation/);
  assertNoPublication();
  git(received.receiver, "remote", "set-url", "origin", env.REHEARSAL_ORIGIN);
  git(received.receiver, "remote", "set-url", "--push", "origin", "https://github.com/microsoft/aspire-skills.git");
  const blockedPush = await runStep(publish, "Push release branch and open draft PR", received.context, env, { fail: true });
  assert.match(blockedPush.stderr, /Refusing remote operation/);
  assertNoPublication();
  git(received.receiver, "config", "--unset-all", "remote.origin.pushurl");
  for (const name of ["release/0.0.2", "release/1.2.3-rc.1", "release/2.0.0-RC.1+Build.42"]) {
    git(root, "check-ref-format", `refs/heads/${name}`);
  }
  await runStep(publish, "Push release branch and open draft PR", received.context, env);
  const branch = `release/${version}`;
  assert.equal(git(env.REHEARSAL_ORIGIN, "rev-parse", `refs/heads/${branch}`), candidate);
  assert.equal(git(env.REHEARSAL_ORIGIN, "rev-parse", "main"), base);
  assert.equal(git(env.REHEARSAL_ORIGIN, "rev-parse", "dev"), source);
  assert.deepEqual(logEntries(env.REHEARSAL_PUSH_LOG), [{
    remote: env.REHEARSAL_ORIGIN, refspec: `refs/heads/release/candidate:refs/heads/${branch}`,
    lease: `--force-with-lease=refs/heads/${branch}:`
  }]);
  const prs = logEntries(env.REHEARSAL_GH_LOG).filter(item => item.kind === "pr");
  assert.equal(prs.length, 1);
  assert.deepEqual(prs[0].args, ["pr", "create", "--repo", "microsoft/aspire-skills", "--draft", "--base", "main",
    "--head", branch, "--title", `Release v${version}`, "--body-file", join(received.destination, "pr-body.md")]);
  assert.equal(prs[0].body.replaceAll("\r\n", "\n"), body);
  const publishedRefs = git(env.REHEARSAL_ORIGIN, "show-ref", "--heads");
  const pushLog = read(env.REHEARSAL_PUSH_LOG);
  const prLog = read(env.REHEARSAL_GH_LOG);
  const collision = await runStep(publish, "Push release branch and open draft PR", received.context, env, { fail: true });
  assert.ok(collision.stdout.includes(`::error::Release branch ${branch} already exists`));
  assert.equal(git(env.REHEARSAL_ORIGIN, "show-ref", "--heads"), publishedRefs);
  assert.equal(read(env.REHEARSAL_PUSH_LOG), pushLog, "A collision must fail before git push");
  assert.equal(read(env.REHEARSAL_GH_LOG), prLog, "A collision must not create another PR");
  t.diagnostic(`Publication rehearsal: only the fixture bare origin received ${branch} with a create-only lease; main/dev unchanged; fake gh recorded one draft-main PR.`);
  t.diagnostic("Existing release branch collision, denied actors, permission API failure, tampered PR body, and github.com fetch/push URLs all blocked publication. Checkout/artifact/token actions were simulated; no GitHub-hosted run occurred.");
});
