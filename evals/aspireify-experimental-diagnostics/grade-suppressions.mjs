// Program grader for the Aspireify experimental-diagnostics stimuli.
// For the file and project cases it inspects the AppHost the agent wrote under <workspace>/app and
// fails unless the api resource is added to the AppHost's builder for the supplied project with the
// certificate call chained from it, the AppHost still creates and runs that builder, the existing
// echo container keeps its endpoint and probe wiring, every call to an Aspire 13.6 experimental API
// is covered by an unconditional, case-sensitive #pragma or NoWarn suppression that no conditional
// #pragma restore can undo, and the project's existing NoWarn values survive. The dotnet17 case grades each fenced code block returned in the response for the
// read-only 17.0 stimulus on its own. Self-contained: the eval copies only this file into .grader/.
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
    // The prompt asks to keep the fixture's echo container with its endpoint and probe. Arguments
    // are compared with whitespace removed.
    kept: {
      method: "AddContainer",
      name: "echo",
      image: /^hashicorp\/http-echo$/,
      display: 'AddContainer("echo", "hashicorp/http-echo")',
      calls: [
        { name: "WithHttpEndpoint", args: /(?:^|,)targetPort:5678(?:,|$)/, display: "WithHttpEndpoint(targetPort: 5678)" },
        { name: "WithHttpProbe", args: /^(?:type:)?ProbeType\.Liveness,(?:path:)?"\/"(?:,|$)/, display: 'WithHttpProbe(ProbeType.Liveness, "/")' },
      ],
    },
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

const splitIds = list => list.split(/[;,\s]+/).map(id => id.trim()).filter(Boolean);
// NoWarn values are compared case-insensitively. #pragma warning IDs are not: C# ignores a
// lowercase `#pragma warning disable aspirecertificates001` for ASPIRECERTIFICATES001.
const ids = list => splitIds(list).map(id => id.toUpperCase());

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

// Returns the IDs of APIs with a call outside an active #pragma warning disable for that ID. A
// #pragma inside an #if/#elif/#else block applies only in some configurations, so it is judged
// conservatively: a conditional disable is ignored (returned in `conditional`) and a conditional
// restore is applied (returned in `conditionalRestores`), since either may compile in the evaluated
// configuration. Calls (in any branch) are matched across line breaks and checked on the line of
// the API name, where the compiler reports the diagnostic. As in C#, the most recent directive
// naming an ID, or blanket directive, wins.
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
  const conditionalRestores = new Set();
  const inConditional = conditionalLines(stripped);
  stripped.split("\n").forEach((line, index) => {
    const pragma = line.match(/^\s*#pragma\s+warning\s+(disable|restore)\b(.*)$/);
    if (pragma) {
      const listed = splitIds(pragma[2]);
      const disable = pragma[1] === "disable";
      if (inConditional[index]) {
        const named = apis.filter(api => listed.length === 0 || listed.includes(api.id)).map(api => api.id);
        named.forEach(id => (disable ? conditional : conditionalRestores).add(id));
        if (disable) return;
      }
      if (listed.length === 0) { all = disable; overrides.clear(); }
      listed.forEach(id => overrides.set(id, disable));
      return;
    }
    for (const api of callsByLine.get(index) ?? []) {
      if (!(overrides.has(api.id) ? overrides.get(api.id) : all)) uncovered.add(api.id);
    }
  });
  return { uncovered, conditional, conditionalRestores };
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

// Returns the methods chained (.Name(...)) starting at index from, with their arguments.
function chainedCalls(code, from) {
  const member = /\s*\.\s*([A-Za-z_]\w*)\s*(?:<[^<>();]*>\s*)?\(/y;
  const calls = [];
  for (let at = from; at >= 0;) {
    member.lastIndex = at;
    const match = member.exec(code);
    if (!match) break;
    at = closeParen(code, member.lastIndex - 1);
    calls.push({ name: match[1], args: at < 0 ? "" : code.slice(member.lastIndex, at - 1) });
  }
  return calls;
}

const normalizePath = path => path.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^(?!\.{1,2}\/)/, "./");

const twoStringArgs = /^\s*(?:name\s*:\s*)?"([^"]*)"\s*,\s*(?:\w+\s*:\s*)?@?"([^"]*)"\s*$/;

// Finds `method("<name>", "<value>")` calls in unconditional code whose name is `name` and whose
// value passes accept. For each it returns the call's position, the receiver it is called on and
// the methods chained from it, directly or through the variable it is assigned to.
function resourceCalls(code, method, name, accept) {
  const found = [];
  for (const match of code.matchAll(new RegExp(`\\b${method}\\s*\\(`, "g"))) {
    const open = match.index + match[0].length - 1;
    const end = closeParen(code, open);
    if (end < 0) continue;
    const args = code.slice(open + 1, end - 1).match(twoStringArgs);
    if (!args || args[1] !== name || !accept(args[2])) continue;
    const before = code.slice(0, match.index);
    const calls = chainedCalls(code, end);
    const variable = before.match(/\b([A-Za-z_]\w*)\s*(?<![=!<>])=(?!=)\s*[A-Za-z_][\w.]*?\s*\.\s*$/)?.[1];
    if (variable) {
      for (const use of code.slice(end).matchAll(new RegExp(`(?<![\\w.])${variable}\\b(?=\\s*\\.)`, "g"))) {
        calls.push(...chainedCalls(code, end + use.index + use[0].length));
      }
    }
    found.push({ index: match.index, end, receiver: before.match(/([A-Za-z_]\w*)\s*\.\s*$/)?.[1], calls });
  }
  return found;
}

// Finds a `method("api", "<path>")` call for one of the accepted project paths and reports whether
// WithHttpsDeveloperCertificate() is chained from it, directly or through the variable it is
// assigned to. Only unconditional code counts.
export function apiResource(source, method, paths) {
  const code = unconditional(stripComments(source));
  const accepted = new Set(paths.map(normalizePath));
  const found = resourceCalls(code, method, "api", path => accepted.has(normalizePath(path)));
  const call = found.find(c => c.calls.some(chained => chained.name === "WithHttpsDeveloperCertificate")) ?? found[0];
  const certificate = Boolean(call?.calls.some(c => c.name === "WithHttpsDeveloperCertificate"));
  return { added: Boolean(call), certificate, call, code };
}

// Returns problems unless the code is a complete AppHost around the api resource call: a builder
// created with DistributedApplication.CreateBuilder(args) before it, the call made on that builder
// and builder.Build().Run() after it. A fragment that uses an undefined builder cannot compile.
function appHostProblems(code, where, call) {
  const created = [...code.matchAll(
    /\b(?:var|I?DistributedApplicationBuilder)\s+([A-Za-z_]\w*)\s*=\s*DistributedApplication\s*\.\s*CreateBuilder\s*\(\s*args\s*\)\s*;/g)]
    .filter(match => match.index < call.index);
  const builder = created.at(-1)?.[1];
  if (!builder) {
    return [`${where} does not create the builder with var builder = DistributedApplication.CreateBuilder(args) before adding the api resource`];
  }
  const problems = [];
  if (call.receiver !== builder) {
    problems.push(`${where} adds the api resource on ${call.receiver ?? "an expression"} instead of the ${builder} created by DistributedApplication.CreateBuilder(args)`);
  }
  const run = new RegExp(`(?<![\\w.])${builder}\\s*\\.\\s*Build\\s*\\(\\s*\\)\\s*\\.\\s*Run(?:Async)?\\s*\\(\\s*\\)`, "g");
  if (![...code.slice(call.end).matchAll(run)].length) {
    problems.push(`${where} does not run the AppHost with ${builder}.Build().Run() after adding the api resource`);
  }
  return problems;
}

const compact = args => args.replace(/\s+/g, "");

// Returns problems unless the resource the prompt asks to keep is still added with its chained
// calls and their original arguments.
function keptResourceProblems(source, where, kept) {
  const code = unconditional(stripComments(source));
  const found = resourceCalls(code, kept.method, kept.name, image => kept.image.test(image));
  if (!found.length) return [`${where} no longer adds the existing ${kept.name} resource with ${kept.display}`];
  const missing = kept.calls.filter(required =>
    !found.some(call => call.calls.some(c => c.name === required.name && required.args.test(compact(c.args)))));
  return missing.map(required => `${where} no longer chains ${required.display} from the existing ${kept.name} resource`);
}

const conditionalProblem = (where, id) =>
  `${where} disables ${id} with a #pragma inside an #if/#elif/#else block; it applies only when that branch compiles, so it is not counted`;

const conditionalRestoreProblem = (where, id) =>
  `${where} restores ${id} with a #pragma inside an #if/#elif/#else block; that branch may compile, so the diagnostic is treated as restored`;

// Explains why a call is uncovered when conditional #pragma directives are involved.
function coverageProblems(where, id, { conditional, conditionalRestores }) {
  return [
    ...conditional.has(id) ? [conditionalProblem(where, id)] : [],
    ...conditionalRestores.has(id) ? [conditionalRestoreProblem(where, id)] : [],
  ];
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
  if (used.length === experimentalApis.length) {
    const resource = apiResource(source, "AddCSharpApp", spec.apiPaths);
    if (!resource.added) {
      problems.push(`${spec.source} does not add the api resource with AddCSharpApp("api", "${spec.apiPaths[0]}")`);
    } else {
      if (!resource.certificate) problems.push(`${spec.source} does not chain WithHttpsDeveloperCertificate() from the api resource`);
      problems.push(...appHostProblems(resource.code, spec.source, resource.call));
    }
  }
  if (spec.kept) problems.push(...keptResourceProblems(source, spec.source, spec.kept));

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

  const coverage = pragmaCoverage(source, used);
  for (const api of used) {
    if (coverage.uncovered.has(api.id) && !noWarn.has(api.id)) {
      problems.push(...coverageProblems(spec.source, api.id, coverage));
      problems.push(`${api.name} in ${spec.source} is not covered by #pragma warning disable ${api.id} or NoWarn; Aspire 13.6 fails the build with error ${api.id}`);
    }
  }
  return problems;
}

const certificateApi = experimentalApis.find(api => api.name === "WithHttpsDeveloperCertificate");

// Returns the contents of the fenced code blocks in a Markdown response.
const codeBlocks = output => [...output.replace(/\r\n/g, "\n")
  .matchAll(/^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm)].map(match => match[2]);

// A NuGet version Aspire 17 resolves: 17.minor.patch with an optional prerelease label.
const aspire17Version = /^17\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

// Grades one fenced code block as the requested Aspire 17.0 AppHost: a complete AppHost that adds
// the api resource with AddDotnetProject on its builder with the certificate call chained from it,
// a `#:package Aspire.Hosting.Dotnet@17.x.y` directive (the 17.0 SDK does not include the package,
// and an `aspire add` command shown in a read-only reply is never run) matching any #:sdk version,
// and an effective ASPIRECERTIFICATES001 suppression.
function gradeDotnet17Block(source) {
  const code = unconditional(stripComments(source));
  const problems = [];

  const resource = apiResource(source, "AddDotnetProject", ["./api", "./api/Api.csproj"]);
  if (!resource.added) problems.push('The returned code does not add the api resource with AddDotnetProject("api", "./api")');
  else {
    if (!resource.certificate) problems.push("The returned code does not chain WithHttpsDeveloperCertificate() from the api resource");
    problems.push(...appHostProblems(resource.code, "The returned AppHost", resource.call));
  }

  const packageVersion = code.match(/^[ \t]*#:package[ \t]+Aspire\.Hosting\.Dotnet@(\S+)[ \t]*$/m)?.[1];
  const sdkVersion = code.match(/^[ \t]*#:sdk[ \t]+Aspire\.AppHost\.Sdk@(\S+)[ \t]*$/m)?.[1];
  if (!packageVersion) {
    problems.push("The returned AppHost does not reference Aspire.Hosting.Dotnet with a versioned #:package directive; " +
      "the 17.0 SDK does not include it, and an aspire add command in a read-only reply is not run");
  } else if (!aspire17Version.test(packageVersion)) {
    problems.push(`The returned AppHost references Aspire.Hosting.Dotnet@${packageVersion}, which is not an Aspire 17 NuGet version (17.x.y)`);
  } else if (sdkVersion && sdkVersion !== packageVersion) {
    problems.push(`The returned AppHost references Aspire.Hosting.Dotnet@${packageVersion} but Aspire.AppHost.Sdk@${sdkVersion}; the versions must match`);
  }

  if (certificateApi.call.test(code)) {
    const noWarn = effectiveNoWarn(directiveNoWarn(code), problems, "#:property");
    const coverage = pragmaCoverage(source, [certificateApi]);
    if (coverage.uncovered.has(certificateApi.id) && !noWarn.has(certificateApi.id)) {
      problems.push(...coverageProblems("The returned code", certificateApi.id, coverage));
      problems.push(`WithHttpsDeveloperCertificate in the returned code is not covered by #pragma warning disable ${certificateApi.id} or NoWarn`);
    }
  }
  return { added: resource.added, problems };
}

// Grades the read-only Aspire 17.0 stimulus from the code the response returns, not its prose. Each
// fenced block is graded on its own, so a directive in one block cannot cover code in another; the
// response passes when one block is a complete, correct AppHost.
export function gradeDotnet17Response(output) {
  const blocks = codeBlocks(typeof output === "string" ? output : "");
  if (blocks.length === 0) return ["The response contains no fenced code block with the AppHost code"];
  const graded = blocks.map(gradeDotnet17Block);
  if (graded.some(block => block.problems.length === 0)) return [];
  // Report the closest block, preferring one that adds the api resource.
  const closest = graded.reduce((best, block) =>
    (block.added && !best.added) || (block.added === best.added && block.problems.length < best.problems.length) ? block : best);
  return blocks.length > 1
    ? ["No single fenced code block is a complete, correct AppHost; each block is graded on its own", ...closest.problems]
    : closest.problems;
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
