import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../skills/", import.meta.url);

const markdownFiles = (prefix = "") =>
  readdirSync(new URL(prefix, root), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? markdownFiles(`${prefix}${entry.name}/`)
      : entry.name.endsWith(".md") ? [`${prefix}${entry.name}`] : []);

// Captured from Aspire CLI 13.6.4 `aspire describe --format Json` on an
// aspire-starter AppHost (webfrontend still starting, so its `urls` is empty).
// Environment, properties, commands, health reports, relationships and volumes
// are emptied; every resource key is kept.
const sample = readFileSync(new URL("fixtures/aspire-describe-13.6.4.json", import.meta.url), "utf8");
const resourceKeys = new Set(JSON.parse(sample).resources.flatMap(Object.keys));
// ResourceUrlJson: `displayName` is omitted when null and `isInternal` when false.
const urlKeys = new Set(["name", "displayName", "url", "isInternal"]);

const describeJq = /aspire describe(?:[^\n|]|\\\n)*--format[ =]json\b(?:[^\n|]|\\\n)*\|\s*jq(?: --?[a-z-]+)* (['"])(.+?)\1/gi;

const filters = markdownFiles().flatMap(file =>
  [...readFileSync(new URL(file, root), "utf8").matchAll(describeJq)].map(([, , filter]) => ({ file, filter })));

test("finds jq filters over `aspire describe --format Json`", () => {
  assert.ok(filters.length > 0, "Expected skills to document jq over aspire describe JSON");
  for (const command of [
    "aspire describe api --format json | jq '.resources'",
    "aspire describe api --format=Json | jq '.resources'",
    "aspire describe api --format Json --non-interactive | jq '.resources'",
    "aspire describe api --format Json | jq --raw-output '.resources'",
    "aspire describe api --format Json | jq -er \".resources\"",
    "aspire describe api --format Json \\\n  | jq '.resources'",
  ]) {
    assert.equal([...command.matchAll(describeJq)].length, 1, command);
  }
});

test("jq filters over `aspire describe --format Json` use the resources[].urls shape", () => {
  for (const { file, filter } of filters) {
    assert.match(filter, /\.resources\b/,
      `${file} uses jq '${filter}'; aspire describe JSON has a top-level \`resources\` array`);
    assert.doesNotMatch(filter, /\.endpoints\b/,
      `${file} uses jq '${filter}'; resource URLs are under \`urls[].url\`, not \`endpoints\``);
    for (const [, chain] of filter.matchAll(/\.resources\[[^\]]*\]\??((?:\.\w+(?:\[[^\]]*\]\??)*)*)/g)) {
      const [field, child] = [...chain.matchAll(/\.(\w+)/g)].map(([, name]) => name);
      if (field === undefined) continue;
      assert.ok(resourceKeys.has(field),
        `${file} uses jq '${filter}'; aspire describe resources have no \`${field}\` field`);
      if (field === "urls" && child !== undefined) {
        assert.ok(urlKeys.has(child), `${file} uses jq '${filter}'; resource URLs have no \`${child}\` field`);
      }
    }
  }
});

test("jq filters over `aspire describe --format Json` produce a value from captured output", t => {
  if (spawnSync("jq", ["--version"]).error) {
    t.skip("jq is not installed");
    return;
  }
  for (const { file, filter } of filters) {
    const result = spawnSync("jq", ["-e", filter], { input: sample, encoding: "utf8" });
    assert.equal(result.status, 0,
      `${file} uses jq '${filter}', which produced no value from captured aspire describe JSON: ${result.stderr}`);
  }
});
