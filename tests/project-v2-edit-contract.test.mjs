import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import {
  assertDiffBoundary, assertEditedFixture, assertFileBoundary, editCases, prepareFixture, snapshotFiles
} from "../scripts/project-v2-edit-contract.mjs";

const fixturesRoot = fileURLToPath(new URL("../evals/project-v2-migration", import.meta.url));

function fixture(t, caseName = "csharp", lineEnding) {
  const root = mkdtempSync(join(tmpdir(), "project-v2-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = join(root, "before");
  const after = join(root, "after");
  prepareFixture(before, caseName, fixturesRoot);
  if (lineEnding) setLineEndings(before, editCases[caseName].files, lineEnding);
  cpSync(before, after, { recursive: true });
  return { root, before, after };
}

function setLineEndings(root, paths, lineEnding) {
  for (const path of paths) {
    const absolute = join(root, path);
    writeFileSync(absolute, readFileSync(absolute, "utf8").replace(/\r?\n/g, lineEnding));
  }
}

function edit(root, path, change) {
  const absolute = join(root, path);
  const before = readFileSync(absolute, "utf8");
  const after = change(before);
  assert.notEqual(after, before, `Test mutation did not change ${path}`);
  writeFileSync(absolute, after);
}

function mutateCsharp(root, subset = false) {
  edit(root, editCases.csharp.source, source => {
    let result = source.replace('AddProject<Projects.CatalogApi>("api", launchProfileName: "http")',
      'AddDotnetProject("api", "../Migration.Api/Migration.Api.csproj", profile => { profile.LaunchProfileName = "http"; })');
    if (!subset) result = result.replace('AddProject<Projects.Migration_Worker>("worker", launchProfileName: null)',
      'AddDotnetProject("worker", "../Migration.Worker/Migration.Worker.csproj", p => p.ExcludeLaunchProfile = true)');
    return result.replace("var api =", "#pragma warning disable ASPIREDOTNETPROJECT001\nvar api =")
      .replace("builder.Build().Run();", "#pragma warning restore ASPIREDOTNETPROJECT001\nbuilder.Build().Run();");
  });
  edit(root, editCases.csharp.appHost, source => {
    const removed = subset ? "Api" : "(?:Api|Worker)";
    return source.replace(new RegExp(`<ProjectReference Include="[^"]*Migration\\.${removed}[^"]*"[^>]*\\/>`, "g"), "")
      .replace("</Project>", "<ItemGroup><PackageReference Include = 'Aspire.Hosting.Dotnet'></PackageReference></ItemGroup></Project>");
  });
  edit(root, "Directory.Packages.props", source => source.replace("</Project>",
    '<ItemGroup><PackageVersion Version = "$(AspireVersion)" Include = "Aspire.Hosting.Dotnet" /></ItemGroup></Project>'));
}

function combineCsharpMigrationPragmas(root, diagnostics) {
  edit(root, editCases.csharp.source, source => source
    .replace(
      "#pragma warning disable ASPIREPIPELINES003\n#pragma warning disable ASPIREDOTNETPROJECT001",
      `#pragma warning disable ${diagnostics}`
    )
    .replace(
      /#pragma warning restore ASPIREPIPELINES003\r?\n\r?\n#pragma warning restore ASPIREDOTNETPROJECT001/,
      `#pragma warning restore ${diagnostics}`
    ));
}

function removeLegacyGatewayDockerfileMutation(source) {
  const marker = "var gatewayBuild = gateway.Resource.Annotations";
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, "Missing test gateway Dockerfile mutation");
  const start = source.lastIndexOf("#pragma warning disable ASPIREPIPELINES003", markerIndex);
  const restore = "#pragma warning restore ASPIREPIPELINES003";
  const restoreIndex = source.indexOf(restore, markerIndex);
  assert.notEqual(start, -1, "Missing test gateway Dockerfile suppression");
  assert.notEqual(restoreIndex, -1, "Missing test gateway Dockerfile restore");
  const lineEnd = source.indexOf("\n", restoreIndex + restore.length);
  const end = lineEnd === -1 ? source.length : lineEnd + 1;
  return source.slice(0, start) + source.slice(end);
}

function mutateBlazor(root, removeLegacyMutation = true) {
  edit(root, "Program.cs", source => {
    const result = source.replace('var api = builder.AddProject<Projects.Api>("api")',
      '#pragma warning disable ASPIREDOTNETPROJECT001\nvar api = builder.AddDotnetProject("api", "Api/Api.csproj")')
      .replace("api.WithContainerBuildOptions", "#pragma warning restore ASPIREDOTNETPROJECT001\napi.WithContainerBuildOptions")
      .replace('var gateway = builder.AddBlazorGateway("gateway")',
        '#pragma warning disable ASPIREDOTNETPROJECT001\nvar gateway = builder.AddDotnetProjectBlazorGateway("gateway")')
      .replace("gateway.WithContainerBuildOptions", "#pragma warning restore ASPIREDOTNETPROJECT001\ngateway.WithContainerBuildOptions")
      .replace("var migrations = api.AddEFMigrations",
        "#pragma warning disable ASPIREPROJECTS001\nvar migrations = api.AddEFMigrations")
      .replace("migrations.WithContainerBuildOptions",
        "#pragma warning restore ASPIREPROJECTS001\nmigrations.WithContainerBuildOptions");
    return removeLegacyMutation ? removeLegacyGatewayDockerfileMutation(result) : result;
  });
  edit(root, "AppHost.csproj", source => source.replace("</Project>",
    '<ItemGroup><PackageReference Include="Aspire.Hosting.Dotnet" Version="$(AspireVersion)" /></ItemGroup></Project>'));
}

test("every edit case has a program contract and every assessment is no-edit", () => {
  const spec = parse(readFileSync(new URL("../skills/aspire-project-v2-migration/evals/eval.yaml", import.meta.url), "utf8"));
  assert.equal(spec.scoring.threshold, 1);
  assert.equal(spec.environment.skills.length, 7);
  for (const caseName of Object.keys(editCases)) {
    const stimuli = spec.stimuli.filter(stimulus => stimulus.tags?.integration === caseName);
    assert.equal(stimuli.length, 1, `Missing or duplicated edit case: ${caseName}`);
    assert.ok(stimuli[0].graders.some(grader => grader.type === "program" && grader.config.args.includes(caseName)));
  }
  for (const stimulus of spec.stimuli.filter(stimulus => !stimulus.tags?.integration)) {
    assert.ok(stimulus.graders.some(grader => grader.type === "diff-empty"), `${stimulus.name} needs a no-edit guard`);
  }
  const full = spec.stimuli.find(stimulus => stimulus.tags?.integration === "csharp");
  assert.ok(full.graders.some(grader => grader.type === "diff-empty" && grader.turn === 1));
});

test("source mutation controls are not substituted agent outputs", () => {
  const grader = readFileSync(new URL("../evals/project-v2-migration/grade-edit.mjs", import.meta.url), "utf8");
  assert.match(grader, /EVALUATE_WORKSPACE/);
  assert.match(grader, /input\.trajectory\?\.diff/);
  assert.match(grader, /"apply", "--reverse", "--check"/);
  assert.doesNotMatch(grader, /mutateCsharp|mutateBlazor|test-project-v2-migration/);
});

test("source mutation controls reject unchanged input", t => {
  const { after } = fixture(t);
  assert.throws(() => edit(after, editCases.csharp.source, source => source), /Test mutation did not change/);
});

test("gateway image decisions have read-only controls and a separately approved edit case", () => {
  const spec = parse(readFileSync(new URL("../skills/aspire-project-v2-migration/evals/eval.yaml", import.meta.url), "utf8"));
  const skill = readFileSync(new URL("../skills/aspire-project-v2-migration/SKILL.md", import.meta.url), "utf8");
  for (const name of ["project-v2-blazor-image-change-approval", "project-v2-blazor-unresolved-image-policy"]) {
    const stimulus = spec.stimuli.find(item => item.name === name);
    assert.ok(stimulus, `Missing gateway approval control: ${name}`);
    assert.ok(stimulus.graders.some(grader => grader.type === "diff-empty"));
    assert.ok(stimulus.graders.some(grader => grader.type === "prompt" && grader.config.scoring === "binary"));
    assert.equal(stimulus.tags.integration, undefined);
  }
  const approved = spec.stimuli.find(item => item.tags?.integration === "blazor-ef");
  assert.match(approved.prompt, /separately approve the resolved gateway/);
  assert.match(approved.prompt, /root to UID 1654/);
  assert.match(approved.prompt, /do not\s+retarget service\/client source/);
  assert.match(approved.prompt, /Remove only the obsolete publish-mode gateway DockerfileBuildAnnotation/);
  assert.match(approved.prompt, /gateway\.WithContainerBuildOptions/);
  assert.match(skill, /final question:[\s\S]*?gateway bounded discovery/);
  assert.match(skill, /Never end with only API-edit[\s\S]*?gateway is still decision-required/);
  const evidence = JSON.parse(readFileSync(join(fixturesRoot, "gateway-publishing-evidence.json"), "utf8"));
  assert.match(evidence.purpose, /not proof of installed packages or completed validation/);
  assert.equal(evidence.before.targetFramework, "net10.0");
  assert.equal(evidence.after.targetFramework, "net11.0");
  assert.equal(evidence.before.effectiveUser, "root");
  assert.equal(evidence.after.effectiveUser, "1654");
});

test("file apps preserve AOT and the negative TypeScript input remains handle-only", () => {
  const fileApp = readFileSync(join(fixturesRoot, "file-app/file-api.cs"), "utf8");
  assert.match(fileApp, /^#:property PublishAot=true$/m);
  const handle = readFileSync(join(fixturesRoot, "typescript/handle-only-api.mts"), "utf8");
  assert.match(handle, /options\?: Awaitable<ProjectResourceOptions>/);
  assert.match(handle, /excludeLaunchProfile: Property<boolean>/);
  assert.doesNotMatch(handle, /interface DotnetProjectOptions/);
});

test("source contract tolerates layout/attribute order/lambda naming without weakening scope", t => {
  const { before, after } = fixture(t);
  mutateCsharp(after);
  assert.deepEqual(assertEditedFixture(before, after, "csharp"), editCases.csharp.files.toSorted());
});

test("project package entries accept self-closing and explicitly empty forms", t => {
  const { before, after } = fixture(t);
  mutateCsharp(after);
  edit(after, editCases.csharp.appHost, source => source.replace(
    "<PackageReference Include = 'Aspire.Hosting.Dotnet'></PackageReference>",
    '<PackageReference Include="Aspire.Hosting.Dotnet" />'
  ));
  edit(after, "Directory.Packages.props", source => source.replace(
    '<PackageVersion Version = "$(AspireVersion)" Include = "Aspire.Hosting.Dotnet" />',
    '<PackageVersion Include="Aspire.Hosting.Dotnet" Version="$(AspireVersion)">\n  \n</PackageVersion>'
  ));
  assertEditedFixture(before, after, "csharp");
});

for (const [name, path, mutate] of [
  ["PackageReference", editCases.csharp.appHost, source => source.replace(
    "<PackageReference Include = 'Aspire.Hosting.Dotnet'></PackageReference>",
    '<PackageReference Include="Aspire.Hosting.Dotnet"><Version>13.5.3</Version></PackageReference>'
  )],
  ["PackageVersion", "Directory.Packages.props", source => source.replace(
    '<PackageVersion Version = "$(AspireVersion)" Include = "Aspire.Hosting.Dotnet" />',
    '<PackageVersion Include="Aspire.Hosting.Dotnet" Version="$(AspireVersion)"><Version>13.5.3</Version></PackageVersion>'
  )]
]) {
  test(`project package contract rejects nested ${name} metadata`, t => {
    const { before, after } = fixture(t);
    mutateCsharp(after);
    edit(after, path, mutate);
    assert.throws(() => assertEditedFixture(before, after, "csharp"), /package child content/);
  });
}

for (const diagnostics of [
  "ASPIREPIPELINES003, ASPIREDOTNETPROJECT001",
  "ASPIREDOTNETPROJECT001, ASPIREPIPELINES003"
]) {
  test(`source contract preserves combined warning pragmas: ${diagnostics}`, t => {
    const { before, after } = fixture(t);
    mutateCsharp(after);
    combineCsharpMigrationPragmas(after, diagnostics);
    assertEditedFixture(before, after, "csharp");
  });
}

test("source contract rejects an unpaired combined migration diagnostic", t => {
  const { before, after } = fixture(t);
  mutateCsharp(after);
  combineCsharpMigrationPragmas(after, "ASPIREPIPELINES003, ASPIREDOTNETPROJECT001");
  edit(after, editCases.csharp.source, source => source.replace(
    "#pragma warning restore ASPIREPIPELINES003, ASPIREDOTNETPROJECT001",
    "#pragma warning restore ASPIREPIPELINES003"
  ));
  assert.throws(() => assertEditedFixture(before, after, "csharp"),
    /Missing or excessive ASPIREDOTNETPROJECT001/);
});

test("source contract rejects a migration diagnostic that covers no migration call", t => {
  const { before, after } = fixture(t);
  mutateCsharp(after);
  edit(after, editCases.csharp.source, source => source
    .replace("#pragma warning disable ASPIREDOTNETPROJECT001\n", "")
    .replace("#pragma warning restore ASPIREDOTNETPROJECT001\n", "")
    .replace(
      'var cache = builder.AddRedis("cache");',
      '#pragma warning disable ASPIREDOTNETPROJECT001\nvar cache = builder.AddRedis("cache");\n#pragma warning restore ASPIREDOTNETPROJECT001'
    ));
  assert.throws(() => assertEditedFixture(before, after, "csharp"),
    /ASPIREDOTNETPROJECT001 does not cover the required migration call/);
});

test("source contract rejects a migration diagnostic extending through build", t => {
  const { before, after } = fixture(t);
  mutateCsharp(after);
  edit(after, editCases.csharp.source, source => source.replace(
    "#pragma warning restore ASPIREDOTNETPROJECT001\nbuilder.Build().Run();",
    "builder.Build().Run();\n#pragma warning restore ASPIREDOTNETPROJECT001"
  ));
  assert.throws(() => assertEditedFixture(before, after, "csharp"),
    /Experimental suppression extends beyond resource declarations/);
});

test("subset keeps worker registration and build edge", t => {
  const { before, after } = fixture(t, "subset");
  mutateCsharp(after, true);
  assertEditedFixture(before, after, "subset");
  edit(after, editCases.subset.appHost, text => text.replace(/<ProjectReference Include="[^"]*Migration\.Worker[^"]*"[^>]*\/>/, ""));
  assert.throws(() => assertEditedFixture(before, after, "subset"), /reference changes/);
});

test("source contract accepts an immediate same-variable fluent continuation", t => {
  const { before, after } = fixture(t, "subset");
  mutateCsharp(after, true);
  edit(after, editCases.subset.source, source => source.replace(
    /profile => \{ profile\.LaunchProfileName = "http"; \}\)\r?\n    \.WithReference\(cache\)/,
    'profile => { profile.LaunchProfileName = "http"; });\napi.WithReference(cache)'
  ));
  assertEditedFixture(before, after, "subset");
});

test("source contract rejects an interleaved split fluent continuation", t => {
  const { before, after } = fixture(t, "subset");
  mutateCsharp(after, true);
  edit(after, editCases.subset.source, source => source.replace(
    /profile => \{ profile\.LaunchProfileName = "http"; \}\)\r?\n    \.WithReference\(cache\)/,
    'profile => { profile.LaunchProfileName = "http"; });\nConsole.WriteLine("changed");\napi.WithReference(cache)'
  ));
  assert.throws(() => assertEditedFixture(before, after, "subset"), /fluent behavior/);
});

for (const [name, mutate, error] of [
  ["only one resource migrated", text => text.replace('AddDotnetProject("worker"', 'AddCSharpApp("worker"'), /Wrong target for worker/],
  ["C# null treated as default", text => text.replace("p.ExcludeLaunchProfile = true", 'p.LaunchProfileName = "http"'), /launch-profile mapping/],
  ["replica dropped", text => text.replace(".WithReplicas(2)", ".WithReplicas(1)"), /fluent behavior/],
  ["image settings changed", text => text.replace('"validation"', '"different"'), /fluent behavior/],
  ["reference removed", text => text.replace(".WithReference(cache)", ""), /fluent behavior/],
  ["runtime environment changed", text => text.replace('"MIGRATION_MARKER"', '"SOMETHING_ELSE"'), /fluent behavior/]
]) {
  test(`source contract rejects ${name}`, t => {
    const { before, after } = fixture(t);
    mutateCsharp(after);
    edit(after, editCases.csharp.source, mutate);
    assert.throws(() => assertEditedFixture(before, after, "csharp"), error);
  });
}

test("source contract rejects missing actual edits and application file changes", t => {
  const { before, after } = fixture(t);
  assert.throws(() => assertEditedFixture(before, after, "csharp"), /Missing actual migrated source/);
  mutateCsharp(after);
  edit(after, "Migration.Api/Program.cs", text => `${text}\n// not approved\n`);
  assert.throws(() => assertEditedFixture(before, after, "csharp"), /Unapproved file change/);
});

test("file-set guards detect creation, deletion, and absent evidence", t => {
  const { before, after } = fixture(t);
  const initial = snapshotFiles(before);
  assertFileBoundary(initial, snapshotFiles(after));
  const path = join(after, "unexpected.txt");
  writeFileSync(path, "unexpected");
  assert.throws(() => assertFileBoundary(initial, snapshotFiles(after)), /Unapproved file change/);
  rmSync(path);
  rmSync(join(after, "Migration.Api/Program.cs"));
  assert.throws(() => assertFileBoundary(initial, snapshotFiles(after)), /Unapproved file change/);
  const empty = join(after, "empty");
  mkdirSync(empty);
  assert.throws(() => snapshotFiles(empty), /Missing fixture files/);
  assert.throws(() => assertDiffBoundary(undefined, []), /Missing captured/);
  assert.throws(() => assertDiffBoundary("", []), /actual agent edit/);
  assert.throws(() => assertDiffBoundary("diff --git a/aspire/SKILL.md b/aspire/SKILL.md", editCases.csharp.files), /Unapproved workspace edit/);
});

test("TypeScript checks both resources and configuration ownership", t => {
  const { before, after } = fixture(t, "typescript");
  const contract = editCases.typescript;
  edit(after, contract.source, text => text.replaceAll(".addProject(", ".addDotnetProject("));
  edit(after, contract.config, text => {
    const config = JSON.parse(text);
    config.packages["Aspire.Hosting.Dotnet"] = "13.6.0-dev";
    return JSON.stringify(config);
  });
  assertEditedFixture(before, after, "typescript");
  edit(after, contract.source, text => text.replace('.addDotnetProject("worker"', '.addProject("worker"'));
  assert.throws(() => assertEditedFixture(before, after, "typescript"), /Wrong target for worker/);
});

for (const [endingName, lineEnding] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
  test(`specialized contract requires obsolete gateway Dockerfile cleanup with ${endingName} line endings`, t => {
    const { before, after } = fixture(t, "blazor-ef", lineEnding);
    mutateBlazor(after, false);
    setLineEndings(after, editCases["blazor-ef"].files, lineEnding);
    assert.throws(() => assertEditedFixture(before, after, "blazor-ef"),
      /Obsolete gateway Dockerfile image mutation must be removed/);
  });

  for (const [name, mutate, error] of [
    ["missing EF diagnostic", source => source.replace(/^#pragma warning (?:disable|restore) ASPIREPROJECTS001\r?\n/gm, ""), /Missing or excessive ASPIREPROJECTS001/],
    ["unpaired EF diagnostic", source => source.replace("#pragma warning restore ASPIREPROJECTS001", ""), /Missing or excessive ASPIREPROJECTS001/],
    ["unsuppressed gateway diagnostic", source => source
      .replace(/^#pragma warning disable ASPIREDOTNETPROJECT001\r?\n(?=var gateway)/m, "")
      .replace(/^#pragma warning restore ASPIREDOTNETPROJECT001\r?\n(?=gateway\.WithContainerBuildOptions)/m, ""),
    /ASPIREDOTNETPROJECT001 does not cover migrated resource gateway/],
    ["removed existing Blazor scope", source => source.replace(/^#pragma warning (?:disable|restore) ASPIREBLAZOR001\r?\n/gm, ""), /fluent behavior/],
    ["changed gateway publishing identity", source => source.replace('LocalImageName = $"{imagePrefix}-gateway"', 'LocalImageName = $"{imagePrefix}-wrong"'), /fluent behavior/],
    ["removed client-publish behavior", source => source.replace("clientPublishBuild.HasEntrypoint = false;", ""), /fluent behavior/],
    ["removed gateway target-port behavior", source => source.replace("httpEndpoint.TargetPort = 8080;", ""), /fluent behavior/]
  ]) {
    test(`specialized contract rejects ${name} with ${endingName} line endings`, t => {
      const { before, after } = fixture(t, "blazor-ef", lineEnding);
      mutateBlazor(after);
      setLineEndings(after, editCases["blazor-ef"].files, lineEnding);
      assertEditedFixture(before, after, "blazor-ef");
      edit(after, "Program.cs", mutate);
      assert.throws(() => assertEditedFixture(before, after, "blazor-ef"), error);
    });
  }
}
