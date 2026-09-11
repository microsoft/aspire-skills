import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  compareVersions,
  normalizeReleaseTag,
  readPluginVersion,
  resolveReleaseContext
} from "../scripts/resolve-release.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("current plugin version sources are synchronized", () => {
  assert.match(readPluginVersion(repoRoot), /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});

test("plugin version drift is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "aspire-release-version-"));

  try {
    writeVersionSources(root, "1.2.3");
    writeJson(root, "package.json", { version: "1.2.4" });

    assert.throws(
      () => readPluginVersion(root),
      /Plugin versions must match:.*package\.json=1\.2\.4/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release tags accept an optional v prefix", () => {
  assert.equal(normalizeReleaseTag("v1.2.3"), "1.2.3");
  assert.equal(normalizeReleaseTag("1.2.3-rc.1"), "1.2.3-rc.1");
  assert.throws(() => normalizeReleaseTag("release-1.2.3"), /unsupported semantic version/);
});

test("semantic version comparison handles prereleases", () => {
  assert.equal(compareVersions("0.0.2", "0.0.1"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(compareVersions("1.0.0-beta", "1.0.0-alpha"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

test("default-branch releases resolve the plugin version tag", () => {
  const version = readPluginVersion(repoRoot);
  const release = resolveReleaseContext({
    repoRoot,
    env: {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF_NAME: "main",
      GITHUB_REF_TYPE: "branch",
      REPOSITORY_DEFAULT_BRANCH: "main"
    }
  });

  assert.equal(release.auto_tag, "true");
  assert.equal(release.tag_name, `v${version}`);
  assert.equal(release.version, version);
});

test("tag releases must match the synchronized plugin version", () => {
  const version = readPluginVersion(repoRoot);

  assert.throws(
    () => resolveReleaseContext({
      repoRoot,
      env: {
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF_NAME: version === "0.0.1" ? "v0.0.2" : "v0.0.1",
        GITHUB_REF_TYPE: "tag"
      }
    }),
    /but the plugin version is/
  );
});

function writeVersionSources(root, version) {
  writeJson(root, ".plugin/plugin.json", { version });
  writeJson(root, ".claude-plugin/plugin.json", { version });
  writeJson(root, ".claude-plugin/marketplace.json", {
    plugins: [{ version }]
  });
  writeJson(root, ".cursor-plugin/marketplace.json", {
    plugins: [{ version }]
  });
  writeJson(root, "gemini-extension.json", { version });
  writeJson(root, "package.json", { version });
}

function writeJson(root, relativePath, value) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
