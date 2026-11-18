import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const upstream = { owner: "microsoft", repo: "aspire" };
export const destination = { repository: "microsoft/aspire-skills", branch: "dev" };
export const limits = Object.freeze({
  windowHours: 48, maximumHours: 168, pulls: 100, candidates: 5, files: 100,
  sourceFiles: 6, testFiles: 4, fileBytes: 48 * 1024, evidenceBytes: 256 * 1024,
  bodyBytes: 16 * 1024, patchBytes: 128 * 1024, documents: 100,
  documentBytes: 64 * 1024, contextBytes: 1024 * 1024, selectedDocuments: 6,
  edits: 3, responseBytes: 128 * 1024, stateEntries: 2000
});
const hour = 3600 * 1000;
const shaPattern = /^[a-f0-9]{40}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

class PolicyError extends Error {}
class ModelResponseSyntaxError extends SyntaxError {}

function requireValue(condition, message) {
  if (!condition) throw new PolicyError(message);
}

function boundedText(value, maximum, field, empty = false) {
  requireValue(typeof value === "string" && (empty || value.trim().length > 0) &&
    Buffer.byteLength(value) <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
  `Invalid or oversized ${field}.`);
  return value;
}

export function immutableSha(value) {
  requireValue(typeof value === "string" && shaPattern.test(value), "Expected an immutable source SHA.");
  return value;
}

function number(value) {
  requireValue(typeof value === "string" && /^[1-9]\d{0,8}$/.test(value), "pr_number must be a positive integer.");
  return Number(value);
}

export function eligibleBranch(value) {
  return value === "main" || (typeof value === "string" && value.length <= 120 &&
    /^release\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value) &&
    value.split("/").every(part => part && part !== "." && part !== ".."));
}

export function safeSourcePath(value) {
  return typeof value === "string" && value.length <= 240 &&
    /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(value) &&
    value.split("/").every(part => part && part !== "." && part !== "..");
}

export function safeSkillPath(value) {
  return safeSourcePath(value) &&
    value.split("/").every(part => !part.startsWith(".")) &&
    /^skills\/[a-z][a-z0-9-]*\/(?:SKILL\.md|references\/[a-zA-Z0-9_./-]+\.md)$/.test(value);
}

export function relevantPath(value) {
  return safeSourcePath(value) &&
    /^src\/Aspire\.(?:Cli|Hosting(?:\.[a-zA-Z0-9_-]+)*|AppHost\.Sdk)\//.test(value) &&
    /\.(?:cs|ts|json|txt|props|targets)$/.test(value);
}

function testPath(value) {
  return safeSourcePath(value) && /^tests\//.test(value) && /\.(?:cs|ts|txt|json)$/.test(value);
}

function timestamp(value) {
  requireValue(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().replace(".000Z", "Z") === value, "Use a real UTC timestamp, YYYY-MM-DDTHH:mm:ssZ.");
  return Date.parse(value);
}

export function assessmentWindow(inputs = {}, now = new Date()) {
  const end = Math.floor(new Date(now).getTime() / 1000) * 1000;
  requireValue(Number.isFinite(end), "Invalid assessment clock.");
  if (inputs.pr_number) {
    requireValue(!inputs.since && !inputs.until, "Use pr_number OR a bounded time window.");
    return { number: number(inputs.pr_number), since: null, until: new Date(end).toISOString() };
  }
  requireValue(Boolean(inputs.since) === Boolean(inputs.until), "Supply both since and until.");
  const until = inputs.until ? timestamp(inputs.until) : end;
  const since = inputs.since ? timestamp(inputs.since) : until - limits.windowHours * hour;
  requireValue(since < until && until <= end && until - since <= limits.maximumHours * hour,
    "The window must be in the past, nonempty, and at most seven days.");
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}

export function sourceIdentity(pr) {
  const prNumber = number(String(pr.number));
  requireValue(pr.merged === true && pr.state === "closed", "Only merged upstream PRs are eligible.");
  requireValue(pr.base?.repo?.full_name === "microsoft/aspire" && eligibleBranch(pr.base.ref),
    "The source must target microsoft/aspire main or release/*.");
  const merge = immutableSha(pr.merge_commit_sha);
  const base = immutableSha(pr.base.sha);
  const head = immutableSha(pr.head?.sha);
  const mergedAt = new Date(timestamp(pr.merged_at)).toISOString();
  const key = createHash("sha256").update(`microsoft/aspire#${prNumber}:${merge}:${pr.base.ref}`).digest("hex");
  return {
    key, repository: "microsoft/aspire", number: prNumber, merge, base, head, mergedAt,
    branch: pr.base.ref, url: `https://github.com/microsoft/aspire/pull/${prNumber}`,
    release: pr.base.ref === "main"
      ? "main: unreleased; shipping version unconfirmed"
      : `${pr.base.ref}: release branch; publication and shipping version unconfirmed`
  };
}

export function validateState(value, now = new Date()) {
  requireValue(value?.schema === 1 && Array.isArray(value.entries) &&
    value.entries.length <= limits.stateEntries, "Invalid assessment state.");
  const cutoff = new Date(now).getTime() - 14 * 24 * hour;
  const entries = new Map();
  for (const entry of value.entries) {
    requireValue(entry && /^[a-f0-9]{64}$/.test(entry.key) &&
      ["noop", "triage", "draft"].includes(entry.status) &&
      Number.isFinite(Date.parse(entry.mergedAt)) &&
      Number.isFinite(Date.parse(entry.assessedAt)) &&
      Date.parse(entry.assessedAt) <= new Date(now).getTime(), "Invalid assessment state entry.");
    const previous = entries.get(entry.key);
    if (Date.parse(entry.assessedAt) >= cutoff &&
        (!previous || Date.parse(entry.assessedAt) > Date.parse(previous.assessedAt))) {
      entries.set(entry.key, {
        key: entry.key, status: entry.status, mergedAt: entry.mergedAt, assessedAt: entry.assessedAt
      });
    }
  }
  return { schema: 1, entries: [...entries.values()] };
}

export function mergeStates(states, now = new Date()) {
  const entries = new Map();
  for (const state of states) {
    for (const entry of validateState(state, now).entries) {
      const previous = entries.get(entry.key);
      if (!previous || Date.parse(entry.assessedAt) > Date.parse(previous.assessedAt)) entries.set(entry.key, entry);
    }
  }
  requireValue(entries.size <= limits.stateEntries, "Merged assessment state exceeds capacity.");
  return { schema: 1, entries: [...entries.values()] };
}

export async function selectStateRuns(github, context) {
  const repo = context.repo;
  const hasState = async run_id => {
    const { data } = await github.rest.actions.listWorkflowRunArtifacts({ ...repo, run_id, per_page: 100 });
    return data.artifacts.some(artifact => artifact.name === "upstream-assessment-state" && !artifact.expired);
  };
  const previous = await hasState(context.runId) ? String(context.runId) : "";
  // Never let an old attempt short-circuit newer successful-run state.
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...repo, workflow_id: "upstream-skill-assessment.yml",
    branch: context.payload.repository.default_branch, status: "success", per_page: 20
  });
  const eligible = data.workflow_runs.filter(run =>
    run.id !== context.runId && run.head_branch === context.payload.repository.default_branch &&
    run.conclusion === "success" && ["schedule", "workflow_dispatch"].includes(run.event)
  ).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.id - a.id);
  for (const run of eligible) {
    if (await hasState(run.id)) return { previous, latest: String(run.id) };
  }
  return { previous, latest: "" };
}

export function readJson(path, maximum = 4 * 1024 * 1024) {
  const stat = lstatSync(path);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum, "Invalid JSON artifact.");
  return JSON.parse(decoder.decode(readFileSync(path)));
}

export async function discoverPulls(github, window) {
  if (window.number) return [window.number];
  const { data } = await github.rest.search.issuesAndPullRequests({
    q: `repo:microsoft/aspire is:pr is:merged merged:${window.since}..${window.until}`,
    per_page: limits.pulls, page: 1, sort: "created", order: "asc"
  });
  requireValue(data.incomplete_results === false && Number.isSafeInteger(data.total_count) &&
    data.total_count >= 0 && data.total_count <= limits.pulls &&
    Array.isArray(data.items) && data.items.length === data.total_count,
  "Discovery was incomplete or exceeded 100 PRs. Narrow the manual window or select one PR.");
  return [...new Set(data.items.map(item => number(String(item.number))))].sort((a, b) => a - b);
}

export function validatePatch(patch) {
  boundedText(patch, limits.patchBytes, "PR patch");
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let expected;
  let oldLines = 0;
  let newLines = 0;
  let changes = 0;
  const complete = () => expected && oldLines === expected.old && newLines === expected.new;
  for (const line of lines) {
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/.exec(line);
    if (header) {
      requireValue(!expected || complete(), "Incomplete PR patch hunk.");
      expected = { old: Number(header[1] ?? 1), new: Number(header[2] ?? 1) };
      requireValue(Number.isSafeInteger(expected.old) && Number.isSafeInteger(expected.new),
        "Malformed PR patch range.");
      oldLines = 0;
      newLines = 0;
    } else {
      requireValue(expected && [" ", "+", "-", "\\"].includes(line[0]), "Malformed PR patch.");
      if (line[0] === "\\") requireValue(line === "\\ No newline at end of file", "Malformed PR patch marker.");
      if (line[0] === " " || line[0] === "-") oldLines++;
      if (line[0] === " " || line[0] === "+") newLines++;
      if (line[0] === "+" || line[0] === "-") changes++;
      requireValue(oldLines <= expected.old && newLines <= expected.new, "PR patch hunk exceeds its range.");
    }
  }
  requireValue(complete() && changes > 0, "Incomplete or empty PR patch.");
  return patch;
}

async function snapshot(github, source, path, kind) {
  const { data } = await github.rest.repos.getContent({
    ...upstream, path, ref: source.merge
  });
  requireValue(data && data.type === "file" && data.path === path && data.encoding === "base64" &&
    Number.isSafeInteger(data.size) && data.size >= 0 && data.size <= limits.fileBytes &&
    typeof data.content === "string" && data.content.length <= limits.fileBytes * 2,
  "Missing, non-file, or oversized authoritative evidence.");
  const encoded = data.content.replace(/\n/g, "");
  requireValue(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded),
    "Malformed base64 evidence.");
  const bytes = Buffer.from(encoded, "base64");
  requireValue(bytes.length === data.size, "Evidence size mismatch.");
  requireValue(isUtf8(bytes), "Authoritative evidence must be valid UTF-8.");
  const content = boundedText(decoder.decode(bytes), limits.fileBytes, "authoritative evidence", true);
  return {
    path, kind, commit: source.merge, blob: immutableSha(data.sha), content,
    digest: createHash("sha256").update(bytes).digest("hex"),
    url: `https://github.com/microsoft/aspire/blob/${source.merge}/${path.split("/").map(encodeURIComponent).join("/")}`
  };
}

export async function collectEvidence(github, pr, source, fullSnapshots = true) {
  boundedText(pr.title, 300, "PR title");
  boundedText(pr.body ?? "", limits.bodyBytes, "PR body", true);
  requireValue(Number.isSafeInteger(pr.changed_files) && pr.changed_files > 0 && pr.changed_files <= limits.files,
    "PR file count exceeds the evidence bound or is invalid.");
  const { data: files } = await github.rest.pulls.listFiles({
    ...upstream, pull_number: source.number, per_page: limits.files, page: 1
  });
  requireValue(Array.isArray(files) && files.length === pr.changed_files &&
    files.every(file => safeSourcePath(file.filename) &&
      (file.previous_filename === undefined || safeSourcePath(file.previous_filename)) &&
      (file.status !== "renamed" || safeSourcePath(file.previous_filename))) &&
    new Set(files.map(file => file.filename)).size === files.length, "Incomplete or malformed PR file evidence.");
  const sources = files.filter(file => relevantPath(file.filename) || relevantPath(file.previous_filename));
  if (!sources.length) return { status: "noop", reason: "No API/CLI source paths changed." };
  requireValue(!sources.some(file => file.status === "renamed" || file.previous_filename !== undefined),
    "Renames touching monitored API/CLI source require human triage.");
  const tests = files.filter(file => testPath(file.filename));
  requireValue(sources.length <= limits.sourceFiles && tests.length <= limits.testFiles,
    "Too many relevant source/test files. Human scoping is required.");
  let patchBytes = 0;
  const selected = [...sources, ...tests];
  const diffs = selected.map(file => {
    requireValue(["added", "modified"].includes(file.status), "Removed or renamed evidence requires human triage.");
    const patch = validatePatch(file.patch);
    patchBytes += Buffer.byteLength(patch);
    requireValue(patchBytes <= limits.patchBytes, "PR patches exceed the evidence bound.");
    return { path: file.filename, status: file.status, patch };
  });
  const evidence = {
    status: "candidate", title: pr.title, body: pr.body ?? "", diffs, snapshots: [],
    releaseEvidence: { branch: source.branch, mergedAt: source.mergedAt, shippingRelease: null }
  };
  return fullSnapshots ? hydrateEvidence(github, source, evidence) : evidence;
}

async function hydrateEvidence(github, source, evidence) {
  const snapshots = [];
  let bytes = 0;
  for (const file of evidence.diffs) {
    const item = await snapshot(github, source, file.path, relevantPath(file.path) ? "source" : "test");
    bytes += Buffer.byteLength(item.content);
    requireValue(bytes <= limits.evidenceBytes, "Authoritative evidence exceeds the total bound.");
    snapshots.push(item);
  }
  return { ...evidence, snapshots };
}

function evidenceFailure(source, error) {
  // Do not put remote error bodies (or credentials) in artifacts.
  if (error instanceof PolicyError) return {
    source, status: "triage", reason: "Evidence could not be collected within policy.", questions: [error.message]
  };
  if (error?.name === "HttpError" && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 &&
      error.response?.status === error.status && error.request?.method === "GET" &&
      typeof error.request.url === "string" && error.request.url.startsWith("https://api.github.com/")) {
    return {
      source, status: "blocked", reason: `GitHub evidence read failed (HTTP ${error.status}). Check access/service availability and retry.`
    };
  }
  throw error;
}

export function skillDocuments(directory) {
  const tracked = execFileSync("git", ["--no-pager", "ls-files", "--stage", "-z", "--", "skills"], {
    cwd: directory, encoding: "utf8", maxBuffer: 2 * limits.contextBytes
  }).split("\0").filter(Boolean);
  const documents = {};
  let bytes = 0;
  for (const entry of tracked) {
    const match = /^(\d+) [a-f0-9]{40} 0\t(.+)$/.exec(entry);
    requireValue(match, "Unmerged or malformed skill index.");
    const [, mode, path] = match;
    if (!safeSkillPath(path)) continue;
    requireValue(mode === "100644", "Skill documents must be regular tracked files.");
    let current = directory;
    for (const part of path.split("/")) {
      current = join(current, part);
      requireValue(!lstatSync(current).isSymbolicLink(), "Symlinked skill paths are not eligible.");
    }
    const stat = lstatSync(current);
    requireValue(stat.isFile() && stat.size <= limits.documentBytes, "Oversized skill document.");
    const content = decoder.decode(readFileSync(current));
    boundedText(content, limits.documentBytes, "skill document");
    bytes += stat.size;
    documents[path] = content;
  }
  requireValue(Object.keys(documents).length > 0 && Object.keys(documents).length <= limits.documents &&
    bytes <= limits.contextBytes, "Skill context exceeds the document bound.");
  return documents;
}

export async function prepareAssessment({
  github, inputs = {}, now = new Date(), stateNow = now, ledger, targetSha, documents, findPublished
}) {
  immutableSha(targetSha);
  const window = assessmentWindow(inputs, now);
  const state = validateState(ledger ?? { schema: 1, entries: [] }, stateNow);
  const seen = new Set(state.entries.filter(entry => entry.status !== "draft").map(entry => entry.key));
  const sources = [];
  const reports = [];
  const replay = inputs.reassess === true || inputs.reassess === "true";
  const numbers = await discoverPulls(github, window);
  for (const pull_number of numbers) {
    const { data: pr } = await github.rest.pulls.get({ ...upstream, pull_number });
    if (pr.base?.repo?.full_name === "microsoft/aspire" && !eligibleBranch(pr.base.ref)) {
      requireValue(!window.number, "The selected PR must target main or release/*.");
      continue;
    }
    const source = sourceIdentity(pr);
    requireValue(source.number === pull_number, "PR identity mismatch.");
    requireValue(Date.parse(source.mergedAt) <= Date.parse(window.until), "PR merged after the frozen window.");
    if (!window.number && Date.parse(source.mergedAt) < Date.parse(window.since)) continue;
    if (seen.has(source.key) && !replay) {
      reports.push({ source, status: "duplicate", reason: "Already assessed; use explicit reassess to revisit." });
      continue;
    }
    try {
      const evidence = await collectEvidence(github, pr, source, false);
      if (evidence.status === "noop") reports.push({ source, ...evidence });
      else sources.push({ source, evidence });
    } catch (error) {
      reports.push(evidenceFailure(source, error));
    }
  }
  if (sources.length > limits.candidates) {
    for (const { source } of sources.splice(0)) reports.push({
      source, status: "blocked", reason: "More than five relevant PRs. Narrow the window or select one PR."
    });
  } else {
    for (let index = sources.length - 1; index >= 0; index--) {
      const candidate = sources[index];
      const published = findPublished ? await findPublished(candidate.source) : null;
      if (published) {
        reports.push({
          source: candidate.source, status: "duplicate",
          reason: "An open or closed source proposal already exists.", proposal: published
        });
        sources.splice(index, 1);
        continue;
      }
      try {
        candidate.evidence = await hydrateEvidence(github, candidate.source, candidate.evidence);
      } catch (error) {
        reports.push(evidenceFailure(candidate.source, error));
        sources.splice(index, 1);
      }
    }
  }
  return {
    schema: 1, scope: "assessment", assessedAt: new Date(stateNow).toISOString(),
    window, target: { ...destination, sha: targetSha },
    sources, documents, reports, state
  };
}

export function parseResponse(content) {
  const text = boundedText(content, limits.responseBytes, "model response");
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ModelResponseSyntaxError("The model response is not valid JSON.");
    throw error;
  }
}

function keys(value, expected) {
  requireValue(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === expected.slice().sort().join(","), "Unexpected assessment fields.");
}

export function terminalOutcome(value) {
  if (value?.status === "noop") {
    keys(value, ["status", "reason"]);
    return { status: "noop", reason: boundedText(value.reason, 4000, "no-op rationale") };
  }
  keys(value, ["status", "reason", "questions"]);
  requireValue(value.status === "triage" && Array.isArray(value.questions) &&
    value.questions.length > 0 && value.questions.length <= 10, "Uncertain impact requires triage questions.");
  return {
    status: "triage", reason: boundedText(value.reason, 4000, "triage rationale"),
    questions: value.questions.map(question => boundedText(question, 1000, "triage question"))
  };
}

export function validateRouting(value, documents) {
  if (value?.status !== "inspect") return terminalOutcome(value);
  keys(value, ["status", "paths"]);
  requireValue(Array.isArray(value.paths) && value.paths.length > 0 &&
    value.paths.length <= limits.selectedDocuments && new Set(value.paths).size === value.paths.length &&
    value.paths.every(path => safeSkillPath(path) && Object.hasOwn(documents, path)),
  "Routing must select at most six existing canonical skill documents.");
  return value;
}

export function validateDraft(value, candidate, documents) {
  if (value?.status !== "draft") return terminalOutcome(value);
  keys(value, ["status", "reason", "api", "citations", "edits"]);
  boundedText(value.reason, 4000, "impact rationale");
  boundedText(value.api, 300, "affected API");
  requireValue(Array.isArray(value.citations) && value.citations.length >= 2 && value.citations.length <= 12,
    "Drafts require source and test citations, not diff-only inference.");
  const kinds = new Set();
  const citations = value.citations.map(citation => {
    keys(citation, ["path", "quote"]);
    boundedText(citation.quote, 2000, "source quote");
    requireValue(citation.quote.length >= 20, "Source quote is too short.");
    const snapshot = candidate.evidence.snapshots.find(item => item.path === citation.path);
    requireValue(snapshot && snapshot.commit === candidate.source.merge &&
      snapshot.content.includes(citation.quote), "Citation is not in the immutable source evidence.");
    kinds.add(snapshot.kind);
    return { ...citation, url: snapshot.url, commit: snapshot.commit, blob: snapshot.blob, digest: snapshot.digest };
  });
  requireValue(kinds.has("source") && kinds.has("test"), "Authoritative source AND tests are required for draft guidance.");
  requireValue(Array.isArray(value.edits) && value.edits.length > 0 && value.edits.length <= limits.edits,
    "Invalid draft edit count.");
  for (const edit of value.edits) keys(edit, ["path", "before", "after"]);
  requireValue(new Set(value.edits.map(edit => edit.path)).size === value.edits.length, "Duplicate draft edit paths.");
  const edits = value.edits.map(edit => {
    requireValue(safeSkillPath(edit.path) && Object.hasOwn(documents, edit.path), "Unsafe or unselected skill path.");
    boundedText(edit.before, limits.documentBytes, "original guidance");
    boundedText(edit.after, limits.documentBytes, "proposed guidance");
    const content = documents[edit.path];
    requireValue(edit.before !== edit.after && content.split(edit.before).length === 2,
      "Draft must replace one exact occurrence and make a real change.");
    requireValue(Buffer.byteLength(content.replace(edit.before, edit.after)) <= limits.documentBytes,
      "Proposed skill exceeds the document bound.");
    return edit;
  });
  return {
    status: "draft", reason: value.reason, api: value.api, citations, edits,
    validation: { tests: "not-run", evals: "not-run", maintainerReview: "required", publication: "disabled" }
  };
}

export const assessmentInstructions = readFileSync(
  new URL("../.github/prompts/upstream-skill-assessment.txt", import.meta.url), "utf8"
).trim();

export async function assessCandidate(candidate, documents, ask) {
  const route = validateRouting(parseResponse(await ask(`${assessmentInstructions}
Select up to six documents needing inspection, including relevant references, using
{"status":"inspect","paths":["skills/.../SKILL.md"]}, or return noop/triage.
Inventory and entrypoints: ${JSON.stringify({
    paths: Object.keys(documents),
    entrypoints: Object.fromEntries(Object.entries(documents).filter(([path]) => path.endsWith("/SKILL.md")))
  })}
Upstream evidence: ${JSON.stringify(candidate)}`)), documents);
  if (route.status !== "inspect") return route;
  const selected = Object.fromEntries(route.paths.map(path => [path, documents[path]]));
  return validateDraft(parseResponse(await ask(`${assessmentInstructions}
If a change is grounded in the supplied authoritative source and tests, propose:
{"status":"draft","reason":"impact and rationale","api":"affected API or CLI command",
"citations":[{"path":"src/...","quote":"exact source quote, >=20 characters"},
{"path":"tests/...","quote":"exact test quote, >=20 characters"}],
"edits":[{"path":"skills/...","before":"one exact nonempty occurrence","after":"replacement"}]}.
At most three existing selected Markdown documents may change. No new files, commands,
workflow edits, eval code edits, version assumptions, or unrelated rewrites.
Selected guidance: ${JSON.stringify(selected)}
Upstream evidence: ${JSON.stringify(candidate)}`)), candidate, selected);
}

export async function finishAssessment(prepared, ask) {
  const reports = [...prepared.reports];
  for (const candidate of prepared.sources) {
    let result;
    if (!ask) result = {
      status: "blocked", reason: "Read-only agent runtime is not enabled/configured. No model assessment ran."
    };
    else {
      try {
        result = await assessCandidate(candidate, prepared.documents, ask);
      } catch (error) {
        if (!(error instanceof PolicyError || error instanceof ModelResponseSyntaxError)) throw error;
        result = {
          status: "triage", reason: "Agent returned an unsupported/ungrounded assessment.",
          questions: ["Review immutable source evidence manually; no guidance was changed."]
        };
      }
    }
    reports.push({ source: candidate.source, ...result });
  }
  const entries = new Map(prepared.state.entries.filter(entry => entry.status !== "draft").map(entry => [entry.key, entry]));
  for (const report of reports) {
    // A proposed draft is not completed work: validation, approval or publication can still fail.
    if (["noop", "triage"].includes(report.status)) entries.set(report.source.key, {
      key: report.source.key, mergedAt: report.source.mergedAt, status: report.status, assessedAt: prepared.assessedAt
    });
  }
  requireValue(entries.size <= limits.stateEntries, "State capacity exceeded; narrow the polling history.");
  return {
    schema: 1, scope: "assessment", assessedAt: prepared.assessedAt, target: prepared.target, window: prepared.window,
    reports, state: { schema: 1, entries: [...entries.values()] },
    publication: "pending isolated validation and approval of the exact draft PR preview"
  };
}
