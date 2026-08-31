import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(repoRoot, "skills");
const mirrorSkillsRoot = join(repoRoot, ".github", "plugins", "aspire-skills", "skills");

test("published plugin mirrors every non-eval skill file with a relative symlink", () => {
  const sourceFiles = listNonEvalFiles(skillsRoot);
  const mirrorFiles = listNonEvalFiles(mirrorSkillsRoot);
  const indexModes = readMirrorIndexModes();

  assert.deepEqual(mirrorFiles, sourceFiles);

  for (const relativePath of sourceFiles) {
    const sourcePath = join(skillsRoot, relativePath);
    const mirrorPath = join(mirrorSkillsRoot, relativePath);
    const expectedTarget = relative(dirname(mirrorPath), sourcePath).split(sep).join("/");
    const stat = lstatSync(mirrorPath);
    const actualTarget = stat.isSymbolicLink()
      ? readlinkSync(mirrorPath)
      : readFileSync(mirrorPath, "utf8");

    assert.equal(
      actualTarget.replaceAll("\\", "/"),
      expectedTarget,
      `${relativePath} must link to its root skill source`
    );
    assert.equal(
      indexModes.get(`.github/plugins/aspire-skills/skills/${relativePath}`),
      "120000",
      `${relativePath} must be committed as a Git symlink`
    );
  }
});

function readMirrorIndexModes() {
  const result = spawnSync(
    "git",
    ["ls-files", "-s", "--", ".github/plugins/aspire-skills/skills"],
    { cwd: repoRoot, encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);

  return new Map(
    result.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        const match = /^(\d{6}) [0-9a-f]+ \d+\t(.+)$/.exec(line);
        assert.ok(match, `unexpected git ls-files entry: ${line}`);
        return [match[2], match[1]];
      })
  );
}

function listNonEvalFiles(root, current = root) {
  const files = [];

  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name === "evals") {
      continue;
    }

    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...listNonEvalFiles(root, fullPath));
    }
    else {
      files.push(relative(root, fullPath).split(sep).join("/"));
    }
  }

  return files.sort();
}
