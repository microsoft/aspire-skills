import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { readOnlySession } from "../scripts/run-upstream-skill-assessment.mjs";
import { finishAssessment } from "../scripts/upstream-skill-assessment.mjs";

const tools = resolve(process.env.UPSTREAM_SKILL_SDK_ROOT ?? ".test-artifacts/upstream-agent-tools");
const packagePath = join(tools, "node_modules", "@github", "copilot-sdk", "package.json");
const skip = !process.env.UPSTREAM_SKILL_SDK_ROOT && !existsSync(packagePath);

test("SDK 1.0.11 itself accepts the tool-free session and rejects a bare wildcard", {
  skip: skip ? "Optional pinned runtime is not installed; the agent workflow requires this check after installation." : false
}, async () => {
  assert.equal(JSON.parse(readFileSync(packagePath, "utf8")).version, "1.0.11");
  const require = createRequire(join(tools, "package.json"));
  const { CopilotClient } = await import(pathToFileURL(require.resolve("@github/copilot-sdk")).href);
  // Exercise the real compiled SDK method, without starting a runtime or authenticating.
  const client = { options: { mode: "empty" } };
  const normalize = config => CopilotClient.prototype.resolveToolFilterOptions.call(client, config);
  const session = readOnlySession("contract-only");
  assert.throws(() => normalize({ ...session, excludedTools: ["*"] }), /there is no bare wildcard/);
  assert.deepEqual(normalize(session), {
    availableTools: [], excludedTools: undefined, toolFilterPrecedence: "excluded"
  });
  assert.throws(() => normalize({}), /Empty mode requires every session/);
  const defaults = CopilotClient.prototype.configDefaultsForMode.call(client);
  for (const setting of [
    "enableFileHooks", "enableHostGitOperations", "enableSkills", "enableSessionStore",
    "enableOnDemandInstructionDiscovery", "enableSessionTelemetry"
  ]) assert.equal(defaults[setting], false, setting);
  assert.equal(session.enableConfigDiscovery, false);
  assert.deepEqual(session.mcpServers, {});
  const prepared = {
    reports: [], sources: [{ source: { key: "a".repeat(64) }, evidence: {} }],
    documents: {}, state: { schema: 1, entries: [] }
  };
  await assert.rejects(finishAssessment(prepared,
    async () => normalize({ ...session, excludedTools: ["*"] })), /there is no bare wildcard/);
  assert.deepEqual(prepared.state.entries, [], "SDK failures must not become completed semantic triage.");
});
