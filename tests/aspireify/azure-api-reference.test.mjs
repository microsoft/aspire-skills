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

  // Target hosting packages do not depend on Aspire.Hosting.Azure.Network, so the example only
  // compiles when the AppHost references that package explicitly.
  assert.match(azure, /<PackageReference Include="Aspire\.Hosting\.Azure\.Network"/);
  assert.match(azure, /#:package Aspire\.Hosting\.Azure\.Network@/);

  // Aspire.Hosting.Azure.Network is [Experimental("ASPIREAZURE003")] assembly-wide, so the example
  // only compiles when the private endpoint calls are wrapped in a paired opt-in.
  const optIn = /#pragma warning disable ASPIREAZURE003\n([\s\S]*?)#pragma warning restore ASPIREAZURE003/.exec(azure);
  assert.ok(optIn, "Missing paired ASPIREAZURE003 opt-in");
  assert.match(optIn[1], /AddAzureVirtualNetwork\([^)]*\)\.AddSubnet\([^)]*\)/);
  assert.match(optIn[1], /\bsubnet\.AddPrivateEndpoint\(\w+\)/);
});

test("Aspireify routes Azure private endpoint requests to the subnet-owned Aspire API", () => {
  const skill = read("skills/aspireify/SKILL.md");
  const rules = /^## Current Authoring Rules\n([\s\S]*?)(?=^## )/m.exec(skill)?.[1];
  assert.ok(rules, "Missing Current Authoring Rules section");

  // Without a rule here, agents never open the Azure-Specific reference and fall back to raw Bicep
  // or hand-built ConfigureInfrastructure networking (aspireify-private-endpoint-001).
  const row = rules.split("\n").find(line => /private endpoint/i.test(line));
  assert.ok(row, "Missing private endpoint authoring rule");
  assert.match(row, /AddAzureVirtualNetwork\([^)]*\)\.AddSubnet\([^)]*\)/);
  assert.match(row, /\bsubnet\.AddPrivateEndpoint\(\w+\)/);
  assert.match(row, /Aspire\.Hosting\.Azure\.Network/);
  assert.match(row, /ASPIREAZURE003/);
  assert.match(row, /references\/csharp-authoring\.md#azure-specific/);
  assert.match(row, /Bicep/);
});
