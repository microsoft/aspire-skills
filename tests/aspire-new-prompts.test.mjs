import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const templates = readFileSync(
  new URL("../skills/aspire-init/references/templates.md", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

function promptRows() {
  const section = /## Interactive Prompts[^\n]*\n([\s\S]*?)\n## /.exec(templates);
  assert.ok(section, "Missing the Interactive Prompts section");
  return section[1]
    .split("\n")
    .filter((line) => line.startsWith("| ") && !/^\|\s*-/.test(line) && !line.startsWith("| Prompt "))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
}

test("every aspire new prompt names a flag that answers it non-interactively", () => {
  const rows = promptRows();
  assert.ok(rows.length >= 4, "Expected the name, version, output and localhost prompts");
  for (const [prompt, , skipWith] of rows) {
    const flags = (skipWith.match(/`--[a-z][\w-]*/g) ?? []).filter((flag) => flag !== "`--non-interactive");
    assert.ok(flags.length > 0, `Prompt "${prompt}" has no answering flag: ${skipWith}`);
  }
});

test("the *.dev.localhost prompt documents --localhost-tld", () => {
  const row = promptRows().find(([prompt]) => prompt.includes("dev.localhost"));
  assert.ok(row, "Missing the *.dev.localhost prompt row");
  assert.match(row[2], /`--localhost-tld`/);
  assert.match(row[2], /`--non-interactive`/);
});
