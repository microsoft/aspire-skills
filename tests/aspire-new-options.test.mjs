import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const templatesReference = new URL("../skills/aspire-init/references/templates.md", import.meta.url);

// Short aliases accepted by `aspire new` in Aspire CLI 13.6.4 (`aspire new --help`).
// `--version` has no short alias; `aspire new ... -v <version>` fails with
// "Unrecognized command or argument '-v'".
const aspireNewShortAliases = new Map([
  ["-n", "--name"],
  ["-o", "--output"],
  ["-s", "--source"],
  ["-l", "--log-level"],
]);

test("aspire new option table only documents short aliases the CLI accepts", () => {
  const text = readFileSync(templatesReference, "utf8");
  const rows = [...text.matchAll(/^\| `(-[A-Za-z]), (--[a-z-]+)` \|/gm)];
  assert.ok(rows.length > 0, "Expected the Common Options table to list short aliases");

  for (const [, alias, option] of rows) {
    assert.equal(aspireNewShortAliases.get(alias), option,
      `templates.md documents \`${alias}, ${option}\`, but aspire new does not accept ${alias} for ${option}`);
  }
});
