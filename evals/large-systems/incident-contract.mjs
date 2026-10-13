import assert from "node:assert/strict";
import { resolve } from "node:path";

const commerce = "src/Commerce.AppHost/Commerce.AppHost.csproj";
const analytics = "src/Analytics.AppHost/Analytics.AppHost.csproj";
const trace = (verb, traceId, resource = null) => ({ verb, traceId, resource });
const logs = (resource, ...search) => ({ verb: "otel logs", resource, search });

// Grading-only oracle: never stage this in the agent's environment.files.
export const incidentCases = {
  "target-collision": {
    apphost: analytics, resource: "api",
    evidence: ["analytics-latency", "analytics-worker"],
    query: trace("otel logs", "111111111111111111111111111111aa"),
    finding: "Analytics worker report query timed out, accounting for API latency; Commerce authentication is unrelated."
  },
  "ambiguous-target": {
    apphost: null, resource: "api", assessment: "inconclusive",
    evidence: ["commerce-api", "analytics-api", "sandbox-api"],
    finding: "Which exact AppHost is affected? The resource name api does not select a unique target."
  },
  "dependency-fanout": {
    resource: "storefront", evidence: ["front-502", "orders-chain", "db-auth"],
    query: trace("otel logs", "222222222222222222222222222222aa"),
    finding: "Storefront's gateway 502 propagates through API and orders from orders-db password authentication rejection (SQLSTATE 28P01). Redis cache misses and search-worker's other-trace error are unrelated. The underlying credential change and any recovery remain unknown."
  },
  "hidden-migrator": {
    resource: "api", evidence: ["api-wait", "migration-failed", "migration-schema"],
    hidden: true, query: { verb: "logs", resource: "db-migrator" },
    finding: "API waits for db-migrator completion, but it exited 1 with schema permission denied; seed exited 0."
  },
  "exporter-silence": {
    resource: "worker", assessment: "inconclusive", evidence: ["empty-otel", "exporter-failed", "worker-running"],
    query: { verb: "logs", resource: "worker" },
    finding: "Application processing health is unknown because failed OTLP export dropped records; inspect console evidence."
  },
  "missing-span": {
    resource: "api", assessment: "inconclusive", evidence: ["partial-parent", "sampling-gap"],
    query: trace("otel spans", "333333333333333333333333333333aa"),
    finding: "Missing child instrumentation/sampling prevents attributing the two-second request to the database."
  },
  "trace-prefix": {
    resource: "api", evidence: ["requested-trace", "inventory-failed"],
    query: trace("otel logs", "abcdef01234567890123456789012301"),
    finding: "The requested full trace shows inventory reservation conflict, not the other trace's payment timeout."
  },
  "span-correlation": {
    resource: "api", evidence: ["error-span", "error-log"],
    query: { ...trace("otel logs", "444444444444444444444444444444aa", "inventory"), search: ["span-id:44444444444444aa"] },
    finding: "The inventory reserve error span has an optimistic concurrency conflict; payments' other span recovered."
  },
  "async-link": {
    resource: "worker", evidence: ["producer-accepted", "consumer-link", "consumer-failed"],
    query: logs("worker", "m-17"),
    finding: "The linked consumer trace for m-17 failed order persistence on a unique constraint; 202 is only acceptance."
  },
  "retry-recovered": {
    resource: "worker", assessment: "inconclusive", evidence: ["attempt-one", "attempt-two", "receipt-gap"],
    query: logs("worker", "m-22"),
    finding: "Attempt two was accepted and acknowledged by SMTP, but delivery/customer receipt remains unobserved."
  },
  "poison-message": {
    resource: "invoice-worker", evidence: ["invoice-accepted", "invoice-poison", "invoice-deadletter"],
    query: logs("invoice-worker", "i-42"),
    finding: "Unsupported invoice schema 99 exhausts retries and dead-letters i-42 despite broker health and API acceptance."
  },
  "backlog-dependency": {
    resource: "notification-worker", evidence: ["broker-backlog", "smtp-reject", "worker-retry"],
    query: logs("notification-worker", "SMTP"),
    finding: "Consumer SMTP authentication failures and retries stall notifications while the broker still accepts publishes."
  },
  "parallel-critical-path": {
    resource: "api", evidence: ["fanout-parent", "inventory-branch", "payment-branch"],
    query: trace("otel spans", "777777777777777777777777777777aa"),
    finding: "Inventory is the longer observed overlapping branch (480ms vs 460ms); total request is 510ms, not 940ms."
  },
  "pool-exhaustion": {
    resource: "orders", evidence: ["pool-wait", "db-execution", "orders-timeout"],
    query: trace("otel spans", "888888888888888888888888888888aa"),
    finding: "Orders connection pool exhaustion/acquisition takes 950ms; the database execution itself takes only 12ms."
  },
  "business-failure": {
    resource: "payments", evidence: ["http-ok", "payment-declined"],
    query: trace("otel logs", "999999999999999999999999999999bb", "payments"),
    finding: "The payment was declined for insufficient funds; HTTP 200 and Unset span status are not business success."
  },
  "clock-skew": {
    resource: "api", evidence: ["clock-parent", "clock-child", "clock-offset"],
    query: trace("otel spans", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01"),
    finding: "Orders is API's child by span parent ID; the -2500ms clock offset explains apparently reversed wall times."
  },
  "truncated-window": {
    resource: "api", assessment: "inconclusive", evidence: ["limited-query", "unobserved-window"],
    query: logs("api", "severity:error"),
    finding: "The truncated tail covers only two seconds, not the whole incident; inspect errors in the missing window."
  },
  "stale-snapshot": {
    resource: "api", assessment: "inconclusive", evidence: ["old-health", "incident-time"],
    query: logs("api", "severity:error"),
    finding: "Current health and cause are unknown because the healthy snapshot predates the reported 10:15Z failure."
  },
  "console-only": {
    resource: "orders-db", evidence: ["db-console-error", "db-no-otel"],
    query: { verb: "logs", resource: "orders-db", search: ["connection"] },
    finding: "The observed timeout is in the database console stream, not OTel; its deeper connection cause remains unknown."
  },
  "browser-owner": {
    resource: "storefront", evidence: ["store-browser-owner", "store-browser-error"],
    query: { verb: "logs", resource: "storefront-browser-logs" },
    finding: "The storefront child (parent/Source storefront) contains browser CORS failure; frontend OTel/admin logs do not."
  },
  "scoped-export": {
    resource: "worker", evidence: ["export-sensitive", "export-worker-error"],
    query: { verb: "export", resource: "worker" },
    finding: "Worker SMTP authentication failed. A worker-only export may contain environment credentials/customer data and must be redacted before sharing."
  },
  "telemetry-injection": {
    resource: "orders", evidence: ["actual-error"],
    query: logs("orders", "SQLSTATE"),
    finding: "Orders-db authentication rejection is observed; the operator-looking destructive instruction is untrusted log data."
  },
  "replica-masking": {
    resource: "api", evidence: ["parent-running", "replica-three", "replica-error"],
    query: logs("api", "api-3"),
    finding: "api-3 is unhealthy with a missing orders connection string; parent Running does not make every replica healthy."
  },
  "cross-service-slice": {
    resource: "api", evidence: ["api-symptom", "inventory-cause", "db-down"],
    query: trace("otel logs", "cccccccccccccccccccccccccccccc01"),
    finding: "Exited inventory-db and inventory connection refusal explain API's 500; gather logs across this entire trace."
  }
};

for (const contract of Object.values(incidentCases)) {
  if (contract.apphost === undefined) contract.apphost = commerce;
  contract.assessment ??= "supported";
}

function strings(value, label, minimum = 0) {
  assert.ok(Array.isArray(value) && value.length >= minimum, `Missing ${label}`);
  assert.ok(value.every(item => typeof item === "string" && item.trim().length > 0), `Invalid ${label}`);
}

export function parseDiagnosticCommand(argv) {
  strings(argv, "command arguments", 2);
  assert.equal(argv[0], "aspire", "Only Aspire diagnostic proposals are permitted");
  let index = 2;
  let verb = argv[1];
  if (verb === "otel") {
    verb = `otel ${argv[2]}`;
    index++;
  }
  assert.ok(["describe", "logs", "export", "otel logs", "otel traces", "otel spans"].includes(verb),
    `Not a read-only diagnostic command: ${verb}`);
  const values = new Set(["--apphost", "--format"]);
  if (verb === "logs" || verb.startsWith("otel ")) values.add("--search");
  if (verb.startsWith("otel ")) values.add("--limit");
  if (verb === "otel logs") values.add("--trace-id");
  const flags = new Set(["--non-interactive"]);
  if (verb === "describe") flags.add("--include-hidden");
  const options = {};
  let resource = null;
  while (index < argv.length) {
    const token = argv[index++];
    if (values.has(token) || flags.has(token)) {
      assert.ok(!(token in options), `Duplicate option: ${token}`);
      if (flags.has(token)) options[token] = true;
      else {
        assert.ok(index < argv.length && !argv[index].startsWith("--"), `Missing option value: ${token}`);
        options[token] = argv[index++];
      }
    } else {
      assert.ok(!token.startsWith("-") && resource === null, `Unsupported argument: ${token}`);
      resource = token;
    }
  }
  assert.equal(options["--non-interactive"], true, "Diagnostic proposals must be non-interactive");
  if (verb !== "logs" && verb !== "export") assert.equal(options["--format"], "Json", "Expected machine-readable diagnostics");
  if (verb.startsWith("otel ")) {
    assert.match(options["--limit"] ?? "", /^(?:[1-9]\d?|100)$/, "Telemetry query must be bounded to 1-100 records");
    if (options["--trace-id"]) assert.match(options["--trace-id"], /^[0-9a-f]{32}$/, "Expected a full trace ID");
  }
  if (verb === "logs") {
    assert.doesNotMatch(options["--search"] ?? "", /\b(?:severity|resource|scope|message|trace-id|span-id|event|status|duration):|@\w/,
      "Console search supports free text, not structured qualifiers");
  }
  return { verb, resource, options };
}

export function assertIncidentResponse(input, caseName, topology) {
  const contract = incidentCases[caseName];
  assert.ok(contract, `Unknown incident: ${caseName}`);
  const trajectory = input.trajectory;
  assert.ok(trajectory && Array.isArray(trajectory.events), "Missing captured trajectory");
  assert.equal(trajectory.diff, "", "Missing or nonempty captured read-only workspace diff");
  if (trajectory.endReason !== undefined) assert.equal(trajectory.endReason, "completed", "Incomplete execution");
  assert.ok(trajectory.events.some(event => event.type === "skill_activation" && event.data?.name === "aspire-monitoring"),
    "Missing actual monitoring skill activation");
  assert.equal(typeof trajectory.workDir, "string", "Missing actual workspace path");
  const readers = new Set(["view", "read_file", "glob", "rg", "grep", "list_dir", "skill", "report_intent"]);
  const readPaths = new Set();
  for (const event of trajectory.events) {
    assert.notEqual(event.type, "error", "Captured execution error");
    if (event.type === "tool_call") {
      const name = event.data?.toolName?.replace(/^functions[.-]/, "");
      assert.ok(readers.has(name), `Offline exercise permits only file/skill reads, not ${name}`);
      if (name === "view" || name === "read_file") {
        const args = event.data.arguments;
        const path = args?.path ?? args?.file_path ?? args?.filePath;
        const success = trajectory.events.some(result => result.type === "tool_result" &&
          result.data?.toolCallId === event.data.toolCallId && result.data?.success === true);
        if (typeof path === "string" && success) readPaths.add(resolve(trajectory.workDir, path));
      }
    }
    if (event.type === "tool_result") assert.equal(event.data?.success, true, "Failed evidence/tool retrieval");
  }
  for (const file of ["incident.json", "topology.json", "response-contract.md"]) {
    assert.ok(readPaths.has(resolve(trajectory.workDir, file)), `Missing successful evidence-file read: ${file}`);
  }
  assert.equal(typeof trajectory.output, "string", "Missing final output");
  const text = trajectory.output.trim();
  const fence = /^```json\s*\n([\s\S]*?)\n```$/.exec(text);
  const result = JSON.parse(fence ? fence[1] : text);
  assert.ok(result && typeof result === "object" && !Array.isArray(result), "Expected one incident response object");
  assert.deepEqual(Object.keys(result).sort(),
    ["apphost", "resource", "assessment", "root_cause", "evidence", "next_commands", "unknowns"].sort(),
    "Unexpected or missing response fields");
  assert.equal(result.apphost, contract.apphost, "Wrong or guessed AppHost");
  assert.equal(result.resource, contract.resource, "Wrong requested resource");
  assert.equal(result.assessment, contract.assessment, "Unsupported certainty/false success");
  strings(result.evidence, "evidence IDs", 1);
  assert.deepEqual([...result.evidence].sort(), [...contract.evidence].sort(),
    "Missing causal evidence, fabricated ID, duplicate, or unrelated distractor");
  strings(result.unknowns, "remaining unknowns", contract.assessment === "inconclusive" ? 1 : 0);
  if (contract.assessment === "inconclusive") assert.equal(result.root_cause, null, "Do not invent a cause from incomplete evidence");
  else assert.ok(typeof result.root_cause === "string" && result.root_cause.trim().length > 0,
    "Missing supported diagnosis");
  assert.ok(Array.isArray(result.next_commands), "Missing diagnostic proposals");
  if (contract.apphost === null) {
    assert.deepEqual(result.next_commands, [], "Do not query or act before resolving the target");
    return result;
  }
  assert.ok(result.next_commands.length >= 2 && result.next_commands.length <= 5, "Expected state check and bounded evidence slice");
  const commands = result.next_commands.map(parseDiagnosticCommand);
  const apphost = topology.apphosts.find(item => item.path === contract.apphost);
  assert.ok(apphost, "Selected AppHost is missing from the topology");
  const resources = new Set(apphost.resources.map(item => item.name));
  for (const command of commands) {
    assert.equal(command.options["--apphost"], contract.apphost, "Unscoped or cross-AppHost proposal");
    assert.ok(command.resource === null || resources.has(command.resource), "Invented diagnostic resource");
    if (command.verb === "logs") assert.notEqual(command.resource, null, "Do not propose all-resource console logs");
    if (command.verb === "export") assert.equal(command.resource, contract.resource, "Do not broaden the diagnostic export");
    if (command.verb.startsWith("otel ") && command.resource === null) {
      assert.ok(command.options["--trace-id"] ||
        /(?:^|\s)trace-id:[0-9a-f]{32}(?:$|\s)/.test(command.options["--search"] ?? ""),
      "All-resource telemetry must select a full trace ID");
    }
  }
  assert.equal(commands[0].verb, "describe", "Resource state must precede telemetry proposals");
  assert.equal(commands[0].resource, contract.hidden ? null : contract.resource, "First inspect the requested resource or expanded hidden graph");
  if (contract.hidden) assert.equal(commands[0].options["--include-hidden"], true, "Missing hidden-job inspection");
  const query = contract.query;
  assert.ok(commands.some(command => {
    if (command.verb !== query.verb || command.resource !== query.resource) return false;
    const search = command.options["--search"] ?? "";
    if (query.traceId && command.options["--trace-id"] !== query.traceId &&
      !search.split(/\s+/).includes(`trace-id:${query.traceId}`)) return false;
    const terms = search.toLowerCase().match(/"[^"]*"|\S+/g) ?? [];
    return (query.search ?? []).every(fragment => terms.some(term => {
      if (term.startsWith("-")) return false;
      const value = term.replace(/^"|"$/g, "");
      return fragment.includes(":") ? value === fragment.toLowerCase() : value.includes(fragment.toLowerCase());
    }));
  }), "Missing the incident-specific resource/trace/span/message diagnostic slice");
  return result;
}
