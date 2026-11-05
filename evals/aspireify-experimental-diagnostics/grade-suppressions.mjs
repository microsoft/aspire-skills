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

const projectNoWarn = text => [...text.matchAll(/<NoWarn\b[^>]*>([\s\S]*?)<\/NoWarn>/gi)].map(match => match[1]);
const directiveNoWarn = text => [...text.matchAll(/^#:property\s+NoWarn\s*=\s*(.*)$/gim)].map(match => match[1].trim());

// Returns, per API, whether every call line is inside an active #pragma warning disable for its ID.
function pragmaCoverage(code, apis) {
  const disabled = new Set();
  let all = false;
  const uncovered = new Set();
  for (const line of stripComments(code).split("\n")) {
    const pragma = line.match(/^\s*#pragma\s+warning\s+(disable|restore)\b(.*)$/);
    if (pragma) {
      const listed = ids(pragma[2]);
      if (pragma[1] === "disable") {
        if (listed.length === 0) all = true;
        listed.forEach(id => disabled.add(id));
      } else {
        if (listed.length === 0) { all = false; disabled.clear(); }
        listed.forEach(id => disabled.delete(id));
      }
      continue;
    }
    for (const api of apis) {
      if (api.call.test(line) && !all && !disabled.has(api.id)) uncovered.add(api.id);
    }
  }
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
    noWarn = effectiveNoWarn(projectNoWarn(read(projectPath)), problems, spec.project);
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
