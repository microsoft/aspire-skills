import {
  compareVersions, onlyVersionChanges, updateVersion, versionManifests, versionSnapshot
} from "./versions.mjs";
import {
  developmentChanges, generateChangelog, latestRelease, readChangelog, releaseMessage, validateChangelog
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
  const previousRelease = latestRelease(previousChangelog, { optional: true });
  if (!previousRelease) throw new Error("Main's latest changelog entry needs verified historical release metadata.");
  if (previousRelease.version !== baseline.version) throw new Error("Main's version does not match the last published release.");
  const from = previousRelease.source;
  return Object.freeze({
    from, source, base, version: inputs.version, baselineVersion: baseline.version,
    previousChangelog, changes: developmentChanges(repo, from, source)
  });
}

function alignedTree(repo, tree, version) {
  return repo.withIndex(indexFile => {
    repo.run(["read-tree", tree], { indexFile });
    for (const [path, bytes] of versionManifests(repo, tree)) {
      const updated = updateVersion(bytes, path, version);
      if (!updated.equals(bytes)) {
        const oid = repo.run(["hash-object", "-w", "--stdin"], { input: updated }).trim();
        repo.run(["update-index", "--add", "--cacheinfo", "100644", oid, path], { indexFile });
      }
    }
    return repo.run(["write-tree"], { indexFile }).trim();
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
        /^(?:Co-authored-by|Signed-off-by): [^<>\r\n]+ <[^<>\r\n]+>$/.test(line)))) {
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

function validateDevMerge(repo, head, dev, expectedVersion) {
  const merged = repo.mergeTree(dev, head);
  if (!merged.conflicts.length) {
    requireSourceOnly(repo, merged.tree);
    if (versionSnapshot(repo, merged.tree).version !== expectedVersion) {
      throw new Error("The dev merge must preserve its source-only tree and expected version.");
    }
  }
}

function initializeDevelopment(repo, head, base, branch) {
  const published = latestRelease(readChangelog(repo, base), { optional: true });
  if (base !== repo.sha("origin/main")
    || (published && (published.from !== published.source
      || (published.baselineVersion && published.baselineVersion !== published.version)))
    || !onlyVersionChanges(repo, base, head)) {
    throw new Error("Initialization is allowed only from the bootstrap main tree, removing generated files and preserving source.");
  }
  const version = versionSnapshot(repo, head).version;
  if (branch !== `initialize-dev/${version}` || version !== versionSnapshot(repo, base).version) {
    throw new Error("Initialization must preserve main's current version.");
  }
}

export function checkDevelopment(repo, { head, base, branch }) {
  requireSourceOnly(repo, head);
  const version = versionSnapshot(repo, head).version;
  const main = repo.sha("origin/main");
  const published = latestRelease(readChangelog(repo, main), { optional: true });
  if (!branch) {
    if (published) repo.requireFirstParent(published.source, head);
    return;
  }
  if (branch === "main" || branch.startsWith("release/") || branch.startsWith("prepare-release/")) {
    throw new Error("Main/release/preparation branches cannot target dev.");
  }
  if (branch.startsWith("initialize-dev/")) {
    initializeDevelopment(repo, head, base, branch);
    return;
  }
  if (/^backport\/pr-[1-9]\d*-to-dev$/.test(branch)) {
    validateDevMerge(repo, head, repo.sha("origin/dev"), version);
    return;
  }
  const common = repo.run(["merge-base", base, head]).trim();
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
  const sourceTree = alignedTree(repo, context.source, context.version);
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
