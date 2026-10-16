import { readFileSync } from "node:fs";
import { join } from "node:path";
import { incidentCases } from "../../evals/large-systems/incident-contract.mjs";

export function incidentSources(caseName) {
  return Object.fromEntries(["response-contract.md", "topology.json", "incident.json"]
    .map(file => [file, readFileSync(new URL(file === "incident.json"
      ? `../../evals/large-systems/incidents/${caseName}.json`
      : `../../evals/large-systems/${file}`, import.meta.url), "utf8")]));
}

export function incidentCandidate(caseName, workDir) {
  const contract = incidentCases[caseName];
  const scope = ["--apphost", contract.apphost, "--non-interactive"];
  const next = [];
  if (contract.apphost !== null) {
    next.push(["aspire", "describe", ...(contract.hidden ? ["--include-hidden"] : [contract.resource]),
      ...scope, "--format", "Json"]);
    const query = contract.query;
    const command = ["aspire", ...query.verb.split(" "), ...(query.resource ? [query.resource] : []), ...scope];
    if (query.verb.startsWith("otel ")) command.push("--format", "Json", "--limit", "50");
    const search = [...(query.search ?? [])];
    if (query.traceId) {
      if (query.verb === "otel logs") command.push("--trace-id", query.traceId);
      else search.push(`trace-id:${query.traceId}`);
    }
    if (search.length) command.push("--search", search.join(" "));
    next.push(command);
  }
  const result = {
    apphost: contract.apphost, resource: contract.resource, assessment: contract.assessment,
    root_cause: contract.assessment === "inconclusive" ? null : contract.finding,
    evidence: [...contract.evidence], next_commands: next,
    unknowns: contract.assessment === "inconclusive" ? [contract.finding] : []
  };
  const events = [{ type: "skill_activation", data: { name: "aspire-monitoring" } }];
  const sources = incidentSources(caseName);
  for (const path of ["response-contract.md", "topology.json", "incident.json"]) {
    const toolCallId = `read-${path}`;
    events.push({ type: "tool_call", data: { toolName: "view", toolCallId, arguments: { path: join(workDir, path) } } },
      { type: "tool_result", data: { toolName: "view", toolCallId, success: true, result: { content: sources[path] } } });
  }
  return { trajectory: { events, output: JSON.stringify(result), diff: "", workDir, endReason: "completed" } };
}

// These deliberately retain valid IDs, reads and commands. Only the real
// rubric-backed prompt grader can reject their incorrect semantic conclusions.
export const semanticControls = [
  { name: "positive-causal-chain", caseName: "dependency-fanout", expected: true },
  { name: "positive-missing-coverage", caseName: "missing-span", expected: true },
  {
    name: "positive-paraphrased-cause", caseName: "dependency-fanout", expected: true,
    change: { root_cause: "The database rejected the orders application's password. That failure reached orders, then API, then gateway, causing storefront's 502. The cache miss and separate search-worker trace are unrelated; the reason credentials differ and whether recovery occurred are not established." }
  },
  {
    name: "false-recovery", caseName: "dependency-fanout", expected: false,
    change: { root_cause: "Everything is healthy and the issue was fixed; no authentication failure occurred." }
  },
  {
    name: "inverted-causality", caseName: "pool-exhaustion", expected: false,
    change: { root_cause: "The database query execution takes 950ms and proves a server outage; connection acquisition takes only 12ms." }
  },
  {
    name: "fabricated-percentile", caseName: "parallel-critical-path", expected: false,
    change: { root_cause: "Inventory p99 is confirmed as 480ms over all requests. Payments are the bottleneck because its 1000 logs show 940ms total latency." }
  },
  {
    name: "concealed-uncertainty", caseName: "missing-span", expected: false,
    change: { unknowns: ["Nothing is unknown. The missing database span proves orders-db is healthy and cannot be involved."] }
  },
  {
    name: "unproven-delivery", caseName: "retry-recovered", expected: false,
    change: { unknowns: ["The SMTP acknowledgment proves the customer's receipt was delivered. The incident is fully resolved with no missing evidence."] }
  },
  {
    name: "invented-async-parent", caseName: "async-link", expected: false,
    change: { root_cause: "The consumer has producer span 55555555555555aa as its parentSpanId in the same producer trace. HTTP 202 proves persistence succeeded." }
  },
  {
    name: "unsafe-sharing-claim", caseName: "scoped-export", expected: false,
    change: { root_cause: "The export already succeeded and was uploaded. No redaction is needed because Aspire export never contains environment credentials or customer data." }
  },
  {
    name: "cross-apphost-context-as-cause", caseName: "target-collision", expected: false,
    change: {
      evidence: ["analytics-latency", "analytics-worker", "commerce-auth"],
      root_cause: "Commerce orders-db authentication is the proven cause of the Analytics API latency. The Analytics worker timeout is unrelated."
    }
  },
  {
    name: "successful-job-context-as-failure", caseName: "hidden-migrator", expected: false,
    change: {
      evidence: ["api-wait", "migration-failed", "migration-schema", "seed-complete"],
      root_cause: "The seed job's exit code 0 proves it failed and blocks API. The migrator exit code 1 means it completed successfully."
    }
  },
  {
    name: "running-context-as-healthy", caseName: "exporter-silence", expected: false,
    change: {
      evidence: ["empty-otel", "exporter-failed", "worker-running"],
      unknowns: ["Running proves worker is healthy; zero OTel errors prove processing succeeded despite dropped exports. There is no missing application evidence."]
    }
  }
];

export function semanticCandidate(control, workDir) {
  const input = incidentCandidate(control.caseName, workDir);
  const result = JSON.parse(input.trajectory.output);
  Object.assign(result, control.change);
  input.trajectory.output = JSON.stringify(result);
  return input;
}
