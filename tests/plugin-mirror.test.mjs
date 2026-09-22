import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(repoRoot, "skills");
const mirrorSkillsRoot = join(repoRoot, ".github", "plugins", "aspire-skills", "skills");
const extensionsRoot = join(repoRoot, "extensions");
const mirrorExtensionsRoot = join(repoRoot, ".github", "plugins", "aspire-skills", "extensions");

test("published plugin mirrors every non-eval skill file with a relative symlink", () => {
  assertMirror({
    sourceRoot: skillsRoot,
    mirrorRoot: mirrorSkillsRoot,
    indexRoot: ".github/plugins/aspire-skills/skills",
    kind: "skill"
  });
});

test("published plugin mirrors every extension file with a relative symlink", () => {
  assertMirror({
    sourceRoot: extensionsRoot,
    mirrorRoot: mirrorExtensionsRoot,
    indexRoot: ".github/plugins/aspire-skills/extensions",
    kind: "extension"
  });
});

function assertMirror({ sourceRoot, mirrorRoot, indexRoot, kind }) {
  const sourceFiles = listNonEvalFiles(sourceRoot);
  const mirrorFiles = listNonEvalFiles(mirrorRoot);
  const indexEntries = readMirrorIndexEntries(indexRoot);

  assert.deepEqual(mirrorFiles, sourceFiles);

  for (const relativePath of sourceFiles) {
    const sourcePath = join(sourceRoot, relativePath);
    const mirrorPath = join(mirrorRoot, relativePath);
    const expectedTarget = relative(dirname(mirrorPath), sourcePath).split(sep).join("/");
    const stat = lstatSync(mirrorPath);
    const actualTarget = stat.isSymbolicLink()
      ? readlinkSync(mirrorPath)
      : readFileSync(mirrorPath, "utf8");

    const normalizedTarget = normalizeMirrorTarget(actualTarget, stat.isSymbolicLink());
    assert.equal(normalizedTarget, expectedTarget, `${relativePath} must link to its root ${kind} source`);

    const indexPath = `${indexRoot}/${relativePath}`;
    const indexEntry = indexEntries.get(indexPath);
    assert.equal(
      indexEntry?.mode,
      "120000",
      `${relativePath} must be committed as a Git symlink`
    );
    assert.equal(
      readGitBlob(indexEntry.object),
      expectedTarget,
      `${relativePath} Git symlink target must not contain trailing bytes`
    );
  }
}

function normalizeMirrorTarget(target, symbolicLink, separator = sep) {
  return symbolicLink ? target.split(separator).join("/") : target;
}

test("mirror targets normalize native links but preserve exact placeholder and Git bytes", () => {
  const target = "../../../../../skills/aspire-project-v2-migration/SKILL.md";
  const windowsTarget = target.replaceAll("/", "\\");
  assert.equal(normalizeMirrorTarget(windowsTarget, true, "\\"), target);
  assert.equal(normalizeMirrorTarget(target, true, "/"), target);
  assert.equal(normalizeMirrorTarget(target, false), target);
  assert.notEqual(normalizeMirrorTarget(windowsTarget, false), target);
  for (const suffix of ["\n", "\r\n", " ", "\0", "/extra"]) {
    assert.notEqual(normalizeMirrorTarget(target + suffix, false), target);
    assert.notEqual(normalizeMirrorTarget(windowsTarget + suffix, true, "\\"), target);
  }
});

function readMirrorIndexEntries(indexRoot) {
  const result = spawnSync(
    "git",
    ["ls-files", "-s", "--", indexRoot],
    { cwd: repoRoot, encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);

  return new Map(
    result.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        const fields = /^(\d{6}) ([0-9a-f]+) \d+\t(.+)$/.exec(line);
        assert.ok(fields, `unexpected git ls-files entry: ${line}`);
        return [fields[3], { mode: fields[1], object: fields[2] }];
      })
  );
}

function readGitBlob(object) {
  const result = spawnSync("git", ["cat-file", "blob", object], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
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
