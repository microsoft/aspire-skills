import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { finishAssessment, readJson } from "./upstream-skill-assessment.mjs";

// Empty-mode defaults and the deny handler are deliberately independent defenses.
export function readOnlySession(model) {
  return {
    model, availableTools: [], tools: [], mcpServers: {},
    customAgents: [], enableConfigDiscovery: false, enableSkills: false,
    enableSessionStore: false, infiniteSessions: { enabled: false },
    onPermissionRequest: () => ({ kind: "reject", feedback: "This assessment has no tool permissions." }),
    hooks: { onPreToolUse: () => ({ permissionDecision: "deny" }) }
  };
}

export async function askWithClient(client, model, prompt) {
  const session = await client.createSession(readOnlySession(model));
  try {
    const response = await session.sendAndWait({ prompt }, 120_000);
    if (typeof response?.data.content !== "string" || !response.data.content.trim()) {
      throw new Error("The runtime returned no assessment.");
    }
    return response.data.content;
  } finally {
    await session.disconnect();
  }
}

export async function run(directory, environment = process.env) {
  const prepared = readJson(join(directory, "evidence.json"));
  let client;
  let ask;
  let runtime = "disabled";
  if (environment.UPSTREAM_SKILL_AGENT_ENABLED === "true" && environment.UPSTREAM_SKILL_MODEL) {
    try {
      const tools = resolve(".test-artifacts", "upstream-agent-tools");
      const require = createRequire(join(tools, "package.json"));
      const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(require.resolve("@github/copilot-sdk")).href);
      const home = resolve(".test-artifacts", "upstream-agent-home");
      const work = resolve(".test-artifacts", "upstream-agent-work");
      mkdirSync(home, { recursive: true });
      mkdirSync(work, { recursive: true });
      client = new CopilotClient({
        mode: "empty", baseDirectory: home, workingDirectory: work,
        useLoggedInUser: false, logLevel: "error",
        connection: RuntimeConnection.forStdio({
          path: join(tools, "node_modules", "@github", "copilot-linux-x64", "index.js")
        }),
        env: {
          PATH: environment.PATH, HOME: home,
          COPILOT_GITHUB_TOKEN: environment.COPILOT_GITHUB_TOKEN
        }
      });
      await client.start();
      ask = prompt => askWithClient(client, environment.UPSTREAM_SKILL_MODEL, prompt);
      runtime = "started; individual assessments may still fail";
    } catch {
      // Missing auth/runtime is a blocked handoff, never a successful model assessment.
      runtime = "setup failed; no model assessment ran";
    }
  }
  try {
    const result = await finishAssessment(prepared, ask);
    result.runtime = runtime;
    writeFileSync(join(directory, "review.json"), JSON.stringify(result, null, 2));
    writeFileSync(join(directory, "state.json"), JSON.stringify(result.state));
    return result;
  } finally {
    if (client) await client.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await run(resolve(".test-artifacts", "upstream-assessment"));
  const counts = {};
  for (const report of result.reports) counts[report.status] = (counts[report.status] ?? 0) + 1;
  console.log(JSON.stringify({ scope: result.scope, runtime: result.runtime, counts, publication: "disabled" }));
}
