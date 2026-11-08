import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { gradeAppHost } from "../../evals/aspireify-experimental-diagnostics/grade-suppressions.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = join(repoRoot, "evals/aspireify-experimental-diagnostics");
const grader = join(fixtures, "grade-suppressions.mjs");

function workspace(t, caseName) {
  const root = mkdtempSync(join(tmpdir(), "aspireify-experimental-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(fixtures, caseName === "file" ? "file-based" : "project-based"), join(root, "app"), { recursive: true });
  return root;
}

function edit(root, path, change) {
  const file = join(root, "app", path);
  // Windows checkouts may convert fixtures to CRLF; the edits match LF text.
  const before = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const after = change(before);
  assert.notEqual(after, before, `Test edit did not change ${path}`);
  writeFileSync(file, after);
}

const wireApi = (path, pragma = "") => source => source.replace(
  "var builder = DistributedApplication.CreateBuilder(args);\n",
  `${pragma}var builder = DistributedApplication.CreateBuilder(args);\n\n` +
  `var api = builder.AddCSharpApp("api", "${path}")\n    .WithHttpsDeveloperCertificate();\n`);

const both = "#pragma warning disable ASPIRECSHARPAPPS001, ASPIRECERTIFICATES001\n\n";
const grade = (root, caseName) => gradeAppHost(join(root, "app"), caseName);

test("grader rejects the unedited fixtures because they do not wire the API", t => {
  for (const caseName of ["file", "project"]) {
    const problems = grade(workspace(t, caseName), caseName);
    assert.ok(problems.some(p => p.includes("does not call AddCSharpApp")), problems.join("\n"));
  }
});

test("file-based AppHost passes with the documented pragma after the #: directives", t => {
  const root = workspace(t, "file");
  edit(root, "apphost.cs", wireApi("./api", both));
  assert.deepEqual(grade(root, "file"), []);
});

test("file-based AppHost fails when the experimental calls are not suppressed", t => {
  const root = workspace(t, "file");
  edit(root, "apphost.cs", wireApi("./api"));
  const problems = grade(root, "file");
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.match(problems.join("\n"), /ASPIRECSHARPAPPS001/);
  assert.match(problems.join("\n"), /ASPIRECERTIFICATES001/);
});

test("file-based AppHost fails when only one diagnostic is suppressed", t => {
  const root = workspace(t, "file");
  edit(root, "apphost.cs", wireApi("./api", "#pragma warning disable ASPIRECSHARPAPPS001\n\n"));
  assert.deepEqual(grade(root, "file").map(p => p.split(" ")[0]), ["WithHttpsDeveloperCertificate"]);
});

test("file-based AppHost fails when the pragma comes after the call or is restored before it", t => {
  const late = workspace(t, "file");
  edit(late, "apphost.cs", wireApi("./api"));
  edit(late, "apphost.cs", source => source.replace("builder.Build().Run();", `${both}builder.Build().Run();`));
  assert.equal(grade(late, "file").length, 2);

  const restored = workspace(t, "file");
  edit(restored, "apphost.cs", wireApi("./api", `${both}#pragma warning restore ASPIRECERTIFICATES001\n`));
  assert.deepEqual(grade(restored, "file").map(p => p.split(" ")[0]), ["WithHttpsDeveloperCertificate"]);
});

test("file-based AppHost fails when a specific ID is restored after a blanket pragma disable", t => {
  const restored = workspace(t, "file");
  edit(restored, "apphost.cs", wireApi("./api", "#pragma warning disable\n#pragma warning restore ASPIRECERTIFICATES001\n\n"));
  assert.deepEqual(grade(restored, "file").map(p => p.split(" ")[0]), ["WithHttpsDeveloperCertificate"]);

  const redisabled = workspace(t, "file");
  edit(redisabled, "apphost.cs", wireApi("./api",
    "#pragma warning disable\n#pragma warning restore ASPIRECERTIFICATES001\n#pragma warning disable ASPIRECERTIFICATES001\n\n"));
  assert.deepEqual(grade(redisabled, "file"), []);
});

test("file-based AppHost checks calls split across lines on the API name's line", t => {
  const unsuppressed = workspace(t, "file");
  edit(unsuppressed, "apphost.cs", source => source.replace("builder.Build().Run();",
    "var api = builder\n    .AddCSharpApp\n    (\"api\", \"./api\")\n    .WithHttpsDeveloperCertificate\n    ();\n\nbuilder.Build().Run();"));
  const problems = grade(unsuppressed, "file");
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.match(problems.join("\n"), /AddCSharpApp in apphost\.cs is not covered/);
  assert.match(problems.join("\n"), /WithHttpsDeveloperCertificate in apphost\.cs is not covered/);

  edit(unsuppressed, "apphost.cs", source => source.replace("var api = builder\n", `${both}var api = builder\n`));
  assert.deepEqual(grade(unsuppressed, "file"), []);
});

test("file-based AppHost ignores #pragma directives inside #if blocks", t => {
  for (const [label, pragma] of Object.entries({
    "#if false": `#if false\n${both}#endif\n`,
    "#else branch": `#if DEBUG\n#else\n${both}#endif\n`,
  })) {
    const root = workspace(t, "file");
    edit(root, "apphost.cs", wireApi("./api", pragma));
    const problems = grade(root, "file").join("\n");
    for (const id of ["ASPIRECSHARPAPPS001", "ASPIRECERTIFICATES001"]) {
      assert.match(problems, new RegExp(`disables ${id} with a #pragma inside an #if`), label);
      assert.match(problems, new RegExp(`is not covered by #pragma warning disable ${id}`), label);
    }
  }
});

test("file-based AppHost treats a conditional #pragma restore after an unconditional disable as restored", t => {
  for (const [label, restore] of Object.entries({
    "#if DEBUG restore of the ID": "#if DEBUG\n#pragma warning restore ASPIRECERTIFICATES001\n#endif\n",
    "#else branch restore of the ID": "#if RELEASE\n#else\n#pragma warning restore ASPIRECERTIFICATES001\n#endif\n",
    "#if DEBUG blanket restore": "#if DEBUG\n#pragma warning restore\n#endif\n",
  })) {
    const root = workspace(t, "file");
    edit(root, "apphost.cs", wireApi("./api", `${both}${restore}`));
    const problems = grade(root, "file").join("\n");
    assert.match(problems, /restores ASPIRECERTIFICATES001 with a #pragma inside an #if/, label);
    assert.match(problems, /WithHttpsDeveloperCertificate in apphost\.cs is not covered/, label);
    assert.equal(/AddCSharpApp in apphost\.cs is not covered/.test(problems), label.includes("blanket"), label);
  }

  const redisabled = workspace(t, "file");
  edit(redisabled, "apphost.cs", wireApi("./api",
    `${both}#if DEBUG\n#pragma warning restore ASPIRECERTIFICATES001\n#endif\n#pragma warning disable ASPIRECERTIFICATES001\n`));
  assert.deepEqual(grade(redisabled, "file"), []);
});

test("file-based AppHost requires the certificate call on the api resource for ./api", t => {
  const unrelated = workspace(t, "file");
  edit(unrelated, "apphost.cs", source => source.replace("builder.Build().Run();", `${both}` +
    'builder.AddCSharpApp("other", "./not-api");\n' +
    'builder.AddContainer("api", "nginx").WithHttpsDeveloperCertificate();\n\nbuilder.Build().Run();'));
  assert.deepEqual(grade(unrelated, "file"), ['apphost.cs does not add the api resource with AddCSharpApp("api", "./api")']);

  const elsewhere = workspace(t, "file");
  edit(elsewhere, "apphost.cs", source => source.replace("builder.Build().Run();", `${both}` +
    'var api = builder.AddCSharpApp("api", "./api");\n' +
    'builder.AddContainer("web", "nginx").WithHttpsDeveloperCertificate();\n\nbuilder.Build().Run();'));
  assert.deepEqual(grade(elsewhere, "file"), ["apphost.cs does not chain WithHttpsDeveloperCertificate() from the api resource"]);

  const inactive = workspace(t, "file");
  edit(inactive, "apphost.cs", wireApi("./api", both));
  edit(inactive, "apphost.cs", source => source.replace('var api = builder.AddCSharpApp("api", "./api")\n    .WithHttpsDeveloperCertificate();\n',
    'builder.AddCSharpApp("other", "./not-api").WithHttpsDeveloperCertificate();\n#if false\n' +
    'builder.AddCSharpApp("api", "./api").WithHttpsDeveloperCertificate();\n#endif\n'));
  assert.deepEqual(grade(inactive, "file"), ['apphost.cs does not add the api resource with AddCSharpApp("api", "./api")']);

  const variable = workspace(t, "file");
  edit(variable, "apphost.cs", source => source.replace("builder.Build().Run();", `${both}` +
    'var api = builder.AddCSharpApp("api", "./api/Api.csproj");\napi.WithHttpsDeveloperCertificate();\n\nbuilder.Build().Run();'));
  assert.deepEqual(grade(variable, "file"), []);
});

test("file-based AppHost ignores a commented-out #:property NoWarn", t => {
  const root = workspace(t, "file");
  edit(root, "apphost.cs", wireApi("./api"));
  edit(root, "apphost.cs", source => source.replace("#:sdk Aspire.AppHost.Sdk@13.6.4\n",
    "#:sdk Aspire.AppHost.Sdk@13.6.4\n/*\n#:property NoWarn=$(NoWarn);ASPIRECSHARPAPPS001;ASPIRECERTIFICATES001\n*/\n"));
  assert.equal(grade(root, "file").length, 2);
});

test("file-based AppHost accepts #:property NoWarn only when it keeps $(NoWarn)", t => {
  const root = workspace(t, "file");
  edit(root, "apphost.cs", wireApi("./api"));
  edit(root, "apphost.cs", source => source.replace("#:sdk Aspire.AppHost.Sdk@13.6.4\n",
    "#:sdk Aspire.AppHost.Sdk@13.6.4\n#:property NoWarn=$(NoWarn);ASPIRECSHARPAPPS001;ASPIRECERTIFICATES001\n"));
  assert.deepEqual(grade(root, "file"), []);

  edit(root, "apphost.cs", source => source.replace("NoWarn=$(NoWarn);", "NoWarn="));
  assert.match(grade(root, "file").join("\n"), /without \$\(NoWarn\)/);
});

test("project-based AppHost passes when the IDs are appended to the existing NoWarn", t => {
  const root = workspace(t, "project");
  edit(root, "AppHost/AppHost.cs", wireApi("../Api"));
  edit(root, "AppHost/AppHost.csproj", source => source.replace("ASPIREPROBES001</NoWarn>",
    "ASPIREPROBES001;ASPIRECSHARPAPPS001;ASPIRECERTIFICATES001</NoWarn>"));
  assert.deepEqual(grade(root, "project"), []);
});

test("project-based AppHost passes with a second NoWarn that chains $(NoWarn) or with a pragma", t => {
  const chained = workspace(t, "project");
  edit(chained, "AppHost/AppHost.cs", wireApi("../Api"));
  edit(chained, "AppHost/AppHost.csproj", source => source.replace("  </PropertyGroup>",
    "    <NoWarn>$(NoWarn);ASPIRECSHARPAPPS001;ASPIRECERTIFICATES001</NoWarn>\n  </PropertyGroup>"));
  assert.deepEqual(grade(chained, "project"), []);

  const pragma = workspace(t, "project");
  edit(pragma, "AppHost/AppHost.cs", wireApi("../Api", both));
  assert.deepEqual(grade(pragma, "project"), []);
});

test("project-based AppHost rejects conditional and commented-out NoWarn suppressions", t => {
  const added = "$(NoWarn);ASPIRECSHARPAPPS001;ASPIRECERTIFICATES001";
  const variants = {
    "a NoWarn Condition": `    <NoWarn Condition="'$(Configuration)' == 'Release'">${added}</NoWarn>\n  </PropertyGroup>`,
    "a PropertyGroup Condition": `  </PropertyGroup>\n  <PropertyGroup Condition="'$(Configuration)' == 'Release'">\n    <NoWarn>${added}</NoWarn>\n  </PropertyGroup>`,
    "a Choose/When": `  </PropertyGroup>\n  <Choose>\n    <When Condition="'$(Configuration)' == 'Release'">\n      <PropertyGroup>\n        <NoWarn>${added}</NoWarn>\n      </PropertyGroup>\n    </When>\n  </Choose>`,
    "an XML comment": `    <!-- <NoWarn>${added}</NoWarn> -->\n  </PropertyGroup>`,
  };
  for (const [label, replacement] of Object.entries(variants)) {
    const root = workspace(t, "project");
    edit(root, "AppHost/AppHost.cs", wireApi("../Api"));
    edit(root, "AppHost/AppHost.csproj", source => source.replace("  </PropertyGroup>", replacement));
    const problems = grade(root, "project").join("\n");
    assert.match(problems, /AddCSharpApp in AppHost\/AppHost\.cs is not covered/, label);
    assert.match(problems, /WithHttpsDeveloperCertificate in AppHost\/AppHost\.cs is not covered/, label);
    if (label !== "an XML comment") assert.match(problems, /sets NoWarn conditionally/, label);
  }
});

test("project-based AppHost requires the api resource to point at ../Api", t => {
  const root = workspace(t, "project");
  edit(root, "AppHost/AppHost.cs", wireApi("../Web", both));
  assert.deepEqual(grade(root, "project"), ['AppHost/AppHost.cs does not add the api resource with AddCSharpApp("api", "../Api")']);
});

test("project-based AppHost fails without a suppression", t => {
  const root = workspace(t, "project");
  edit(root, "AppHost/AppHost.cs", wireApi("../Api"));
  assert.equal(grade(root, "project").length, 2);
});

test("project-based AppHost fails when the existing NoWarn values are not preserved", t => {
  const replaced = workspace(t, "project");
  edit(replaced, "AppHost/AppHost.cs", wireApi("../Api"));
  edit(replaced, "AppHost/AppHost.csproj", source => source.replace("$(NoWarn);ASPIREPROBES001",
    "$(NoWarn);ASPIRECSHARPAPPS001;ASPIRECERTIFICATES001"));
  assert.match(grade(replaced, "project").join("\n"), /dropped the existing ASPIREPROBES001/);

  const overwritten = workspace(t, "project");
  edit(overwritten, "AppHost/AppHost.cs", wireApi("../Api"));
  edit(overwritten, "AppHost/AppHost.csproj", source => source.replace("  </PropertyGroup>",
    "    <NoWarn>ASPIRECSHARPAPPS001;ASPIRECERTIFICATES001</NoWarn>\n  </PropertyGroup>"));
  const problems = grade(overwritten, "project").join("\n");
  assert.match(problems, /without \$\(NoWarn\)/);
  assert.match(problems, /dropped the existing ASPIREPROBES001/);
});

test("grader CLI reads EVALUATE_WORKSPACE and sets its exit code", t => {
  const root = workspace(t, "file");
  const run = () => {
    try {
      execFileSync(process.execPath, [grader, "file"], { env: { ...process.env, EVALUATE_WORKSPACE: root }, stdio: "pipe" });
      return 0;
    } catch (error) {
      return error.status;
    }
  };
  assert.equal(run(), 1);
  edit(root, "apphost.cs", wireApi("./api", both));
  assert.equal(run(), 0);
});

test("Aspireify eval runs the suppression grader on file-based and project-based C# AppHosts", () => {
  const specPath = join(repoRoot, "skills/aspireify/evals/eval.yaml");
  const spec = parse(readFileSync(specPath, "utf8"));
  const specDir = join(repoRoot, "skills/aspireify/evals");
  assert.ok(spec.grading_environment.files.some(f =>
    f.dest === ".grader/grade-suppressions.mjs" && existsSync(join(specDir, f.src))));

  for (const [caseName, fixture] of [["file", "file-based"], ["project", "project-based"]]) {
    const stimulus = spec.stimuli.find(s => s.graders?.some(g =>
      g.type === "program" && g.config?.args?.[0] === ".grader/grade-suppressions.mjs" && g.config.args[1] === caseName));
    assert.ok(stimulus, `No Aspireify stimulus grades the ${caseName} case`);
    assert.ok(stimulus.environment.files.some(f => f.dest === "app" &&
      join(specDir, f.src) === join(fixtures, fixture)), `${stimulus.name} does not use the ${fixture} fixture`);
    assert.ok(stimulus.graders.some(g => g.type === "skill-invocation" && g.config.required.includes("aspireify")));
  }
});
