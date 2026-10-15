import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.argv[2] || !process.env.COPILOT_CLI_PATH) {
  throw new Error("Evaluation tool directory and COPILOT_CLI_PATH are required.");
}

const require = createRequire(pathToFileURL(resolve(process.argv[2], "package.json")));
const { CopilotClient } = await import(pathToFileURL(require.resolve("@github/copilot-sdk")).href);
const client = new CopilotClient({ cliPath: process.env.COPILOT_CLI_PATH });

try {
  await client.start();
  const models = await client.listModels();
  if (models.some(model => typeof model.id !== "string" || model.id.length === 0)) {
    throw new Error("Evaluation runtime returned an invalid model ID.");
  }
  console.log(JSON.stringify({
    listedModels: models.map(model => ({ id: model.id, policyState: model.policy?.state ?? null }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }));
} finally {
  const errors = await client.stop();
  for (const error of errors) {
    console.error(error);
  }
  if (errors.length > 0) {
    process.exitCode = 1;
  }
}
