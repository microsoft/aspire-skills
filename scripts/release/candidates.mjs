import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fullSha } from "./git.mjs";
import { compareVersions, onlyVersionChanges, updateVersion, versionManifests, versionSnapshot } from "./versions.mjs";
import {
  changelogEntry, changelogStateMarker, developmentChanges, generateChangelog, latestRelease, readChangelog,
  releaseHeading, releaseMarker, releaseNotes, validateChangelog
} from "./changelog.mjs";
import { expectedCatalog, validateCatalog } from "./catalog.mjs";
import { publishSourceRelease, repositoryName, repositoryUrl } from "./github.mjs";

const generated = ["CHANGELOG.md", "opencode"];
const candidateRef = "refs/heads/release/candidate";
const checked = new WeakMap();

export function requireSourceOnly(repo, sha) {
  const paths = [...repo.files(sha, generated).keys()];
  if (paths.length) throw new Error(`Dev must not contain generated changelog or catalogs:\n${paths.join("\n")}`);
}

function currentSnapshot(repo, source, base) {
  const main = repo.sha("origin/main");
  repo.requireFirstParent(base, main);
  if (versionSnapshot(repo, base).version !== versionSnapshot(repo, main).version) {
    throw new Error("Main's published version changed. Select a snapshot for the new release cycle.");
  }
  const dev = repo.sha("origin/dev");
  repo.requireFirstParent(source, dev);
  requireSourceOnly(repo, dev);
}

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
  const branch = `release/${inputs.version}`;
  if (repo.run(["check-ref-format", `refs/heads/${branch}`], { statuses: [0, 1] }).status !== 0) {
    throw new Error(`Invalid generated Git branch: ${branch}`);
  }
  if (!previousRelease) throw new Error("Main's latest changelog entry needs verified historical release metadata.");
  if (previousRelease.version !== baseline.version) throw new Error("Main's version does not match the last published release.");
  const from = previousRelease.source;
  repo.requireAncestor(from, base);
  const changes = developmentChanges(repo, from, source);
  return Object.freeze({
    from, source, base, version: inputs.version, baselineVersion: baseline.version,
    previousChangelog, changes
  });
}

function existingBranch(repo, branch) {
  const ref = `refs/remotes/origin/${branch}`;
  return repo.hasRef(ref) ? repo.sha(ref) : "";
}

export function resolveStage(repo, options = {}) {
  const branch = `release/${options.releaseVersion}`;
  const previous = existingBranch(repo, branch);
  const context = contextFor(repo, {
    source: options.sourceCommit || repo.sha("origin/dev"),
    base: options.baseCommit || (previous ? latestRelease(readChangelog(repo, previous)).base : repo.sha("origin/main")),
    version: options.releaseVersion
  });
  currentSnapshot(repo, context.source, context.base);
  return Object.freeze({
    ...context, branch, previous, candidateRef
  });
}

function stagingParents(repo, candidate, source) {
  const parents = repo.parents(candidate);
  if (parents.length !== 1) return undefined;
  if (parents[0] === source) return parents;
  const integration = repo.parents(parents[0]);
  if (integration.length !== 2 || integration[1] !== source) return undefined;
  if (!repo.sameTree(source, parents[0], { exclude: generated })) {
    throw new Error("Snapshot integration must preserve the selected dev source and version values.");
  }
  return integration;
}

export function validateStage(repo, candidate, { currentState = false } = {}) {
  candidate = repo.selected(candidate, "candidate_commit");
  if (!checked.has(repo)) checked.set(repo, new Map());
  const cache = checked.get(repo);
  if (!cache.has(candidate)) {
    const changelog = readChangelog(repo, candidate);
    const release = latestRelease(changelog);
    const context = contextFor(repo, release);
    const lineage = stagingParents(repo, candidate, context.source);
    if (!lineage) throw new Error("Release version, changelog, and catalog edits must be staged on an ordinary commit.");
    if (lineage.length === 1) repo.requireAncestor(context.base, context.source);
    const initialStaging = lineage.length === 1 || lineage[0] === context.base;
    if (!initialStaging) {
      const previous = validateReleaseHead(repo, lineage[0], repo.sha("origin/main"), { currentState: false });
      for (const key of ["from", "base", "version"]) {
        if (context[key] !== previous[key]) throw new Error("Candidate refresh changed the release baseline or version.");
      }
      repo.requireFirstParent(previous.source, context.source);
    }
    if (versionSnapshot(repo, candidate).version !== context.version
      || !onlyVersionChanges(repo, context.source, candidate)) {
      throw new Error("Candidate source differs from the selected dev tree beyond canonical release version values.");
    }
    validateChangelog(context, changelog);
    validateCatalog(repo, candidate, expectedCatalog(repo, context.source, context.version));
    cache.set(candidate, Object.freeze({ ...context, candidate, notesState: release.notesState }));
  }
  const result = cache.get(candidate);
  if (currentState) currentSnapshot(repo, result.source, result.base);
  return result;
}

export function validatePublished(repo, release) {
  release = repo.selected(release, "released_commit");
  const lineage = repo.parents(release);
  if (lineage.length !== 2) throw new Error("Main must receive a release through a merge commit.");
  const result = validateReleaseHead(repo, lineage[1], lineage[0], { allowPendingNotes: false });
  validateMainContents(repo, release, result.version);
  validateChangelog(result, readChangelog(repo, release), { allowPending: false });
  return Object.freeze({ ...result, release });
}

export function publishRelease(repo, commit) {
  const result = validatePublished(repo, commit);
  repo.requireFirstParent(result.release, repo.sha("origin/main"));
  return publishSourceRelease(repo, result);
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

function mergeVersionTrees(repo, start, incoming, desired) {
  const common = repo.run(["merge-base", start, incoming]).trim();
  // Normalize all three sides so version bumps cannot create source conflicts.
  const base = repo.commitTree(alignedTree(repo, common, desired), [], "Normalize versions for restaging");
  const sides = [start, incoming].map(sha =>
    repo.commitTree(alignedTree(repo, sha, desired), [base], "Compare release source for restaging"));
  return repo.mergeTree(...sides);
}

function validateMainContents(repo, sha, version) {
  if (versionSnapshot(repo, sha).version !== version) throw new Error("Main's canonical versions do not match the reviewed change.");
  if (repo.files(sha, ["opencode"]).size) validateCatalog(repo, sha, expectedCatalog(repo, sha, version));
}

function changedPaths(repo, first, second) {
  return repo.run(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z",
    first, second, "--"]).split("\0").filter(Boolean);
}

function validateReleaseHead(repo, head, main, { currentState = true, allowPendingNotes = true } = {}) {
  const release = latestRelease(readChangelog(repo, head));
  const context = contextFor(repo, release);
  let current = head;
  let mergedMain = false;
  const reviewed = [];
  let anchor;
  while (!anchor) {
    const parents = repo.parents(current);
    if (stagingParents(repo, current, context.source)) {
      anchor = validateStage(repo, current);
      break;
    }
    if (!parents.length || parents.length > 2) throw new Error("Release PRs must retain their generated snapshot.");
    if (parents.length === 2) {
      repo.requireAncestor(parents[1], main);
      mergedMain = true;
    }
    reviewed.push({ head: current, parents });
    current = parents[0];
  }
  for (const change of reviewed) {
    const before = latestRelease(readChangelog(repo, change.parents[0]));
    const after = latestRelease(readChangelog(repo, change.head));
    if (before.notesState === "pending" && after.notesState === "finalized"
      && ["from", "source", "base", "version", "baselineVersion"].some(key => before[key] !== after[key])) {
      throw new Error("Finalizing release notes cannot change the selected range, baseline, or version.");
    }
    if (change.parents.length === 1) {
      if (!onlyVersionChanges(repo, change.parents[0], change.head)) {
        throw new Error("Source fixes must enter dev and be deliberately restaged.");
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
  repo.requireAncestor(anchor.base, context.base);
  repo.requireAncestor(context.base, main);
  if (!mergedMain && !onlyVersionChanges(repo, context.source, head)) {
    throw new Error("Source fixes must enter dev and be deliberately restaged.");
  }
  if (currentState && compareVersions(context.version, versionSnapshot(repo, main).version) <= 0) {
    throw new Error("Release version must be greater than main's current published version.");
  }
  if (repo.hasRef("refs/remotes/origin/dev")) {
    const dev = repo.sha("origin/dev");
    repo.requireFirstParent(context.source, dev);
    const later = repo.run(["rev-list", "--first-parent", `${context.source}..${dev}`]).trim().split("\n").filter(Boolean);
    if (later.some(sha => repo.ancestor(sha, head))) throw new Error("Later dev commits require deliberate restaging.");
  }
  validateMainContents(repo, head, context.version);
  validateChangelog(context, readChangelog(repo, head), { allowPending: allowPendingNotes });
  return Object.freeze({ ...context, candidate: head, notesState: release.notesState });
}

function checkMain(repo, head, base, branch, { allowPendingNotes = false } = {}) {
  if (branch && !branch.startsWith("release/")) {
    if (!/^backport\/pr-[1-9]\d*-to-main$/.test(branch)) {
      throw new Error("Contributor PRs must target dev. Main accepts only releases or generated backports.");
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
  if (!branch && compareVersions(version, before) > 0) return validatePublished(repo, head);
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
  if (base !== repo.sha("origin/main")
    || latestRelease(readChangelog(repo, base), { optional: true })?.base
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
    return checkMain(repo, head, common, options.headBranch, validation);
  }
  if (options.target !== "dev") throw new Error("Release policy supports only main and dev.");
  checkDevelopment(repo, {
    head, base: options.baseCommit ? repo.selected(options.baseCommit, "base_commit") : repo.sha("origin/dev"),
    branch: options.headBranch
  });
  return undefined;
}

export function prepareReleaseNotes(repo, options, inputPath) {
  if (!options.headBranch?.startsWith("release/")) throw new Error("Changelog automation requires a release PR into main.");
  const head = repo.selected(options.headCommit, "head_commit");
  if (head !== repo.sha("refs/remotes/origin/notes-pr")) {
    throw new Error("The release PR advanced before changelog generation. Reapply its release label on the current head.");
  }
  const context = checkPull(repo, { ...options, target: "main" }, { allowPendingNotes: true });
  const release = latestRelease(readChangelog(repo, head));
  if (!inputPath) throw new Error("RELEASE_NOTES_PATH is required.");
  writeFileSync(inputPath, `${JSON.stringify({
    repository: repositoryName(),
    head, from: context.from, source: context.source, base: context.base,
    version: context.version, pending: release.notesState === "pending",
    catalogsIntroduced: repo.files(context.base, ["opencode"]).size === 0,
    heading: releaseHeading(context.version), releaseMarker: releaseMarker(context),
    pendingMarker: changelogStateMarker(context, "pending"), finalizedMarker: changelogStateMarker(context, "finalized"),
    candidates: context.changes.map(change => ({
      sha: change.sha, parent: change.parents[0], subject: change.subject,
      paths: changedPaths(repo, change.parents[0], change.sha)
    }))
  }, null, 2)}\n`);
  repo.run(["switch", "--detach", head]);
  console.log(release.notesState === "pending"
    ? `Prepared ${context.changes.length} exact changelog candidates for ${context.from}..${context.source}.`
    : `Release v${context.version} already has completed notes; no changelog push is needed.`);
  return Object.freeze({ ...context, notesState: release.notesState });
}

function mutablePaths(repo, ...snapshots) {
  return [...new Set([
    ...generated, ...snapshots.flatMap(sha => [...versionSnapshot(repo, sha).manifests.keys()])
  ])];
}

function clean(repo) {
  if (repo.run(["status", "--porcelain"]).trim()) throw new Error("Candidate generation requires a clean isolated checkout.");
  artifactPaths(repo);
}

function writeCatalog(repo, files) {
  rmSync(join(repo.root, "opencode"), { recursive: true, force: true });
  for (const [path, contents] of files) {
    const destination = join(repo.root, ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
}

export function stageRelease(repo, options = {}) {
  clean(repo);
  const context = resolveStage(repo, options);
  let previous;
  if (context.previous) {
    previous = validateReleaseHead(repo, context.previous, repo.sha("origin/main"));
    for (const key of ["from", "base", "version"]) {
      if (context[key] !== previous[key]) throw new Error("An existing candidate belongs to a different release baseline.");
    }
    repo.requireFirstParent(previous.source, context.source);
    if (context.source === previous.source) {
      repo.run(["switch", "--create", context.candidateRef.slice("refs/heads/".length), context.previous]);
      const result = Object.freeze({ ...context, candidate: context.previous, notesState: previous.notesState });
      writeArtifacts(repo, result);
      return result;
    }
  }
  let tree = context.source;
  const parents = context.previous
    ? [context.previous]
    : repo.ancestor(context.base, context.source)
      ? [context.source]
      : [context.base, context.source];
  if (previous) {
    const merged = mergeVersionTrees(repo, context.previous, context.source, context.version);
    if (merged.conflicts.length) {
      throw new Error(`Resolve source conflicts through dev before restaging; the reviewed release head is preserved:\n${merged.conflicts.join("\n")}`);
    }
    tree = merged.tree;
    parents.push(context.source);
  }
  tree = alignedTree(repo, tree, context.version);
  if (previous && !onlyVersionChanges(repo, context.source, tree)) {
    throw new Error("Restaging must preserve reviewed main resolutions in the selected dev snapshot rather than overwrite them.");
  }
  let parent = parents[0];
  if (parents.length === 2) {
    const integrationTree = alignedTree(repo, tree, versionSnapshot(repo, context.source).version);
    parent = repo.commitTree(integrationTree, parents, `Integrate source snapshot for Aspire skills v${context.version}`);
  }
  repo.run(["switch", "--create", context.candidateRef.slice("refs/heads/".length), parent]);
  repo.run(["read-tree", "--reset", "-u", tree]);
  const entry = options.releaseWorkDir
    ? readFileSync(join(options.releaseWorkDir, "changelog_entry.md"), "utf8").trimEnd()
    : changelogEntry(context);
  if (entry !== changelogEntry(context) || (options.releaseWorkDir
    && readFileSync(join(options.releaseWorkDir, "release_notes.md"), "utf8") !== releaseNotes(repo, context))) {
    throw new Error("Prepared release notes differ from the pinned commit range.");
  }
  writeFileSync(join(repo.root, "CHANGELOG.md"), generateChangelog(context, entry));
  writeCatalog(repo, expectedCatalog(repo, tree, context.version));
  repo.run(["add", "--force", "--all", "--", ...generated]);
  // GitHub PR patches omit merge commits, so release edits need an ordinary commit.
  const candidate = repo.commitTree(repo.run(["write-tree"]).trim(), [parent], `Stage Aspire skills v${context.version}`);
  repo.run(["update-ref", context.candidateRef, candidate]);
  repo.run(["switch", "--detach", candidate]);
  const release = validateReleaseHead(repo, candidate, repo.sha("origin/main"));
  const result = Object.freeze({ ...context, candidate, notesState: release.notesState });
  writeArtifacts(repo, result);
  return result;
}

export function summary(repo, result) {
  const url = repositoryUrl();
  const links = [
    `Source: [\`${result.source.slice(0, 12)}\`](${url}/commit/${result.source})`,
    `Main: [\`${result.base.slice(0, 12)}\`](${url}/commit/${result.base})`,
    `Release version: \`${result.version}\``
  ];
  const release = latestRelease(readChangelog(repo, result.candidate));
  const notes = release.notesState === "pending"
    ? [
      "### Release notes", "",
      "User-facing notes are pending in `CHANGELOG.md`. Complete and review them before merging.", "",
      "<details>", "<summary>Source commits (review evidence, not release notes)</summary>", "",
      releaseNotes(repo, result).trimEnd(), "", "</details>"
    ].join("\n")
    : release.entry;
  const checklist = [
    "### Release checklist", "",
    "- [ ] Review this release's `CHANGELOG.md` entry. Describe changes to plugins, skills, canvases, and other user-facing components; omit CI, build, and release infrastructure.",
    "- [ ] Merge this PR into `main` using **Create a merge commit**. Do not squash or rebase.",
    `- [ ] After publication, confirm \`v${result.version}\` points to the merge commit and the GitHub release matches the approved changelog entry.`,
    `- [ ] Review and merge the automatic backport into \`dev\`. Check that it carries version \`${result.version}\` and excludes \`CHANGELOG.md\` and \`opencode/\`.`
  ].join("\n");
  return `${links.join(" | ")}\n\nCommit range: [\`${result.from.slice(0, 12)}\`](${url}/commit/${result.from})..[\`${result.source.slice(0, 12)}\`](${url}/commit/${result.source})\n\nLater dev commits are excluded unless deliberately restaged. Resolve main conflicts on this branch.\n\n${checklist}\n\n${notes}\n`;
}

function artifactPaths(repo) {
  for (const path of ["dist", "dist/release"]) {
    const entry = lstatSync(join(repo.root, path), { throwIfNoEntry: false });
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error(`Unsafe artifact directory: ${path}`);
  }
  for (const name of ["release.bundle", "release-summary.md"]) {
    const entry = lstatSync(join(repo.root, "dist", "release", name), { throwIfNoEntry: false });
    if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error(`Unsafe release artifact: ${name}`);
  }
}

function verifyBundle(repo, path, candidate, candidateRef) {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("The Git bundle must be a regular file.");
  const heads = repo.run(["bundle", "list-heads", resolve(path)]).trim();
  if (heads !== `${candidate} ${candidateRef}`) throw new Error("The Git bundle must advertise only the expected candidate.");
  repo.run(["bundle", "verify", resolve(path)]);
}

function writeArtifacts(repo, result) {
  artifactPaths(repo);
  const output = join(repo.root, "dist", "release");
  mkdirSync(output, { recursive: true });
  const bundle = join(output, "release.bundle");
  repo.run(["bundle", "create", bundle, result.candidateRef, `^${result.base}`]);
  verifyBundle(repo, bundle, result.candidate, result.candidateRef);
  writeFileSync(join(output, "release-summary.md"), summary(repo, result));
}

export function receiveCandidate(repo, options, bundlePath, summaryPath) {
  const context = resolveStage(repo, options);
  if (context.previous !== (options.previousCommit || "")) throw new Error("The remote candidate changed before receipt.");
  const candidate = fullSha(options.candidateCommit, "candidate_commit");
  for (const path of [bundlePath, summaryPath]) {
    const entry = path && lstatSync(path);
    if (!entry?.isFile() || entry.isSymbolicLink()) throw new Error("Release artifacts must be regular files.");
  }
  verifyBundle(repo, bundlePath, candidate, context.candidateRef);
  if (repo.hasRef(context.candidateRef)) throw new Error("The receiver already contains a candidate ref.");
  repo.run([
    "-c", "fetch.fsckObjects=true", "fetch", "--no-tags", "--no-write-fetch-head",
    resolve(bundlePath), `${context.candidateRef}:${context.candidateRef}`
  ]);
  if (repo.sha(context.candidateRef) !== candidate) throw new Error("The received candidate SHA changed.");
  return verifiedResult(repo, context, candidate, summaryPath);
}

function verifiedResult(repo, context, candidate, summaryPath) {
  const verified = validateReleaseHead(repo, candidate, repo.sha("origin/main"));
  currentSnapshot(repo, verified.source, verified.base);
  for (const key of ["from", "source", "base", "version"]) {
    if (verified[key] !== context[key]) throw new Error(`Received candidate ${key} differs from the pinned inputs.`);
  }
  const result = Object.freeze({ ...verified, ...context, candidate });
  const entry = lstatSync(summaryPath);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("The summary must be a regular file.");
  const body = readFileSync(summaryPath, "utf8");
  if (body !== summary(repo, result)) throw new Error("The release summary artifact changed.");
  return Object.freeze({ ...result, summary: body });
}

export function verifyCandidate(repo, options, bundlePath, summaryPath) {
  clean(repo);
  const context = resolveStage(repo, options);
  if (context.previous !== (options.previousCommit || "")) throw new Error("The publication branch changed.");
  const candidate = repo.selected(options.candidateCommit, "candidate_commit");
  if (repo.sha(context.candidateRef) !== candidate) throw new Error("The candidate ref changed.");
  if (bundlePath) verifyBundle(repo, bundlePath, candidate, context.candidateRef);
  return verifiedResult(repo, context, candidate, summaryPath);
}
