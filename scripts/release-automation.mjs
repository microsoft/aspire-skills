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

export function mergeChangelogs(targetText, sourceText) {
  const target = changelogSections(targetText);
  const source = changelogSections(sourceText);
  const sections = new Map([...target.sections, ...source.sections]);
  const ordered = [...sections].sort(([left], [right]) => compareVersions(right, left));
  return Buffer.from(
    target.prefix + ordered.map(([, section]) => section.trimEnd()).join("\n\n") + "\n"
  );
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

const releaseSourceTrailer = "Aspire-Release-Source";

function operationMarker(source, version, nextVersion) {
  return `${releaseSourceTrailer}: ${source}\nAspire-Release-Version: ${version}\nAspire-Next-Version: ${nextVersion}`;
}

export function releaseSources(messages) {
  const pattern = new RegExp(`^(?:<!-- )?${releaseSourceTrailer}: ([0-9a-f]{40})$`, "gm");
  return new Set([...messages.replaceAll("\r\n", "\n").matchAll(pattern)].map(match => match[1]));
}

function isAncestor(repo, ancestor, descendant) {
  try {
    repo.run(["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

export function prepareRelease(repo, source, version, nextVersion, {
  api = githubRequest,
  repository = process.env.GITHUB_REPOSITORY
} = {}) {
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
    let expected;
    if (kind === "release") {
      expected = commitFiles(repo, source, releaseFiles(repo, source, version, main),
        `Prepare release ${version}`);
      assertPublishedHistory(repo, expected, main);
      expected = commitFiles(repo, expected, expectedCatalog(repo, expected),
        `Generate release ${version} catalogs`, { replace: ["opencode"] });
      validateRelease(repo, expected, main, branch);
    } else {
      const { files } = developmentVersionFiles(repo, dev, nextVersion);
      expected = commitFiles(repo, dev, files, `Advance dev to ${nextVersion}\n\n${marker}`);
      expected = commitFiles(repo, expected, expectedCatalog(repo, expected),
        `Generate dev ${nextVersion} catalogs`, { replace: ["opencode"] });
    }
    const pull = repository ? matchingPullRequest(api, repository, {
      branch, base, marker: `<!-- ${marker} -->`
    }) : null;
    let commit = remoteHead(repo, branch);
    const existing = commit !== null;
    if (commit) {
      repo.run(["fetch", "--no-tags", "origin", commit]);
      const operationBase = kind === "release" ? source : dev;
      if (!isAncestor(repo, operationBase, commit)) {
        throw new Error(`Existing branch does not descend from this operation's source: ${branch}`);
      }
      if (!pull && repo.run(["rev-parse", `${commit}^{tree}`]) !== repo.run(["rev-parse", `${expected}^{tree}`])) {
        throw new Error(`Existing branch has no matching PR and contains unexpected changes: ${branch}`);
      }
      if (kind === "release") validateRelease(repo, commit, main, branch);
      else if (versionSnapshot(repo, commit).version !== nextVersion) {
        throw new Error(`Existing branch has an unexpected development version: ${branch}`);
      }
    } else {
      commit = expected;
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
    if (command === "prepare" && args.length === 3) result = prepareRelease(repo, ...args);
    else throw new Error("Usage: release-automation.mjs prepare <sha> <version> <next-version>");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
