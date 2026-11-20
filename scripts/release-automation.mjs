import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Repository, fullSha } from "./release-git.mjs";
import { expectedCatalog } from "./release-catalog.mjs";
import { compareVersions, parseVersion, versionSnapshot } from "./release-versions.mjs";
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
  return version;
}

function releaseCuts(repo, head) {
  const cuts = new Map();
  const refs = repo.run(["ls-remote", "--heads", "origin", "refs/heads/release/*"]).trim();
  for (const line of refs ? refs.split("\n") : []) {
    const [sha, ref] = line.split(/\s+/);
    let version;
    try {
      version = releaseVersion(ref.slice("refs/heads/".length));
    } catch {
      continue;
    }
    repo.run(["fetch", "--no-tags", "origin", fullSha(sha)]);
    cuts.set(version, fullSha(repo.run(["merge-base", sha, head]).trim()));
  }
  return cuts;
}

// Changelog sections that other branches own: sections published on main, and the dev commits release branches were cut from.
function changelogOwners(repo, head) {
  const main = fetchedRemoteHead(repo, "main");
  return { published: main ? Changelog.read(repo, main) : null, cuts: releaseCuts(repo, head) };
}

// Keeps changelog entries out of released versions. `base` is the commit `head` is compared against.
// While a cut version is still dev's newest, entries may be added; `syncChangelog` moves them.
export function validateChangelogPlacement(repo, head, base) {
  const changelog = Changelog.read(repo, head);
  const before = Changelog.read(repo, base);
  const { published, cuts } = changelogOwners(repo, head);
  const devVersion = versionSnapshot(repo, head).version;
  const newest = changelog.newest;
  if (newest !== devVersion) {
    throw new Error(`The newest changelog heading must be the development version ${devVersion}.`);
  }
  for (const version of changelog.versions) {
    const section = changelog.section(version);
    if (section === before.section(version)) continue;
    const publishedSection = published?.section(version);
    if (publishedSection !== undefined) {
      if (section !== publishedSection) throw new Error(`${version} is already released. Add changelog entries under ${newest}.`);
    } else if (cuts.has(version)) {
      if (changelog.entryChanges(version, Changelog.read(repo, cuts.get(version))).removed.length) {
        throw new Error(`${version} changelog entries shipped in release/${version}. Edit them on that branch, not on dev.`);
      }
      if (version !== newest && changelog.entryChanges(version, before).added.length) {
        throw new Error(`release/${version} was cut from dev. Add changelog entries under ${newest}.`);
      }
    } else if (version !== newest) {
      throw new Error(`Add changelog entries under ${newest}, not ${version}.`);
    }
  }
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
  validateRelease(repo, source, main, branch);
  const existing = fetchedRemoteHead(repo, branch);
  if (existing) {
    if (!isAncestor(repo, source, existing)) {
      throw new Error(`Existing branch does not descend from this operation's source: ${branch}`);
    }
    if (!pull && existing !== source) {
      throw new Error(`Existing branch has no matching PR and contains unexpected changes: ${branch}`);
    }
    validateRelease(repo, existing, main, branch);
  }
  return planEntry({
    kind: "release", branch, base: "main", baseCommit: main, commit: source, existing,
    title: `Release ${version}`,
    description: `This PR releases \`dev\` commit ${source} as ${version}. `
      + "Finalize the release notes, then merge after required checks pass."
  });
}

function buildDevBump(repo, operation, dev) {
  const { version, nextVersion } = operation;
  const { files } = developmentVersionFiles(repo, dev, nextVersion);
  files.set("CHANGELOG.md", Changelog.parse(files.get("CHANGELOG.md").toString("utf8"))
    .withLaterEntriesMoved(version, Changelog.read(repo, operation.source), nextVersion).toBuffer());
  const bump = commitFiles(repo, dev, files, `Advance dev to ${nextVersion}\n\n${operation.trailer()}`);
  return commitFiles(repo, bump, expectedCatalog(repo, bump), `Generate dev ${nextVersion} catalogs`, { replace: ["opencode"] });
}

function planDevBump(repo, operation, dev, findPull) {
  const { version, nextVersion } = operation;
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
    expected = buildDevBump(repo, operation, dev);
  }
  return planEntry({
    kind: "bump-dev", branch, base: "dev", baseCommit: dev, commit: expected, existing,
    title: `Advance dev to ${nextVersion}`,
    description: [
      `This PR advances \`dev\` to ${nextVersion}. Release ${version} ships \`dev\` commit ${operation.source}.`,
      "",
      `Until this PR merges, keep adding changelog entries under ${version}. After each merge into \`dev\`, `
        + `automation rebuilds this PR on the latest \`dev\` and moves ${version} entries added after `
        + `${operation.source} to ${nextVersion}. Don't push to this branch.`
    ].join("\n")
  });
}

// Computes, without pushing, the release and dev-bump branches for one release operation.
// Existing branches are reused only when they match the operation and any open PR records its marker.
export function prepareRelease(repo, request, {
  api = githubRequest,
  repository = process.env.GITHUB_REPOSITORY
} = {}) {
  assertRepository(repository);
  const source = fullSha(request?.source, "Release source");
  const nextVersion = request?.nextVersion;
  parseVersion(nextVersion);
  repo.run(["fetch", "--no-tags", "origin", "main", "dev"]);
  const main = repo.sha("refs/remotes/origin/main");
  const dev = repo.sha("refs/remotes/origin/dev");
  repo.run(["merge-base", "--is-ancestor", source, dev]);
  const version = versionSnapshot(repo, source).version;
  const operation = ReleaseOperation.create({ source, version, nextVersion });
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

export const changelogReviewMarker = "<!-- Aspire-Changelog-Review -->";

// Rebuilds an open bump PR on the latest dev. Returns null when the branch already holds that tree on top of dev.
function bumpUpdate(repo, dev, newest, pull) {
  const operation = ReleaseOperation.parse(pull.body);
  if (operation?.version !== newest || pull.head.ref !== `bump-dev/${operation.nextVersion}`) return null;
  const commit = buildDevBump(repo, operation, dev);
  const current = fetchedRemoteHead(repo, pull.head.ref);
  const tree = sha => repo.run(["rev-parse", `${sha}^{tree}`]).trim();
  if (current && isAncestor(repo, dev, current) && tree(current) === tree(commit)) return null;
  return Object.freeze({ branch: pull.head.ref, current, commit, pull: pull.number });
}

// Entries `head` adds, relative to its merge base with dev, under versions older than dev's newest.
// Sections equal to main's published notes are skipped so main-to-dev merges are not flagged.
function lateEntries(repo, head, dev, newest, published) {
  const changelog = Changelog.read(repo, head);
  const base = Changelog.read(repo, repo.run(["merge-base", head, dev]).trim());
  return changelog.versions
    .filter(version => compareVersions(version, newest) < 0 && changelog.section(version) !== published?.section(version))
    .flatMap(version => changelog.entryChanges(version, base).added.map(({ text }) => ({ version, text })));
}

// Requests changes while a PR adds late entries, and dismisses the bot's review once it no longer does.
function reviewUpdate(api, repository, pull, commit, entries, newest) {
  const active = api(`repos/${repository}/pulls/${pull.number}/reviews?per_page=100`).filter(review =>
    review.user?.type === "Bot" && review.state === "CHANGES_REQUESTED" && review.body?.includes(changelogReviewMarker));
  if (!entries.length) {
    return active.length ? Object.freeze({ action: "dismiss", pull: pull.number, reviews: active.map(review => review.id) }) : null;
  }
  if (active.length) return null;
  const versions = [...new Set(entries.map(entry => entry.version))];
  const body = [
    changelogReviewMarker,
    `\`dev\` has advanced to ${newest}, so these entries won't ship in ${versions.join(" or ")}. Move them to ${newest}:`,
    ...versions.map(version => `\n**${version}**\n\n${entries.filter(entry => entry.version === version).map(entry => entry.text).join("\n")}`)
  ].join("\n");
  return Object.freeze({ action: "request", pull: pull.number, commit, body });
}

// Plans, without writing, the bot actions that keep dev's changelog entries out of cut releases:
// open bump PRs are rebuilt on the latest dev, and open PRs that add entries under an older version get
// a changes-requested review until they move them.
export function syncChangelog(repo, { api = githubRequest, repository = process.env.GITHUB_REPOSITORY } = {}) {
  assertRepository(repository);
  repo.run(["fetch", "--no-tags", "origin", "dev"]);
  const dev = repo.sha("refs/remotes/origin/dev");
  const newest = Changelog.read(repo, dev).newest;
  const main = fetchedRemoteHead(repo, "main");
  const published = main ? Changelog.read(repo, main) : null;
  const updates = [];
  const reviews = [];
  for (const pull of api(`repos/${repository}/pulls?state=open&base=dev&per_page=100`)) {
    if (pull.head.repo?.full_name === repository && pull.head.ref.startsWith("bump-dev/")) {
      const update = bumpUpdate(repo, dev, newest, pull);
      if (update) updates.push(update);
      continue;
    }
    const ref = `refs/remotes/origin/pull/${pull.number}`;
    repo.run(["fetch", "--no-tags", "origin", `+refs/pull/${pull.number}/head:${ref}`]);
    const head = repo.sha(ref);
    let entries;
    try {
      entries = lateEntries(repo, head, dev, newest, published);
    } catch (error) {
      // An unreadable changelog fails that PR's Changelog check; don't let it block other PRs.
      console.warn(`Skipping #${pull.number}: ${error.message}`);
      continue;
    }
    const review = reviewUpdate(api, repository, pull, head, entries, newest);
    if (review) reviews.push(review);
  }
  return Object.freeze({ updates: Object.freeze(updates), reviews: Object.freeze(reviews) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const repo = new Repository(process.cwd());
    const [command, ...args] = process.argv.slice(2);
    let result;
    if (command === "prepare" && args.length === 2) {
      const [source, nextVersion] = args;
      result = prepareRelease(repo, { source, nextVersion });
    } else if (command === "sync" && args.length === 0) {
      result = syncChangelog(repo);
    } else if (command === "validate-release" && (args.length === 1 || args.length === 2)) {
      const [base, branch] = args;
      validateRelease(repo, repo.sha("HEAD"), fullSha(base, "Base"), branch || undefined, { requireNotes: true });
    } else if (command === "check-changelog" && args.length === 1) {
      validateChangelogPlacement(repo, repo.sha("HEAD"), fullSha(args[0], "Base"));
    } else {
      throw new Error("Usage: release-automation.mjs prepare <sha> <next-version> | sync"
        + " | validate-release <base-sha> [release-branch] | check-changelog <base-sha>");
    }
    if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
