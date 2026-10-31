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
