import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("TypeScript authoring uses the exported Foundry builder and deployment APIs", () => {
  const reference = read("skills/aspireify/references/typescript-authoring.md");
  const catalogs = /^## Predefined Value Catalogs\n([\s\S]*?)(?=^## )/m.exec(reference)?.[1];
  assert.ok(catalogs, "Missing Predefined Value Catalogs section");

  // Aspire.Hosting.Foundry exports AddFoundry and FoundryResource.AddDeployment to TypeScript as
  // addFoundry and addDeployment; addAzureFoundry and a Foundry addModel do not exist.
  assert.doesNotMatch(reference, /\baddAzureFoundry\b/);
  const example = /```ts\n([\s\S]*?)\n```/.exec(catalogs)?.[1];
  assert.ok(example, "Missing Foundry catalog example");
  assert.match(example, /\bbuilder\.addFoundry\(\s*'foundry'\s*\)\s*\.addDeployment\(\s*'chat',\s*FoundryModels\.OpenAI\.Gpt41Mini\s*\)/);
  assert.doesNotMatch(example, /\.addModel\(/);
});
