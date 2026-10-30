import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("C# authoring documents private endpoints with the subnet-owned Aspire API", () => {
  const reference = read("skills/aspireify/references/csharp-authoring.md");
  const azure = /^## Azure-Specific\n([\s\S]*?)(?=^## )/m.exec(reference)?.[1];
  assert.ok(azure, "Missing Azure-Specific section");

  // Aspire.Hosting.Azure.Network exposes AddPrivateEndpoint on an AzureSubnetResource builder;
  // there is no WithPrivateEndpoint extension on target resources.
  assert.doesNotMatch(azure, /\bWithPrivateEndpoint\b/);
  const row = azure.split("\n").find(line => /\bAddPrivateEndpoint\(/.test(line));
  assert.ok(row, "Missing private endpoint API row");
  assert.match(row, /AddAzureVirtualNetwork\([^)]*\)\.AddSubnet\([^)]*\)/);
  assert.match(row, /\bsubnet\.AddPrivateEndpoint\(\w+\)/);
});
