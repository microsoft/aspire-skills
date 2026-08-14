import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { spawnSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const continueResponse = '{"continue":true}';
const hookKinds = [
  {
    name: "bash",
    executable: "bash",
    args: [join(repoRoot, "hooks", "scripts", "track-telemetry.sh")],
    readArgs: path => readFileSync(path, "utf8").trim().split("\n")
  },
  {
    name: "pwsh",
    executable: "pwsh",
    args: ["-NoProfile", "-File", join(repoRoot, "hooks", "scripts", "track-telemetry.ps1")],
    readArgs: path => JSON.parse(readFileSync(path, "utf8"))
  }
];

let workspace;
let bashStub;
let pwshStub;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "aspire-hook-tests-"));
  bashStub = join(workspace, "capture.sh");
  pwshStub = join(workspace, "capture.ps1");

  writeFileSync(
    bashStub,
    `#!/bin/bash
printf '%s\\n' "$@" > "$ASPIRE_HOOK_TEST_CAPTURE_FILE"
printf '%s\\n' 'child stdout'
printf '%s\\n' 'child stderr' >&2
exit "\${ASPIRE_HOOK_TEST_EXIT_CODE:-0}"
`
  );
  chmodSync(bashStub, 0o755);

  writeFileSync(
    pwshStub,
    `[System.IO.File]::WriteAllText(
    $env:ASPIRE_HOOK_TEST_CAPTURE_FILE,
    ((ConvertTo-Json -InputObject @($args) -Compress) + [Environment]::NewLine))
Write-Output 'child stdout'
[Console]::Error.WriteLine('child stderr')
if ($env:ASPIRE_HOOK_TEST_EXIT_CODE) { exit [int]$env:ASPIRE_HOOK_TEST_EXIT_CODE }
`
  );
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function runHook(kind, payload, options = {}) {
  const capturePath = join(workspace, `${kind.name}-${randomUUID()}.json`);
  const command = options.missingCommand
    ? join(workspace, "missing-aspire-command")
    : kind.name === "bash"
      ? bashStub
      : pwshStub;

  const result = spawnSync(kind.executable, kind.args, {
    cwd: repoRoot,
    encoding: "utf8",
    input: payload,
    env: {
      ...process.env,
      COPILOT_CLI: "",
      ASPIRE_CLI_COMMAND: command,
      ASPIRE_CLI_TELEMETRY_OPTOUT: "",
      ASPIRE_HOOK_TEST_CAPTURE_FILE: capturePath,
      ASPIRE_HOOK_TEST_EXIT_CODE: options.exitCode ? String(options.exitCode) : "",
      ...options.env
    }
  });

  assert.equal(result.status, 0, `${kind.name} hook exited with ${result.status}: ${result.stderr}`);
  assert.equal(result.stdout.trim(), continueResponse);
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1);
  assert.equal(result.stderr, "");

  return {
    args: existsSync(capturePath) ? kind.readArgs(capturePath) : undefined
  };
}

function assertArg(args, name, expected) {
  assert.ok(args, `expected telemetry invocation containing ${name}`);
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `missing ${name} in ${JSON.stringify(args)}`);
  assert.equal(args[index + 1], expected);
}

for (const kind of hookKinds) {
  test(`${kind.name}: Copilot string toolArgs forwards an Aspire skill`, () => {
    const run = runHook(
      kind,
      String.raw`{"toolName":"skill","sessionId":"session-1","toolArgs":"{\"skill\":\"aspire\"}"}`,
      { env: { COPILOT_CLI: "1" } }
    );

    assertArg(run.args, "--event-type", "skill_invocation");
    assertArg(run.args, "--client-name", "copilot-cli");
    assertArg(run.args, "--skill-name", "aspire");
    assertArg(run.args, "--session-id", "session-1");
  });

  test(`${kind.name}: Claude Aspire MCP usage forwards the tool name`, () => {
    const run = runHook(
      kind,
      '{"hook_event_name":"PostToolUse","tool_name":"mcp__aspire__list_resources"}'
    );

    assertArg(run.args, "--event-type", "tool_invocation");
    assertArg(run.args, "--client-name", "claude-code");
    assertArg(run.args, "--tool-name", "mcp__aspire__list_resources");
  });

  test(`${kind.name}: an Aspire reference read forwards only the relative path`, () => {
    const run = runHook(
      kind,
      '{"hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":".agents/skills/aspire/references/deploy.md"}}'
    );

    assertArg(run.args, "--event-type", "reference_file_read");
    assertArg(run.args, "--file-reference", "aspire/references/deploy.md");
  });

  test(`${kind.name}: non-Aspire input does not invoke the CLI`, () => {
    const run = runHook(
      kind,
      '{"hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":"/tmp/notes.txt"}}'
    );

    assert.equal(run.args, undefined);
  });

  test(`${kind.name}: opt-out does not invoke the CLI`, () => {
    const run = runHook(
      kind,
      '{"toolName":"skill","toolArgs":{"skill":"aspire"}}',
      { env: { COPILOT_CLI: "1", ASPIRE_CLI_TELEMETRY_OPTOUT: "true" } }
    );

    assert.equal(run.args, undefined);
  });

  test(`${kind.name}: malformed input still returns exactly one continuation response`, () => {
    const run = runHook(kind, "{ this is not valid json");
    assert.equal(run.args, undefined);
  });

  test(`${kind.name}: an unexpected CLI launch failure still returns exactly one continuation response`, () => {
    const run = runHook(
      kind,
      '{"toolName":"skill","toolArgs":{"skill":"aspire"}}',
      { env: { COPILOT_CLI: "1" }, missingCommand: true }
    );

    assert.equal(run.args, undefined);
  });

  test(`${kind.name}: child output and a nonzero child exit cannot contaminate the hook response`, () => {
    const run = runHook(
      kind,
      '{"toolName":"skill","toolArgs":{"skill":"aspire"}}',
      { env: { COPILOT_CLI: "1" }, exitCode: 17 }
    );

    assertArg(run.args, "--skill-name", "aspire");
  });
}
