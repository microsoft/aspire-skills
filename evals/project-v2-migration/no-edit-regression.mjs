import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

function normalizePath(path) {
  return path.split(sep).join("/");
}

function listFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(root, path) : [normalizePath(relative(root, path))];
  });
}

export function captureNoEditSnapshot(root, paths) {
  return new Map(paths.map((path) => [path, readFileSync(join(root, path))]));
}

export function assertNoEditSnapshot(root, snapshot) {
  const expectedPaths = [...snapshot.keys()].sort();
  assert.deepEqual(listFiles(root).sort(), expectedPaths, "workspace file set changed");

  for (const [path, expected] of snapshot) {
    assert.deepEqual(readFileSync(join(root, path)), expected, `${path} changed`);
  }
}
