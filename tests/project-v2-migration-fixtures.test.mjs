import assert from "node:assert/strict";
import { appendFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertNoEditSnapshot,
  captureNoEditSnapshot,
} from "../evals/project-v2-migration/no-edit-regression.mjs";

const csharpAppHost = readFileSync(
  new URL("../evals/project-v2-migration/runnable-csharp/Migration.AppHost/Program.cs", import.meta.url),
  "utf8"
);
const typescriptAppHost = readFileSync(
  new URL("../evals/project-v2-migration/runnable-csharp/Migration.TypeScriptAppHost/apphost.mts", import.meta.url),
  "utf8"
);
const typescriptNamedAppHost = readFileSync(
  new URL("../evals/project-v2-migration/typescript-named/apphost.mts", import.meta.url),
  "utf8"
);
const typescriptHandleOnlyApi = readFileSync(
  new URL("../evals/project-v2-migration/typescript/handle-only-api.mts", import.meta.url),
  "utf8"
);
const workerLaunchSettings = JSON.parse(
  readFileSync(
    new URL("../evals/project-v2-migration/runnable-csharp/Migration.Worker/Properties/launchSettings.json", import.meta.url),
    "utf8"
  )
);
const fileAppHost = readFileSync(
  new URL("../evals/project-v2-migration/file-app/apphost.cs", import.meta.url),
  "utf8"
);
const fileAppService = readFileSync(
  new URL("../evals/project-v2-migration/file-app/file-api.cs", import.meta.url),
  "utf8"
);
const blazorEfAppHost = readFileSync(
  new URL("../evals/project-v2-migration/blazor-ef/AppHost.csproj", import.meta.url),
  "utf8"
);
const blazorEfProgram = readFileSync(
  new URL("../evals/project-v2-migration/blazor-ef/Program.cs", import.meta.url),
  "utf8"
);

test("Project v2 plugin mirrors have exact relative targets without trailing bytes", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const skill = "aspire-project-v2-migration";
  for (const path of [
    "SKILL.md",
    "references/migration-patterns.md",
    "references/compatibility-and-validation.md",
  ]) {
    const mirror = join(root, ".github", "plugins", "aspire-skills", "skills", skill, path);
    const source = join(root, "skills", skill, path);
    const expected = relative(dirname(mirror), source).split(sep).join("/");
    const actual = lstatSync(mirror).isSymbolicLink()
      ? readlinkSync(mirror)
      : readFileSync(mirror, "utf8");
    assert.equal(actual, expected);
  }
});

test("Project v2 C# fixture binds health checks to the intended endpoints", () => {
  assert.match(csharpAppHost, /\.WithHttpHealthCheck\("\/", endpointName: "http"\)/);
  assert.match(csharpAppHost, /\.WithHttpEndpoint\(name: "status"\)[\s\S]*\.WithHttpHealthCheck\("\/", endpointName: "status"\)/);
});

test("Project v2 TypeScript fixture uses health-check option objects with named endpoints", () => {
  assert.match(typescriptAppHost, /\.withHttpHealthCheck\(\{ path: "\/", endpointName: "http" \}\)/);
  assert.match(typescriptAppHost, /\.withHttpEndpoint\(\{ name: "status" \}\)[\s\S]*\.withHttpHealthCheck\(\{ path: "\/", endpointName: "status" \}\)/);
  assert.doesNotMatch(typescriptAppHost, /\.withHttpHealthCheck\("\/"\)/);
});

test("Project v2 TypeScript fixture preserves default launch-profile semantics", () => {
  assert.match(typescriptAppHost, /\.addProject\("worker", "\.\.\/Migration\.Worker\/Migration\.Worker\.csproj"\)/);
  assert.equal(
    workerLaunchSettings.profiles["should-not-be-used"].commandLineArgs,
    "--wrong-profile-argument"
  );
  assert.equal(
    workerLaunchSettings.profiles["should-not-be-used"].environmentVariables.PROFILE_MARKER,
    "must-not-appear"
  );
});

test("Project v2 TypeScript option fixtures distinguish legacy, DTO, and handle shapes", () => {
  assert.match(
    typescriptNamedAppHost,
    /addProject\("named-api", "\.\.\/Api\/Api\.csproj", \{\s*launchProfileOrOptions: "http"\s*\}\)/
  );
  assert.match(typescriptNamedAppHost, /await api\.withReplicas\(2\)/);
  assert.match(typescriptHandleOnlyApi, /options\?: Awaitable<ProjectResourceOptions>/);
  assert.match(typescriptHandleOnlyApi, /launchProfileName: Property<string \| null>/);
  assert.match(typescriptHandleOnlyApi, /excludeLaunchProfile: Property<boolean>/);
  assert.match(typescriptHandleOnlyApi, /excludeKestrelEndpoints: Property<boolean>/);

  const patterns = readFileSync(
    new URL("../skills/aspire-project-v2-migration/references/migration-patterns.md", import.meta.url),
    "utf8"
  );
  assert.match(patterns, /addDotnetProject\("api", "\.\.\/Api\/Api\.csproj", \{\s*launchProfileName: "https"/);
  assert.match(patterns, /excludeLaunchProfile: true/);
  assert.match(patterns, /excludeKestrelEndpoints: true/);
  assert.match(patterns, /property\.get\(\)/);
  assert.match(patterns, /Do not nest the DTO under `options`/);
  assert.match(patterns, /does not rewrite or\s+disable the service's own Kestrel configuration/);
});

test("Project v2 file-app fixture uses a resolvable sibling Web app", () => {
  assert.match(fileAppHost, /AddCSharpApp\("file-api", "file-api\.cs"\)/);
  assert.match(fileAppHost, /^#:property AspireUseCliBundle=true$/m);
  assert.match(fileAppHost, /^#pragma warning disable ASPIRECSHARPAPPS001$/m);
  assert.match(fileAppHost, /^#pragma warning restore ASPIRECSHARPAPPS001$/m);
  assert.match(fileAppService, /^#:sdk Microsoft\.NET\.Sdk\.Web$/m);
  assert.match(fileAppService, /^#:property PublishAot=true$/m);
});

test("Project v2 Blazor and EF fixture uses current APIs with resolvable metadata", () => {
  for (const packageName of [
    "Aspire.Hosting.Blazor",
    "Aspire.Hosting.EntityFrameworkCore",
    "Aspire.Hosting.PostgreSQL",
  ]) {
    assert.match(blazorEfAppHost, new RegExp(`PackageReference Include="${packageName.replaceAll(".", "\\.")}"`));
  }
  for (const metadataName of ["Api", "Migrations", "Client"]) {
    assert.match(blazorEfAppHost, new RegExp(`AspireProjectMetadataTypeName="${metadataName}"`));
  }
  assert.match(blazorEfProgram, /api\.AddEFMigrations\("api-migrations"\)/);
  assert.match(blazorEfProgram, /\.WithMigrationsProject<Projects\.Migrations>\(\)/);
});

test("Project v2 no-edit evals make every guard mandatory", () => {
  const evalSpec = readFileSync(
    new URL("../skills/aspire-project-v2-migration/evals/eval.yaml", import.meta.url),
    "utf8"
  );
  assert.match(evalSpec, /scoring:\s+threshold: 1\.0/);

  for (const name of [
    "project-v2-assessment-before-edits",
    "project-v2-ineligible-13-5",
    "project-v2-conflicting-version",
    "project-v2-unresolved-version",
    "project-v2-typescript-options-blocked",
    "project-v2-unsupported-assessment",
    "project-v2-file-app-aot-assessment",
  ]) {
    const start = evalSpec.indexOf(`- name: ${name}`);
    const next = evalSpec.indexOf("\n  - name:", start + 1);
    const stimulus = evalSpec.slice(start, next === -1 ? undefined : next);
    assert.match(stimulus, /- type: diff-empty/, `${name} must require an empty workspace diff`);
  }
});

test("Project v2 byte guards reject application and package mutations", () => {
  const source = new URL("../evals/project-v2-migration/runnable-csharp/", import.meta.url);
  const root = mkdtempSync(join(tmpdir(), "project-v2-no-edit-"));
  const paths = [
    "Directory.Packages.props",
    "Migration.AppHost/Migration.AppHost.csproj",
    "Migration.AppHost/Program.cs",
    "Migration.Api/Program.cs",
    "Migration.Api/Properties/launchSettings.json",
    "Migration.Shared/FixtureContract.cs",
  ];

  for (const path of paths) {
    const destination = join(root, path);
    mkdirSync(join(destination, ".."), { recursive: true });
    cpSync(new URL(path, source), destination);
  }

  const snapshot = captureNoEditSnapshot(root, paths);
  const mutations = [
    "Directory.Packages.props",
    "Migration.AppHost/Migration.AppHost.csproj",
    "Migration.AppHost/Program.cs",
    "Migration.Api/Properties/launchSettings.json",
    "Migration.Api/Program.cs",
    "Migration.Shared/FixtureContract.cs",
  ];

  try {
    for (const path of mutations) {
      const original = readFileSync(join(root, path));
      appendFileSync(join(root, path), "\nmutation");
      assert.throws(() => assertNoEditSnapshot(root, snapshot), /changed/);
      writeFileSync(join(root, path), original);
    }

    writeFileSync(join(root, "unexpected.txt"), "mutation");
    assert.throws(() => assertNoEditSnapshot(root, snapshot), /file set changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
