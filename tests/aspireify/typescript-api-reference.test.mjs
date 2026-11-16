import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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

test("Aspireify TypeScript examples call exported APIs with their generated signatures", () => {
  const files = ["typescript-authoring.md", "apphost-wiring.md"];
  const blocks = files.flatMap(file =>
    [...read(`skills/aspireify/references/${file}`).matchAll(/```(?:ts|typescript)\n([\s\S]*?)\n```/g)].map(m => m[1]));
  const code = blocks.join("\n");

  // addNodeApp(name, appDirectory, scriptPath) has no two-argument overload.
  const nodeApps = [...code.matchAll(/\.addNodeApp\(([^)]*)\)/g)].map(m => m[1]);
  assert.ok(nodeApps.length > 0, "Missing addNodeApp examples");
  for (const args of nodeApps) {
    assert.equal(args.split(",").length, 3, `addNodeApp needs name, appDirectory and scriptPath: ${args}`);
  }

  // withEndpoint takes an options object; endpoint mutation uses withEndpointCallback and
  // EndpointUpdateContext property setters.
  assert.doesNotMatch(code, /\.withEndpoint\(\s*['"][^'"]+['"]\s*,\s*\w+\s*=>/);
  assert.match(code, /\.withEndpointCallback\(\s*'admin',\s*async \(?\w+\)? => \{\s*await \w+\.excludeReferenceEndpoint\.set\(true\);/);

  // addDockerfileBuilder(name, contextPath, callback) gets the builder from its callback context;
  // there is no single-argument overload, and stages expose workDir rather than workdir.
  assert.doesNotMatch(code, /\.addDockerfileBuilder\(\s*'[^']*'\s*\)/);
  assert.match(code, /\.addDockerfileBuilder\(\s*'[^']+',\s*'[^']+',\s*async \(?\w+\)? => \{[\s\S]*?await \w+\.builder\(\)/);
  assert.doesNotMatch(code, /\.workdir\(/);

  // withComputeEnvironment only accepts the environment. ACA custom domains are configured on the
  // generated ContainerApp in the publishAsAzureContainerApp callback.
  assert.doesNotMatch(code, /\.withComputeEnvironment\(\s*\w+\s*,/);
  assert.doesNotMatch(code, /\bcustomDomains\b/);
  assert.match(code, /\.publishAsAzureContainerApp\(\s*async \(\w+, (\w+)\) => \{\s*await \1\.configureCustomDomain\(\w+, \w+\);/);

  // withLifetime takes the generated ContainerLifetime string enum, whose members are PascalCase.
  assert.doesNotMatch(code, /\.withLifetime\(\s*['"]/);
  assert.match(code, /\.withLifetime\(ContainerLifetime\.Persistent\)/);
});

test("Aspire skills document addNodeApp with its app directory and script path", () => {
  // AddNodeApp(name, appDirectory, scriptPath) / addNodeApp(name, appDirectory, scriptPath) has no
  // two-argument overload, so signature rows and examples that omit appDirectory don't compile.
  const root = new URL("../../skills/", import.meta.url);
  const files = readdirSync(root, { recursive: true }).filter(file => file.endsWith(".md"));
  const calls = files.flatMap(file =>
    [...readFileSync(new URL(file, root), "utf8").matchAll(/\b[Aa]ddNodeApp\(([^()]+)\)/g)]
      .map(m => ({ file, args: m[1] })))
    .filter(({ args }) => args.trim() !== "...");
  assert.ok(calls.length > 0, "Missing addNodeApp examples");
  for (const { file, args } of calls) {
    assert.equal(args.split(",").length, 3, `${file}: addNodeApp needs name, appDirectory and scriptPath: ${args}`);
  }
});
