import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(scriptPath), "..");
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const versionSources = [
  [".plugin/plugin.json", json => json.version],
  [".claude-plugin/plugin.json", json => json.version],
  [".claude-plugin/marketplace.json", json => json.plugins?.[0]?.version],
  [".cursor-plugin/marketplace.json", json => json.plugins?.[0]?.version],
  ["gemini-extension.json", json => json.version],
  ["package.json", json => json.version]
];

export function readPluginVersion(repoRoot = defaultRepoRoot) {
  const versions = versionSources.map(([relativePath, selectVersion]) => {
    const document = JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8"));
    const version = selectVersion(document);
    validateVersion(version, relativePath);
    return { relativePath, version };
  });

  const expected = versions[0].version;
  const mismatches = versions.filter(entry => entry.version !== expected);
  if (mismatches.length > 0) {
    const details = versions
      .map(entry => `${entry.relativePath}=${entry.version}`)
      .join(", ");
    throw new Error(`Plugin versions must match: ${details}.`);
  }

  return expected;
}

export function normalizeReleaseTag(tagName) {
  const version = tagName.startsWith("v") ? tagName.slice(1) : tagName;
  validateVersion(version, `tag '${tagName}'`);
  return version;
}

export function compareVersions(left, right) {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);

  for (let index = 0; index < leftVersion.core.length; index += 1) {
    if (leftVersion.core[index] !== rightVersion.core[index]) {
      return leftVersion.core[index] > rightVersion.core[index] ? 1 : -1;
    }
  }

  if (leftVersion.prerelease === undefined) {
    return rightVersion.prerelease === undefined ? 0 : 1;
  }
  if (rightVersion.prerelease === undefined) {
    return -1;
  }

  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    if (leftIdentifier === rightIdentifier) {
      continue;
    }

    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftIdentifier) > BigInt(rightIdentifier) ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return Math.sign(leftIdentifier.localeCompare(rightIdentifier, "en"));
  }

  return 0;
}

export function resolveReleaseContext({
  repoRoot = defaultRepoRoot,
  env = process.env
} = {}) {
  const version = readPluginVersion(repoRoot);
  const refType = env.GITHUB_REF_TYPE;
  const refName = env.GITHUB_REF_NAME;
  let tagName;
  let autoTag;

  if (refType === "tag") {
    const tagVersion = normalizeReleaseTag(refName);
    if (tagVersion !== version) {
      throw new Error(
        `Tag '${refName}' resolves to ${tagVersion}, but the plugin version is ${version}.`
      );
    }
    tagName = refName;
    autoTag = false;
  } else if (refType === "branch") {
    if (refName !== env.REPOSITORY_DEFAULT_BRANCH) {
      throw new Error(
        `Automatic releases must run from '${env.REPOSITORY_DEFAULT_BRANCH}', not '${refName}'.`
      );
    }
    tagName = `v${version}`;
    autoTag = true;
  } else {
    throw new Error(`Unsupported Git ref type '${refType}'.`);
  }

  let previousVersion = "";
  if (
    env.GITHUB_EVENT_NAME === "push" &&
    refType === "branch" &&
    env.BEFORE_SHA &&
    !/^0+$/.test(env.BEFORE_SHA)
  ) {
    previousVersion = readPluginVersionAtRef(repoRoot, env.BEFORE_SHA);
    if (previousVersion !== version && compareVersions(version, previousVersion) <= 0) {
      throw new Error(
        `Plugin version must increase on main: ${previousVersion} -> ${version}.`
      );
    }
  }

  const sourceCommit = runGit(repoRoot, ["rev-parse", "HEAD^{commit}"]);
  return {
    auto_tag: String(autoTag),
    extensions_asset: `dist/aspire-extensions-v${version}.tgz`,
    previous_version: previousVersion,
    skills_asset: `dist/aspire-skills-v${version}.tgz`,
    source_commit: sourceCommit,
    tag_name: tagName,
    version,
    version_changed: String(previousVersion !== "" && previousVersion !== version)
  };
}

function parseVersion(version) {
  validateVersion(version, "version");
  const match = versionPattern.exec(version);
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split(".")
  };
}

function validateVersion(version, source) {
  if (typeof version !== "string" || !versionPattern.test(version)) {
    throw new Error(`${source} has unsupported semantic version '${version}'.`);
  }
}

function readPluginVersionAtRef(repoRoot, ref) {
  const contents = runGit(repoRoot, ["show", `${ref}:.plugin/plugin.json`]);
  const version = JSON.parse(contents).version;
  validateVersion(version, `.plugin/plugin.json at ${ref}`);
  return version;
}

function runGit(repoRoot, args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed.`);
  }
  return result.stdout.trim();
}

function writeOutputs(outputs, outputPath) {
  const lines = Object.entries(outputs)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
  appendFileSync(outputPath, `${lines}\n`);
}

function isDirectRun() {
  return process.argv[1] &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectRun()) {
  try {
    const outputs = resolveReleaseContext();
    if (process.env.GITHUB_OUTPUT) {
      writeOutputs(outputs, process.env.GITHUB_OUTPUT);
      console.log(`Resolved ${outputs.tag_name} at ${outputs.source_commit}.`);
    } else {
      console.log(JSON.stringify(outputs, null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
