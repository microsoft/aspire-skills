import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Repository, fullSha } from "./release-git.mjs";
import { expectedCatalog, validateCatalog } from "./release-catalog.mjs";
import { compareVersions, parseVersion, updateVersion, versionSnapshot } from "./release-versions.mjs";
import { developmentVersionFiles } from "./version-development.mjs";

export function remoteHead(repo, branch) {
  repo.run(["check-ref-format", `refs/heads/${branch}`]);
  const lines = repo.run(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]).trim();
  if (!lines) return null;
  const [sha, ref] = lines.split(/\s+/);
  if (ref !== `refs/heads/${branch}`) throw new Error("Unexpected remote ref.");
  return fullSha(sha);
}

export function commitFiles(repo, parent, files, message, { replace = [], allowEmpty = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "aspire-release-index-"));
  const indexFile = join(directory, "index");
  try {
    const entries = new Map(parent ? repo.files(parent) : []);
    for (const path of entries.keys()) {
      if (replace.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) entries.delete(path);
    }
    for (const [path, bytes] of files) {
      if (bytes === null) {
        entries.delete(path);
      } else {
        const oid = repo.run(["hash-object", "-w", "--stdin"], { input: bytes }).trim();
        entries.set(path, { mode: "100644", oid });
      }
    }
    repo.run(["read-tree", "--empty"], { indexFile });
    repo.run(["update-index", "-z", "--index-info"], {
      indexFile,
      input: [...entries].map(([path, entry]) => `${entry.mode} ${entry.oid}\t${path}\0`).join("")
    });
    const tree = repo.run(["write-tree"], { indexFile }).trim();
    if (!allowEmpty && parent && tree === repo.run(["rev-parse", `${parent}^{tree}`]).trim()) return parent;
    return fullSha(repo.run(["commit-tree", tree, ...(parent ? ["-p", parent] : [])], {
      input: `${message}\n`
    }).trim());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function guardedPush(repo, branch, commit, expected) {
  const current = remoteHead(repo, branch);
  if (current !== expected) throw new Error(`Stale operation: ${branch} changed; retry from its current tip.`);
  repo.run(["push", `--force-with-lease=refs/heads/${branch}:${expected ?? ""}`,
    "origin", `${fullSha(commit)}:refs/heads/${branch}`]);
}

export function refreshRelease(repo, branch, source) {
  releaseVersion(branch);
  fullSha(source);
  if (remoteHead(repo, branch) !== source) throw new Error("Stale release catalog source; candidate has advanced.");
  const version = versionSnapshot(repo, source).version;
  if (branch !== `release/${version}`) throw new Error("Release branch and coordinated versions disagree.");
  const commit = commitFiles(repo, source, expectedCatalog(repo, source),
    `Refresh release catalogs for ${source}`, { replace: ["opencode"] });
  if (commit !== source) guardedPush(repo, branch, commit, source);
  return { commit };
}

export function releaseVersion(branch) {
  if (!branch.startsWith("release/")) throw new Error("Target must be a release/<version> branch.");
  const version = branch.slice("release/".length);
  parseVersion(version);
  return version;
}

function changelogSections(text) {
  const normalized = text.replaceAll("\r\n", "\n");
  const start = normalized.search(/^## /m);
  if (start < 0) throw new Error("CHANGELOG.md needs a version heading.");
  const sections = normalized.slice(start).split(/(?=^## )/m).filter(Boolean);
  const result = new Map();
  for (const section of sections) {
    const version = /^## \[([^\]]+)\]\(https:\/\/github\.com\/microsoft\/aspire-skills\/releases\/tag\/v\1\)\n/.exec(section)?.[1];
    if (!version || result.has(version)) throw new Error("Invalid or duplicate changelog heading.");
    parseVersion(version);
    result.set(version, section);
  }
  return { prefix: normalized.slice(0, start), sections: result };
}

export function assertPublishedHistory(repo, candidate, main) {
  const approved = changelogSections(repo.read(main, "CHANGELOG.md").toString("utf8")).sections;
  const proposed = changelogSections(repo.read(candidate, "CHANGELOG.md").toString("utf8")).sections;
  for (const [version, text] of approved) {
    if (proposed.get(version)?.trimEnd() !== text.trimEnd()) {
      throw new Error(`Approved changelog history changed or is missing: ${version}`);
    }
  }
}

export function validateRelease(repo, candidate, base, branch) {
  const version = versionSnapshot(repo, candidate).version;
  if (branch && releaseVersion(branch) !== version) throw new Error("Release branch and coordinated versions disagree.");
  if (compareVersions(version, versionSnapshot(repo, base).version) <= 0) throw new Error("Release version must be newer than main.");
  const sections = changelogSections(repo.read(candidate, "CHANGELOG.md").toString("utf8")).sections;
  if (sections.keys().next().value !== version) throw new Error("Release version and newest changelog heading disagree.");
  assertPublishedHistory(repo, candidate, base);
  validateCatalog(repo, candidate, expectedCatalog(repo, candidate));
  return version;
}

export function releaseFiles(repo, source, version, main) {
  parseVersion(version);
  const snapshot = versionSnapshot(repo, source);
  if (compareVersions(version, snapshot.version) < 0) throw new Error("Release version cannot precede the source version.");
  if (main && version !== snapshot.version && versionSnapshot(repo, main).version === snapshot.version) {
    assertPublishedHistory(repo, source, main);
    return developmentVersionFiles(repo, source, version).files;
  }
  const files = new Map([...snapshot.manifests].map(([path, bytes]) => [path, updateVersion(bytes, path, version)]));
  const text = repo.read(source, "CHANGELOG.md").toString("utf8");
  const parsed = changelogSections(text);
  if (parsed.sections.keys().next().value !== snapshot.version) throw new Error("Source version and newest changelog heading disagree.");
  files.set("CHANGELOG.md", Buffer.from(text.replace(
    `## [${snapshot.version}](https://github.com/microsoft/aspire-skills/releases/tag/v${snapshot.version})`,
    `## [${version}](https://github.com/microsoft/aspire-skills/releases/tag/v${version})`
  )));
  return files;
}

export function githubRequest(path, { method = "GET", body } = {}) {
  const result = spawnSync("gh", ["api", "--method", method, path, ...(body ? ["--input", "-"] : [])], {
    encoding: "utf8", input: body ? JSON.stringify(body) : undefined, maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`GitHub API failed: ${result.stderr.trim()}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

export function ensurePullRequest(api, repository, { branch, base, title, body, marker }) {
  const owner = repository.split("/")[0];
  const pulls = api(`repos/${repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`);
  if (pulls.length > 1) throw new Error(`Multiple PRs exist for ${branch}; resolve manually.`);
  const existing = pulls[0];
  if (existing) {
    if (existing.base.ref !== base || !existing.body?.includes(marker)) {
      throw new Error(`Existing PR does not match this automation operation: ${branch}`);
    }
    if (existing.state !== "open") throw new Error(`PR #${existing.number} is already closed or merged; it will not be reopened.`);
    return existing;
  }
  return api(`repos/${repository}/pulls`, {
    method: "POST", body: { head: branch, base, title, body: `${marker}\n\n${body}` }
  });
}

function operationMarker(source, version, nextVersion) {
  return `Aspire-Release-Source: ${source}\nAspire-Release-Version: ${version}\nAspire-Next-Version: ${nextVersion}`;
}

export function prepareRelease(repo, source, version, nextVersion) {
  fullSha(source);
  parseVersion(version);
  parseVersion(nextVersion);
  if (compareVersions(nextVersion, version) <= 0) throw new Error("Next dev version must be newer than the release.");
  repo.run(["fetch", "--no-tags", "origin", "main", "dev"]);
  const main = repo.sha("refs/remotes/origin/main");
  const dev = repo.sha("refs/remotes/origin/dev");
  repo.run(["merge-base", "--is-ancestor", source, dev]);
  if (compareVersions(version, versionSnapshot(repo, main).version) <= 0) throw new Error("Release version must be newer than main.");
  if (compareVersions(nextVersion, versionSnapshot(repo, dev).version) <= 0) throw new Error("Next dev version must be newer than dev.");
  if (repo.run(["ls-remote", "--tags", "origin", `refs/tags/v${version}`]).trim()) {
    throw new Error("This release version already has a published tag.");
  }
  const marker = operationMarker(source, version, nextVersion);
  const branches = [];
  for (const kind of ["release", "bump-dev"]) {
    const branch = `${kind}/${kind === "release" ? version : nextVersion}`;
    const base = kind === "release" ? "main" : "dev";
    let commit = remoteHead(repo, branch);
    const existing = commit !== null;
    if (commit) {
      repo.run(["fetch", "--no-tags", "origin", commit]);
      // The original operation commit remains in history even after maintainer edits.
      const messages = repo.run(["log", "--format=%B%x00", commit, "--not", main]);
      if (!messages.split("\0").some(message => message.includes(marker))) {
        throw new Error(`Existing branch belongs to another operation: ${branch}`);
      }
    } else {
      if (kind === "release") {
        commit = commitFiles(repo, source, releaseFiles(repo, source, version, main),
          `Prepare release ${version}\n\n${marker}`, { allowEmpty: true });
        assertPublishedHistory(repo, commit, main);
        commit = commitFiles(repo, commit, expectedCatalog(repo, commit), `Generate release ${version} catalogs`, { replace: ["opencode"] });
        validateRelease(repo, commit, main, branch);
      } else {
        const { files } = developmentVersionFiles(repo, dev, nextVersion);
        commit = commitFiles(repo, dev, files, `Advance dev to ${nextVersion}\n\n${marker}`);
      }
    }
    branches.push({ branch, base, commit, baseCommit: base === "main" ? main : dev, existing });
  }
  return { marker: `<!-- ${marker} -->`, branches };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const repo = new Repository(process.cwd());
    const [command, ...args] = process.argv.slice(2);
    let result;
    if (command === "refresh" && args.length === 2) result = refreshRelease(repo, ...args);
    else if (command === "prepare" && args.length === 3) result = prepareRelease(repo, ...args);
    else throw new Error("Usage: release-automation.mjs refresh <branch> <sha> | prepare <sha> <version> <next-version>");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
