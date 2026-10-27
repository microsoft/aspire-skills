import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionsRoot = join(repoRoot, "extensions");
const mirrorRoot = join(repoRoot, ".github", "plugins", "aspire-skills", "extensions");

function listFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, path));
    }
    else {
      files.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
  return files.sort();
}

test("published plugin mirrors every runtime extension file", () => {
  const extensionNames = readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => listFiles(join(extensionsRoot, entry.name)).includes("extension.mjs"))
    .map((entry) => entry.name)
    .sort();
  const mirrorNames = readdirSync(mirrorRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(mirrorNames, extensionNames);
  for (const extensionName of extensionNames) {
    const sourceRoot = join(extensionsRoot, extensionName);
    const publishedRoot = join(mirrorRoot, extensionName);
    const sourceFiles = listFiles(sourceRoot);
    assert.deepEqual(listFiles(publishedRoot), sourceFiles, `${extensionName} mirror file set must match its source.`);

    for (const relativePath of sourceFiles) {
      const sourcePath = join(sourceRoot, relativePath);
      const mirrorPath = join(publishedRoot, relativePath);
      const target = lstatSync(mirrorPath).isSymbolicLink()
        ? readlinkSync(mirrorPath)
        : readFileSync(mirrorPath, "utf8").trim();
      assert.equal(
        resolve(dirname(mirrorPath), target),
        resolve(sourcePath),
        `${extensionName}/${relativePath} must point to its root extension source.`,
      );
    }
  }
});
