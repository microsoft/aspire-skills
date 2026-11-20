import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { finishAssessment, parseResponse, readJson, terminalOutcome } from "./upstream-skill-assessment.mjs";

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

async function createRuntimeClient(environment) {
  const tools = resolve(".test-artifacts", "upstream-agent-tools");
  const require = createRequire(join(tools, "package.json"));
  const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(require.resolve("@github/copilot-sdk")).href);
  const home = resolve(".test-artifacts", "upstream-agent-home");
  const work = resolve(".test-artifacts", "upstream-agent-work");
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  return new CopilotClient({
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
}

export async function smokeRuntime(client, model) {
  const result = terminalOutcome(parseResponse(await askWithClient(client, model,
    'Hosted setup smoke test. Do not call tools. Return exactly {"status":"noop","reason":"hosted tool-free smoke"}.')));
  if (result.status !== "noop" || result.reason !== "hosted tool-free smoke") {
    throw new Error("Hosted runtime smoke returned an unexpected response.");
  }
}

export async function run(directory, environment = process.env, createClient = createRuntimeClient) {
  const prepared = readJson(join(directory, "evidence.json"));
  let client;
  let result;
  try {
    let ask;
    const configured = environment.UPSTREAM_SKILL_AGENT_ENABLED === "true" && Boolean(environment.UPSTREAM_SKILL_MODEL);
    let runtime = configured ? "not-needed" : "disabled";
    if (configured && (prepared.sources.length > 0 || environment.UPSTREAM_SKILL_SMOKE_ONLY === "true")) {
      client = await createClient(environment);
      await client.start();
      await smokeRuntime(client, environment.UPSTREAM_SKILL_MODEL);
      ask = prompt => askWithClient(client, environment.UPSTREAM_SKILL_MODEL, prompt);
      runtime = "started";
    }
    result = await finishAssessment(prepared, ask);
    result.runtime = runtime;
    result.smoke = runtime === "started" ? "passed" : "not-run";
  } finally {
    if (client) {
      const errors = await client.stop();
      if (errors?.length) throw errors[0];
    }
  }
  writeFileSync(join(directory, "review.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(directory, "state.json"), JSON.stringify(result.state));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await run(resolve(".test-artifacts", "upstream-assessment"));
  const counts = {};
  for (const report of result.reports) counts[report.status] = (counts[report.status] ?? 0) + 1;
  console.log(JSON.stringify({ scope: result.scope, runtime: result.runtime, smoke: result.smoke, counts }));
}
