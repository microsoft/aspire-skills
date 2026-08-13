import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  normalizeHookBytes,
  publishTelemetryHooks,
  resolveSourceCommit,
  telemetryHookFileModes
} from "../scripts/telemetry-hook-bundle.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsParentRoot = join(repoRoot, ".test-artifacts");
const artifactsRoot = join(artifactsParentRoot, "telemetry-hook-bundle");
const sourceCommit = resolveSourceCommit(undefined, repoRoot);
const hookFileNames = ["track-telemetry.sh", "track-telemetry.ps1"];
const testGitEnv = createSanitizedGitEnvironment();

after(() => {
  rmSync(artifactsRoot, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50
  });

  try {
    if (readdirSync(artifactsParentRoot).length === 0) {
      rmdirSync(artifactsParentRoot);
    }
  }
  catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY" && error?.code !== "EBUSY") {
      throw error;
    }
  }
});

function createArtifactDir(prefix) {
  mkdirSync(artifactsRoot, { recursive: true });
  return mkdtempSync(join(artifactsRoot, prefix));
}

function createSanitizedGitEnvironment() {
  const environment = { ...process.env };

  for (const variableName of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CEILING_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_GRAFT_FILE",
    "GIT_SHALLOW_FILE",
    "GIT_REPLACE_REF_BASE",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_GLOBAL",
    "GIT_TEMPLATE_DIR",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_ATTR_NOSYSTEM",
    "GIT_NO_REPLACE_OBJECTS"
  ]) {
    delete environment[variableName];
  }

  for (const variableName of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(variableName)) {
      delete environment[variableName];
    }
  }

  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  return environment;
}

function createScratchGitEnvironment(emptyGitRoot) {
  return {
    ...testGitEnv,
    GIT_TEMPLATE_DIR: emptyGitRoot,
    GIT_AUTHOR_NAME: "Telemetry Hook Test",
    GIT_COMMITTER_NAME: "Telemetry Hook Test",
    GIT_AUTHOR_EMAIL: "telemetry-hook-test@example.com",
    GIT_COMMITTER_EMAIL: "telemetry-hook-test@example.com",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z"
  };
}

function createMalformedGitConfigEnvironment(scratchRoot) {
  const homeRoot = join(scratchRoot, "hostile-home");
  const xdgRoot = join(scratchRoot, "hostile-xdg");

  mkdirSync(join(xdgRoot, "git"), { recursive: true });
  mkdirSync(homeRoot, { recursive: true });
  writeFileSync(join(homeRoot, ".gitconfig"), "[malformed-home-config\n");
  writeFileSync(join(xdgRoot, "git", "config"), "[malformed-xdg-config\n");

  return {
    HOME: homeRoot,
    XDG_CONFIG_HOME: xdgRoot
  };
}

function initializeScratchRepository(scratchRoot, scratchGitEnv) {
  let git = spawnSync("git", ["-c", "init.defaultBranch=main", "init"], {
    cwd: scratchRoot,
    encoding: "utf8",
    env: scratchGitEnv
  });
  assert.equal(git.status, 0, git.stderr);

  git = spawnSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: scratchRoot,
    encoding: "utf8",
    env: scratchGitEnv
  });
  assert.equal(git.status, 0, git.stderr);
  assert.equal(resolve(git.stdout.trim()), resolve(join(scratchRoot, ".git")));
}

test("publishes telemetry hooks with deterministic file modes", () => {
  assert.deepEqual(telemetryHookFileModes, {
    "track-telemetry.sh": 0o755,
    "track-telemetry.ps1": 0o644
  });
});

test("normalizes BOM, CRLF, and CR before hashing", () => {
  const canonical = Buffer.from("#!/bin/bash\necho aspire\n", "utf8");
  const variants = [
    canonical,
    Buffer.from("#!/bin/bash\r\necho aspire\r\n", "utf8"),
    Buffer.from("#!/bin/bash\recho aspire\r", "utf8"),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("#!/bin/bash\r\necho aspire\r\n", "utf8")])
  ];

  for (const variant of variants) {
    assert.deepEqual(normalizeHookBytes(variant), canonical);
  }
});

test("resolves the current commit when provenance is not passed explicitly", () => {
  const expected = spawnSync("git", ["rev-parse", "HEAD^{commit}"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: testGitEnv
  });

  assert.equal(expected.status, 0, expected.stderr);
  assert.equal(resolveSourceCommit(undefined, repoRoot), expected.stdout.trim());
});

test("skills bundle publishes hook bytes and compatible provenance", () => {
  const outputRoot = createArtifactDir("aspire-skills-bundle-");

  try {
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-aspire-bundles.mjs"),
        "--bundle", "skills",
        "--version", "9.9.9",
        "--out", outputRoot,
        "--source-commit", sourceCommit
      ],
      { cwd: repoRoot, encoding: "utf8", env: testGitEnv }
    );

    assert.equal(result.status, 0, result.stderr);

    const bundleRoot = join(outputRoot, "aspire-skills-v9.9.9");
    const manifest = JSON.parse(readFileSync(join(bundleRoot, "skill-manifest.json"), "utf8"));

    assert.equal(manifest.hooks.commitSha, sourceCommit);
    assert.deepEqual(Object.keys(manifest.hooks.files).sort(), hookFileNames.toSorted());

    for (const fileName of hookFileNames) {
      const sourceBytes = normalizeHookBytes(
        readFileSync(join(repoRoot, "hooks", "scripts", fileName))
      );
      const publishedBytes = readFileSync(join(bundleRoot, "hooks", "scripts", fileName));
      const expectedHash = createHash("sha512").update(publishedBytes).digest("hex");

      assert.deepEqual(publishedBytes, sourceBytes);
      assert.equal(manifest.hooks.files[fileName], expectedHash);
      assert.match(manifest.hooks.files[fileName], /^[0-9a-f]{128}$/);
      assert.equal(
        statSync(join(bundleRoot, "hooks", "scripts", fileName)).mode & 0o777,
        telemetryHookFileModes[fileName]
      );
    }

    const archive = join(outputRoot, "aspire-skills-v9.9.9.tgz");
    const listed = spawnSync("tar", ["-tvzf", archive], { encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /aspire-skills-v9\.9\.9\/hooks\/scripts\/track-telemetry\.sh/);
    assert.match(listed.stdout, /aspire-skills-v9\.9\.9\/hooks\/scripts\/track-telemetry\.ps1/);
    assert.match(listed.stdout, /-rwxr-xr-x\s+.*aspire-skills-v9\.9\.9\/hooks\/scripts\/track-telemetry\.sh/);
    assert.match(listed.stdout, /-rw-r--r--\s+.*aspire-skills-v9\.9\.9\/hooks\/scripts\/track-telemetry\.ps1/);
  }
  finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("skills bundle ignores malformed HOME and XDG Git configuration", () => {
  const outputRoot = createArtifactDir("aspire-skills-bundle-home-xdg-");
  const scratchRoot = createArtifactDir("hostile-home-xdg-");

  try {
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-aspire-bundles.mjs"),
        "--bundle", "skills",
        "--version", "9.9.9",
        "--out", outputRoot,
        "--source-commit", sourceCommit
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          ...createMalformedGitConfigEnvironment(scratchRoot)
        }
      }
    );

    assert.equal(result.status, 0, result.stderr);

    const manifest = JSON.parse(
      readFileSync(join(outputRoot, "aspire-skills-v9.9.9", "skill-manifest.json"), "utf8")
    );
    assert.equal(manifest.hooks.commitSha, sourceCommit);
  }
  finally {
    rmSync(outputRoot, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test("skills bundle ignores ambient Git repository variables", () => {
  const outputRoot = createArtifactDir("aspire-skills-bundle-ambient-git-");
  const scratchRoot = createArtifactDir("unrelated-git-repository-");
  const emptyGitRoot = join(scratchRoot, "empty-git-environment");

  try {
    mkdirSync(emptyGitRoot);
    const scratchGitEnv = createScratchGitEnvironment(emptyGitRoot);
    initializeScratchRepository(scratchRoot, scratchGitEnv);

    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-aspire-bundles.mjs"),
        "--bundle", "skills",
        "--version", "9.9.9",
        "--out", outputRoot,
        "--source-commit", sourceCommit
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_DIR: join(scratchRoot, ".git"),
          GIT_WORK_TREE: scratchRoot,
          GIT_INDEX_FILE: join(scratchRoot, ".git", "index")
        }
      }
    );

    assert.equal(result.status, 0, result.stderr);

    const manifest = JSON.parse(
      readFileSync(join(outputRoot, "aspire-skills-v9.9.9", "skill-manifest.json"), "utf8")
    );
    assert.equal(manifest.hooks.commitSha, sourceCommit);
  }
  finally {
    rmSync(outputRoot, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

const hostileGitEnvironmentCases = [
  {
    name: "GIT_NAMESPACE",
    createEnvironment: () => ({
      GIT_NAMESPACE: "forged-namespace"
    })
  },
  {
    name: "GIT_OBJECT_DIRECTORY",
    createEnvironment: scratchRoot => ({
      GIT_OBJECT_DIRECTORY: join(scratchRoot, ".git", "objects")
    })
  },
  {
    name: "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    createEnvironment: scratchRoot => ({
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(scratchRoot, ".git", "objects")
    })
  },
  {
    name: "GIT_COMMON_DIR",
    createEnvironment: scratchRoot => ({
      GIT_COMMON_DIR: join(scratchRoot, ".git")
    })
  },
  {
    name: "GIT_CEILING_DIRECTORIES",
    createEnvironment: scratchRoot => ({
      GIT_CEILING_DIRECTORIES: scratchRoot
    })
  },
  {
    name: "GIT_CONFIG_PARAMETERS",
    createEnvironment: () => ({
      GIT_CONFIG_PARAMETERS: "invalid"
    })
  },
  {
    name: "GIT_CONFIG_COUNT with KEY_0/VALUE_0",
    createEnvironment: () => ({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.repositoryformatversion",
      GIT_CONFIG_VALUE_0: "999"
    })
  },
  {
    name: "HOME and XDG_CONFIG_HOME",
    createEnvironment: scratchRoot => createMalformedGitConfigEnvironment(scratchRoot)
  }
];

for (const { name, createEnvironment } of hostileGitEnvironmentCases) {
  test(`skills bundle ignores ambient ${name}`, () => {
    const outputRoot = createArtifactDir(`aspire-skills-bundle-${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}-`);
    const scratchRoot = createArtifactDir(`unrelated-${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}-`);
    const emptyGitRoot = join(scratchRoot, "empty-git-environment");

    try {
      mkdirSync(emptyGitRoot);
      const scratchGitEnv = createScratchGitEnvironment(emptyGitRoot);
      initializeScratchRepository(scratchRoot, scratchGitEnv);

      const result = spawnSync(
        process.execPath,
        [
          join(repoRoot, "scripts", "build-aspire-bundles.mjs"),
          "--bundle", "skills",
          "--version", "9.9.9",
          "--out", outputRoot,
          "--source-commit", sourceCommit
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            ...createEnvironment(scratchRoot)
          }
        }
      );

      assert.equal(result.status, 0, result.stderr);

      const manifest = JSON.parse(
        readFileSync(join(outputRoot, "aspire-skills-v9.9.9", "skill-manifest.json"), "utf8")
      );
      assert.equal(manifest.hooks.commitSha, sourceCommit);
    }
    finally {
      rmSync(outputRoot, { recursive: true, force: true });
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });
}

test("publishTelemetryHooks ignores replace refs when validating provenance", () => {
  const scratchRoot = createArtifactDir("telemetry-hook-replace-ref-");
  const sourceRoot = join(scratchRoot, "hooks", "scripts");
  const targetRoot = join(scratchRoot, "published", "hooks", "scripts");
  const emptyGitRoot = join(scratchRoot, "empty-git-environment");

  try {
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(emptyGitRoot);
    const scratchGitEnv = createScratchGitEnvironment(emptyGitRoot);

    for (const fileName of hookFileNames) {
      writeFileSync(
        join(sourceRoot, fileName),
        readFileSync(join(repoRoot, "hooks", "scripts", fileName))
      );
    }

    initializeScratchRepository(scratchRoot, scratchGitEnv);

    let git = spawnSync("git", ["add", "hooks/scripts"], {
      cwd: scratchRoot,
      encoding: "utf8",
      env: scratchGitEnv
    });
    assert.equal(git.status, 0, git.stderr);

    git = spawnSync(
      "git",
      [
        "-c", "commit.gpgsign=false",
        "-c", `core.hooksPath=${emptyGitRoot}`,
        "commit",
        "--no-verify",
        "-m", "canonical hooks"
      ],
      {
        cwd: scratchRoot,
        encoding: "utf8",
        env: scratchGitEnv
      }
    );
    assert.equal(git.status, 0, git.stderr);

    git = spawnSync("git", ["rev-parse", "HEAD^{commit}"], {
      cwd: scratchRoot,
      encoding: "utf8",
      env: scratchGitEnv
    });
    assert.equal(git.status, 0, git.stderr);
    const realCommit = git.stdout.trim();

    writeFileSync(
      join(sourceRoot, "track-telemetry.sh"),
      `${readFileSync(join(sourceRoot, "track-telemetry.sh"), "utf8")}\n# forged replacement\n`
    );

    git = spawnSync("git", ["add", "hooks/scripts/track-telemetry.sh"], {
      cwd: scratchRoot,
      encoding: "utf8",
      env: scratchGitEnv
    });
    assert.equal(git.status, 0, git.stderr);

    git = spawnSync(
      "git",
      [
        "-c", "commit.gpgsign=false",
        "-c", `core.hooksPath=${emptyGitRoot}`,
        "commit",
        "--no-verify",
        "-m", "forged hooks"
      ],
      {
        cwd: scratchRoot,
        encoding: "utf8",
        env: scratchGitEnv
      }
    );
    assert.equal(git.status, 0, git.stderr);

    git = spawnSync("git", ["rev-parse", "HEAD^{commit}"], {
      cwd: scratchRoot,
      encoding: "utf8",
      env: scratchGitEnv
    });
    assert.equal(git.status, 0, git.stderr);
    const forgedCommit = git.stdout.trim();

    git = spawnSync("git", ["replace", realCommit, forgedCommit], {
      cwd: scratchRoot,
      encoding: "utf8",
      env: scratchGitEnv
    });
    assert.equal(git.status, 0, git.stderr);

    assert.throws(
      () => publishTelemetryHooks({
        sourceRoot,
        targetRoot,
        commitSha: realCommit,
        repoRoot: scratchRoot
      }),
      /does not match commit/
    );
  }
  finally {
    rmSync(scratchRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50
    });
  }
});

test("publishTelemetryHooks rejects a nested non-repository repo root", () => {
  const scratchRoot = createArtifactDir("telemetry-hook-ancestor-repository-");
  const parentSourceRoot = join(scratchRoot, "hooks", "scripts");
  const nestedRoot = join(scratchRoot, "nested", "non-repository");
  const sourceRoot = join(nestedRoot, "hooks", "scripts");
  const targetRoot = join(nestedRoot, "published", "hooks", "scripts");
  const emptyGitRoot = join(scratchRoot, "empty-git-environment");

  try {
    mkdirSync(parentSourceRoot, { recursive: true });
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(emptyGitRoot);
    const scratchGitEnv = createScratchGitEnvironment(emptyGitRoot);

    for (const fileName of hookFileNames) {
      const canonicalBytes = readFileSync(join(repoRoot, "hooks", "scripts", fileName));
      writeFileSync(join(parentSourceRoot, fileName), canonicalBytes);
      writeFileSync(join(sourceRoot, fileName), canonicalBytes);
    }

    initializeScratchRepository(scratchRoot, scratchGitEnv);

    let git = spawnSync("git", ["add", "hooks/scripts"], {
      cwd: scratchRoot,
      encoding: "utf8",
      env: scratchGitEnv
    });
    assert.equal(git.status, 0, git.stderr);

    git = spawnSync(
      "git",
      [
        "-c", "commit.gpgsign=false",
        "-c", `core.hooksPath=${emptyGitRoot}`,
        "commit",
        "--no-verify",
        "-m", "canonical hooks"
      ],
      {
        cwd: scratchRoot,
        encoding: "utf8",
        env: scratchGitEnv
      }
    );
    assert.equal(git.status, 0, git.stderr);

    git = spawnSync("git", ["rev-parse", "HEAD^{commit}"], {
      cwd: scratchRoot,
      encoding: "utf8",
      env: scratchGitEnv
    });
    assert.equal(git.status, 0, git.stderr);
    const commitSha = git.stdout.trim();

    assert.throws(
      () => publishTelemetryHooks({
        sourceRoot,
        targetRoot,
        commitSha,
        repoRoot: nestedRoot
      }),
      /^Error: Requested root '.+' is not the Git repository root '.+'\.$/
    );

    assert.throws(
      () => resolveSourceCommit(undefined, nestedRoot),
      /^Error: Requested root '.+' is not the Git repository root '.+'\.$/
    );
  }
  finally {
    rmSync(scratchRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50
    });
  }
});

test("builder rejects provenance whose committed hook contents differ from the published sources", () => {
  const outputRoot = createArtifactDir("aspire-skills-bundle-root-commit-");
  const rootCommit = spawnSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: testGitEnv
  });
  const rootCommitSha = rootCommit.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0);

  try {
    assert.equal(rootCommit.status, 0, rootCommit.stderr);
    assert.ok(rootCommitSha, "Expected git rev-list to return at least one root commit");

    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-aspire-bundles.mjs"),
        "--bundle", "skills",
        "--version", "9.9.9",
        "--out", outputRoot,
        "--source-commit", rootCommitSha
      ],
      { cwd: repoRoot, encoding: "utf8", env: testGitEnv }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match commit/);
  }
  finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("publishTelemetryHooks rejects provenance when the commit has no hook paths", () => {
  const scratchRoot = createArtifactDir("telemetry-hook-missing-commit-paths-");
  const sourceRoot = join(scratchRoot, "hooks", "scripts");
  const targetRoot = join(scratchRoot, "published", "hooks", "scripts");
  const emptyGitRoot = join(scratchRoot, "empty-git-environment");

  try {
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(emptyGitRoot);
    const scratchGitEnv = createScratchGitEnvironment(emptyGitRoot);

    for (const fileName of hookFileNames) {
      writeFileSync(
        join(sourceRoot, fileName),
        readFileSync(join(repoRoot, "hooks", "scripts", fileName))
      );
    }

    initializeScratchRepository(scratchRoot, scratchGitEnv);

    let git = spawnSync(
      "git",
      [
        "-c", "commit.gpgsign=false",
        "-c", `core.hooksPath=${emptyGitRoot}`,
        "commit",
        "--allow-empty",
        "--no-verify",
        "-m", "empty"
      ],
      {
        cwd: scratchRoot,
        encoding: "utf8",
        env: scratchGitEnv
      }
    );
    assert.equal(git.status, 0, git.stderr);

    const commit = spawnSync("git", ["rev-parse", "HEAD^{commit}"], {
      cwd: scratchRoot,
      encoding: "utf8",
      env: scratchGitEnv
    });
    assert.equal(commit.status, 0, commit.stderr);

    assert.throws(
      () => publishTelemetryHooks({
        sourceRoot,
        targetRoot,
        commitSha: commit.stdout.trim(),
        repoRoot: scratchRoot
      }),
      /^Error: Could not read hook 'hooks\/scripts\/track-telemetry\.sh' from commit '[0-9a-f]{40}': .+/
    );
  }
  finally {
    rmSync(scratchRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50
    });
  }
});

test("extensions-only bundle ignores invalid hook provenance", () => {
  const outputRoot = createArtifactDir("aspire-extensions-bundle-invalid-");

  try {
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-aspire-bundles.mjs"),
        "--bundle", "extensions",
        "--version", "9.9.9",
        "--out", outputRoot,
        "--source-commit", "not-a-commit"
      ],
      { cwd: repoRoot, encoding: "utf8", env: testGitEnv }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(statSync(join(outputRoot, "aspire-extensions-v9.9.9.tgz")).isFile(), true);
  }
  finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("builder rejects invalid hook provenance", () => {
  const outputRoot = createArtifactDir("aspire-skills-bundle-invalid-");

  try {
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-aspire-bundles.mjs"),
        "--bundle", "skills",
        "--version", "9.9.9",
        "--out", outputRoot,
        "--source-commit", "not-a-commit"
      ],
      { cwd: repoRoot, encoding: "utf8", env: testGitEnv }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /40-character Git commit SHA/);
  }
  finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});
