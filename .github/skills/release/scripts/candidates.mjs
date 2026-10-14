import {
  compareVersions, onlyVersionChanges, updateVersion, versionSnapshot, versionTree
} from "./versions.mjs";
import {
  developmentChanges, generateChangelog, latestRelease, publishedBaseline, readChangelog, releaseMessage, validateChangelog
} from "./changelog.mjs";
import { expectedCatalog, validateCatalog } from "./catalog.mjs";
import { generatedPaths as generated, requireSourceOnly } from "./development.mjs";
import { publishSourceRelease, resolveReleasePull } from "./github.mjs";

export { requireSourceOnly } from "./development.mjs";

function contextFor(repo, inputs) {
  const source = repo.selected(inputs.source, "source_commit");
  const base = repo.selected(inputs.base, "base_commit");
  requireSourceOnly(repo, source);
  versionSnapshot(repo, source);
  const baseline = versionSnapshot(repo, base);
  if (compareVersions(inputs.version, baseline.version) <= 0) {
    throw new Error("Release version must be greater than main's version.");
  }
  const previousChangelog = readChangelog(repo, base);
  const previousRelease = publishedBaseline(repo, base);
  if (previousRelease.version !== baseline.version) throw new Error("Main's version does not match the last published release.");
  const from = previousRelease.source;
  return Object.freeze({
    from, source, base, version: inputs.version, baselineVersion: baseline.version,
    previousChangelog, changes: developmentChanges(repo, from, source)
  });
}

function validateMainContents(repo, sha, version) {
  if (versionSnapshot(repo, sha).version !== version) throw new Error("Main's canonical versions do not match the reviewed change.");
  validateCatalog(repo, sha, expectedCatalog(repo, sha, version));
}

function mutablePaths(repo, ...snapshots) {
  return [...new Set([
    ...generated, ...snapshots.flatMap(sha => [...versionSnapshot(repo, sha).manifests.keys()])
  ])];
}

function validateReleaseHead(repo, head, main, { currentState = true, allowPendingNotes = true } = {}) {
  const release = latestRelease(readChangelog(repo, head));
  let current = head;
  let mergedMain = false;
  const reviewed = [];
  let anchor;
  while (!anchor) {
    const parents = repo.parents(current);
    if (parents.length === 1 && repo.firstParentAncestor(parents[0], main)) {
      const message = releaseMessage(release);
      const actual = repo.run(["show", "-s", "--format=%B", current]).trimEnd();
      const canonical = `${message.title}\n\n${message.body}`;
      const trailers = actual.slice(canonical.length + 2);
      if (actual === canonical || (actual.startsWith(`${canonical}\n\n`) && trailers.split("\n").every(line =>
        /^(?:(?:Co-authored-by|Signed-off-by): [^<>\r\n]+ <[^<>\r\n]+>|Copilot-Session: [0-9a-f-]{36})$/.test(line)))) {
        const context = contextFor(repo, { ...release, base: parents[0] });
        if (!onlyVersionChanges(repo, context.source, current)) {
          throw new Error("The local release must preserve the selected dev snapshot.");
        }
        validateMainContents(repo, current, context.version);
        validateChangelog(context, readChangelog(repo, current));
        anchor = context;
        break;
      }
    }
    if (!parents.length || parents.length > 2) throw new Error("Release PRs must retain their prepared snapshot.");
    if (parents.length === 2) {
      repo.requireAncestor(parents[1], main);
      mergedMain = true;
    }
    reviewed.push({ head: current, parents });
    current = parents[0];
  }
  const context = contextFor(repo, { ...release, base: anchor.base });
  for (const change of reviewed) {
    const before = latestRelease(readChangelog(repo, change.parents[0]));
    const after = latestRelease(readChangelog(repo, change.head));
    if (before.notesState === "pending" && after.notesState === "finalized"
      && ["from", "source", "version", "baselineVersion"].some(key => before[key] !== after[key])) {
      throw new Error("Finalizing release notes cannot change the selected range, baseline, or version.");
    }
    if (change.parents.length === 1) {
      if (!onlyVersionChanges(repo, change.parents[0], change.head)) {
        throw new Error("Source fixes must enter dev and be deliberately prepared for release.");
      }
    } else {
      const merged = repo.mergeTree(...change.parents);
      const mutable = mutablePaths(repo, change.parents[0], change.head);
      if (!repo.sameTree(merged.tree, change.head, { exclude: [...mutable, ...merged.conflicts] })) {
        throw new Error("Release conflict resolution changed source outside the actual main merge conflicts.");
      }
      for (const path of mutable.filter(path => !generated.includes(path) && !merged.conflicts.includes(path))) {
        const bytes = repo.files(merged.tree).has(path) ? repo.read(merged.tree, path) : undefined;
        const actual = versionSnapshot(repo, change.head).manifests.get(path);
        if ((!bytes && actual) || (bytes && !actual?.equals(updateVersion(bytes, path, context.version)))) {
          throw new Error("Release conflict resolution changed non-version manifest content outside a conflict.");
        }
      }
    }
  }
  for (const key of ["source", "from", "version"]) {
    if (context[key] !== anchor[key]) throw new Error("Conflict resolution changed the selected release membership.");
  }
  repo.requireFirstParent(context.base, main);
  if (!mergedMain && !onlyVersionChanges(repo, context.source, head)) {
    throw new Error("Source fixes must enter dev and be deliberately prepared for release.");
  }
  if (currentState && versionSnapshot(repo, main).version !== context.baselineVersion) {
    throw new Error("Main's published version changed. Select a snapshot for the new release cycle.");
  }
  if (repo.hasRef("refs/remotes/origin/dev")) {
    const dev = repo.sha("origin/dev");
    repo.requireFirstParent(context.source, dev);
    const later = repo.run(["rev-list", "--first-parent", `${context.source}..${dev}`]).trim().split("\n").filter(Boolean);
    if (later.some(sha => repo.ancestor(sha, head))) throw new Error("Later dev commits require deliberate release preparation.");
  }
  validateMainContents(repo, head, context.version);
  validateChangelog(context, readChangelog(repo, head), { allowPending: allowPendingNotes });
  return Object.freeze({ ...context, candidate: head, notesState: release.notesState });
}

export function validatePublished(repo, release, { headCommit } = {}) {
  release = repo.selected(release, "released_commit");
  const lineage = repo.parents(release);
  if (lineage.length !== 1) throw new Error("Main must receive a release through squash and merge.");
  if (!headCommit) throw new Error("The reviewed release PR head is required for squash validation.");
  const head = repo.selected(headCommit, "reviewed_release_head");
  const result = validateReleaseHead(repo, head, lineage[0], { currentState: false, allowPendingNotes: false });
  repo.requireFirstParent(result.base, lineage[0]);
  if (versionSnapshot(repo, lineage[0]).version !== result.baselineVersion) {
    throw new Error("The published squash must advance the reviewed main baseline version.");
  }
  const merged = repo.mergeTree(lineage[0], head);
  if (merged.conflicts.length || !repo.sameTree(merged.tree, release)) {
    throw new Error("The published squash tree must exactly match the reviewed PR merged into its main parent.");
  }
  validateMainContents(repo, release, result.version);
  validateChangelog(result, readChangelog(repo, release), { allowPending: false });
  return Object.freeze({ ...result, release });
}

export function publishRelease(repo, commit, options = {}) {
  commit = repo.selected(commit, "released_commit");
  const reviewed = resolveReleasePull(repo, commit, options);
  const result = validatePublished(repo, commit, { headCommit: reviewed.head });
  repo.requireFirstParent(result.release, repo.sha("origin/main"));
  return publishSourceRelease(repo, result);
}

function checkMain(repo, head, base, branch, { allowPendingNotes = false, reviewedHead } = {}) {
  if (branch && !branch.startsWith("release/")) {
    if (!/^backport\/pr-[1-9]\d*-to-main$/.test(branch)) {
      throw new Error("Contributor PRs must target dev. Main accepts only maintainer-created release or backport PRs.");
    }
    return;
  }
  const previous = base || repo.parents(head)[0];
  if (!previous) throw new Error("Main validation requires a previous main commit.");
  const before = versionSnapshot(repo, previous).version;
  const version = versionSnapshot(repo, head).version;
  if (branch?.startsWith("release/")) {
    const result = validateReleaseHead(repo, head, base, { allowPendingNotes });
    if (branch !== `release/${result.version}`) throw new Error("Release PR branch must match its version.");
    const merged = repo.mergeTree(base, head);
    if (!merged.conflicts.length) {
      validateMainContents(repo, merged.tree, result.version);
      validateChangelog(result, readChangelog(repo, merged.tree), { allowPending: allowPendingNotes });
    }
    return result;
  }
  if (!branch && compareVersions(version, before) > 0) {
    const reviewed = reviewedHead ? { head: reviewedHead } : resolveReleasePull(repo, head);
    return validatePublished(repo, head, { headCommit: reviewed.head });
  }
}

function sameChangelog(repo, before, after) {
  return repo.run([
    "diff", "--no-ext-diff", "--no-textconv", "--quiet", before, after, "--", "CHANGELOG.md"
  ], { statuses: [0, 1] }).status === 0;
}

function validateDevMerge(repo, head, dev, expectedVersion) {
  const merged = repo.mergeTree(dev, head);
  if (!merged.conflicts.length) {
    requireSourceOnly(repo, merged.tree);
    if (versionSnapshot(repo, merged.tree).version !== expectedVersion) {
      throw new Error("The dev merge must exclude OpenCode catalogs and preserve its expected version.");
    }
  }
}

function initializeDevelopment(repo, head, base, branch) {
  const main = repo.sha("origin/main");
  const published = publishedBaseline(repo, main);
  if (base !== main || !onlyVersionChanges(repo, main, head) || !sameChangelog(repo, main, head)) {
    throw new Error("Initialization must start from synchronized main/dev, preserving source and published changelog history.");
  }
  const version = versionSnapshot(repo, head).version;
  if (branch !== `initialize-dev/${version}` || compareVersions(version, published.version) <= 0) {
    throw new Error("Initialization must advance dev beyond main's published version.");
  }
  repo.requireFirstParent(published.source, head);
  validateDevMerge(repo, head, repo.sha("origin/dev"), version);
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
    if (!onlyVersionChanges(repo, parent, merge)) {
      throw new Error("Backflow follow-ups may only resolve versions, catalogs, and changelog history.");
    }
    merge = parent;
  }
  const parents = repo.parents(merge);
  if (parents.length !== 2 || parents[1] !== main || !repo.ancestor(parents[0], dev)) {
    throw new Error("Backflows must merge current main into a branch based on dev, preserving dev's first-parent history.");
  }
  const merged = repo.mergeTree(...parents);
  const mutable = mutablePaths(repo, parents[0], head);
  if (!repo.sameTree(merged.tree, head, { exclude: [...mutable, ...merged.conflicts] })) {
    throw new Error("Backflow changed source outside the actual main/dev merge conflicts.");
  }
  for (const path of mutable.filter(path => !generated.includes(path) && !merged.conflicts.includes(path))) {
    const bytes = repo.files(merged.tree).has(path) ? repo.read(merged.tree, path) : undefined;
    const actual = versionSnapshot(repo, head).manifests.get(path);
    if ((!bytes && actual) || (bytes && !actual?.equals(updateVersion(bytes, path, expectedVersion)))) {
      throw new Error("Backflow changed non-version manifest content outside a merge conflict.");
    }
  }
  validateDevMerge(repo, head, dev, expectedVersion);
}

export function checkDevelopment(repo, { head, base, branch }) {
  requireSourceOnly(repo, head);
  const version = versionSnapshot(repo, head).version;
  const main = repo.sha("origin/main");
  const published = publishedBaseline(repo, main);
  if (!branch) {
    repo.requireFirstParent(published.source, head);
    return;
  }
  if (branch === "main" || branch.startsWith("release/") || branch.startsWith("prepare-release/")) {
    throw new Error("Main/release/preparation branches cannot target dev.");
  }
  if (branch.startsWith("initialize-dev/")) {
    initializeDevelopment(repo, head, base, branch);
    return;
  }
  if (branch.startsWith("bump-dev/")) {
    const common = repo.run(["merge-base", base, head]).trim();
    if (branch !== `bump-dev/${version}` || compareVersions(version, versionSnapshot(repo, common).version) <= 0
      || !onlyVersionChanges(repo, common, head) || !sameChangelog(repo, common, head)) {
      throw new Error("Dev version bumps must advance coordinated versions without changing source or changelog.");
    }
    validateDevMerge(repo, head, repo.sha("origin/dev"), version);
    checkDevelopment(repo, { head });
    return;
  }
  if (/^backport\/pr-[1-9]\d*-to-dev$/.test(branch)) {
    validateBackflow(repo, head, repo.sha("origin/dev"), main);
    return;
  }
  const common = repo.run(["merge-base", base, head]).trim();
  if (!sameChangelog(repo, common, head)) {
    throw new Error("Ordinary development PRs must preserve their dev baseline's CHANGELOG.md. Only release backflows may copy main's approved history.");
  }
  if (version !== versionSnapshot(repo, common).version) {
    throw new Error("Ordinary development PRs must preserve their dev baseline's version.");
  }
  validateDevMerge(repo, head, repo.sha("origin/dev"), versionSnapshot(repo, repo.sha("origin/dev")).version);
  checkDevelopment(repo, { head });
}

export function checkPull(repo, options, validation = {}) {
  const head = options.headCommit ? repo.selected(options.headCommit, "head_commit") : repo.sha("HEAD");
  if (options.target === "main") {
    const base = options.headBranch ? repo.sha("origin/main")
      : options.baseCommit ? repo.selected(options.baseCommit, "base_commit") : undefined;
    const common = options.headBranch && !options.headBranch.startsWith("release/")
      ? repo.run(["merge-base", base, head]).trim() : base;
    return checkMain(repo, head, common, options.headBranch, {
      ...validation, reviewedHead: options.reviewedHead
    });
  }
  if (options.target !== "dev") throw new Error("Release policy supports only main and dev.");
  checkDevelopment(repo, {
    head, base: options.baseCommit ? repo.selected(options.baseCommit, "base_commit") : repo.sha("origin/dev"),
    branch: options.headBranch
  });
  return undefined;
}

export function prepareLocalRelease(repo, { releaseVersion, sourceCommit, remote }) {
  if (!remote || remote.startsWith("-")) throw new Error("A target remote is required.");
  repo.run(["check-ref-format", `refs/remotes/${remote}/main`]);
  if (repo.run(["status", "--porcelain"]).trim()) {
    throw new Error("Local release preparation requires a clean working tree and index.");
  }
  const branch = `release/${releaseVersion}`;
  repo.run(["check-ref-format", `refs/heads/${branch}`]);
  if (repo.run(["branch", "--show-current"]).trim() !== branch) {
    throw new Error(`Check out ${branch} from the tip of ${remote}/main first.`);
  }
  const base = repo.sha("HEAD");
  if (base !== repo.sha(`refs/remotes/${remote}/main`)) {
    throw new Error(`The release branch must start at the current tip of ${remote}/main.`);
  }
  const context = contextFor(repo, { source: sourceCommit, base, version: releaseVersion });
  const dev = repo.sha(`refs/remotes/${remote}/dev`);
  repo.requireFirstParent(context.source, dev);
  requireSourceOnly(repo, dev);
  const sourceTree = versionTree(repo, context.source, context.version);
  const files = expectedCatalog(repo, sourceTree, context.version);
  files.set("CHANGELOG.md", Buffer.from(generateChangelog(context)));
  const tree = repo.withIndex(indexFile => {
    repo.run(["read-tree", sourceTree], { indexFile });
    for (const [path, contents] of files) {
      const blob = repo.run(["hash-object", "-w", "--stdin"], { input: contents }).trim();
      repo.run(["update-index", "--add", "--cacheinfo", "100644", blob, path], { indexFile });
    }
    return repo.run(["write-tree"], { indexFile }).trim();
  });
  validateMainContents(repo, tree, context.version);
  validateChangelog(context, readChangelog(repo, tree));
  const patch = repo.run([
    "diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", base, tree, "--"
  ], { binary: true });
  repo.run(["apply", "--index", "--binary"], { input: patch });
  return Object.freeze({ ...context, branch });
}
