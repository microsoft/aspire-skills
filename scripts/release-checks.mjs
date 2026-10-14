import { compareVersions, onlyVersionChanges, updateVersion, versionSnapshot } from "./release-versions.mjs";
import { readChangelog, releaseNotes, validateChangelog } from "./release-changelog.mjs";
import { expectedCatalog, validateCatalog } from "./release-catalog.mjs";
import { publishSourceRelease, resolveReleasePull } from "./release-github.mjs";

function validateCandidate(repo, head, version, previous) {
  if (versionSnapshot(repo, head).version !== version) throw new Error("Release branch and coordinated versions must match.");
  validateChangelog(readChangelog(repo, head), version, previous);
  validateCatalog(repo, head, expectedCatalog(repo, head));
  return { version, candidate: head };
}

export function validatePublished(repo, release, { headCommit } = {}) {
  release = repo.selected(release, "released_commit");
  const head = repo.selected(headCommit, "reviewed_release_head");
  const version = versionSnapshot(repo, head).version;
  const result = validateCandidate(repo, release, version);
  if (releaseNotes(readChangelog(repo, release)) !== releaseNotes(readChangelog(repo, head))) {
    throw new Error("Published release notes must match the approved PR.");
  }
  return { ...result, release };
}

export function publishRelease(repo, commit, options = {}) {
  commit = repo.selected(commit, "released_commit");
  const reviewed = resolveReleasePull(repo, commit, options);
  const result = validatePublished(repo, commit, { headCommit: reviewed.head });
  repo.requireFirstParent(result.release, repo.sha("origin/main"));
  return publishSourceRelease(repo, result);
}

function sameChangelog(repo, before, after) {
  return repo.run([
    "diff", "--no-ext-diff", "--no-textconv", "--quiet", before, after, "--", "CHANGELOG.md"
  ], { statuses: [0, 1] }).status === 0;
}

function validateDevMerge(repo, head, dev, expectedVersion) {
  const merged = repo.mergeTree(dev, head);
  if (!merged.conflicts.length) {
    if (versionSnapshot(repo, merged.tree).version !== expectedVersion) {
      throw new Error("The dev merge must preserve its expected version.");
    }
    validateCatalog(repo, merged.tree, expectedCatalog(repo, merged.tree));
  }
}

function validateBackflow(repo, head, dev, main) {
  const expectedVersion = versionSnapshot(repo, dev).version;
  if (versionSnapshot(repo, head).version !== expectedVersion || !sameChangelog(repo, main, head)) {
    throw new Error("Dev backflows must preserve dev's current version and copy main's approved CHANGELOG.md.");
  }
  repo.requireAncestor(main, head);
  let merge = head;
  while (repo.parents(merge).length === 1) {
    const parent = repo.parents(merge)[0];
    if (!onlyVersionChanges(repo, parent, merge)) throw new Error("Backflow follow-ups may only resolve versions, catalogs, and changelog history.");
    merge = parent;
  }
  const parents = repo.parents(merge);
  if (parents.length !== 2 || parents[1] !== main || !repo.ancestor(parents[0], dev)) {
    throw new Error("Backflows must merge current main into a branch based on dev.");
  }
  const merged = repo.mergeTree(...parents);
  const mutable = ["CHANGELOG.md", "opencode", ...new Set([
    ...versionSnapshot(repo, parents[0]).manifests.keys(), ...versionSnapshot(repo, head).manifests.keys()
  ])];
  if (!repo.sameTree(merged.tree, head, { exclude: [...mutable, ...merged.conflicts] })) {
    throw new Error("Backflow changed source outside the actual main/dev merge conflicts.");
  }
  for (const path of mutable.filter(path => !["CHANGELOG.md", "opencode"].includes(path) && !merged.conflicts.includes(path))) {
    const bytes = repo.files(merged.tree).has(path) ? repo.read(merged.tree, path) : undefined;
    const actual = versionSnapshot(repo, head).manifests.get(path);
    if ((!bytes && actual) || (bytes && !actual?.equals(updateVersion(bytes, path, expectedVersion)))) {
      throw new Error("Backflow changed non-version manifest content outside a merge conflict.");
    }
  }
  validateDevMerge(repo, head, dev, expectedVersion);
}

export function checkPull(repo, { target, headBranch, headCommit, baseCommit }) {
  const head = headCommit ? repo.selected(headCommit, "head_commit") : repo.sha("HEAD");
  const version = versionSnapshot(repo, head).version;
  if (target === "main" && headBranch?.startsWith("release/")) {
    if (headBranch !== `release/${version}`) throw new Error("Release PR branch must match its version.");
    const main = repo.sha("origin/main");
    if (compareVersions(version, versionSnapshot(repo, main).version) <= 0) throw new Error("Release version must be greater than main's version.");
    const source = repo.run(["merge-base", repo.sha("origin/dev"), head]).trim();
    if (versionSnapshot(repo, source).version !== version) throw new Error("Release branches must start from a dev snapshot at the release version.");
    return validateCandidate(repo, head, version, readChangelog(repo, main));
  }
  if (target?.startsWith("release/")) {
    if (target !== `release/${version}`) throw new Error("Backported fixes must preserve the release branch version.");
    return validateCandidate(repo, head, version, readChangelog(repo, repo.sha("origin/main")));
  }
  if (target === "main") {
    if (headBranch && !/^backport\/pr-[1-9]\d*-to-main$/.test(headBranch)) throw new Error("Contributor PRs must target dev.");
    return;
  }
  if (target !== "dev") throw new Error("Release policy supports main, dev, and release branches.");
  validateCatalog(repo, head, expectedCatalog(repo, head));
  const dev = repo.sha("origin/dev");
  if (!headBranch) {
    if (version !== versionSnapshot(repo, dev).version) throw new Error("Dev must preserve its current coordinated version.");
    return;
  }
  if (["main", "dev"].includes(headBranch) || headBranch.startsWith("release/")) throw new Error("Main/release branches cannot target dev.");
  const base = baseCommit ? repo.selected(baseCommit, "base_commit") : dev;
  if (/^backport\/pr-[1-9]\d*-to-dev$/.test(headBranch)) {
    validateBackflow(repo, head, dev, repo.sha("origin/main"));
    return;
  }
  const common = repo.run(["merge-base", base, head]).trim();
  if (headBranch.startsWith("bump-dev/") || headBranch.startsWith("initialize-dev/")) {
    const prefix = headBranch.startsWith("initialize-dev/") ? "initialize-dev/" : "bump-dev/";
    if (headBranch !== `${prefix}${version}` || compareVersions(version, versionSnapshot(repo, common).version) <= 0
      || !onlyVersionChanges(repo, common, head) || !sameChangelog(repo, common, head)) {
      throw new Error("Dev version bumps must advance coordinated versions without changing source or changelog.");
    }
    if (prefix === "initialize-dev/" && common !== repo.sha("origin/main")) throw new Error("Initialization must start from synchronized main/dev.");
    validateDevMerge(repo, head, dev, version);
    return;
  }
  if (!sameChangelog(repo, common, head)) throw new Error("Ordinary development PRs must preserve their dev baseline's CHANGELOG.md.");
  if (version !== versionSnapshot(repo, common).version) throw new Error("Ordinary development PRs must preserve their dev baseline's version.");
  validateDevMerge(repo, head, dev, versionSnapshot(repo, dev).version);
}
