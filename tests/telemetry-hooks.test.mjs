import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { spawnSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const continueResponse = '{"continue":true}';
const hookKinds = [
  ...(process.platform === "win32" ? [] : [{
    name: "bash",
    executable: "bash",
    args: [join(repoRoot, "hooks", "scripts", "track-telemetry.sh")],
    readArgs: path => readFileSync(path, "utf8").trim().split("\n")
  }]),
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
if [ "$ASPIRE_HOOK_TEST_HANG" = "1" ]; then
    trap '' TERM
    (trap '' TERM; sleep 60) &
    printf '%s\\n' "$!" > "$ASPIRE_HOOK_TEST_CHILD_PID_FILE"
    wait
fi
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
if ($env:ASPIRE_HOOK_TEST_HANG -eq '1') {
    $child = Start-Process pwsh -PassThru -NoNewWindow -ArgumentList @(
        '-NoProfile',
        '-Command',
        'while ($true) { Start-Sleep -Seconds 1 }')
    [System.IO.File]::WriteAllText(
        $env:ASPIRE_HOOK_TEST_CHILD_PID_FILE,
        ([string]$child.Id + [Environment]::NewLine))
    while ($true) { Start-Sleep -Seconds 1 }
}
if ($env:ASPIRE_HOOK_TEST_EXIT_CODE) { exit [int]$env:ASPIRE_HOOK_TEST_EXIT_CODE }
`
  );
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function runHook(kind, payload, options = {}) {
  const capturePath = join(workspace, `${kind.name}-${randomUUID()}.json`);
  const childPidPath = join(workspace, `${kind.name}-${randomUUID()}.pid`);
  const command = options.missingCommand
    ? join(workspace, "missing-aspire-command")
    : kind.name === "bash"
      ? bashStub
      : pwshStub;

  const result = spawnSync(kind.executable, kind.args, {
    cwd: repoRoot,
    encoding: "utf8",
    input: payload,
    timeout: options.outerTimeoutMs,
    env: {
      ...process.env,
      COPILOT_CLI: "",
      ASPIRE_CLI_COMMAND: command,
      ASPIRE_CLI_TELEMETRY_OPTOUT: "",
      ASPIRE_HOOK_TEST_CAPTURE_FILE: capturePath,
      ASPIRE_HOOK_TEST_EXIT_CODE: options.exitCode ? String(options.exitCode) : "",
      ASPIRE_HOOK_TEST_HANG: "",
      ASPIRE_HOOK_TEST_CHILD_PID_FILE: childPidPath,
      ...options.env
    }
  });

  const childPid = existsSync(childPidPath)
    ? Number.parseInt(readFileSync(childPidPath, "utf8").trim(), 10)
    : undefined;
  if (result.error && childPid) {
    try {
      process.kill(childPid, "SIGKILL");
    }
    catch {
    }
  }

  assert.equal(result.error, undefined, `${kind.name} hook failed: ${result.error?.message}`);
  assert.equal(result.status, 0, `${kind.name} hook exited with ${result.status}: ${result.stderr}`);
  assert.equal(result.stdout.trim(), continueResponse);
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1);
  assert.equal(result.stderr, "");

  return {
    args: existsSync(capturePath) ? kind.readArgs(capturePath) : undefined,
    childPid
  };
}

function assertProcessExited(pid) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      process.kill(pid, 0);
    }
    catch (error) {
      if (error?.code === "ESRCH") {
        return;
      }

      throw error;
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }

  assert.fail(`process ${pid} is still running`);
}

function listShippedReferenceFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current)) {
    const fullPath = join(current, entry);
    if (statSync(fullPath).isDirectory()) {
      if (entry !== "evals") {
        files.push(...listShippedReferenceFiles(root, fullPath));
      }
    }
    else if (entry !== "SKILL.md") {
      files.push(relative(root, fullPath).split("\\").join("/"));
    }
  }

  return files.sort();
}

function readBashMultilineAllowlist(name) {
  const script = readFileSync(join(repoRoot, "hooks", "scripts", "track-telemetry.sh"), "utf8");
  const match = new RegExp(`${name}="\\n([\\s\\S]*?)\\n"`).exec(script);
  assert.ok(match, `missing ${name} in Bash hook`);
  return match[1].split("\n").filter(Boolean).toSorted();
}

function readPowerShellArray(name) {
  const script = readFileSync(join(repoRoot, "hooks", "scripts", "track-telemetry.ps1"), "utf8");
  const match = new RegExp(`\\$${name} = @\\(\\n([\\s\\S]*?)\\n\\)`).exec(script);
  assert.ok(match, `missing ${name} in PowerShell hook`);
  return [...match[1].matchAll(/'([^']+)'/g)].map(item => item[1]).toSorted();
}

function assertArg(args, name, expected) {
  assert.ok(args, `expected telemetry invocation containing ${name}`);
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `missing ${name} in ${JSON.stringify(args)}`);
  assert.equal(args[index + 1], expected);
}

test("reference allowlists match the files shipped by this repository", () => {
  const references = listShippedReferenceFiles(join(repoRoot, "skills"));
  assert.deepEqual(readBashMultilineAllowlist("ASPIRE_REFERENCE_FILES"), references);
  assert.deepEqual(readPowerShellArray("AspireReferenceFiles"), references);
});

for (const kind of hookKinds) {
  test(`${kind.name}: Copilot string toolArgs forwards an Aspire skill`, () => {
    const run = runHook(
      kind,
      String.raw`{"toolName":"skill","sessionId":"03d6f9f8-a6e0-4f4d-b175-6737106eaf73","toolArgs":"{\"skill\":\"aspire\"}"}`,
      { env: { COPILOT_CLI: "1" } }
    );

    assertArg(run.args, "--event-type", "skill_invocation");
    assertArg(run.args, "--client-name", "copilot-cli");
    assertArg(run.args, "--skill-name", "aspire");
    assertArg(run.args, "--session-id", "03d6f9f8-a6e0-4f4d-b175-6737106eaf73");
  });

  test(`${kind.name}: Copilot string toolArgs forwards a Windows reference path`, () => {
    const run = runHook(
      kind,
      String.raw`{"toolName":"view","toolArgs":"{\"path\":\"C:\\\\workspace\\\\skills\\\\aspire\\\\references\\\\aspire-13-3-breaking-changes.md\"}"}`,
      { env: { COPILOT_CLI: "1" } }
    );

    assertArg(run.args, "--event-type", "reference_file_read");
    assertArg(run.args, "--file-reference", "aspire/references/aspire-13-3-breaking-changes.md");
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
      '{"hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":".agents/skills/aspire/references/aspire-13-3-breaking-changes.md"}}'
    );

    assertArg(run.args, "--event-type", "reference_file_read");
    assertArg(run.args, "--file-reference", "aspire/references/aspire-13-3-breaking-changes.md");
  });

  test(`${kind.name}: custom Aspire reference paths are ignored`, () => {
    const run = runHook(
      kind,
      '{"hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":".agents/skills/aspire/references/customer-acme.md"}}'
    );
    assert.equal(run.args, undefined);
  });

  test(`${kind.name}: the final recognized skills root determines the reference`, () => {
    const run = runHook(
      kind,
      '{"hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":"/workspace/skills/aspire/customer/.agents/skills/aspire/references/aspire-13-3-breaking-changes.md"}}'
    );

    assertArg(run.args, "--file-reference", "aspire/references/aspire-13-3-breaking-changes.md");
  });

  test(`${kind.name}: a rightmost third-party skill root is not attributed to Aspire`, () => {
    const run = runHook(
      kind,
      '{"hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":"/workspace/skills/aspire/references/aspire-13-3-breaking-changes.md/.agents/skills/private/SKILL.md"}}'
    );

    assert.equal(run.args, undefined);
  });

  test(`${kind.name}: tool response fields cannot forge an Aspire invocation`, () => {
    const payloads = [
      '{"hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":"/tmp/notes.txt"},"tool_response":{"file_path":".agents/skills/aspire/references/aspire-13-3-breaking-changes.md"}}',
      '{"hook_event_name":"PostToolUse","tool_name":"Read","tool_response":{"file_path":".agents/skills/aspire/references/aspire-13-3-breaking-changes.md"},"tool_input":{"file_path":"/tmp/notes.txt"}}'
    ];

    for (const payload of payloads) {
      const run = runHook(kind, payload);
      assert.equal(run.args, undefined);
    }
  });

  test(`${kind.name}: malformed Aspire-shaped input is ignored`, () => {
    const run = runHook(
      kind,
      String.raw`{not-json "toolName":"skill","toolArgs":"{\"skill\":\"aspire\"}"`
    );

    assert.equal(run.args, undefined);
  });

  test(`${kind.name}: unknown Aspire-prefixed MCP tools are ignored`, () => {
    const run = runHook(
      kind,
      '{"hook_event_name":"PostToolUse","tool_name":"mcp__aspire__customer_acme_secret"}'
    );

    assert.equal(run.args, undefined);
  });

  test(`${kind.name}: non-UUID session identifiers are omitted`, () => {
    const run = runHook(
      kind,
      '{"toolName":"skill","sessionId":"customer-acme-case-123","toolArgs":{"skill":"aspire"}}',
      { env: { COPILOT_CLI: "1" } }
    );

    assertArg(run.args, "--skill-name", "aspire");
    assert.equal(run.args.includes("--session-id"), false);
  });

  test(`${kind.name}: multiline session identifiers are omitted`, () => {
    const run = runHook(
      kind,
      JSON.stringify({
        toolName: "skill",
        sessionId: "customer-acme\n03d6f9f8-a6e0-4f4d-b175-6737106eaf73",
        toolArgs: {
          skill: "aspire"
        }
      }),
      { env: { COPILOT_CLI: "1" } }
    );

    assertArg(run.args, "--skill-name", "aspire");
    assert.equal(run.args.includes("--session-id"), false);
  });

  test(`${kind.name}: response metadata cannot change client detection`, () => {
    const run = runHook(
      kind,
      '{"toolName":"skill","toolArgs":{"skill":"aspire"},"tool_response":{"hook_event_name":"PostToolUse"}}'
    );

    assertArg(run.args, "--client-name", "copilot-cli");
  });

  test(`${kind.name}: oversized payloads are ignored promptly`, () => {
    const startedAt = Date.now();
    const run = runHook(
      kind,
      JSON.stringify({
        toolName: "skill",
        toolArgs: {
          skill: "aspire"
        },
        tool_response: {
          text: "aspire".repeat(14_000)
        }
      }),
      { outerTimeoutMs: 3_000 }
    );

    assert.ok(Date.now() - startedAt < 2_000);
    assert.equal(run.args, undefined);
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

  test(`${kind.name}: a hung CLI process tree is terminated within the hook timeout`, () => {
    const startedAt = Date.now();
    const run = runHook(
      kind,
      '{"toolName":"skill","toolArgs":{"skill":"aspire"}}',
      {
        env: {
          COPILOT_CLI: "1",
          ASPIRE_HOOK_TEST_HANG: "1",
          ASPIRE_HOOK_TIMEOUT_SECONDS: "1"
        },
        outerTimeoutMs: 5_000
      }
    );

    assert.ok(Date.now() - startedAt < 4_000);
    assertArg(run.args, "--skill-name", "aspire");
    assert.ok(run.childPid);
    try {
      assertProcessExited(run.childPid);
    }
    finally {
      try {
        process.kill(run.childPid, "SIGKILL");
      }
      catch {
      }
    }
  });
}

test("pwsh: child output is streamed to a null sink instead of buffered", () => {
  const script = readFileSync(join(repoRoot, "hooks", "scripts", "track-telemetry.ps1"), "utf8");
  assert.doesNotMatch(script, /\.ReadToEndAsync\(/);
  assert.match(script, /CopyToAsync\(\[System\.IO\.Stream\]::Null\)/);
});
