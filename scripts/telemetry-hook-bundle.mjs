import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const telemetryHookFileNames = [
  "track-telemetry.sh",
  "track-telemetry.ps1"
];

export const telemetryHookFileModes = {
  "track-telemetry.sh": 0o755,
  "track-telemetry.ps1": 0o644
};

export function normalizeHookBytes(bytes) {
  let text = Buffer.from(bytes).toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  return Buffer.from(text.replace(/\r\n?/g, "\n"), "utf8");
}

function createReadOnlyGitEnvironment() {
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

export function resolveSourceCommit(explicitCommit, repoRoot) {
  let commit = explicitCommit;
  if (commit === undefined || commit === null) {
    const canonicalRepoRoot = assertGitRepositoryRoot(repoRoot);
    commit = readGitCommit(canonicalRepoRoot);
  }

  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error(`Hook provenance must be a 40-character Git commit SHA; got '${commit}'.`);
  }

  return commit.toLowerCase();
}

export function publishTelemetryHooks({ sourceRoot, targetRoot, commitSha, repoRoot }) {
  const logicalRepoRoot = resolve(repoRoot);
  const logicalSourceRoot = resolve(sourceRoot);
  const gitPaths = Object.fromEntries(
    telemetryHookFileNames.map(fileName => [
      fileName,
      relative(logicalRepoRoot, join(logicalSourceRoot, fileName)).split(sep).join("/")
    ])
  );
  const canonicalRepoRoot = assertGitRepositoryRoot(logicalRepoRoot);
  mkdirSync(targetRoot, { recursive: true });
  const files = {};

  for (const fileName of telemetryHookFileNames) {
    const sourcePath = join(logicalSourceRoot, fileName);
    const targetPath = join(targetRoot, fileName);
    const gitPath = gitPaths[fileName];
    const bytes = normalizeHookBytes(readFileSync(sourcePath));
    const committedBytes = normalizeHookBytes(
      readCommittedHookBytes(canonicalRepoRoot, commitSha, gitPath)
    );
    if (!bytes.equals(committedBytes)) {
      throw new Error(`Hook '${gitPath}' does not match commit '${commitSha}' after normalization.`);
    }

    writeFileSync(targetPath, bytes);
    chmodSync(targetPath, telemetryHookFileModes[fileName]);
    files[fileName] = createHash("sha512").update(bytes).digest("hex");
  }

  return {
    commitSha,
    files
  };
}

function assertGitRepositoryRoot(repoRoot) {
  const requestedRoot = resolve(repoRoot);
  const canonicalRequestedRoot = realpathSync(requestedRoot);
  const result = spawnSync(
    "git",
    ["-c", `safe.directory=${canonicalRequestedRoot}`, "rev-parse", "--show-toplevel"],
    {
      cwd: canonicalRequestedRoot,
      encoding: "utf8",
      env: createReadOnlyGitEnvironment()
    }
  );

  if (result.error) {
    throw new Error(
      `Could not resolve a Git repository at requested root '${requestedRoot}': ${result.error.message}`
    );
  }

  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim();
    throw new Error(
      `Could not resolve a Git repository at requested root '${requestedRoot}'${detail ? `: ${detail}` : "."}`
    );
  }

  const canonicalGitRoot = realpathSync(resolve(canonicalRequestedRoot, result.stdout.trim()));
  const comparableRequestedRoot = process.platform === "win32"
    ? canonicalRequestedRoot.toLowerCase()
    : canonicalRequestedRoot;
  const comparableGitRoot = process.platform === "win32"
    ? canonicalGitRoot.toLowerCase()
    : canonicalGitRoot;

  if (comparableRequestedRoot !== comparableGitRoot) {
    throw new Error(
      `Requested root '${canonicalRequestedRoot}' is not the Git repository root '${canonicalGitRoot}'.`
    );
  }

  return canonicalGitRoot;
}

function readCommittedHookBytes(repoRoot, commitSha, gitPath) {
  const result = spawnSync(
    "git",
    ["-c", `safe.directory=${repoRoot}`, "show", `${commitSha}:${gitPath}`],
    {
      cwd: repoRoot,
      env: createReadOnlyGitEnvironment()
    }
  );

  if (result.error) {
    throw new Error(`Could not read hook '${gitPath}' from commit '${commitSha}': ${result.error.message}`);
  }

  if (result.status !== 0) {
    const detail = Buffer.from(result.stderr ?? "").toString("utf8").trim();
    throw new Error(
      `Could not read hook '${gitPath}' from commit '${commitSha}'${detail ? `: ${detail}` : "."}`
    );
  }

  return result.stdout;
}

function readGitCommit(repoRoot) {
  const result = spawnSync(
    "git",
    ["-c", `safe.directory=${repoRoot}`, "rev-parse", "HEAD^{commit}"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: createReadOnlyGitEnvironment()
    }
  );

  if (result.error) {
    throw new Error(`Could not resolve hook source commit: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Could not resolve hook source commit: ${(result.stderr ?? "").trim()}`);
  }

  return result.stdout.trim();
}
