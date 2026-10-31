import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../skills/", import.meta.url);

const markdownFiles = (prefix = "") =>
  readdirSync(new URL(prefix, root), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? markdownFiles(`${prefix}${entry.name}/`)
      : entry.name.endsWith(".md") ? [`${prefix}${entry.name}`] : []);

// Aspire CLI 13.6.4 `aspire describe [resource] --format Json` returns
// {"resources":[{ ..., "urls":[{"name","url"}] }]}. There is no top-level
// `endpoints`, so `.endpoints[0].url` yields `null`.
test("jq filters over `aspire describe --format Json` use the resources[].urls shape", () => {
  const filters = [];
  for (const file of markdownFiles()) {
    const text = readFileSync(new URL(file, root), "utf8");
    for (const [, filter] of text.matchAll(/aspire describe[^\n|]*--format Json\s*\|\s*jq(?: -[a-z]+)* '([^']+)'/g)) {
      filters.push({ file, filter });
    }
  }
  assert.ok(filters.length > 0, "Expected skills to document jq over aspire describe JSON");

  for (const { file, filter } of filters) {
    assert.match(filter, /^\.resources\b/,
      `${file} uses jq '${filter}'; aspire describe JSON has a top-level \`resources\` array`);
    assert.doesNotMatch(filter, /\.endpoints\b/,
      `${file} uses jq '${filter}'; resource URLs are under \`urls[].url\`, not \`endpoints\``);
  }
});
