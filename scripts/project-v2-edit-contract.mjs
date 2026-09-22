import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const appHost = "Migration.AppHost/Migration.AppHost.csproj";
const csharp = "Migration.AppHost/Program.cs";
const typescript = "Migration.TypeScriptAppHost/apphost.mts";
const tsConfig = "Migration.TypeScriptAppHost/aspire.config.json";

export const editCases = {
  csharp: {
    fixture: "runnable-csharp", appHost, source: csharp,
    files: [csharp, appHost, "Directory.Packages.props"],
    migrate: { api: "../Migration.Api/Migration.Api.csproj", worker: "../Migration.Worker/Migration.Worker.csproj" },
    profiles: { api: "http", worker: false },
    removeReferences: ["../Migration.Api/Migration.Api.csproj", "../Migration.Worker/Migration.Worker.csproj"]
  },
  subset: {
    fixture: "runnable-csharp", appHost, source: csharp,
    files: [csharp, appHost, "Directory.Packages.props"],
    migrate: { api: "../Migration.Api/Migration.Api.csproj" }, profiles: { api: "http" },
    removeReferences: ["../Migration.Api/Migration.Api.csproj"]
  },
  typescript: {
    fixture: "runnable-csharp", appHost: typescript, source: typescript,
    files: [typescript, tsConfig],
    migrate: { api: "../Migration.Api/Migration.Api.csproj", worker: "../Migration.Worker/Migration.Worker.csproj" },
    profiles: {}, config: tsConfig
  },
  named: {
    fixture: "runnable-csharp", overlay: "typescript-named/apphost.mts",
    appHost: typescript, source: typescript,
    files: [typescript, tsConfig],
    migrate: { "named-api": "../Migration.Api/Migration.Api.csproj" }, profiles: { "named-api": "http" },
    config: tsConfig
  },
  ownership: {
    fixture: "runnable-csharp", overlayDirectory: "ownership", appHost, source: csharp,
    files: [csharp, appHost, "Directory.Packages.props"],
    migrate: { "dockerfile-api": "../Migration.Api/Migration.Api.csproj", "prebuilt-api": "../Migration.Api/Migration.Api.csproj" },
    profiles: { "dockerfile-api": false, "prebuilt-api": false },
    removeReferences: ["../Migration.Api/Migration.Api.csproj"]
  },
  "file-app": {
    fixture: "file-app", appHost: "apphost.cs", source: "apphost.cs",
    files: ["apphost.cs"], migrate: { "file-api": "file-api.cs" }, profiles: {}
  },
  "blazor-ef": {
    fixture: "blazor-ef", appHost: "AppHost.csproj", source: "Program.cs",
    files: ["Program.cs", "AppHost.csproj"],
    migrate: { api: "Api/Api.csproj", gateway: null }, profiles: {},
    removeReferences: [], efDiagnostic: true, removeLegacyGatewayDockerfileMutation: true
  }
};

export function prepareFixture(destination, caseName, fixturesRoot) {
  const contract = editCases[caseName];
  assert.ok(contract, `Unknown case: ${caseName}`);
  assert.ok(!existsSync(destination), `Refusing to overwrite ${destination}`);
  cpSync(join(fixturesRoot, contract.fixture), destination, { recursive: true });
  if (contract.overlay) cpSync(join(fixturesRoot, contract.overlay), join(destination, contract.source));
  if (contract.overlayDirectory) cpSync(join(fixturesRoot, contract.overlayDirectory), destination, { recursive: true });
}

export function snapshotFiles(root) {
  const files = {};
  function visit(directory, prefix) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(path);
      assert.ok(!stat.isSymbolicLink(), `Unexpected symlink: ${relative}`);
      if (stat.isDirectory()) visit(path, relative);
      else {
        assert.ok(stat.isFile(), `Unexpected non-file: ${relative}`);
        files[relative] = createHash("sha256").update(readFileSync(path)).digest("hex");
      }
    }
  }
  visit(root, "");
  assert.ok(Object.keys(files).length, `Missing fixture files: ${root}`);
  return files;
}

export function assertFileBoundary(before, after, allowed = []) {
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(path => before[path] !== after[path]).sort();
  for (const path of changed) {
    assert.ok(allowed.includes(path), `Unapproved file change: ${path}`);
    assert.ok(path in before && path in after, `Unexpected file addition/removal: ${path}`);
  }
  return changed;
}

export function assertDiffBoundary(diff, allowed) {
  assert.equal(typeof diff, "string", "Missing captured workspace diff");
  const headers = diff.split("\n").filter(line => line.startsWith("diff --git "));
  assert.ok(headers.length, "Expected an actual agent edit, not a missing/empty diff");
  for (const header of headers) {
    assert.ok(allowed.some(path => header === `diff --git a/app/${path} b/app/${path}`),
      `Unapproved workspace edit: ${header}`);
  }
}

// Deliberately fixture-scoped, not a general C#/TypeScript parser. Compilation and
// runtime/publish comparisons are separate gates. Keep strings while ignoring layout.
export function compactCode(text) {
  return (text.match(/@"(?:""|[^"])*"|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\s+|./g) ?? [])
    .filter(token => !/^\s+$|^\/\/|^\/\*/.test(token)).join("");
}

function registrations(source) {
  const code = compactCode(source);
  const pattern = /\b(AddProject<[^>]+>|AddDotnetProjectBlazorGateway|AddDotnetProject|AddBlazorGateway|AddCSharpApp|addProject|addDotnetProject)\(/g;
  const found = [];
  for (let match; (match = pattern.exec(code));) {
    const start = pattern.lastIndex;
    let depth = 1;
    let quote;
    let end = start;
    for (; end < code.length && depth; end++) {
      const char = code[end];
      if (quote) {
        if (char === "\\") end++;
        else if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "(") depth++;
      else if (char === ")") depth--;
    }
    assert.equal(depth, 0, "Unbalanced resource declaration");
    const args = code.slice(start, end - 1);
    const name = /^["']([^"']+)["']/.exec(args)?.[1];
    assert.ok(name, "Fixture resource name must remain a literal");
    assert.ok(!found.some(item => item.name === name), `Duplicate resource ${name}`);
    found.push({ name, method: match[1], args, start: match.index, end });
    pattern.lastIndex = end;
  }
  let stripped = code;
  for (const call of found.toReversed()) {
    stripped = `${stripped.slice(0, call.start)}<resource:${call.name}>${stripped.slice(call.end)}`;
  }
  return { found, stripped };
}

function normalizedPath(value) {
  return value.replaceAll("\\", "/").replaceAll("//", "/").replace(/^\.\//, "");
}

function normalizeImmediateFluentContinuation(code, resourceNames) {
  let result = code;
  for (const name of resourceNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`var([A-Za-z_]\\w*)=builder\\.<resource:${escaped}>;\\1\\.`);
    result = result.replace(pattern, `var$1=builder.<resource:${name}>.`);
  }
  return result;
}

function removeLegacyGatewayDockerfileMutation(source) {
  const marker = "var gatewayBuild = gateway.Resource.Annotations";
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, "Missing legacy gateway Dockerfile image mutation");
  assert.equal(source.indexOf(marker, markerIndex + marker.length), -1,
    "Expected exactly one legacy gateway Dockerfile image mutation");

  const disable = "#pragma warning disable ASPIREPIPELINES003";
  const restore = "#pragma warning restore ASPIREPIPELINES003";
  const start = source.lastIndexOf(disable, markerIndex);
  const restoreIndex = source.indexOf(restore, markerIndex);
  assert.notEqual(start, -1, "Missing legacy gateway Dockerfile mutation suppression");
  assert.notEqual(restoreIndex, -1, "Missing legacy gateway Dockerfile mutation restore");

  const lineEnd = source.indexOf("\n", restoreIndex + restore.length);
  const end = lineEnd === -1 ? source.length : lineEnd + 1;
  const block = source.slice(start, end);
  assert.equal(compactCode(block),
    '#pragmawarningdisableASPIREPIPELINES003vargatewayBuild=gateway.Resource.Annotations.OfType<DockerfileBuildAnnotation>().SingleOrDefault();if(gatewayBuildisnotnull){gatewayBuild.ImageName=$"{imagePrefix}-gateway";gatewayBuild.ImageTag="validation";}#pragmawarningrestoreASPIREPIPELINES003',
    "Unexpected legacy gateway Dockerfile image mutation");
  return source.slice(0, start) + source.slice(end);
}

const migrationDiagnostics = new Set(["ASPIREDOTNETPROJECT001", "ASPIREPROJECTS001"]);

function warningPragmaPattern() {
  return /^([ \t]*#pragma[ \t]+warning[ \t]+)(disable|restore)([ \t]+)([^\r\n]+?)([ \t]*)(\r?)$/gm;
}

function warningIds(value) {
  return value.split(",").map(id => id.trim()).filter(Boolean);
}

function warningPragmas(source) {
  return [...source.matchAll(warningPragmaPattern())].map(match => ({
    text: match[0],
    index: match.index,
    action: match[2],
    ids: warningIds(match[4])
  }));
}

function removeMigrationDiagnostics(source) {
  return source.replace(warningPragmaPattern(),
    (text, prefix, action, separator, list, trailing, carriageReturn) => {
      const ids = warningIds(list);
      const remaining = ids.filter(id => !migrationDiagnostics.has(id));
      if (remaining.length === ids.length) return text;
      if (remaining.length === 0) return carriageReturn;
      return `${prefix}${action}${separator}${remaining.join(", ")}${trailing}${carriageReturn}`;
    });
}

function removeMigrationPragmas(source, contract) {
  const parsedPragmas = warningPragmas(source);
  for (const [diagnostic, minimum, maximum, required] of [
    ["ASPIREDOTNETPROJECT001", 1, Object.keys(contract.migrate).length, /\bAddDotnetProject(?:BlazorGateway)?\(/],
    ["ASPIREPROJECTS001", contract.efDiagnostic ? 1 : 0, contract.efDiagnostic ? 1 : 0, /\bapi\.AddEFMigrations\(/]
  ]) {
    const pragmas = parsedPragmas.filter(pragma => pragma.ids.includes(diagnostic));
    const coveredResources = new Set();
    assert.ok(pragmas.length >= minimum * 2 && pragmas.length <= maximum * 2,
      `Missing or excessive ${diagnostic} suppressions`);
    assert.equal(pragmas.length % 2, 0, "Unpaired experimental diagnostic suppression");
    for (let index = 0; index < pragmas.length; index += 2) {
      assert.equal(pragmas[index].action, "disable", "Expected a paired disable");
      assert.equal(pragmas[index + 1].action, "restore", "Expected a paired restore");
      const rawBody = source.slice(pragmas[index].index + pragmas[index].text.length, pragmas[index + 1].index);
      const body = compactCode(rawBody);
      assert.match(body, required, `${diagnostic} does not cover the required migration call`);
      assert.doesNotMatch(body, /DistributedApplication\.CreateBuilder\(|builder\.Build\(/,
        "Experimental suppression extends beyond resource declarations");
      if (diagnostic === "ASPIREDOTNETPROJECT001") {
        for (const call of registrations(rawBody).found) {
          if (/^AddDotnetProject(?:BlazorGateway)?$/.test(call.method)) coveredResources.add(call.name);
        }
      }
      if (diagnostic === "ASPIREPROJECTS001") {
        assert.doesNotMatch(body, /\bAddDotnetProject|api\.WaitForCompletion\(/,
          "EF suppression extends beyond its migrations declaration");
      }
    }
    if (diagnostic === "ASPIREDOTNETPROJECT001") {
      const uncovered = registrations(source).found
        .filter(call => call.name in contract.migrate && /^AddDotnetProject(?:BlazorGateway)?$/.test(call.method))
        .map(call => call.name)
        .filter(name => !coveredResources.has(name));
      assert.equal(uncovered.length, 0,
        `${diagnostic} does not cover migrated resource${uncovered.length === 1 ? "" : "s"} ${uncovered.join(", ")}`);
    }
  }
  return removeMigrationDiagnostics(source);
}

function assertSource(before, after, contract) {
  let baseline = before;
  let candidate = after;
  const ts = contract.source.endsWith(".mts");
  if (contract.removeLegacyGatewayDockerfileMutation) {
    baseline = removeLegacyGatewayDockerfileMutation(baseline);
    assert.doesNotMatch(compactCode(candidate),
      /vargatewayBuild=gateway\.Resource\.Annotations\.OfType<DockerfileBuildAnnotation>\(\)\.SingleOrDefault\(\);/,
      "Obsolete gateway Dockerfile image mutation must be removed");
  }
  if (contract.appHost === "apphost.cs") {
    const directives = candidate.match(/^#:package Aspire\.Hosting\.Dotnet@[^\r\n]+/gm) ?? [];
    assert.equal(directives.length, 1, "Expected one matching Dotnet package directive");
    const version = /^#:sdk Aspire\.AppHost\.Sdk@([^\r\n]+)/m.exec(before)?.[1]
      ?? /^#:package Aspire\.Hosting\.AppHost@([^\r\n]+)/m.exec(before)?.[1];
    assert.ok(version, "Unresolved file AppHost package version");
    assert.equal(directives[0], `#:package Aspire.Hosting.Dotnet@${version}`);
    candidate = candidate.replace(/^#:package Aspire\.Hosting\.Dotnet@[^\r\n]+\r?\n?/gm, "");
    const legacyPragma = /^\s*#pragma warning (?:disable|restore) ASPIRECSHARPAPPS001\s*$/gm;
    baseline = baseline.replace(legacyPragma, "");
    candidate = candidate.replace(legacyPragma, "");
  }
  if (!ts) candidate = removeMigrationPragmas(candidate, contract);
  const previous = registrations(baseline);
  const next = registrations(candidate);
  assert.deepEqual(next.found.map(c => c.name), previous.found.map(c => c.name), "Resource set/order changed");
  const migratedNames = Object.keys(contract.migrate);
  assert.equal(
    normalizeImmediateFluentContinuation(next.stripped, migratedNames),
    normalizeImmediateFluentContinuation(previous.stripped, migratedNames),
    "Non-migration code/fluent behavior changed"
  );
  for (const call of next.found) {
    if (!(call.name in contract.migrate)) {
      assert.deepEqual([call.method, call.args],
        previous.found.filter(c => c.name === call.name).map(c => [c.method, c.args])[0],
        `Unapproved resource migration: ${call.name}`);
      continue;
    }
    const path = contract.migrate[call.name];
    assert.equal(call.method, path === null ? "AddDotnetProjectBlazorGateway" : ts ? "addDotnetProject" : "AddDotnetProject",
      `Wrong target for ${call.name}`);
    if (path !== null) {
      const actual = /^["'][^"']+["'],@?["']([^"']+)["']/.exec(call.args);
      assert.ok(actual, `Missing literal target path for ${call.name}`);
      assert.equal(normalizedPath(actual[1]), path, `Wrong path for ${call.name}`);
      const options = call.args.slice(actual[0].length);
      const profile = contract.profiles[call.name];
      if (profile === undefined) {
        assert.equal(options, "", `Default options changed for ${call.name}`);
      } else if (ts) {
        assert.match(options, new RegExp(`^,\\{launchProfileName:["']${profile}["'],?\\}$`),
          `Expected flat named-profile DTO for ${call.name}`);
      } else {
        const property = profile === false ? "ExcludeLaunchProfile" : "LaunchProfileName";
        const value = profile === false ? "true" : `"${profile}"`;
        const assignment = new RegExp(`^,([A-Za-z_]\\w*)=>(?:\\{)?\\1\\.${property}=${value};?(?:\\})?$`);
        assert.match(options, assignment, `Wrong launch-profile mapping for ${call.name}`);
      }
    } else assert.equal(call.args, `"${call.name}"`, "Gateway options changed");
  }
}

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w.:-]+)\s*=\s*["']([^"']*)["']/g)]
    .map(match => [match[1], match[2]]));
}

function xmlElements(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${name}>)`, "g"))]
    .map(match => {
      const text = match[0];
      const openingEnd = text.indexOf(">");
      const opening = text.slice(0, openingEnd + 1);
      const innerContent = /\/\s*>$/.test(opening)
        ? ""
        : text.slice(openingEnd + 1, text.lastIndexOf(`</${name}>`));
      return { text, innerContent, attributes: attributes(text.slice(0, openingEnd)) };
    });
}

function compactXml(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<([\w.:-]+)(\s[^<>]*?)(\/?)>/g, (_, name, attrs, end) =>
      `<${name}${JSON.stringify(Object.entries(attributes(attrs)).sort())}${end}>`)
    .replace(/\s+/g, "").replace(/<ItemGroup><\/ItemGroup>/g, "");
}

function assertProject(before, after, removed = [], central = false) {
  const additions = xmlElements(after, central ? "PackageVersion" : "PackageReference")
    .filter(item => item.attributes.Include === "Aspire.Hosting.Dotnet");
  assert.equal(additions.length, 1, "Expected exactly one Dotnet package entry");
  const expected = { Include: "Aspire.Hosting.Dotnet" };
  if (central || /<AspireVersion>/.test(before)) expected.Version = "$(AspireVersion)";
  assert.deepEqual(additions[0].attributes, expected, "Package version ownership changed");
  assert.match(additions[0].innerContent, /^\s*$/, "Unexpected Dotnet package child content");
  let previous = before;
  for (const path of removed) {
    const reference = xmlElements(previous, "ProjectReference")
      .find(item => normalizedPath(item.attributes.Include ?? "") === path);
    assert.ok(reference, `Missing original resource reference ${path}`);
    previous = previous.replace(reference.text, "");
  }
  assert.equal(compactXml(after.replace(additions[0].text, "")), compactXml(previous),
    "Unexpected project/package/reference changes");
}

export function assertEditedFixture(beforeRoot, afterRoot, caseName, diff) {
  const contract = editCases[caseName];
  assert.ok(contract, `Unknown migration case: ${caseName}`);
  const changes = assertFileBoundary(snapshotFiles(beforeRoot), snapshotFiles(afterRoot), contract.files);
  assert.ok(changes.includes(contract.source), "Missing actual migrated source");
  if (diff !== undefined) assertDiffBoundary(diff, contract.files);
  const before = path => readFileSync(join(beforeRoot, path), "utf8");
  const after = path => readFileSync(join(afterRoot, path), "utf8");
  assertSource(before(contract.source), after(contract.source), contract);
  if (contract.config) {
    const expected = JSON.parse(before(contract.config));
    expected.packages["Aspire.Hosting.Dotnet"] = expected.packages["Aspire.Hosting.AppHost"];
    assert.deepEqual(JSON.parse(after(contract.config)), expected, "Unexpected TypeScript configuration changes");
  } else if (contract.appHost.endsWith(".csproj")) {
    assertProject(before(contract.appHost), after(contract.appHost), contract.removeReferences);
    if (contract.files.includes("Directory.Packages.props")) {
      assertProject(before("Directory.Packages.props"), after("Directory.Packages.props"), [], true);
    }
  }
  return changes;
}
