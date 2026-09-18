import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertGitRepositoryRoot, createGitEnvironment } from "../../scripts/git-repository.mjs";

export function sourceInventory(root) {
  root = assertGitRepositoryRoot(root);
  const git = args => {
    const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...createGitEnvironment(), GIT_OPTIONAL_LOCKS: "0" }
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split("\0").filter(Boolean);
  };
  const modes = Object.fromEntries(git(["ls-files", "--stage", "-z"]).map(record => {
    const match = /^(\d+) [0-9a-f]+ 0\t([\s\S]+)$/.exec(record);
    assert.ok(match, "Snapshot requires an index without unresolved conflicts");
    return [match[2], match[1]];
  }));
  const fileMode = git(["config", "--type=bool", "--get", "--default=true", "core.fileMode"])[0]?.trim() !== "false";
  return { modes, fileMode, paths: git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, "Usage: node tests/helpers/workflow-snapshot.mjs OUTPUT.json");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  writeFileSync(process.argv[2], JSON.stringify(sourceInventory(root)));
}
