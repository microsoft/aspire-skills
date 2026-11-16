import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../skills/", import.meta.url);

const markdownFiles = (prefix = "") =>
  readdirSync(new URL(prefix, root), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? markdownFiles(`${prefix}${entry.name}/`)
      : entry.name.endsWith(".md") ? [`${prefix}${entry.name}`] : []);

// Friendly names that `aspire add` no longer resolves. In non-interactive mode the CLI
// requires an exact package id or friendly name, so these fail instead of fuzzy-matching.
const retiredNames = new Map([
  // Aspire.Hosting.NodeJs became Aspire.Hosting.JavaScript in Aspire 13.
  ["nodejs", "javascript"],
]);

test("skills only use `aspire add` friendly names that the CLI resolves", () => {
  const files = markdownFiles();
  assert.ok(files.length > 0, "No skill markdown files found");

  for (const file of files) {
    const text = readFileSync(new URL(file, root), "utf8");
    for (const [, name] of text.matchAll(/\baspire add ([a-z][a-z0-9.-]*)/g)) {
      assert.ok(!retiredNames.has(name),
        `${file} uses \`aspire add ${name}\`; use \`aspire add ${retiredNames.get(name)}\``);
    }
  }
});
