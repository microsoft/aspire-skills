import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { assertIncidentResponse } from "./incident-contract.mjs";
import { incidentSources, semanticCandidate, semanticControls } from "../../tests/fixtures/large-system-candidates.mjs";

// Opt-in qualification: use Vally's actual grader/client, never a lexical
// stand-in for the semantic judge. This is not part of npm test.
const vallyModule = process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : "@microsoft/vally";
const { createCopilotLlmClient, computeMetrics, PromptGrader } = await import(vallyModule);
const moduleUrl = new URL(import.meta.resolve(vallyModule));
const { ProgramGrader } = await import(new URL("graders/static/program-grader.js", moduleUrl));
const { gradeInDisposableWorkspace } = await import(new URL("pipeline/run.js", moduleUrl));
const spec = parse(readFileSync(new URL("../../skills/aspire-monitoring/evals/eval.yaml", import.meta.url), "utf8"));
const topology = JSON.parse(readFileSync(new URL("topology.json", import.meta.url), "utf8"));
const workDir = mkdtempSync(join(tmpdir(), "incident-semantic-controls-"));
let client;
try {
  client = await createCopilotLlmClient();
  const grader = new PromptGrader(client);
  const programGrader = new ProgramGrader();
  for (const control of semanticControls) {
    for (const [source, destination] of [
      ["topology.json", "topology.json"],
      ["response-contract.md", "response-contract.md"],
      [`incidents/${control.caseName}.json`, "incident.json"]
    ]) cpSync(new URL(source, import.meta.url), join(workDir, destination));
    const stimulus = spec.stimuli.find(item => item.tags?.incident === control.caseName);
    const input = semanticCandidate(control, workDir);
    assertIncidentResponse(input, control.caseName, topology, incidentSources(control.caseName));
    for (const event of input.trajectory.events) {
      if (event.type === "tool_result") {
        const call = input.trajectory.events.find(item => item.type === "tool_call" &&
          item.data.toolCallId === event.data.toolCallId);
        event.data.result = readFileSync(call.data.arguments.path, "utf8");
      }
    }
    Object.assign(input.trajectory, {
      id: control.name, stimulus, metrics: computeMetrics(input.trajectory.events), metadata: { executor: "control" }
    });
    input.stimulus = stimulus;
    const program = stimulus.graders.find(item => item.type === "program");
    const structural = await gradeInDisposableWorkspace({
      trajectory: input.trajectory,
      graderFiles: spec.grading_environment.files,
      baseDir: dirname(fileURLToPath(new URL("../../skills/aspire-monitoring/evals/eval.yaml", import.meta.url))),
      grade: trajectory => programGrader.grade({ ...input, trajectory, config: program.config })
    });
    if (structural.status === "error" || !structural.passed) {
      throw new Error(`Disposable-workspace structural control failed: ${control.name}: ${structural.evidence}`);
    }
    const config = stimulus.graders.find(item => item.type === "prompt").config;
    input.config = { ...config, model: spec.defaults.judge_model };
    const verdict = await grader.grade(input);
    console.log(JSON.stringify({ control: control.name, expected: control.expected, structural, verdict }));
    if (verdict.status === "error" || verdict.passed !== control.expected) process.exitCode = 1;
  }
} finally {
  if (client) await client.shutdown();
  rmSync(workDir, { recursive: true, force: true });
}
