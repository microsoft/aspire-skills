// Program grader for the Aspireify experimental-diagnostics stimuli.
// For the file and project cases it inspects the AppHost the agent wrote under <workspace>/app and
// fails unless the api resource is added for the supplied project with the certificate call chained
// from it, every call to an Aspire 13.6 experimental API is covered by an unconditional #pragma or
// NoWarn suppression, and the project's existing NoWarn values survive. The dotnet17 case grades
// the code blocks returned in the response for the read-only 17.0 stimulus. Self-contained: the
// eval copies only this file into .grader/.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const experimentalApis = [
  { name: "AddCSharpApp", call: /\bAddCSharpApp\s*\(/, id: "ASPIRECSHARPAPPS001" },
  { name: "WithHttpsDeveloperCertificate", call: /\.\s*WithHttpsDeveloperCertificate\s*\(/, id: "ASPIRECERTIFICATES001" },
];

// apiPaths are the accepted project paths for the api resource, relative to the AppHost directory.
export const cases = {
  file: { source: "apphost.cs", apiPaths: ["./api", "./api/Api.csproj"] },
  project: {
    source: "AppHost/AppHost.cs",
    project: "AppHost/AppHost.csproj",
    apiPaths: ["../Api", "../Api/Api.csproj"],
    // The fixture already suppresses ASPIREPROBES001 for its WithHttpProbe call.
    preserved: [{ name: "WithHttpProbe", call: /\.\s*WithHttpProbe\s*\(/, id: "ASPIREPROBES001" }],
  },
};

const read = path => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

// Blanks comments (keeping line breaks) without touching comment-like text inside string literals.
function stripComments(code) {
  return code.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    token => token.startsWith("/") ? token.replace(/[^\n]/g, " ") : token);
}

const conditionalDirective = /^\s*#\s*(if|elif|else|endif)\b/;

// Marks each line that is a conditional-compilation directive or sits inside an #if block. Code
// there compiles only when its branch is active, so it cannot supply a required suppression or
// the requested wiring.
function conditionalLines(code) {
  let depth = 0;
  return code.split("\n").map(line => {
    const directive = line.match(conditionalDirective);
    if (!directive) return depth > 0;
    if (directive[1] === "if") depth++;
    else if (directive[1] === "endif") depth = Math.max(0, depth - 1);
    return true;
  });
}

const unconditional = code => {
  const conditional = conditionalLines(code);
  return code.split("\n").map((line, index) => conditional[index] ? "" : line).join("\n");
};

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

// Returns the IDs of APIs with a call outside an active #pragma warning disable for that ID, and
// the IDs named by #pragma directives inside #if/#elif/#else blocks, which are ignored. Calls
// (in any branch) are matched across line breaks and checked on the line of the API name, where
// the compiler reports the diagnostic. As in C#, the most recent directive naming an ID, or
// blanket directive, wins.
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
  const conditional = new Set();
  const inConditional = conditionalLines(stripped);
  stripped.split("\n").forEach((line, index) => {
    const pragma = line.match(/^\s*#pragma\s+warning\s+(disable|restore)\b(.*)$/);
    if (pragma) {
      const listed = ids(pragma[2]);
      if (inConditional[index]) {
        for (const api of apis) if (listed.length === 0 || listed.includes(api.id)) conditional.add(api.id);
        return;
      }
      const disable = pragma[1] === "disable";
      if (listed.length === 0) { all = disable; overrides.clear(); }
      listed.forEach(id => overrides.set(id, disable));
      return;
    }
    for (const api of callsByLine.get(index) ?? []) {
      if (!(overrides.has(api.id) ? overrides.get(api.id) : all)) uncovered.add(api.id);
    }
  });
  return { uncovered, conditional };
}

// Returns the index just past the parenthesized group that opens at code[open].
function closeParen(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '"') {
      for (i++; i < code.length && code[i] !== '"'; i++) if (code[i] === "\\") i++;
    } else if (code[i] === "(") {
      depth++;
    } else if (code[i] === ")" && --depth === 0) {
      return i + 1;
    }
  }
  return -1;
}

// Returns the names of the methods chained (.Name(...)) starting at index from.
function chainedCalls(code, from) {
  const member = /\s*\.\s*([A-Za-z_]\w*)\s*(?:<[^<>();]*>\s*)?\(/y;
  const names = [];
  for (let at = from; at >= 0;) {
    member.lastIndex = at;
    const match = member.exec(code);
    if (!match) break;
    names.push(match[1]);
    at = closeParen(code, member.lastIndex - 1);
  }
  return names;
}

const normalizePath = path => path.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^(?!\.{1,2}\/)/, "./");

// Finds a `method("api", "<path>")` call for one of the accepted project paths and reports whether
// WithHttpsDeveloperCertificate() is chained from it, directly or through the variable it is
// assigned to. Only unconditional code counts.
export function apiResource(source, method, paths) {
  const code = unconditional(stripComments(source));
  const accepted = new Set(paths.map(normalizePath));
  const result = { added: false, certificate: false };
  for (const match of code.matchAll(new RegExp(`\\b${method}\\s*\\(`, "g"))) {
    const open = match.index + match[0].length - 1;
    const end = closeParen(code, open);
    if (end < 0) continue;
    const args = code.slice(open + 1, end - 1).match(/^\s*(?:name\s*:\s*)?"([^"]*)"\s*,\s*(?:\w+\s*:\s*)?@?"([^"]*)"\s*$/);
    if (!args || args[1] !== "api" || !accepted.has(normalizePath(args[2]))) continue;
    result.added = true;
    const calls = chainedCalls(code, end);
    const variable = code.slice(0, match.index).match(/\b([A-Za-z_]\w*)\s*(?<![=!<>])=(?!=)\s*[A-Za-z_][\w.]*?\s*\.\s*$/)?.[1];
    if (variable) {
      for (const use of code.slice(end).matchAll(new RegExp(`(?<![\\w.])${variable}\\b(?=\\s*\\.)`, "g"))) {
        calls.push(...chainedCalls(code, end + use.index + use[0].length));
      }
    }
    if (calls.includes("WithHttpsDeveloperCertificate")) result.certificate = true;
  }
  return result;
}

const conditionalProblem = (where, id) =>
  `${where} disables ${id} with a #pragma inside an #if/#elif/#else block; it applies only when that branch compiles, so it is not counted`;

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
  if (used.length === experimentalApis.length) {
    const resource = apiResource(source, "AddCSharpApp", spec.apiPaths);
    if (!resource.added) {
      problems.push(`${spec.source} does not add the api resource with AddCSharpApp("api", "${spec.apiPaths[0]}")`);
    } else if (!resource.certificate) {
      problems.push(`${spec.source} does not chain WithHttpsDeveloperCertificate() from the api resource`);
    }
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

  const { uncovered, conditional } = pragmaCoverage(source, used);
  for (const api of used) {
    if (uncovered.has(api.id) && !noWarn.has(api.id)) {
      if (conditional.has(api.id)) problems.push(conditionalProblem(spec.source, api.id));
      problems.push(`${api.name} in ${spec.source} is not covered by #pragma warning disable ${api.id} or NoWarn; Aspire 13.6 fails the build with error ${api.id}`);
    }
  }
  return problems;
}

const certificateApi = experimentalApis.find(api => api.name === "WithHttpsDeveloperCertificate");

// Returns the contents of the fenced code blocks in a Markdown response.
const codeBlocks = output => [...output.replace(/\r\n/g, "\n")
  .matchAll(/^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm)].map(match => match[2]);

// Grades the read-only Aspire 17.0 stimulus from the code the response returns, not its prose: the
// api resource added with AddDotnetProject and the certificate call chained from it, an
// Aspire.Hosting.Dotnet reference (not implicit in the 17.0 SDK) and an effective
// ASPIRECERTIFICATES001 suppression.
export function gradeDotnet17Response(output) {
  const blocks = codeBlocks(typeof output === "string" ? output : "");
  if (blocks.length === 0) return ["The response contains no fenced code block with the AppHost code"];
  const source = blocks.join("\n");
  const code = unconditional(stripComments(source));
  const problems = [];

  const resource = apiResource(source, "AddDotnetProject", ["./api", "./api/Api.csproj"]);
  if (!resource.added) problems.push('The returned code does not add the api resource with AddDotnetProject("api", "./api")');
  else if (!resource.certificate) problems.push("The returned code does not chain WithHttpsDeveloperCertificate() from the api resource");

  if (!/^\s*#:package\s+Aspire\.Hosting\.Dotnet@/m.test(code) && !/^\s*(?:\$\s*)?aspire\s+add\s+Aspire\.Hosting\.Dotnet\b/im.test(code)) {
    problems.push("The returned code does not reference Aspire.Hosting.Dotnet with #:package or aspire add; the 17.0 SDK does not include it");
  }

  if (certificateApi.call.test(code)) {
    const noWarn = effectiveNoWarn(directiveNoWarn(code), problems, "#:property");
    const { uncovered, conditional } = pragmaCoverage(source, [certificateApi]);
    if (uncovered.has(certificateApi.id) && !noWarn.has(certificateApi.id)) {
      if (conditional.has(certificateApi.id)) problems.push(conditionalProblem("The returned code", certificateApi.id));
      problems.push(`WithHttpsDeveloperCertificate in the returned code is not covered by #pragma warning disable ${certificateApi.id} or NoWarn`);
    }
  }
  return problems;
}

function runCli(caseName) {
  if (caseName === "dotnet17") {
    if (!process.env.EVALUATE_GRADER_INPUT) return ["EVALUATE_GRADER_INPUT is not set"];
    const input = JSON.parse(readFileSync(process.env.EVALUATE_GRADER_INPUT, "utf8"));
    return gradeDotnet17Response(input.trajectory?.output);
  }
  const workspace = process.env.EVALUATE_WORKSPACE;
  return workspace ? gradeAppHost(join(workspace, "app"), caseName) : ["EVALUATE_WORKSPACE is not set"];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = runCli(process.argv[2]);
  for (const problem of problems) console.error(problem);
  process.exitCode = problems.length ? 1 : 0;
}
