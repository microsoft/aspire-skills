import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../skills/aspireify/", import.meta.url);

const markdownFiles = (dir, prefix = "") =>
  readdirSync(new URL(prefix, dir), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? markdownFiles(dir, `${prefix}${entry.name}/`)
      : entry.name.endsWith(".md") ? [`${prefix}${entry.name}`] : []);

const csharpCode = text => [...text.matchAll(/```(?:csharp|cs)\n([\s\S]*?)\n```/g)].map(match => match[1]).join("\n");

// In Aspire 13.6 these C# APIs carry [Experimental] diagnostics that fail an unmodified AppHost
// build with error ASPIRE..., so any C# example that uses them must show the suppression.
const experimentalApis = [
  { call: /\bAddCSharpApp\(/, diagnostic: "ASPIRECSHARPAPPS001" },
  { call: /\.WithHttpsDeveloperCertificate\(/, diagnostic: "ASPIRECERTIFICATES001" },
];

test("Aspireify C# examples that use experimental APIs document their diagnostic suppression", () => {
  const files = markdownFiles(root);
  assert.ok(files.length > 0, "No Aspireify markdown files found");

  for (const file of files) {
    const text = readFileSync(new URL(file, root), "utf8").replace(/\r\n/g, "\n");
    const code = csharpCode(text);
    for (const { call, diagnostic } of experimentalApis) {
      if (!call.test(code)) continue;
      assert.match(text, new RegExp(`#pragma warning disable [A-Z0-9, ]*\\b${diagnostic}\\b`),
        `${file} uses ${call.source} in C# without showing #pragma warning disable ${diagnostic}`);
      assert.match(text, new RegExp(`<NoWarn>\\$\\(NoWarn\\);[^<]*\\b${diagnostic}\\b`),
        `${file} uses ${call.source} in C# without the project-level NoWarn alternative for ${diagnostic}`);
    }
  }
});

// Aspire 17.0 (microsoft/aspire main, 17.0.0) replaces AddCSharpApp's [Experimental] with
// [Obsolete], ships AddDotnetProject as stable and keeps WithHttpsDeveloperCertificate experimental.
test("Aspireify experimental C# API guidance is version-aware for Aspire 17.0", () => {
  const text = readFileSync(new URL("references/apphost-wiring.md", root), "utf8").replace(/\r\n/g, "\n");
  const section = text.match(/### Experimental C# APIs used in these examples\n([\s\S]*?)\n## /)?.[1];
  assert.ok(section, "apphost-wiring.md is missing the experimental C# APIs section");

  assert.match(section, /In Aspire 13\.6, two C# APIs used below are experimental/);
  assert.match(section, /`AddCSharpApp` is obsolete in 17\.0/);
  assert.match(section, /`ASPIRECSHARPAPPS001` no longer applies/);
  assert.match(section, /aspire add Aspire\.Hosting\.Dotnet/);
  assert.match(section, /The 17\.0 SDK doesn't\s+reference `Aspire\.Hosting\.Dotnet` implicitly/);
  assert.match(section, /`#:package Aspire\.Hosting\.Dotnet@<AppHost SDK version>`/);
  assert.match(section, /builder\.AddDotnetProject\("api", "\.\.\/src\/Api"\)/);
  assert.match(section, /Don't migrate existing `AddCSharpApp` or `AddProject` calls unless the user asks/);
  assert.match(section, /`WithHttpsDeveloperCertificate\(\)` is still experimental in 17\.0[\s\S]*`ASPIRECERTIFICATES001`/);

  assert.doesNotMatch(text, /`AddDotnetProject` moved to experimental/,
    "AddDotnetProject is stable from 17.0; only 13.5 marks it ASPIREDOTNETPROJECT001");
  assert.match(text, /experimental on 13\.5 \(`ASPIREDOTNETPROJECT001`\), a preview package on 13\.6 and stable from 17\.0/);
});

// Vally 0.16 has only an eval-wide scoring threshold, so this stimulus must be weighted so that
// omitting anything the requested 17.0 AppHost needs fails it outright: the
// Aspire.Hosting.Dotnet reference (not implicit in the 17.0 SDK), the requested
// WithHttpsDeveloperCertificate() call and its ASPIRECERTIFICATES001 suppression.
test("Aspireify 17.0 AddDotnetProject eval fails a response that omits the package, certificate call or suppression", async () => {
  const { parse } = await import("yaml");
  const spec = parse(readFileSync(new URL("evals/eval.yaml", root), "utf8"));
  const stimulus = spec.stimuli.find(s => s.name === "aspireify-csharp-dotnet-project-17-001");
  assert.ok(stimulus, "aspireify-csharp-dotnet-project-17-001 stimulus is missing");
  const threshold = spec.scoring.threshold;

  // Mirrors Vally's static output graders: an unweighted mean of grader scores, pass when >= threshold.
  const score = output => {
    const results = stimulus.graders.map(({ type, config }) => {
      const lower = !config.case_sensitive;
      const has = value => lower ? output.toLowerCase().includes(value.toLowerCase()) : output.includes(value);
      switch (type) {
        case "output-matches": return new RegExp(config.pattern).test(output);
        case "output-contains": return has(config.value ?? config.substring);
        case "output-not-contains": return !has(config.value ?? config.substring);
        case "skill-invocation": return true;
        default: assert.fail(`Unexpected grader type ${type}`);
      }
    });
    return results.filter(Boolean).length / results.length;
  };

  const lines = [
    "#:sdk Aspire.AppHost.Sdk@17.0.0",
    "#:package Aspire.Hosting.Dotnet@17.0.0",
    "",
    "#pragma warning disable ASPIRECERTIFICATES001",
    "",
    'var api = builder.AddDotnetProject("api", "./api")',
    "    .WithHttpsDeveloperCertificate();",
  ];
  const suppressed = lines.join("\n");
  const without = text => lines.filter(line => !line.includes(text)).join("\n");
  const failing = {
    "the ASPIRECERTIFICATES001 suppression": without("ASPIRECERTIFICATES001"),
    "the requested WithHttpsDeveloperCertificate() call": without("WithHttpsDeveloperCertificate"),
    "the Aspire.Hosting.Dotnet package reference": without("Aspire.Hosting.Dotnet"),
    "AddDotnetProject (uses the obsolete AddCSharpApp)": suppressed.replace("AddDotnetProject", "AddCSharpApp"),
  };

  assert.ok(score(suppressed) >= threshold, `A correct response scores ${score(suppressed)} < ${threshold}`);
  assert.ok(score(suppressed.replace("#:package Aspire.Hosting.Dotnet@17.0.0", "aspire add Aspire.Hosting.Dotnet")) >= threshold,
    "A response that adds the package with `aspire add Aspire.Hosting.Dotnet` must pass");
  for (const [omitted, output] of Object.entries(failing)) {
    assert.ok(score(output) < threshold, `A response without ${omitted} still passes at ${score(output)} >= ${threshold}`);
  }
});
