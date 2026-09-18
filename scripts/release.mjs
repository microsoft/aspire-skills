import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafePath, buildCatalog, createCatalog, isDevelopmentPath } from "./build-opencode-catalog.mjs";
import { assertGitRepositoryRoot, createGitEnvironment } from "./git-repository.mjs";
import { compareVersions, isSkillVersionPath, manifestVersion, parseVersion, releaseVersionFiles, updateManifestVersion } from "./release-version.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidateRef = "refs/heads/release/candidate";
const metadataPattern = /<!-- aspire-skills-release source=([0-9a-f]{40}) base=([0-9a-f]{40}) version=([0-9A-Za-z.+-]+) source-version=([0-9A-Za-z.+-]+) base-version=([0-9A-Za-z.+-]+) -->/g;
const repositoryUrl = "https://github.com/microsoft/aspire-skills";

function git(root, args, allowedStatuses = [0], binary = false, input) {
  const result = spawnSync("git", [
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false",
    "-c", "user.name=Aspire Skills Bot", "-c", "user.email=aspire-skills-bot@users.noreply.github.com", ...args
  ], {
    cwd: root, encoding: binary ? undefined : "utf8", maxBuffer: 64 * 1024 * 1024, input,
    env: createGitEnvironment()
  });
  if (result.error) throw result.error;
  if (!allowedStatuses.includes(result.status)) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`);
  }
  return result;
}

function fullSha(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${label} must be a full Git commit SHA.`);
  }
  return value.toLowerCase();
}

function commit(root, ref) {
  return git(root, ["rev-parse", "--verify", `${ref}^{commit}`]).stdout.trim();
}

function selectedCommit(root, value, label) {
  const sha = fullSha(value, label);
  if (commit(root, sha) !== sha) throw new Error(`${label} must identify a commit, not a tag.`);
  return sha;
}

function requireAncestor(root, ancestor, descendant) {
  if (git(root, ["merge-base", "--is-ancestor", ancestor, descendant], [0, 1]).status !== 0) {
    throw new Error(`${ancestor} must be an ancestor of ${descendant}.`);
  }
}

function tree(root, ref, paths = []) {
  return new Map(git(root, ["ls-tree", "-r", "-z", ref, "--", ...paths]).stdout
    .split("\0").filter(Boolean).map(record => {
      const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/.exec(record);
      if (!match) throw new Error("Invalid Git tree entry.");
      const [, mode, type, oid, path] = match;
      return [path, { mode, type, oid }];
    }));
}

function blob(root, entry) {
  return git(root, ["cat-file", "blob", entry.oid], [0], true).stdout;
}

function blobs(root, entries) {
  const ids = [...new Set([...entries].map(entry => entry.oid))];
  if (!ids.length) return new Map();
  const output = git(root, ["cat-file", "--batch"], [0], true, `${ids.join("\n")}\n`).stdout;
  const contents = new Map();
  let position = 0;
  for (const oid of ids) {
    const end = output.indexOf(10, position);
    const header = /^([0-9a-f]{40}) blob (\d+)$/.exec(output.subarray(position, end).toString("utf8"));
    if (!header || header[1] !== oid) throw new Error("Invalid Git blob batch.");
    const size = Number(header[2]);
    position = end + 1;
    contents.set(oid, output.subarray(position, position + size));
    position += size + 1;
  }
  return contents;
}

function versionPaths(root, ref) {
  return [...releaseVersionFiles, ...tree(root, ref, ["skills"]).keys()].filter(path => releaseVersionFiles.includes(path) || isSkillVersionPath(path));
}

function versionManifests(root, ref, { staged = false, skip = [], paths = versionPaths(root, ref) } = {}) {
  let entries;
  if (staged) {
    entries = new Map(git(root, ["ls-files", "--stage", "-z", "--", ...paths]).stdout
      .split("\0").filter(Boolean).map(record => {
        const [, mode, oid, stage, path] = /^([0-7]{6}) ([0-9a-f]{40}) ([0-3])\t([\s\S]+)$/.exec(record);
        return [path, { mode, oid, stage }];
      }).filter(([, entry]) => entry.stage === "0"));
  } else {
    entries = tree(root, ref, paths);
  }
  for (const path of paths) {
    if (!skip.includes(path) && entries.get(path)?.mode !== "100644") {
      throw new Error(`Release metadata requires a regular version manifest: ${path}`);
    }
  }
  const contents = blobs(root, [...entries].filter(([path]) => !skip.includes(path)).map(([, entry]) => entry));
  return new Map([...entries].filter(([path]) => !skip.includes(path)).map(([path, entry]) => [path, contents.get(entry.oid)]));
}

function requireSourceOnly(root, ref) {
  const paths = [...tree(root, ref, ["opencode", "CHANGELOG.md"]).keys()];
  if (paths.length) throw new Error(`Development sources must not contain release-owned files:\n${paths.join("\n")}`);
}

export function resolveReleaseSource(root, requested) {
  root = assertGitRepositoryRoot(root);
  const source = requested ? selectedCommit(root, requested, "source_commit") : commit(root, "origin/dev");
  requireAncestor(root, source, "origin/dev");
  requireSourceOnly(root, source);
  return source;
}

function requireSourceMatch(root, source, ref, { staged = false, version, skip = [] } = {}) {
  const paths = versionPaths(root, source);
  const sourcePaths = [".", ...["opencode", "CHANGELOG.md", ...paths].map(path => `:(top,exclude)${path}`)];
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--quiet",
    ...(staged ? ["--cached"] : []), source, ...(staged ? [] : [ref]), "--", ...sourcePaths];
  if (git(root, args, [0, 1]).status !== 0) {
    throw new Error("Release source differs from the selected dev commit. Sync source changes back to dev and prepare again.");
  }
  const original = versionManifests(root, source);
  for (const [path, contents] of versionManifests(root, ref, { staged, skip, paths })) {
    const expected = version ? updateManifestVersion(original.get(path), path, version) : original.get(path);
    const actual = version ? contents : updateManifestVersion(contents, path, manifestVersion(original.get(path), path));
    if (!actual.equals(expected)) throw new Error(`Release source differs beyond the permitted version bump: ${path}`);
  }
}

function escapeMarkdown(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/[\\`*_[\]#!|]/g, "\\$&").replace(/[\u0000-\u001f\u007f]/g, " ");
}

function packageVersion(root, sha) {
  fullSha(sha, "metadata commit");
  const versions = [...versionManifests(root, sha)].map(([path, contents]) => manifestVersion(contents, path));
  if (versions.some(version => version !== versions[0])) {
    throw new Error("Plugin and package versions must be synchronized at both source and baseline.");
  }
  return versions[0];
}

function isProductPath(path) {
  if (path === "package.json") return false;
  if (["LICENSE", ".mcp.json", "copilot-hooks.json", "apm.yml", "apm.yaml",
    "gemini-extension.json", "scripts/build-opencode-catalog.mjs"].includes(path)) return true;
  const relative = path.replace(/^\.github\/plugins\/aspire-skills\/?/, "");
  const pluginPath = /^(?:\.plugin|\.claude-plugin|\.cursor-plugin|hooks)(?:\/|$)/.test(relative);
  const shipped = /^(?:skills|extensions|\.github\/plugins\/aspire-skills)(?:\/|$)/.test(path);
  return (pluginPath || shipped) && !isDevelopmentPath(pluginPath ? relative.replace(/^[^/]+\/?/, "") : relative)
    && !/(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/.test(path);
}

export function hasProductChanges(root, source, base) {
  // Catalogs are a new shipped deliverable even if their generator already landed on main.
  if (tree(root, base, ["opencode"]).size === 0) return true;
  const read = ref => {
    const entries = new Map([...tree(root, ref)].filter(([path]) => isProductPath(path)));
    const contents = blobs(root, entries.values());
    return new Map([...entries].map(([path, entry]) => [
      path, { mode: entry.mode, contents: releaseVersionFiles.includes(path) || isSkillVersionPath(path)
        ? updateManifestVersion(contents.get(entry.oid), path, "0.0.0") : contents.get(entry.oid) }
    ]));
  };
  const previous = read(base);
  const selected = read(source);
  return previous.size !== selected.size || [...selected].some(([path, value]) => {
    const existing = previous.get(path);
    return !existing || value.mode !== existing.mode || !value.contents.equals(existing.contents);
  });
}

export function validateReleaseVersion(root, source, base, version) {
  parseVersion(version);
  const sourceVersion = packageVersion(root, source);
  const baseVersion = packageVersion(root, base);
  if (!hasProductChanges(root, source, base)) {
    if (version !== baseVersion) {
      throw new Error("Repository-only changes must keep the existing main version; no product version bump is needed.");
    }
    return baseVersion;
  }
  for (const [label, previous] of [["selected source", sourceVersion], ["main baseline", baseVersion]]) {
    if (compareVersions(version, previous) <= 0) {
      throw new Error(`Release version must be greater than the ${label} plugin version.`);
    }
  }
  return version;
}

function releaseMetadata(root, source, base, version) {
  return `<!-- aspire-skills-release source=${source} base=${base} version=${version} source-version=${packageVersion(root, source)} base-version=${packageVersion(root, base)} -->`;
}

function releaseEntry(root, source, base, version) {
  const date = git(root, ["show", "-s", "--format=%cs", source]).stdout.trim();
  const changes = git(root, ["log", "--reverse", "--topo-order", "--no-merges", "--format=%H%x09%s", `${base}..${source}`])
    .stdout.trimEnd().split("\n").filter(Boolean).map(line => {
      const [sha, ...subject] = line.split("\t");
      return `- ${escapeMarkdown(subject.join("\t"))} ([${sha.slice(0, 12)}](${repositoryUrl}/commit/${sha}))`;
    });
  return [
    `## v${version} - ${date} (${source.slice(0, 12)})`, releaseMetadata(root, source, base, version), "",
    ...(changes.length ? changes : ["- Prepare the initial release catalog."])
  ].join("\n");
}

export function createReleaseChangelog(root, source, base, version) {
  selectedCommit(root, source, "source_commit");
  selectedCommit(root, base, "base_commit");
  version = validateReleaseVersion(root, source, base, version);
  const oldEntry = tree(root, base, ["CHANGELOG.md"]).get("CHANGELOG.md");
  if (oldEntry && oldEntry.mode !== "100644") throw new Error("Main's CHANGELOG.md must be a regular text file.");
  const previous = oldEntry ? blob(root, oldEntry).toString("utf8").replaceAll("\r\n", "\n") : "# Changelog\n";
  const firstEntry = previous.search(/^## /m);
  const header = firstEntry < 0 ? previous : previous.slice(0, firstEntry);
  let history = firstEntry < 0 ? "" : previous.slice(firstEntry);
  let entry = releaseEntry(root, source, base, version);
  const pending = /^## \[([^\]]+)\] - Unreleased\n/.exec(history);
  if (pending?.[1] === version) {
    const remaining = history.slice(pending[0].length);
    const nextEntry = remaining.search(/^## /m);
    const notes = (nextEntry < 0 ? remaining : remaining.slice(0, nextEntry)).replace(/^\n+|\n+$/g, "");
    history = nextEntry < 0 ? "" : remaining.slice(nextEntry);
    const separator = entry.indexOf("\n\n");
    entry = `${entry.slice(0, separator)}\n\n${notes ? `${notes}\n\n` : ""}### Release preparation\n\n${entry.slice(separator + 2)}`;
  }
  return `${header.trimEnd()}\n\n${entry}\n${history ? `\n${history}` : ""}`;
}

export function createReleaseBody(root, source, base, version) {
  version = validateReleaseVersion(root, source, base, version);
  const changelog = createReleaseChangelog(root, source, base, version);
  const entries = changelog.slice(changelog.search(/^## /m));
  const nextEntry = entries.indexOf("\n## ");
  const latestEntry = (nextEntry < 0 ? entries : entries.slice(0, nextEntry)).trimEnd();
  return [
    "## Release source", "", releaseMetadata(root, source, base, version), "",
    `- Plugin version: \`${version}\` (selected source: \`${packageVersion(root, source)}\`; main baseline: \`${packageVersion(root, base)}\`)`,
    `- Selected dev commit: [\`${source}\`](${repositoryUrl}/commit/${source})`,
    `- Main baseline: [\`${base}\`](${repositoryUrl}/commit/${base})`, "",
    "Includes the selected development source with aligned plugin and skill versions, generated OpenCode V1/V2 catalogs, and cumulative changelog.",
    "The release correctness check verifies ancestry, version-only source changes, catalog bytes, and changelog history.", "",
    "**Merge with a merge commit, not squash or rebase, to preserve the released dev history.**", "",
    latestEntry.replace(`${releaseMetadata(root, source, base, version)}\n`, ""), ""
  ].join("\n");
}

function metadataFromChangelog(changelog) {
  const newest = /^## [^\n]+\n([^\n]+)/m.exec(changelog)?.[1];
  const metadata = newest && [...newest.matchAll(metadataPattern)];
  if (metadata?.length !== 1 || metadata[0][0] !== newest) {
    throw new Error("The newest CHANGELOG.md entry must identify the selected source and main baseline.");
  }
  return { source: metadata[0][1], base: metadata[0][2], version: metadata[0][3] };
}

function checkBodyMetadata(root, body, source, base, version) {
  const metadata = typeof body === "string" ? [...body.matchAll(metadataPattern)] : [];
  if (metadata.length !== 1 || metadata[0][0] !== releaseMetadata(root, source, base, version)) {
    throw new Error("The release PR body must record the selected source, main baseline, and their package versions.");
  }
}

function expectedCatalog(root, source, version) {
  const snapshot = mkdtempSync(join(tmpdir(), "aspire-release-source-"));
  try {
    mkdirSync(join(snapshot, "skills"));
    const paths = new Map();
    const entries = tree(root, source, ["skills"]);
    const contents = blobs(root, [...entries].filter(([path]) => !isDevelopmentPath(path)).map(([, entry]) => entry));
    for (const [path, entry] of entries) {
      if (!path.startsWith("skills/")) throw new Error("skills must be a directory.");
      const relative = path.slice("skills/".length);
      if (isDevelopmentPath(relative)) continue;
      assertSafePath(relative);
      const parts = relative.split("/");
      for (let length = 1; length <= parts.length; length++) {
        const prefix = parts.slice(0, length).join("/");
        const previous = paths.get(prefix.toLowerCase());
        if (previous && previous !== prefix) throw new Error(`Case-colliding skill paths: ${previous}, ${prefix}`);
        paths.set(prefix.toLowerCase(), prefix);
      }
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
        throw new Error(`Only regular skill files may be published: ${path}`);
      }
      const destination = join(snapshot, ...path.split("/"));
      mkdirSync(dirname(destination), { recursive: true });
      const bytes = contents.get(entry.oid);
      writeFileSync(destination, isSkillVersionPath(path) ? updateManifestVersion(bytes, path, version) : bytes);
    }
    const files = new Map();
    for (const format of ["v1", "v2"]) {
      for (const [path, contents] of createCatalog(snapshot, { format }).files) {
        files.set(`opencode/${format}/${path}`, contents);
      }
    }
    return files;
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

function checkCatalog(root, ref, source, version) {
  const expected = expectedCatalog(root, source, version);
  const actual = tree(root, ref, ["opencode"]);
  if (JSON.stringify([...actual.keys()].sort()) !== JSON.stringify([...expected.keys()].sort())) {
    throw new Error("OpenCode catalog file lists do not match the selected sources.");
  }
  const actualContents = blobs(root, actual.values());
  for (const [path, contents] of expected) {
    const entry = actual.get(path);
    if (entry.mode !== "100644" || !actualContents.get(entry.oid).equals(contents)) {
      throw new Error(`OpenCode catalog content, SHA-512 version, or path is invalid: ${path}`);
    }
  }
}

function verifyBundle(root, path, candidate) {
  const heads = git(root, ["bundle", "list-heads", resolve(path)]).stdout.trim();
  if (heads !== `${candidate} ${candidateRef}`) throw new Error("The bundle must advertise only the expected release candidate.");
  git(root, ["bundle", "verify", resolve(path)]);
}

function requireArtifactPaths(root) {
  for (const path of ["dist", "dist/release"]) {
    const entry = lstatSync(join(root, path), { throwIfNoEntry: false });
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
      throw new Error(`Release artifact directory must not be a symlink or file: ${path}`);
    }
  }
  for (const name of ["release.bundle", "pr-body.md", "release.json"]) {
    const entry = lstatSync(join(root, "dist", "release", name), { throwIfNoEntry: false });
    if (entry && !entry.isFile()) throw new Error(`Release artifact must be a regular file: ${name}`);
  }
}

export function checkRelease(root, { target, head, headCommit, baseCommit, prBody } = {}) {
  root = assertGitRepositoryRoot(root);
  const ref = headCommit ? selectedCommit(root, headCommit, "head_commit") : commit(root, "HEAD");
  if (target === "dev") {
    requireSourceOnly(root, ref);
    return;
  }
  if (target !== "main") throw new Error("Release checks require target main or dev.");
  if (head === "dev") throw new Error("Direct dev -> main PRs are blocked. Use Release Aspire Skills.");
  if (head !== undefined && !/^release\/[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(head)) {
    throw new Error("PRs to main must use a prepared release/ branch.");
  }
  const entry = tree(root, ref, ["CHANGELOG.md"]).get("CHANGELOG.md");
  if (!entry || entry.mode !== "100644") throw new Error("The release must have a regular CHANGELOG.md.");
  const changelog = blob(root, entry).toString("utf8");
  const { source, base, version } = metadataFromChangelog(changelog);
  resolveReleaseSource(root, source);
  selectedCommit(root, base, "base_commit");
  requireAncestor(root, source, ref);
  requireAncestor(root, base, ref);
  requireAncestor(root, base, "origin/main");
  if ((head !== undefined && base !== commit(root, "origin/main"))
      || (baseCommit && base !== selectedCommit(root, baseCommit, "base_commit"))) {
    throw new Error("The main baseline changed. Prepare a new release to preserve main's history.");
  }
  if (version !== validateReleaseVersion(root, source, base, version)) throw new Error("Release metadata version is not valid for the selected changes.");
  requireSourceMatch(root, source, ref, { version });
  checkCatalog(root, ref, source, version);
  if (changelog !== createReleaseChangelog(root, source, base, version)) {
    throw new Error("CHANGELOG.md does not match the selected commit range and preserved main history.");
  }
  if (prBody !== undefined) checkBodyMetadata(root, prBody, source, base, version);
  return { source, base, candidate: ref, version };
}

export function prepareRelease(root, { sourceCommit, baseCommit, releaseVersion } = {}) {
  root = assertGitRepositoryRoot(root);
  requireArtifactPaths(root);
  if (git(root, ["status", "--porcelain"]).stdout.trim()) throw new Error("Release preparation requires a clean worktree.");
  const source = resolveReleaseSource(root, sourceCommit);
  const base = baseCommit ? selectedCommit(root, baseCommit, "base_commit") : commit(root, "origin/main");
  if (base !== commit(root, "origin/main")) throw new Error("The main baseline changed. Resolve the release again.");
  if (git(root, ["merge-base", "--is-ancestor", source, base], [0, 1]).status === 0) {
    throw new Error("The selected dev commit has already been released.");
  }
  const version = validateReleaseVersion(root, source, base, releaseVersion);
  const paths = versionPaths(root, source);
  const changelog = createReleaseChangelog(root, source, base, version);
  git(root, ["switch", "--create", "release/candidate", base]);
  const merge = git(root, ["merge", "--no-ff", "--no-commit", "--no-edit", source], [0, 1]);
  let versionConflicts = [];
  if (merge.status !== 0) {
    const conflicts = git(root, ["diff", "--name-only", "--diff-filter=U", "-z"]).stdout.split("\0").filter(Boolean);
    versionConflicts = conflicts.filter(path => paths.includes(path));
    if (!conflicts.length || conflicts.some(path => path !== "CHANGELOG.md" && path !== "opencode" && !path.startsWith("opencode/") && !paths.includes(path))) {
      throw new Error(`Resolve source conflicts between main and dev before preparing a release:\n${merge.stderr}`);
    }
    if (versionConflicts.length) {
      const common = git(root, ["merge-base", "--all", base, source]).stdout.trim();
      fullSha(common, "unique merge base");
      const commonManifests = versionManifests(root, common);
      const mainManifests = versionManifests(root, base);
      for (const path of versionConflicts) {
        const original = commonManifests.get(path);
        if (!updateManifestVersion(mainManifests.get(path), path, manifestVersion(original, path)).equals(original)) {
          throw new Error(`Resolve source conflicts in version manifest before preparing a release: ${path}`);
        }
      }
    }
    git(root, ["rm", "--force", "-r", "--ignore-unmatch", "--", "CHANGELOG.md", "opencode"]);
  }
  requireSourceMatch(root, source, undefined, { staged: true, skip: versionConflicts });
  for (const [path, contents] of versionManifests(root, source)) {
    writeFileSync(join(root, path), updateManifestVersion(contents, path, version));
  }
  // Recreate only release-owned paths; never automatically resolve source conflicts.
  for (const path of ["opencode", "CHANGELOG.md"]) rmSync(join(root, path), { recursive: true, force: true });
  buildCatalog(root, { release: true });
  writeFileSync(join(root, "CHANGELOG.md"), changelog);
  git(root, ["add", "--force", "--all", "--", "opencode", "CHANGELOG.md", ...paths]);
  requireSourceMatch(root, source, undefined, { staged: true, version });
  git(root, [
    "commit", "-m", `Release Aspire skills v${version} from ${source.slice(0, 12)}`,
    "-m", `Source-Commit: ${source}\nBase-Commit: ${base}`,
    "-m", "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
  ]);
  const candidate = commit(root, "HEAD");
  checkRelease(root, { target: "main", head: "release/candidate", baseCommit: base });
  const outputRoot = join(root, "dist", "release");
  requireArtifactPaths(root);
  mkdirSync(outputRoot, { recursive: true });
  git(root, ["bundle", "create", join(outputRoot, "release.bundle"), candidateRef, `^${base}`]);
  verifyBundle(root, join(outputRoot, "release.bundle"), candidate);
  writeFileSync(join(outputRoot, "pr-body.md"), createReleaseBody(root, source, base, version));
  const result = { source, base, candidate, version };
  writeFileSync(join(outputRoot, "release.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export function receiveRelease(root, { bundlePath, prBodyPath, sourceCommit, baseCommit, candidateCommit, releaseVersion } = {}) {
  root = assertGitRepositoryRoot(root);
  const source = selectedCommit(root, sourceCommit, "source_commit");
  const base = selectedCommit(root, baseCommit, "base_commit");
  const candidate = fullSha(candidateCommit, "candidate_commit");
  const version = validateReleaseVersion(root, source, base, releaseVersion);
  if (base !== commit(root, "origin/main")) throw new Error("The main baseline changed. Prepare a new release.");
  for (const path of [bundlePath, prBodyPath]) {
    if (!path || !lstatSync(path).isFile()) throw new Error("Release artifacts must be regular files, not symlinks.");
  }
  verifyBundle(root, bundlePath, candidate);
  if (git(root, ["show-ref", "--verify", "--quiet", candidateRef], [0, 1]).status === 0) {
    throw new Error("The receiver already has a release candidate.");
  }
  git(root, ["-c", "fetch.fsckObjects=true", "fetch", "--no-tags", "--no-write-fetch-head", resolve(bundlePath), `${candidateRef}:${candidateRef}`]);
  const body = readFileSync(prBodyPath, "utf8");
  const result = checkRelease(root, {
    target: "main", head: "release/candidate", headCommit: candidate, baseCommit: base, prBody: body
  });
  if (result.source !== source || result.base !== base || result.candidate !== candidate || result.version !== version) {
    throw new Error("The bundle provenance does not match the preparation outputs.");
  }
  if (body !== createReleaseBody(root, source, base, version)) throw new Error("The release PR body artifact has been modified.");
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, ...args] = process.argv.slice(2);
    if (args.length) throw new Error("Usage: node scripts/release.mjs <resolve|prepare|check|receive>");
    const root = resolve(process.env.RELEASE_REPO || repoRoot);
    let result;
    if (operation === "resolve") {
      result = { source: resolveReleaseSource(root, process.env.SOURCE_COMMIT), base: commit(root, "origin/main") };
      result.version = validateReleaseVersion(root, result.source, result.base, process.env.RELEASE_VERSION);
    } else if (operation === "prepare") {
      result = prepareRelease(root, {
        sourceCommit: process.env.SOURCE_COMMIT, baseCommit: process.env.BASE_COMMIT, releaseVersion: process.env.RELEASE_VERSION
      });
    } else if (operation === "check") {
      result = checkRelease(root, {
        target: process.env.TARGET_BRANCH, head: process.env.HEAD_BRANCH || undefined,
        headCommit: process.env.HEAD_COMMIT || undefined, baseCommit: process.env.BASE_COMMIT || undefined,
        prBody: process.env.HEAD_BRANCH ? process.env.PR_BODY ?? "" : undefined
      });
    } else if (operation === "receive") {
      result = receiveRelease(root, {
        bundlePath: process.env.BUNDLE_PATH, prBodyPath: process.env.PR_BODY_PATH,
        sourceCommit: process.env.SOURCE_COMMIT, baseCommit: process.env.BASE_COMMIT,
        candidateCommit: process.env.CANDIDATE_COMMIT, releaseVersion: process.env.RELEASE_VERSION
      });
    } else {
      throw new Error("Usage: node scripts/release.mjs <resolve|prepare|check|receive>");
    }
    if (result && process.env.GITHUB_OUTPUT) {
      writeFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(""), { flag: "a" });
    }
    console.log(`Release ${operation} succeeded${result ? `: ${JSON.stringify(result)}` : "."}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
