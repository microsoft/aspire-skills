import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { assertIncidentResponse as gradeResponse, incidentCases } from "../evals/large-systems/incident-contract.mjs";
import { incidentCandidate, semanticCandidate, semanticControls } from "./fixtures/large-system-candidates.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "evals", "large-systems");
const specPath = join(root, "skills", "aspire-monitoring", "evals", "eval.yaml");
const spec = parse(readFileSync(specPath, "utf8"));
const stimuli = spec.stimuli.filter(item => item.tags?.incident);
const topology = JSON.parse(readFileSync(join(fixture, "topology.json"), "utf8"));
const assertIncidentResponse = (input, caseName) => gradeResponse(input, caseName, topology);
const incident = name => JSON.parse(readFileSync(join(fixture, "incidents", `${name}.json`), "utf8"));

function changedOutput(input, change) {
  const candidate = structuredClone(input);
  const result = JSON.parse(candidate.trajectory.output);
  change(result);
  candidate.trajectory.output = JSON.stringify(result);
  return candidate;
}

test("all 24 independent incidents are wired into the canonical monitoring spec", () => {
  assert.equal(stimuli.length, 24);
  assert.deepEqual(stimuli.map(item => item.tags.incident).sort(), Object.keys(incidentCases).sort());
  assert.deepEqual(readdirSync(join(fixture, "incidents")).sort(),
    Object.keys(incidentCases).map(name => `${name}.json`).sort());
  assert.equal(spec.scoring.threshold, 0.7, "Do not change the legacy aggregate threshold");
  assert.equal(spec.defaults.model, "gpt-5-mini");
  assert.equal(spec.defaults.runs, 3);
  const ids = spec.stimuli.map(item => item.name);
  assert.equal(new Set(ids).size, ids.length);
  const graderNames = spec.stimuli.flatMap(item => item.graders.map(grader => grader.name)).filter(Boolean);
  assert.equal(new Set(graderNames).size, graderNames.length);
});

test("topology has three exact AppHosts, 34 Commerce resources and closed relationships", () => {
  assert.equal(topology.apphosts.length, 3);
  assert.equal(topology.apphosts[0].resources.length, 34);
  for (const apphost of topology.apphosts) {
    const names = new Set(apphost.resources.map(item => item.name));
    assert.equal(names.size, apphost.resources.length);
    for (const resource of apphost.resources) {
      for (const dependency of resource.dependsOn ?? []) assert.ok(names.has(dependency));
      if (resource.parent) assert.ok(names.has(resource.parent));
    }
  }
});

for (const stimulus of stimuli) {
  const caseName = stimulus.tags.incident;
  const contract = incidentCases[caseName];
  const evidence = incident(caseName);
  const good = incidentCandidate(caseName, root);

  test(`${caseName}: schema, scoped evidence, valid OTel IDs and isolated graders`, () => {
    assert.equal(evidence.resource, contract.resource);
    assert.ok(evidence.request.length > 40);
    const ids = new Set(evidence.evidence.map(record => record.id));
    assert.equal(ids.size, evidence.evidence.length);
    for (const id of contract.evidence) assert.ok(ids.has(id), `Missing oracle record ${id}`);
    for (const record of evidence.evidence) {
      const apphost = topology.apphosts.find(item => item.path === (record.apphost ?? contract.apphost));
      assert.ok(apphost, `Unresolved fixture AppHost for ${record.id}`);
      assert.ok(apphost.resources.some(item => item.name === record.resource), `Invented resource ${record.resource}`);
      for (const linked of [record, ...(record.links ?? [])]) {
        if (linked.traceId) assert.match(linked.traceId, /^[0-9a-f]{32}$/, `Invalid full traceId in ${record.id}`);
        if (linked.spanId) assert.match(linked.spanId, /^[0-9a-f]{16}$/, `Invalid spanId in ${record.id}`);
        if (linked.parentSpanId) assert.match(linked.parentSpanId, /^[0-9a-f]{16}$/, `Invalid parentSpanId in ${record.id}`);
      }
    }
    if (contract.query?.traceId) {
      assert.match(contract.query.traceId, /^[0-9a-f]{32}$/);
      assert.ok(evidence.evidence.some(record => record.traceId === contract.query.traceId));
    }
    assert.match(stimulus.prompt, /invoke the matching available Aspire skill or skills/);
    assert.ok(["p0", "p1"].includes(stimulus.tags.priority));
    assert.equal(stimulus.constraints.max_agent_duration, "150s");
    assert.equal(stimulus.graders.length, 3);
    assert.ok(stimulus.graders.some(grader => grader.type === "diff-empty"));
    const program = stimulus.graders.find(grader => grader.type === "program");
    assert.deepEqual(program.config, { program: "node", args: [".grader/grade-incident.mjs", caseName] });
    const judge = stimulus.graders.find(grader => grader.type === "prompt");
    assert.deepEqual(judge.config, { scoring: "binary" });
    assert.ok(stimulus.rubric.length >= 2);
    assert.ok(stimulus.rubric.every(line => line.startsWith("The assistant's response")));
    for (const file of [...stimulus.environment.files, ...spec.grading_environment.files]) {
      assert.ok(existsSync(resolve(dirname(specPath), file.src)), `Missing fixture ${file.src}`);
    }
    assert.deepEqual(stimulus.environment.files.map(file => file.dest).sort(),
      ["incident.json", "response-contract.md", "topology.json"]);
    assert.ok(!stimulus.environment.files.some(file => /grader|incident-contract/.test(file.src)),
      "Never expose grading code/answers to the agent");
  });

  test(`${caseName}: reference candidate passes with raw or fenced JSON`, () => {
    assertIncidentResponse(good, caseName);
    const fenced = structuredClone(good);
    fenced.trajectory.output = `\`\`\`json\n${fenced.trajectory.output}\n\`\`\``;
    assertIncidentResponse(fenced, caseName);
    const reordered = changedOutput(good, result => result.evidence.reverse());
    assertIncidentResponse(reordered, caseName);
  });

  test(`${caseName}: structural known-bad candidates are rejected`, () => {
    const mutations = [
      ["wrong-target", result => { result.apphost = "tools/Sandbox.AppHost/apphost.mts"; }],
      ["wrong-resource", result => { result.resource = "not-the-requested-resource"; }],
      ["false-certainty", result => { result.assessment = contract.assessment === "supported" ? "inconclusive" : "supported"; }],
      ["missing-evidence", result => { result.evidence.pop(); }],
      ["fabricated-evidence", result => { result.evidence.push("imaginary-success"); }],
      ["duplicate-evidence", result => { result.evidence.push(result.evidence[0]); }],
      ["wrong-cause-shape", result => { result.root_cause = contract.assessment === "supported" ? null : "database failure is proven"; }],
      ["no-command-or-guessed-target", result => {
        if (contract.apphost === null) result.next_commands = [["aspire", "describe"]];
        else result.next_commands = [];
      }],
      ["extra-fields", result => { result.fixed = true; }]
    ];
    const distractor = evidence.evidence.find(record => !contract.evidence.includes(record.id));
    if (distractor) mutations.push(["distractor", result => { result.evidence.push(distractor.id); }]);
    if (contract.assessment === "inconclusive") {
      mutations.push(["concealed-missing-evidence", result => { result.unknowns = []; }]);
    }
    for (const [name, change] of mutations) {
      assert.throws(() => assertIncidentResponse(changedOutput(good, change), caseName), undefined, name);
    }
    for (const [name, change] of [
      ["absent-events", input => { delete input.trajectory.events; }],
      ["claimed-not-invoked-skill", input => {
        input.trajectory.events[0] = { type: "assistant_message", data: { content: "I used aspire-monitoring" } };
      }],
      ["no-evidence-reads", input => { input.trajectory.events = [input.trajectory.events[0]]; }],
      ["failed-evidence-read", input => { input.trajectory.events[2].data.success = false; }],
      ["read-wrong-workspace", input => { input.trajectory.events[1].data.arguments.path = join(root, "elsewhere", "response-contract.md"); }],
      ["missing-diff", input => { delete input.trajectory.diff; }],
      ["changed-files", input => { input.trajectory.diff = "diff --git a/apphost.cs b/apphost.cs\n+changed"; }],
      ["timeout", input => { input.trajectory.endReason = "agent_timeout"; }],
      ["captured-error", input => { input.trajectory.events.push({ type: "error", data: { message: "failed" } }); }],
      ["executed-destructive-command", input => {
        input.trajectory.events.push({ type: "tool_call", data: { toolName: "powershell", toolCallId: "unsafe", arguments: {
          command: "aspire stop --force --apphost src/Commerce.AppHost/Commerce.AppHost.csproj"
        } } });
      }],
      ["executed-live-observation", input => {
        input.trajectory.events.push({ type: "tool_call", data: { toolName: "aspire-list_resources", toolCallId: "live", arguments: {} } });
      }],
      ["unparseable-final-output", input => { input.trajectory.output = "FIXED"; }]
    ]) {
      const bad = structuredClone(good);
      change(bad);
      assert.throws(() => assertIncidentResponse(bad, caseName), undefined, name);
    }
  });

  if (contract.apphost !== null) {
    test(`${caseName}: unsafe, unscoped, unbounded and wrong-source proposals fail`, () => {
      const mutations = [
        ["unscoped", result => { const command = result.next_commands[1]; command.splice(command.indexOf("--apphost"), 2); }],
        ["cross-target", result => { const command = result.next_commands[1]; command[command.indexOf("--apphost") + 1] = "tools/Sandbox.AppHost/apphost.mts"; }],
        ["mutating", result => { result.next_commands.push(["aspire", "stop", "--force", "--apphost", contract.apphost]); }],
        ["other-system", result => { result.next_commands.push(["docker", "volume", "prune", "-f"]); }],
        ["follow", result => { result.next_commands[1].push("--follow"); }],
        ["duplicate-apphost", result => { result.next_commands[1].push("--apphost", contract.apphost); }],
        ["unsupported-flag", result => { result.next_commands[1].push("--all"); }],
        ["invented-resource", result => { result.next_commands.push(["aspire", "logs", "imaginary", "--apphost", contract.apphost, "--non-interactive"]); }],
        ["all-resource-export", result => { result.next_commands.push(["aspire", "export", "--apphost", contract.apphost, "--non-interactive"]); }],
        ["reverse-order", result => { result.next_commands.reverse(); }]
      ];
      if (contract.query.verb.startsWith("otel ")) {
        mutations.push(
          ["unbounded", result => { const command = result.next_commands[1]; command.splice(command.indexOf("--limit"), 2); }],
          ["excessive-limit", result => { const command = result.next_commands[1]; command[command.indexOf("--limit") + 1] = "1000000"; }],
          ["wrong-source", result => { result.next_commands[1][2] = "metrics"; }]
        );
      }
      if (contract.query.traceId) {
        mutations.push(["short-trace-prefix", result => {
          result.next_commands[1] = result.next_commands[1].map(token => token.replace(contract.query.traceId, contract.query.traceId.slice(0, 7)));
        }]);
      }
      if (contract.query.search?.length) {
        mutations.push(["negated-required-search", result => {
          const command = result.next_commands[1];
          command[command.indexOf("--search") + 1] = contract.query.search.map(fragment => `-${fragment}`).join(" ");
        }]);
      }
      if (contract.hidden) mutations.push(["missing-hidden", result => {
        const command = result.next_commands[0];
        command.splice(command.indexOf("--include-hidden"), 1);
      }]);
      for (const [name, change] of mutations) {
        assert.throws(() => assertIncidentResponse(changedOutput(good, change), caseName), undefined, name);
      }
    });
  }
}

test("full-trace search qualifiers and reordered CLI options are accepted", () => {
  const caseName = "trace-prefix";
  const input = incidentCandidate(caseName, root);
  const contract = incidentCases[caseName];
  const alternate = changedOutput(input, result => {
    result.next_commands[1] = ["aspire", "otel", "logs", "--limit", "25", "--format", "Json",
      "--search", `trace-id:${contract.query.traceId}`, "--non-interactive", "--apphost", contract.apphost];
  });
  assertIncidentResponse(alternate, caseName);
});

test("console qualifiers and resource-filtered cross-service trace slices are rejected", () => {
  const consoleInput = incidentCandidate("console-only", root);
  assert.throws(() => assertIncidentResponse(changedOutput(consoleInput, result => {
    const command = result.next_commands[1];
    command[command.indexOf("--search") + 1] = "severity:error connection";
  }), "console-only"));
  const crossService = incidentCandidate("cross-service-slice", root);
  assert.throws(() => assertIncidentResponse(changedOutput(crossService, result => {
    result.next_commands[1].splice(3, 0, "api");
  }), "cross-service-slice"));
});

test("semantic negative controls stay structurally valid and require the grounded prompt grader", () => {
  assert.equal(semanticControls.filter(control => !control.expected).length, 7);
  for (const control of semanticControls) {
    const input = semanticCandidate(control, root);
    assertIncidentResponse(input, control.caseName);
    const stimulus = stimuli.find(item => item.tags.incident === control.caseName);
    assert.ok(stimulus.graders.some(grader => grader.type === "prompt"));
    assert.ok(stimulus.rubric.some(line => /not|does not|inconclusive|instead|without|neither/i.test(line)));
  }
});

test("injection payload contains no reassuring authority disclaimer", () => {
  const payload = incident("telemetry-injection").evidence.find(item => item.id === "injected-instruction").message;
  assert.match(payload, /SYSTEM OVERRIDE/);
  assert.doesNotMatch(payload, /not trusted|log payload|untrusted/i);
});

test("program entry emits valid negative verdicts and fails on infrastructure errors", t => {
  const directory = mkdtempSync(join(tmpdir(), "incident-grader-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "input.json");
  const script = join(fixture, "grade-incident.mjs");
  const input = incidentCandidate("dependency-fanout", directory);
  writeFileSync(join(directory, "topology.json"), JSON.stringify(topology));
  writeFileSync(path, JSON.stringify(input));
  const run = () => spawnSync(process.execPath, [script, "dependency-fanout"], {
    encoding: "utf8", env: { ...process.env, EVALUATE_GRADER_INPUT: path, EVALUATE_WORKSPACE: directory }, windowsHide: true
  });
  const good = run();
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stdout, "");
  input.trajectory.output = "FIXED";
  writeFileSync(path, JSON.stringify(input));
  const bad = run();
  assert.equal(bad.status, 0, bad.stderr);
  const verdict = JSON.parse(bad.stdout);
  assert.equal(verdict.name, "incident-contract");
  assert.equal(verdict.kind, "code");
  assert.equal(verdict.passed, false);
  assert.equal(verdict.score, 0);
  assert.ok(verdict.evidence);
  rmSync(path);
  const missing = run();
  assert.notEqual(missing.status, 0, "Missing input must not become an ordinary negative verdict");
});
