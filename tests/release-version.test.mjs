import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("prerelease ordering uses ASCII rather than locale collation", () => {
  const versions = [
    "1.0.0-1", "1.0.0--", "1.0.0-B", "1.0.0-a",
    "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0"
  ];
  for (let index = 1; index < versions.length; index += 1) {
    assert.equal(compareVersions(versions[index - 1], versions[index]), -1);
    assert.equal(compareVersions(versions[index], versions[index - 1]), 1);
  }
});

test("numeric comparisons preserve integer precision", () => {
  assert.equal(compareVersions("9007199254740993.0.0", "9007199254740992.0.0"), 1);
});

test("numeric prerelease identifiers cannot have leading zeroes", () => {
  for (const version of ["1.2.3-01", "1.2.3-rc.00"]) {
    assert.throws(() => normalizeReleaseTag(`v${version}`), /unsupported semantic version/);
    assert.throws(() => compareVersions(version, "1.2.3"), /unsupported semantic version/);
  }
  assert.equal(normalizeReleaseTag("v1.2.3-0.01a"), "1.2.3-0.01a");
});

test("version values must be complete single-line semantic versions", () => {
  for (const version of ["1.2.3\n", "1.2.3\r\n", "01.2.3", "1.2", "1.2.3-"]) {
    assert.throws(() => normalizeReleaseTag(version), /unsupported semantic version/);
  }
});

test("push releases read the previous commit and reject downgrades", t => {
  const root = createRepo(t);
  const before = commitVersion(root, "0.0.1");
  const head = commitVersion(root, "0.0.2");
  const env = branchEnv("push", before);
  const release = resolveReleaseContext({ repoRoot: root, env });
  assert.equal(release.previous_version, "0.0.1");
  assert.equal(release.version_changed, "true");
  assert.equal(release.source_commit, head);
  assert.equal(release.tag_name, "v0.0.2");
  assert.equal(release.skills_asset, "dist/aspire-skills-v0.0.2.tgz");
  assert.equal(release.extensions_asset, "dist/aspire-extensions-v0.0.2.tgz");

  commitVersion(root, "0.0.1");
  assert.throws(
    () => resolveReleaseContext({ repoRoot: root, env: branchEnv("push", head) }),
    /must increase.*0\.0\.2 -> 0\.0\.1/
  );
});

test("unchanged pushes are not treated as new version bumps", t => {
  const root = createRepo(t);
  const before = commitVersion(root, "0.0.2");
  commitVersion(root, "0.0.2");
  const release = resolveReleaseContext({ repoRoot: root, env: branchEnv("push", before) });
  assert.equal(release.version_changed, "false");
});

test("manual dispatch rejects a downgrade even after same-version commits", t => {
  const root = createRepo(t);
  commitVersion(root, "0.0.3");
  commitVersion(root, "0.0.2");
  writeJson(root, ".plugin/plugin.json", { version: "0.0.2", description: "Changed metadata" });
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "Same version"]);
  const env = branchEnv("workflow_dispatch");
  assert.throws(
    () => resolveReleaseContext({ repoRoot: root, env }),
    /must increase.*0\.0\.3 -> 0\.0\.2/
  );
});

test("manual dispatch accepts the initial version and an upgrade retry", t => {
  const root = createRepo(t);
  commitVersion(root, "0.0.1");
  const env = branchEnv("workflow_dispatch");
  assert.equal(resolveReleaseContext({ repoRoot: root, env }).previous_version, "");
  commitVersion(root, "0.0.2");
  commitVersion(root, "0.0.2");
  const release = resolveReleaseContext({ repoRoot: root, env });
  assert.equal(release.previous_version, "0.0.1");
  assert.equal(release.version_changed, "false");
  assert.equal(release.tag_name, "v0.0.2");
});

test("invalid numeric prereleases in manifests are rejected", t => {
  const root = createRepo(t);
  writeVersionSources(root, "0.0.2-01");
  assert.throws(() => readPluginVersion(root), /unsupported semantic version/);
});

test("feature branches and unavailable push history fail explicitly", t => {
  const root = createRepo(t);
  commitVersion(root, "0.0.2");
  assert.throws(
    () => resolveReleaseContext({
      repoRoot: root,
      env: { ...branchEnv("workflow_dispatch"), GITHUB_REF_NAME: "feature" }
    }),
    /must run from 'main'/
  );
  assert.throws(() => resolveReleaseContext({
    repoRoot: root,
    env: branchEnv("push", "f".repeat(40))
  }));
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

test("tag recovery resolves a matching tag without automatic tagging", t => {
  const root = createRepo(t);
  const head = commitVersion(root, "0.0.2");
  for (const tag of ["v0.0.2", "0.0.2"]) {
    const release = resolveReleaseContext({
      repoRoot: root,
      env: { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: tag }
    });
    assert.equal(release.auto_tag, "false");
    assert.equal(release.tag_name, tag);
    assert.equal(release.source_commit, head);
  }
});

function createRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "aspire-release-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-b", "main"]);
  return root;
}

function git(root, args) {
  const result = spawnSync("git", [
    "-c", "user.name=Release test", "-c", "user.email=release-test@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
    ...args
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commitVersion(root, version) {
  writeVersionSources(root, version);
  git(root, ["add", "."]);
  git(root, ["commit", "--allow-empty", "-m", `Version ${version}`]);
  return git(root, ["rev-parse", "HEAD"]);
}

function branchEnv(event, before) {
  return {
    GITHUB_EVENT_NAME: event,
    GITHUB_REF_NAME: "main",
    GITHUB_REF_TYPE: "branch",
    REPOSITORY_DEFAULT_BRANCH: "main",
    BEFORE_SHA: before
  };
}

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
