import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Repository } from "../scripts/release-git.mjs";

test("standalone dev check validates the committed tree without npm or main tooling", t => {
  const root = mkdtempSync(join(tmpdir(), "dev-tree-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const initialized = spawnSync("git", ["init", "--quiet", root], {
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const repo = new Repository(root);
  const script = fileURLToPath(new URL("../scripts/check-dev-tree.mjs", import.meta.url));
  const check = () => spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  const commit = () => {
    repo.run(["add", "--all"]);
    repo.run(["commit", "--quiet", "-m", "Select dev tree"]);
  };
  writeFileSync(join(root, "README.md"), "Source-only dev.\n");
  commit();
  assert.equal(check().status, 0);
  writeFileSync(join(root, "CHANGELOG.md"), "Untracked file is not in the selected tree.\n");
  assert.equal(check().status, 0);
  commit();
  const changelog = check();
  assert.equal(changelog.status, 0, changelog.stderr);
  assert.match(changelog.stdout, /published changelog history is allowed/);
  mkdirSync(join(root, "opencode", "v1"), { recursive: true });
  writeFileSync(join(root, "opencode", "v1", "catalog.md"), "Generated catalog.\n");
  assert.equal(check().status, 0);
  commit();
  const catalogs = check();
  assert.equal(catalogs.status, 1);
  assert.match(catalogs.stderr, /opencode\/v1\/catalog\.md/);
});
