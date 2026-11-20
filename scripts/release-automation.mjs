import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Repository, fullSha } from "./release-git.mjs";
import { expectedCatalog, validateCatalog } from "./release-catalog.mjs";
import { compareVersions, parseVersion, updateVersion, versionSnapshot } from "./release-versions.mjs";
import { developmentVersionFiles } from "./version-development.mjs";
import { Changelog } from "./release-changelog.mjs";
import { ReleaseOperation } from "./release-operation.mjs";

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

export function releaseVersion(branch) {
  if (!branch.startsWith("release/")) throw new Error("Target must be a release/<version> branch.");
  const version = branch.slice("release/".length);
  parseVersion(version);
  return version;
}

export function assertPublishedHistory(repo, candidate, main) {
  Changelog.read(repo, candidate).assertPreserves(Changelog.read(repo, main),
    version => `Approved changelog history changed or is missing: ${version}`);
}

export function validateRelease(repo, candidate, base, branch, { requireNotes = false } = {}) {
  const version = versionSnapshot(repo, candidate).version;
  if (branch && releaseVersion(branch) !== version) throw new Error("Release branch and coordinated versions disagree.");
  if (compareVersions(version, versionSnapshot(repo, base).version) <= 0) throw new Error("Release version must be newer than main.");
  const changelog = Changelog.read(repo, candidate);
  if (changelog.newest !== version) throw new Error("Release version and newest changelog heading disagree.");
  if (requireNotes && !changelog.notes(version)) throw new Error("Release changelog notes must be finalized before merging.");
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
  const changelog = Changelog.read(repo, source);
  if (changelog.newest !== snapshot.version) throw new Error("Source version and newest changelog heading disagree.");
  files.set("CHANGELOG.md", changelog.withNewestRenamed(version).toBuffer());
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

function matchingPullRequest(api, repository, { branch, base, marker }) {
  const owner = repository.split("/")[0];
  const pulls = api(`repos/${repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`);
  if (pulls.length > 1) throw new Error(`Multiple PRs exist for ${branch}; resolve manually.`);
  const existing = pulls[0];
  if (existing) {
    const body = existing.body?.replaceAll("\r\n", "\n");
    if (existing.base.ref !== base || !body?.includes(marker.replaceAll("\r\n", "\n"))) {
      throw new Error(`Existing PR does not match this automation operation: ${branch}`);
    }
    if (existing.state !== "open") throw new Error(`PR #${existing.number} is already closed or merged; it will not be reopened.`);
  }
  return existing ?? null;
}

export function ensurePullRequest(api, repository, { branch, base, title, body, marker }) {
  const existing = matchingPullRequest(api, repository, { branch, base, marker });
  if (existing) return existing;
  return api(`repos/${repository}/pulls`, {
    method: "POST", body: { head: branch, base, title, body: `${marker}\n\n${body}` }
  });
}

function isAncestor(repo, ancestor, descendant) {
  try {
    repo.run(["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

export function assertRepository(repository) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
    throw new Error("Repository must be an owner/name pair.");
  }
  return repository;
}

function fetchedRemoteHead(repo, branch) {
  const commit = remoteHead(repo, branch);
  if (commit) repo.run(["fetch", "--no-tags", "origin", commit]);
  return commit;
}

function planEntry(entry) {
  return Object.freeze({ ...entry, existing: entry.existing !== null, commit: entry.existing ?? entry.commit });
}

function planRelease(repo, operation, main, findPull) {
  const { source, version } = operation;
  const branch = `release/${version}`;
  const pull = findPull(branch, "main");
  let expected = commitFiles(repo, source, releaseFiles(repo, source, version, main), `Prepare release ${version}`);
  assertPublishedHistory(repo, expected, main);
  expected = commitFiles(repo, expected, expectedCatalog(repo, expected),
    `Generate release ${version} catalogs`, { replace: ["opencode"] });
  validateRelease(repo, expected, main, branch);
  const existing = fetchedRemoteHead(repo, branch);
  if (existing) {
    if (!isAncestor(repo, source, existing)) {
      throw new Error(`Existing branch does not descend from this operation's source: ${branch}`);
    }
    if (!pull && repo.run(["rev-parse", `${existing}^{tree}`]) !== repo.run(["rev-parse", `${expected}^{tree}`])) {
      throw new Error(`Existing branch has no matching PR and contains unexpected changes: ${branch}`);
    }
    validateRelease(repo, existing, main, branch);
  }
  return planEntry({
    kind: "release", branch, base: "main", baseCommit: main, commit: expected, existing,
    title: `Release ${version}`,
    description: "Finalize the release notes and merge after required checks pass."
  });
}

function planDevBump(repo, operation, dev, findPull) {
  const { nextVersion } = operation;
  const branch = `bump-dev/${nextVersion}`;
  findPull(branch, "dev");
  const existing = fetchedRemoteHead(repo, branch);
  let expected = null;
  if (existing) {
    // The bump may predate newer dev commits, so identify it by its recorded operation, not its base.
    const recorded = repo.run(["log", "--format=%B%x00", existing, "--not", dev]).split("\0").map(ReleaseOperation.parse);
    if (!recorded.some(candidate => operation.equals(candidate))) {
      throw new Error(`Existing branch does not match this operation: ${branch}`);
    }
    if (versionSnapshot(repo, existing).version !== nextVersion) {
      throw new Error(`Existing branch has an unexpected development version: ${branch}`);
    }
  } else {
    const { files } = developmentVersionFiles(repo, dev, nextVersion);
    expected = commitFiles(repo, dev, files, `Advance dev to ${nextVersion}\n\n${operation.trailer()}`);
    expected = commitFiles(repo, expected, expectedCatalog(repo, expected),
      `Generate dev ${nextVersion} catalogs`, { replace: ["opencode"] });
  }
  return planEntry({
    kind: "bump-dev", branch, base: "dev", baseCommit: dev, commit: expected, existing,
    title: `Advance dev to ${nextVersion}`,
    description: "Advances coordinated versions, adds the next changelog heading, and regenerates catalogs."
  });
}

// Computes, without pushing, the release and dev-bump branches for one release operation.
// Existing branches are reused only when they match the operation and any open PR records its marker.
export function prepareRelease(repo, request, {
  api = githubRequest,
  repository = process.env.GITHUB_REPOSITORY
} = {}) {
  const operation = ReleaseOperation.create(request ?? {});
  assertRepository(repository);
  const { source, version, nextVersion } = operation;
  repo.run(["fetch", "--no-tags", "origin", "main", "dev"]);
  const main = repo.sha("refs/remotes/origin/main");
  const dev = repo.sha("refs/remotes/origin/dev");
  repo.run(["merge-base", "--is-ancestor", source, dev]);
  if (compareVersions(version, versionSnapshot(repo, main).version) <= 0) throw new Error("Release version must be newer than main.");
  if (compareVersions(nextVersion, versionSnapshot(repo, dev).version) <= 0) throw new Error("Next dev version must be newer than dev.");
  if (repo.run(["ls-remote", "--tags", "origin", `refs/tags/v${version}`]).trim()) {
    throw new Error("This release version already has a published tag.");
  }
  const marker = operation.comment();
  const findPull = (branch, base) => matchingPullRequest(api, repository, { branch, base, marker });
  return Object.freeze({
    operation, marker,
    branches: Object.freeze([planRelease(repo, operation, main, findPull), planDevBump(repo, operation, dev, findPull)])
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const repo = new Repository(process.cwd());
    const [command, ...args] = process.argv.slice(2);
    let result;
    if (command === "prepare" && args.length === 3) {
      const [source, version, nextVersion] = args;
      result = prepareRelease(repo, { source, version, nextVersion });
    } else throw new Error("Usage: release-automation.mjs prepare <sha> <version> <next-version>");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
