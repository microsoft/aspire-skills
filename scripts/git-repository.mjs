import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export function createGitEnvironment() {
  const environment = { ...process.env };
  for (const variableName of [
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES",
    "GIT_NAMESPACE", "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
    "GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL", "GIT_TEMPLATE_DIR",
    "GIT_CONFIG_NOSYSTEM", "GIT_ATTR_NOSYSTEM", "GIT_NO_REPLACE_OBJECTS"
  ]) {
    delete environment[variableName];
  }
  for (const variableName of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(variableName)) delete environment[variableName];
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  // Git for Windows recognizes /dev/null but rejects NUL as a config path.
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

export function assertGitRepositoryRoot(repoRoot) {
  const requestedRoot = resolve(repoRoot);
  const canonicalRequestedRoot = realpathSync.native(requestedRoot);
  const result = spawnSync(
    "git", ["-c", `safe.directory=${canonicalRequestedRoot}`, "rev-parse", "--show-toplevel"],
    { cwd: canonicalRequestedRoot, encoding: "utf8", env: createGitEnvironment() }
  );
  if (result.error) {
    throw new Error(`Could not resolve a Git repository at requested root '${requestedRoot}': ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim();
    throw new Error(`Could not resolve a Git repository at requested root '${requestedRoot}'${detail ? `: ${detail}` : "."}`);
  }
  const canonicalGitRoot = realpathSync.native(resolve(canonicalRequestedRoot, result.stdout.trim()));
  const comparableRequestedRoot = process.platform === "win32" ? canonicalRequestedRoot.toLowerCase() : canonicalRequestedRoot;
  const comparableGitRoot = process.platform === "win32" ? canonicalGitRoot.toLowerCase() : canonicalGitRoot;
  if (comparableRequestedRoot !== comparableGitRoot) {
    throw new Error(`Requested root '${canonicalRequestedRoot}' is not the Git repository root '${canonicalGitRoot}'.`);
  }
  return canonicalGitRoot;
}
