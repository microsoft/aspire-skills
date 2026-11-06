// Program grader for the Aspireify experimental-diagnostics stimuli.
// Inspects the AppHost the agent wrote under <workspace>/app and fails unless every call to an
// Aspire 13.6 experimental API is covered by a #pragma or NoWarn suppression, and the project's
// existing NoWarn values survive. Self-contained: the eval copies only this file into .grader/.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const experimentalApis = [
  { name: "AddCSharpApp", call: /\bAddCSharpApp\s*\(/, id: "ASPIRECSHARPAPPS001" },
  { name: "WithHttpsDeveloperCertificate", call: /\.\s*WithHttpsDeveloperCertificate\s*\(/, id: "ASPIRECERTIFICATES001" },
];

export const cases = {
  file: { source: "apphost.cs" },
  project: {
    source: "AppHost/AppHost.cs",
    project: "AppHost/AppHost.csproj",
    // The fixture already suppresses ASPIREPROBES001 for its WithHttpProbe call.
    preserved: [{ name: "WithHttpProbe", call: /\.\s*WithHttpProbe\s*\(/, id: "ASPIREPROBES001" }],
  },
};

const read = path => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, " ")).replace(/\/\/.*$/gm, "");
}

const ids = list => list.split(/[;,\s]+/).map(id => id.trim().toUpperCase()).filter(Boolean);

// Applies NoWarn assignments in order, expanding $(NoWarn) to the previous value.
function effectiveNoWarn(values, problems, where) {
  let current = "";
  for (const value of values) {
    if (!/\$\(NoWarn\)/i.test(value)) {
      problems.push(`${where} sets NoWarn without $(NoWarn), dropping inherited suppressions`);
    }
    current = value.replace(/\$\(NoWarn\)/gi, current);
  }
  return new Set(ids(current));
}

const stripXmlComments = text => text.replace(/<!--[\s\S]*?-->/g, "");

// Returns the unconditional NoWarn values in document order, ignoring commented-out elements. A
// conditional NoWarn (on the element, its PropertyGroup or under Choose/When) applies only to some
// configurations, so it is rejected rather than counted.
function projectNoWarn(text, problems, where) {
  const xml = stripXmlComments(text);
  const conditionalRanges = [];
  for (const group of xml.matchAll(/<(PropertyGroup|When|Otherwise)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    if (/\bCondition\s*=/i.test(group[2]) || !/^PropertyGroup$/i.test(group[1])) {
      conditionalRanges.push([group.index, group.index + group[0].length]);
    }
  }
  const values = [];
  for (const match of xml.matchAll(/<NoWarn\b([^>]*)>([\s\S]*?)<\/NoWarn>/gi)) {
    if (/\bCondition\s*=/i.test(match[1]) || conditionalRanges.some(([start, end]) => match.index > start && match.index < end)) {
      problems.push(`${where} sets NoWarn conditionally; suppressions must apply to every configuration`);
      continue;
    }
    values.push(match[2]);
  }
  return values;
}

const directiveNoWarn = source => [...stripComments(source).matchAll(/^#:property\s+NoWarn\s*=\s*(.*)$/gim)].map(match => match[1].trim());

const lineAt = (text, index) => text.slice(0, index).split("\n").length - 1;

// Returns the IDs of APIs with a call outside an active #pragma warning disable for that ID. Calls
// are matched across line breaks and checked on the line of the API name, where the compiler reports
// the diagnostic. As in C#, the most recent directive naming an ID, or blanket directive, wins.
function pragmaCoverage(code, apis) {
  const stripped = stripComments(code);
  const callsByLine = new Map();
  for (const api of apis) {
    for (const match of stripped.matchAll(new RegExp(api.call.source, "g"))) {
      const line = lineAt(stripped, match.index + match[0].indexOf(api.name));
      callsByLine.set(line, [...(callsByLine.get(line) ?? []), api]);
    }
  }

  let all = false;
  const overrides = new Map();
  const uncovered = new Set();
  stripped.split("\n").forEach((line, index) => {
    const pragma = line.match(/^\s*#pragma\s+warning\s+(disable|restore)\b(.*)$/);
    if (pragma) {
      const listed = ids(pragma[2]);
      const disable = pragma[1] === "disable";
      if (listed.length === 0) { all = disable; overrides.clear(); }
      listed.forEach(id => overrides.set(id, disable));
      return;
    }
    for (const api of callsByLine.get(index) ?? []) {
      if (!(overrides.has(api.id) ? overrides.get(api.id) : all)) uncovered.add(api.id);
    }
  });
  return uncovered;
}

export function gradeAppHost(appDir, caseName) {
  const spec = cases[caseName];
  if (!spec) return [`Unknown case "${caseName}"; expected one of ${Object.keys(cases).join(", ")}`];
  const problems = [];
  const sourcePath = join(appDir, spec.source);
  if (!existsSync(sourcePath)) return [`${spec.source} is missing`];
  const source = read(sourcePath);
  const code = stripComments(source);

  const used = experimentalApis.filter(api => api.call.test(code));
  for (const api of experimentalApis) {
    if (!used.includes(api)) problems.push(`${spec.source} does not call ${api.name}`);
  }

  let noWarn = new Set();
  if (spec.project) {
    const projectPath = join(appDir, spec.project);
    if (!existsSync(projectPath)) return [...problems, `${spec.project} is missing`];
    noWarn = effectiveNoWarn(projectNoWarn(read(projectPath), problems, spec.project), problems, spec.project);
  } else {
    noWarn = effectiveNoWarn(directiveNoWarn(source), problems, `${spec.source} #:property`);
  }

  for (const api of spec.preserved ?? []) {
    if (!api.call.test(code)) problems.push(`${spec.source} no longer calls ${api.name}`);
    else if (!noWarn.has(api.id)) problems.push(`${spec.project ?? spec.source} dropped the existing ${api.id} suppression`);
  }

  const uncovered = pragmaCoverage(source, used);
  for (const api of used) {
    if (uncovered.has(api.id) && !noWarn.has(api.id)) {
      problems.push(`${api.name} in ${spec.source} is not covered by #pragma warning disable ${api.id} or NoWarn; Aspire 13.6 fails the build with error ${api.id}`);
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = process.env.EVALUATE_WORKSPACE;
  const problems = workspace
    ? gradeAppHost(join(workspace, "app"), process.argv[2])
    : ["EVALUATE_WORKSPACE is not set"];
  for (const problem of problems) console.error(problem);
  process.exitCode = problems.length ? 1 : 0;
}
