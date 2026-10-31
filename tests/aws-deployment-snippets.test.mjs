import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const awsReference = new URL("../skills/aspire-deployment/references/aws.md", import.meta.url);

const csharpBlocks = text =>
  [...text.matchAll(/```csharp\n([\s\S]*?)```/g)].map(([, block]) => block.replace(/^ {3}/gm, ""));

// AddAWSCDKEnvironment is in the implicitly imported Aspire.Hosting namespace, but
// CDKDefaultsProviderFactory is not. Without this using, the snippet fails with CS0103.
test("AWS CDK snippets import the CDKDefaultsProviderFactory namespace", () => {
  const blocks = csharpBlocks(readFileSync(awsReference, "utf8"))
    .filter(block => block.includes("CDKDefaultsProviderFactory"));
  assert.ok(blocks.length > 0, "Expected a C# snippet that uses CDKDefaultsProviderFactory");

  for (const block of blocks) {
    assert.match(block, /^using Aspire\.Hosting\.AWS\.Deployment;$/m,
      "Snippets using CDKDefaultsProviderFactory must include `using Aspire.Hosting.AWS.Deployment;`");
    assert.match(block, /^#pragma warning disable ASPIREAWSPUBLISHERS001$/m,
      "AddAWSCDKEnvironment and CDKDefaultsProviderFactory require the ASPIREAWSPUBLISHERS001 suppression");
  }
});
