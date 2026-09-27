import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Fixture-scoped checks supplement the outcome judge; they are not a C# compiler.
export function assertTerminalEdit(source, diff, mode) {
  assert.equal(typeof diff, "string", "Missing captured diff; configure a diff grader");
  const headers = diff.split("\n").filter(line => line.startsWith("diff --git "));
  assert.deepEqual(headers, ["diff --git a/app/Program.cs b/app/Program.cs"],
    "Only the existing AppHost source may change; a prose answer does not count");
  const code = (source.match(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\/|./gs) ?? [])
    .filter(token => !token.startsWith("//") && !token.startsWith("/*")).join("");
  assert.match(code, /builder\.AddExecutable\("worker",\s*"dotnet",\s*builder\.AppHostDirectory,\s*toolPath\)/);
  assert.match(code, /builder\.Build\(\)\.Run\(\)/);
  assert.match(code, /#pragma warning disable ASPIRETERMINAL001/);
  assert.match(code, /#pragma warning restore ASPIRETERMINAL001/);
  assert.doesNotMatch(code, /Aspire\.Hosting\.Terminals|new TerminalService|WaitForExitAsync|\.ExitCode|TerminalOptions\.Shell/);
  if (mode === "resource") {
    assert.match(code, /(?:resource|builder\.AddExecutable\("worker",\s*"dotnet",\s*builder\.AppHostDirectory,\s*toolPath\))\s*\.WithTerminal\(/);
    assert.doesNotMatch(code, /CreateTerminal|TerminalPlacement/);
    return;
  }
  assert.ok(["dock", "prompt", "headless"].includes(mode), `Unknown edit mode: ${mode}`);
  assert.match(code, /if\s*\(builder\.ExecutionContext\.IsRunMode\)/);
  assert.match(code, /resource\.WithCommand\(/);
  assert.match(code, /GetRequiredService<TerminalService>\(\)/);
  assert.match(code, /CreateTerminal\(new TerminalLaunchOptions/);
  assert.match(code, /Arguments\s*=\s*\{\s*toolPath\s*\}/);
  assert.doesNotMatch(code, /\.WithTerminal\(/);
  if (mode === "dock") {
    assert.match(code, /Placement\s*=\s*TerminalPlacement\.Dock/);
    assert.match(code, /terminal\.Start\(\)/);
    assert.match(code, /terminal\.Show\(\)/);
    assert.doesNotMatch(code, /(?:await\s+)?using\s+(?:var\s+terminal|\(\s*var\s+terminal)|terminal\.Dispose/);
  } else {
    assert.match(code, /await using var terminal\s*=/);
    assert.match(code, /WaitForTextAsync\(/);
    assert.match(code, /TimeSpan\.FromSeconds\(/);
    assert.match(code, /SendTextAsync\("yes",\s*token\)/);
    assert.match(code, /SendKeyAsync\(AspireTerminalKey\.Enter,\s*token\)/);
    assert.match(code, /"Setup complete"/);
    if (mode === "prompt") {
      assert.match(code, /Placement\s*=\s*TerminalPlacement\.Dialog/);
      const availability = code.indexOf("!interaction.IsAvailable");
      assert.ok(availability >= 0 && availability < code.indexOf("CreateTerminal("),
        "Check interaction availability before creating the prompt-owned process");
      assert.match(code, /PromptTerminalAsync\(/);
      assert.match(code, /Work\s*=\s*async/);
      assert.match(code, /terminalContext\.CancellationToken/);
      assert.match(code, /result\.Canceled\s*\?\s*CommandResults\.Failure/);
    } else {
      assert.match(code, /Placement\s*=\s*TerminalPlacement\.None/);
      assert.doesNotMatch(code, /PromptTerminalAsync/);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(process.env.EVALUATE_GRADER_INPUT, "utf8"));
    assert.ok(process.env.EVALUATE_WORKSPACE, "Missing actual workspace");
    assertTerminalEdit(
      readFileSync(join(process.env.EVALUATE_WORKSPACE, "app/Program.cs"), "utf8"),
      input.trajectory?.diff,
      process.argv[2]
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
