import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const compiled = parse(readFileSync(join(root, ".github", "workflows", "update-aspire.lock.yml"), "utf8"));
const ci = parse(readFileSync(join(root, ".github", "workflows", "test.yml"), "utf8"));
const require = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function directory(t, prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function write(path, name, content, options) {
  const filename = join(path, name);
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, content, options);
}

function git(path, ...args) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: path, encoding: "utf8", stdio: "pipe",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
  });
}

test("the CI drift gate rejects changed and unexpected generated files", async t => {
  const step = ci.jobs.test.steps.find(step => step.name === "Reject generated workflow drift");
  assert.ok(step);
  for (const [name, change] of [
    ["clean tree", () => {}],
    ["modified action pins", path => write(path, ".github/aw/actions-lock.json", "{}\n")],
    ["staged lock edit", path => {
      write(path, ".github/workflows/update-aspire.lock.yml", "staged\n");
      git(path, "add", ".");
    }],
    ["extra lock", path => write(path, ".github/workflows/extra.lock.yml", "unexpected\n")],
    ["unexpected maintenance workflow", path => write(path, ".github/workflows/agentics-maintenance.yml", "unexpected\n")]
  ]) {
    await t.test(name, t => {
      const path = directory(t, "telemetry-drift-");
      git(path, "init", "--quiet", "--initial-branch=main");
      write(path, ".github/aw/actions-lock.json", '{"pins":[]}\n');
      write(path, ".github/workflows/update-aspire.lock.yml", "generated\n");
      git(path, "add", ".");
      git(path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Drift fixture");
      change(path);
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", step.run], { cwd: path, encoding: "utf8" });
      if (result.error) throw result.error;
      assert.equal(result.status, name === "clean tree" ? 0 : 1, result.stdout + result.stderr);
    });
  }
});

test("the compiled admission condition excludes unmerged and fork automatic PRs", () => {
  const accepts = new Function("github", `return (${compiled.jobs.pre_activation.if});`);
  const github = {
    repository: "microsoft/aspire-skills", repository_id: 1, event_name: "pull_request",
    event: { pull_request: { merged: true, head: { repo: { id: 1 } }, stack: null } }
  };
  assert.equal(accepts(github), true);
  github.event.pull_request.head.repo.id = 2;
  assert.equal(accepts(github), false);
  github.event.pull_request.head.repo.id = 1;
  github.event.pull_request.merged = false;
  assert.equal(accepts(github), false);
  github.event_name = "workflow_dispatch";
  assert.equal(accepts(github), true);
  github.repository = "example/fork";
  assert.equal(accepts(github), false);
  assert.match(compiled.jobs.activation.if, /needs\.pre_activation\.outputs\.activated == 'true'/);
  assert.ok(compiled.jobs["resolve-source"].needs.includes("activation"));
});

test("the compiled native permission check denies insufficient roles and lookup failures", async t => {
  const runtime = process.env.GH_AW_ACTIONS_DIR;
  assert.ok(runtime, "GH_AW_ACTIONS_DIR must point to the workflow's pinned runtime.");
  const step = compiled.jobs.pre_activation.steps.find(step => step.id === "check_membership");
  assert.equal(step.env.GH_AW_REQUIRED_ROLES, "admin,maintainer,write");
  assert.equal(step.env.GH_AW_ALLOWED_BOTS, "aspire-repo-bot[bot]");
  const run = new AsyncFunction("require", "github", "core", "context", "exec", "io", "getOctokit", step.with.script);
  const path = directory(t, "telemetry-authorization-");
  mkdirSync(join(path, "gh-aw"), { recursive: true });
  const { symlinkSync } = await import("node:fs");
  symlinkSync(runtime, join(path, "gh-aw", "actions"), "dir");
  const values = { ...step.env, RUNNER_TEMP: path };
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  for (const [name, permission, status, allowed] of [
    ["none", "none", undefined, false], ["read", "read", undefined, false],
    ["triage", "triage", undefined, false], ["write", "write", undefined, true],
    ["maintain", "maintain", undefined, true], ["admin", "admin", undefined, true],
    ["API failure", undefined, 500, false]
  ]) {
    await t.test(name, async () => {
      const outputs = {};
      const summary = { addRaw() { return this; }, async write() { return this; } };
      const core = { info() {}, warning() {}, debug() {}, summary, setOutput: (name, value) => outputs[name] = value };
      const github = { hook: { before() {} }, rest: { repos: { getCollaboratorPermissionLevel: async parameters => {
        assert.deepEqual(parameters, { owner: "microsoft", repo: "aspire-skills", username: "fixture-actor" });
        if (status) throw Object.assign(new Error(`Permission lookup failed (${status})`), { status });
        return { data: { permission } };
      } } } };
      await run(require, github, core, {
        actor: "fixture-actor", eventName: "workflow_dispatch", payload: {},
        repo: { owner: "microsoft", repo: "aspire-skills" }
      }, {}, {}, () => github);
      assert.equal(outputs.is_team_member, String(allowed));
    });
  }
});

test("hostile container output remains inside random command-suppression markers on success and failure", async t => {
  const tokens = new Set();
  for (const [offline, status] of [[true, 0], [true, 2], [true, 1], [true, 7], [true, 125], [false, 2]]) {
    await t.test(`${offline ? "tests" : "restore"} exit ${status}`, t => {
      const path = directory(t, "telemetry-stdout-");
      const log = join(path, "docker.log");
      write(path, "docker", [
        "#!/bin/bash", 'printf "%s\\n" "$*" >> "$FAKE_DOCKER_LOG"',
        'if [[ "$1" == "rm" ]]; then exit 0; fi',
        'printf "::error::hostile-canary\\n::set-output name=forged::yes\\n::predictable-resume::\\n"',
        'printf "::warning::hostile-stderr-canary\\n" >&2',
        'if [[ "$FAKE_DOCKER_STATUS" == 0 ]]; then',
        '  printf "Test run summary: Passed!\\n  total: 1\\n  failed: 0\\n  succeeded: 1\\n  skipped: 0\\n  duration: 1ms\\n"',
        'else',
        '  printf "Test run summary: Failed!\\n  total: 1\\n  failed: 1\\n  succeeded: 0\\n  skipped: 0\\n  duration: 1ms\\n"',
        'fi',
        'exit "$FAKE_DOCKER_STATUS"', ""
      ].join("\n"), { mode: 0o755 });
      const module = pathToFileURL(join(root, "scripts", "telemetry-workflow.mjs")).href;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { runContainer } from ${JSON.stringify(module)};
        runContainer({
          workspace: "/private/source", cache: "/private/cache", name: "aspire-telemetry-123456-1",
          uid: 1001, gid: 1001, offline: ${offline}, base: "${"a".repeat(40)}"
        });
      `], {
        encoding: "utf8",
        env: {
          ...process.env, PATH: `${path}:${process.env.PATH}`, GITHUB_RUN_ID: "123456", GITHUB_RUN_ATTEMPT: "1",
          FAKE_DOCKER_LOG: log, FAKE_DOCKER_STATUS: String(status)
        }
      });
      if (result.error) throw result.error;
      assert.equal(result.status, offline && status !== 125 ? 0 : 1, result.stderr);
      const stop = /^::stop-commands::([^:\r\n]+)$/m.exec(result.stdout);
      assert.ok(stop, result.stdout);
      assert.ok(!tokens.has(stop[1]), "Container commands must use a fresh suppression token.");
      tokens.add(stop[1]);
      const hostile = result.stdout.indexOf("::error::hostile-canary");
      const resume = result.stdout.indexOf(`::${stop[1]}::`);
      assert.ok(hostile > stop.index && resume > hostile, result.stdout);
      if (offline) {
        const stderr = result.stdout.indexOf("::warning::hostile-stderr-canary");
        assert.ok(stderr > stop.index && resume > stderr, result.stdout);
      }
      assert.ok(result.stdout.includes("::set-output name=forged::yes"));
      const calls = readFileSync(log, "utf8");
      assert.match(calls, /rm --force aspire-telemetry-123456-1/);
      assert.equal(calls.split("\n").filter(line => line.startsWith("run ")).length, 1);
    });
  }
});
