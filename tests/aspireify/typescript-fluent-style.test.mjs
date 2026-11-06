import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const reference = read("skills/aspireify/references/typescript-authoring.md");
const section = heading => {
  const content = reference.split(`## ${heading}\n`)[1]?.split("\n## ")[0];
  assert.ok(content, `Missing ${heading} section`);
  return content;
};

test("Aspireify TypeScript examples declare fluent resources without intermediate awaits", () => {
  const root = new URL("../../skills/aspireify/", import.meta.url);
  const files = readdirSync(root, { recursive: true }).filter(file => file.endsWith(".md"));
  let count = 0;
  for (const file of files) {
    const markdown = readFileSync(new URL(file, root), "utf8");
    for (const [, code] of markdown.matchAll(/```(?:ts|typescript)\r?\n([\s\S]*?)\r?\n```/g)) {
      count++;
      assert.doesNotMatch(code, /\bawait\s+builder(?!\s*\.\s*build\s*\()/, file);
      assert.doesNotMatch(code, /\bawait\s+\w+\s*\.\s*(?:with\w+|getEndpoint|publishAs\w+)\s*\(/, file);
    }
  }
  assert.ok(count > 0, "Missing TypeScript examples");
  assert.match(read("skills/aspireify/SKILL.md"), /\| Add project \|.*\| `builder\.addProject\(/);
});

test("canonical skeleton awaits lifecycle boundaries and passes fluent resources directly", () => {
  const skeleton = section("Skeleton");
  assert.deepEqual([...skeleton.matchAll(/\bawait\s+([^;\n]+)/g)].map(match => match[1]), [
    "createBuilder()",
    "builder.build().run()",
  ]);
  assert.match(skeleton, /const pg = builder\.addPostgres\('pg'\)\.addDatabase\('appdb'\);/);
  assert.match(skeleton, /const api = builder\.addProject\([\s\S]*?\.withReference\(pg\)/);
  assert.match(skeleton, /builder\.addNextJsApp\([\s\S]*?\.withReference\(api\)/);

  const environment = section("Unified `withEnvironment` API");
  assert.match(environment, /const api = builder\.addProject\([^\n]+\)\n\s*\.withEnvironment/);
  assert.match(environment, /\.withEnvironment\('SERVICE_URL', cache\.primaryEndpoint\(\)\)/);
  assert.match(section("Endpoint Property Expressions"), /const httpEndpoint = api\.getEndpoint\('http'\);/);
});

test("fluent guidance explains promise types without removing required callback awaits", () => {
  const guidance = section("Promise-fluent return types");
  for (const term of ["ResourcePromise", "PromiseLike", "EndpointReferencePromise", "withEnvironment"]) {
    assert.ok(guidance.includes(term), `Missing ${term} explanation`);
  }
  assert.match(guidance, /callback/i);
  assert.match(section("Endpoint Update Behavior"), /await e\.excludeReferenceEndpoint\.set\(true\)/);
  assert.match(section("Dockerfile Builder APIs (experimental)"), /await context\.builder\(\)/);
  assert.match(section("Dockerfile Builder APIs (experimental)"), /await stage\.run\('npm ci'\)/);
  assert.match(section("YARP Routing"), /await yarp\.addRoute\(/);
  assert.match(section("YARP Routing"), /await yarp\.addCatchAllRoute\(/);
  assert.match(section("Compute Environments"), /await app\.configureCustomDomain\(customDomain, certificateName\)/);
  assert.match(reference, /await context\.arguments\(\)/);
  assert.match(reference, /await args\.requiredValue\('message'\)/);
  assert.match(reference, /await context\.services\(\)\.getInteractionService\(\)/);
  assert.match(reference, /await interaction\.isAvailable\(\)/);
});

test("TypeScript eval fixture models the same fluent declaration style", () => {
  const fixture = read("evals/ts-apphost/apphost.mts");
  assert.doesNotMatch(fixture, /\bawait\s+builder(?!\s*\.\s*build\s*\()/);
  assert.match(fixture, /const builder = await createBuilder\(\)/);
  assert.match(fixture, /await builder\.build\(\)\.run\(\)/);
});
