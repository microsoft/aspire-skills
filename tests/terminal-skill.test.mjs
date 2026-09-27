import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { assertTerminalEdit } from "../evals/terminals/grade-edit.mjs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const base = read("evals/terminals/app/Program.cs");
const apphost = read("skills/aspire-terminals/references/apphost-terminals.md");
const recipes = [...apphost.matchAll(/```csharp\n(#pragma[\s\S]*?)\n```/g)].map(match => match[1]);
const diff = "diff --git a/app/Program.cs b/app/Program.cs\n";
const candidate = recipe => base.replace("builder.Build().Run();", `${recipe}\nbuilder.Build().Run();`);
const spec = parse(read("skills/aspire-terminals/evals/eval.yaml"));

test("terminal skill is version-neutral, bounded and linked to each shipped reference", () => {
  const skill = read("skills/aspire-terminals/SKILL.md");
  const frontmatter = parse(/^---\n([\s\S]*?)\n---/.exec(skill)[1]);
  assert.equal(frontmatter.name, "aspire-terminals");
  assert.ok(frontmatter.description.length <= 1024);
  assert.doesNotMatch(frontmatter.description, /\b\d+\.\d+(?:\.\d+)?\b/);
  assert.equal(frontmatter.metadata.version, JSON.parse(read("package.json")).version);
  for (const name of readdirSync(new URL("../skills/aspire-terminals/references/", import.meta.url))) {
    assert.ok(skill.includes(`references/${name}`), `Missing link: ${name}`);
  }
});

test("published examples satisfy fixture edit contracts with paired experimental suppression", () => {
  assert.equal(recipes.length, 4);
  for (const [mode, index] of [["dock", 0], ["prompt", 2], ["headless", 3]]) {
    assertTerminalEdit(candidate(recipes[index]), diff, mode);
    assert.equal((recipes[index].match(/#pragma warning disable/g) ?? []).length, 1);
    assert.equal((recipes[index].match(/#pragma warning restore/g) ?? []).length, 1);
  }
  const resource = read("skills/aspire-terminals/references/resource-terminals.md")
    .match(/```csharp\n([\s\S]*?)\n```/)[1].replace("worker.WithTerminal", "resource.WithTerminal");
  assertTerminalEdit(candidate(resource), diff, "resource");
  const fluent = base.replace(
    'var resource = builder.AddExecutable("worker", "dotnet", builder.AppHostDirectory, toolPath);',
    '#pragma warning disable ASPIRETERMINAL001\nvar resource = builder.AddExecutable("worker", "dotnet", builder.AppHostDirectory, toolPath)\n    .WithTerminal();\n#pragma warning restore ASPIRETERMINAL001'
  );
  assertTerminalEdit(fluent, diff, "resource");
});

test("edit grading rejects prose, unrelated edits and dangerous lifetime mutations", () => {
  const dock = candidate(recipes[0]);
  const prompt = candidate(recipes[2]);
  const headless = candidate(recipes[3]);
  for (const [source, changedDiff, mode] of [
    [dock, "", "dock"],
    [dock, `${diff}diff --git a/app/AppHost.csproj b/app/AppHost.csproj\n`, "dock"],
    [dock.replace("var terminal =", "await using var terminal ="), diff, "dock"],
    [dock.replace("TerminalPlacement.Dock", "TerminalPlacement.Dialog"), diff, "dock"],
    [dock.replace("terminal.Show();", "// terminal.Show();"), diff, "dock"],
    [prompt.replace("!interaction.IsAvailable", "false"), diff, "prompt"],
    [prompt.replace("await using var terminal", "var terminal"), diff, "prompt"],
    [prompt.replace("terminalContext.CancellationToken", "CancellationToken.None"), diff, "prompt"],
    [prompt.replace('CommandResults.Failure("Setup canceled.")', "CommandResults.Success()"), diff, "prompt"],
    [headless.replace("TerminalPlacement.None", "TerminalPlacement.Dock"), diff, "headless"],
    [headless.replace("AspireTerminalKey.Enter, token", "AspireTerminalKey.Enter, CancellationToken.None"), diff, "headless"]
  ]) {
    assert.throws(() => assertTerminalEdit(source, changedDiff, mode));
  }
});

test("terminal evals use real activation and actual-edit graders, with all routing candidates", () => {
  assert.equal(spec.environment.skills.length, 8);
  for (const stimulus of spec.stimuli) {
    assert.ok(stimulus.graders.some(grader => grader.type === "skill-invocation"), stimulus.name);
    if (stimulus.tags.area === "actual-edit") {
      assert.ok(stimulus.graders.some(grader => grader.type === "program"));
      assert.ok(stimulus.graders.some(grader => grader.type === "diff-contains"));
      assert.ok(!stimulus.graders.some(grader => grader.type === "diff-empty"));
    } else {
      assert.ok(stimulus.graders.some(grader => grader.type === "diff-empty"));
    }
  }
});

test("lifecycle guidance and cancellation prompt retain explicit completion and cleanup requirements", () => {
  const skill = read("skills/aspire-terminals/SKILL.md");
  assert.match(skill, /\*\*Dialog and None:\*\* the caller disposes both/);
  assert.match(skill, /successful `Work` closes the\s+prompt, but the caller still disposes/);
  const cancellation = spec.stimuli.find(item => item.name === "terminal-manual-cancellation");
  assert.match(cancellation.prompt, /Work callback completing successfully/);
  assert.match(cancellation.prompt, /being canceled, or throwing an unrelated exception/);
  assert.equal(spec.scoring.threshold, 1);
});

test("tape reference distinguishes upstream syntax, output formats and unsupported effects", () => {
  const tape = read("skills/aspire-terminals/references/tapes.md");
  for (const required of [
    "charmbracelet/vhs#vhs-command-reference", "charmbracelet/vhs#integration-testing",
    'Type "help"', "Wait+Line", "Wait+Screen", "Set WaitTimeout", "Set TypingSpeed",
    'Source "common/ready.tape"', 'Output "probe.txt"', 'Output "probe.ascii"',
    "stdout", "stderr", "UTF-8 without BOM", "U+2500", "not overwritten",
    "one distinct", "root tape directory", "included Output directives are ignored",
    "GIF", "MP4", "WebM", "PNG", ".cast", "Hide", "redaction"
  ]) assert.ok(tape.includes(required), `Missing tape contract: ${required}`);
  assert.match(tape, /Type "printf 'ASPIRE_TAPE_%s\\n' ready"\nEnter\nWait\+Screen \/ASPIRE_TAPE_ready\//);
  assert.doesNotMatch(tape, /(?:npm|brew|apt) install.*(?:vhs|ffmpeg|ttyd)/);
});

test("terminal authoring handoffs no longer declare aspireify as the owner", () => {
  for (const name of ["aspire", "aspireify", "aspire-orchestration", "aspire-monitoring"]) {
    assert.ok(read(`skills/${name}/SKILL.md`).includes("aspire-terminals"));
  }
  const wiring = parse(read("skills/aspireify/evals/eval.yaml"));
  const handoff = wiring.stimuli.find(item => item.name === "terminal-specialist-handoff");
  const activation = handoff.graders.find(grader => grader.type === "skill-invocation");
  assert.deepEqual(activation.config.required, ["aspire-terminals"]);
  assert.deepEqual(activation.config.disallowed, ["aspireify"]);
});
