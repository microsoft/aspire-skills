import { spawnSync } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertSafePath, createCatalog, isDevelopmentPath } from "./build-opencode-catalog.mjs";

function createGitEnvironment() {
  const environment = { ...process.env };
  for (const variableName of [
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES",
    "GIT_NAMESPACE", "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
    "GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL", "GIT_TEMPLATE_DIR",
    "GIT_CONFIG_NOSYSTEM", "GIT_ATTR_NOSYSTEM", "GIT_NO_REPLACE_OBJECTS"
  ]) {
    delete environment[variableName];
  }
  for (const variableName of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(variableName)) delete environment[variableName];
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  // Git for Windows recognizes /dev/null but rejects NUL as a config path.
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

function assertGitRepositoryRoot(repoRoot) {
  const requestedRoot = resolve(repoRoot);
  const canonicalRequestedRoot = realpathSync.native(requestedRoot);
  const result = spawnSync(
    "git", ["-c", `safe.directory=${canonicalRequestedRoot}`, "rev-parse", "--show-toplevel"],
    { cwd: canonicalRequestedRoot, encoding: "utf8", env: createGitEnvironment() }
  );
  if (result.error) {
    throw new Error(`Could not resolve a Git repository at requested root '${requestedRoot}': ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim();
    throw new Error(`Could not resolve a Git repository at requested root '${requestedRoot}'${detail ? `: ${detail}` : "."}`);
  }
  const canonicalGitRoot = realpathSync.native(resolve(canonicalRequestedRoot, result.stdout.trim()));
  const comparableRequestedRoot = process.platform === "win32" ? canonicalRequestedRoot.toLowerCase() : canonicalRequestedRoot;
  const comparableGitRoot = process.platform === "win32" ? canonicalGitRoot.toLowerCase() : canonicalGitRoot;
  if (comparableRequestedRoot !== comparableGitRoot) {
    throw new Error(`Requested root '${canonicalRequestedRoot}' is not the Git repository root '${canonicalGitRoot}'.`);
  }
  return canonicalGitRoot;
}

const releaseVersionFiles = [
  "package.json",
  ".plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".cursor-plugin/marketplace.json",
  "gemini-extension.json"
];

function isSkillVersionPath(path) {
  return /^skills\/[^/]+\/SKILL\.md$/.test(path);
}

function parseVersion(value) {
  const match = typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || match[4]?.split(".").some(part => /^\d+$/.test(part) && /^0\d/.test(part))) {
    throw new Error("Release version must be a valid SemVer value without a v prefix.");
  }
  return { core: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split(".") ?? [] };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function skillVersionToken(contents, path) {
  if (!isUtf8(contents)) throw new Error(`Version manifest must be UTF-8: ${path}`);
  const text = contents.toString("utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const metadata = frontmatter && [...frontmatter[1].matchAll(/^metadata:[ \t]*(?:#.*)?\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))*)/gm)];
  if (metadata?.length !== 1) throw new Error(`Skill must contain one metadata mapping: ${path}`);
  const block = metadata[0][1];
  const indent = [...block.matchAll(/^([ \t]+)\S/gm)].map(match => match[1]).sort((a, b) => a.length - b.length)[0];
  const matches = [...block.matchAll(/^([ \t]+version:[ \t]*)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#]+))([ \t]*(?:#.*)?)\r?$/gm)]
    .filter(match => /^[ \t]+/.exec(match[1])[0] === indent);
  if (matches.length !== 1) throw new Error(`Skill must contain one metadata.version: ${path}`);
  const match = matches[0];
  const value = match[2] ?? match[3] ?? match[4];
  parseVersion(value);
  const start = text.indexOf("\n") + 1 + metadata[0].index + metadata[0][0].length - block.length + match.index + match[1].length;
  const quote = match[2] !== undefined ? '"' : match[3] !== undefined ? "'" : "";
  return { text, value, start, end: start + value.length + quote.length * 2, quote };
}

function versionToken(contents, path) {
  if (isSkillVersionPath(path)) return skillVersionToken(contents, path);
  if (!isUtf8(contents)) throw new Error(`Version manifest must be UTF-8 JSON: ${path}`);
  const text = contents.toString("utf8");
  const document = JSON.parse(text);
  let field = ["version"];
  if (path.endsWith("/marketplace.json")) {
    const plugins = document?.plugins;
    if (!Array.isArray(plugins) || plugins.filter(plugin => plugin?.name === "aspire").length !== 1) {
      throw new Error(`Version manifest must identify exactly one aspire plugin: ${path}`);
    }
    field = ["plugins", plugins.findIndex(plugin => plugin?.name === "aspire"), "version"];
  }
  const value = field.reduce((value, key) => value?.[key], document);
  parseVersion(value);

  // Locate the selected JSON string token rather than reformatting source manifests.
  const tokens = [...text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)];
  let cursor = 0;
  let selected;
  function visit(location) {
    const token = tokens[cursor++];
    if (JSON.stringify(location) === JSON.stringify(field)) selected = token;
    if (token[0] === "{") {
      const keys = new Set();
      while (tokens[cursor][0] !== "}") {
        const key = JSON.parse(tokens[cursor++][0]);
        if (keys.has(key)) throw new Error(`Duplicate JSON key in version manifest: ${path}`);
        keys.add(key);
        cursor++;
        visit([...location, key]);
        if (tokens[cursor][0] === ",") cursor++;
      }
      cursor++;
    } else if (token[0] === "[") {
      let index = 0;
      while (tokens[cursor][0] !== "]") {
        visit([...location, index++]);
        if (tokens[cursor][0] === ",") cursor++;
      }
      cursor++;
    }
  }
  visit([]);
  if (!selected) throw new Error(`Missing version field: ${path}`);
  return { text, value, start: selected.index, end: selected.index + selected[0].length, quote: '"' };
}

function manifestVersion(contents, path) {
  return versionToken(contents, path).value;
}

function updateManifestVersion(contents, path, version) {
  parseVersion(version);
  const { text, start, end, quote } = versionToken(contents, path);
  return Buffer.from(text.slice(0, start) + quote + version + quote + text.slice(end));
}

const stages = {
  prepare: { target: "dev", branch: "prepare-release/candidate" },
  promote: { target: "main", branch: "release/candidate" }
};
const metadataPattern = /<!-- aspire-skills-release source=([0-9a-f]{40}) base=([0-9a-f]{40}) version=([0-9A-Za-z.+-]+) source-version=([0-9A-Za-z.+-]+) base-version=([0-9A-Za-z.+-]+) -->/g;
const promotionPattern = /<!-- aspire-skills-promotion prepared=([0-9a-f]{40}) -->/g;
const repositoryUrl = "https://github.com/microsoft/aspire-skills";

function releaseStage(stage) {
  if (!Object.hasOwn(stages, stage)) throw new Error("Release stage must be prepare or promote.");
  return stages[stage];
}

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
  const paths = [...tree(root, ref, ["opencode"]).keys()];
  if (paths.length) throw new Error(`Development sources must not contain generated OpenCode catalogs:\n${paths.join("\n")}`);
}

function resolveReleaseSource(root, requested) {
  root = assertGitRepositoryRoot(root);
  const source = requested ? selectedCommit(root, requested, "source_commit") : commit(root, "origin/dev");
  requireAncestor(root, source, "origin/dev");
  requireSourceOnly(root, source);
  return source;
}

function requireSourceMatch(root, source, ref, { staged = false, version, skip = [], allowReadme = false } = {}) {
  const paths = versionPaths(root, source);
  const sourcePaths = [".", ...["opencode", "CHANGELOG.md", ...paths, ...(allowReadme ? ["README.md"] : [])]
    .map(path => `:(top,exclude)${path}`)];
  if (allowReadme && tree(root, ref, ["README.md"]).get("README.md")?.mode !== "100644") {
    throw new Error("Preparation documentation edits require a regular README.md.");
  }
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

function hasProductChanges(root, source, base) {
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

function validateReleaseVersion(root, source, base, version) {
  parseVersion(version);
  const sourceVersion = packageVersion(root, source);
  const baseVersion = packageVersion(root, base);
  if (compareVersions(version, sourceVersion) < 0) {
    throw new Error("Release version must not be lower than the selected source plugin version.");
  }
  if (!hasProductChanges(root, source, base)) {
    if (version !== baseVersion) {
      throw new Error("Repository-only changes must keep the existing main version; no product version bump is needed.");
    }
    return baseVersion;
  }
  if (compareVersions(version, baseVersion) <= 0) {
    throw new Error("Release version must be greater than the main baseline plugin version.");
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

function createReleaseChangelog(root, source, base, version) {
  selectedCommit(root, source, "source_commit");
  selectedCommit(root, base, "base_commit");
  version = validateReleaseVersion(root, source, base, version);
  const previous = readChangelog(root, base).replaceAll("\r\n", "\n");
  const firstEntry = previous.search(/^## /m);
  const header = firstEntry < 0 ? previous : previous.slice(0, firstEntry);
  const history = firstEntry < 0 ? "" : previous.slice(firstEntry);
  const entry = releaseEntry(root, source, base, version);
  return `${header.trimEnd()}\n\n${entry}\n${history ? `\n${history}` : ""}`;
}

function readChangelog(root, ref) {
  const entry = tree(root, ref, ["CHANGELOG.md"]).get("CHANGELOG.md");
  if (!entry || entry.mode !== "100644") throw new Error("The release must have a regular CHANGELOG.md.");
  return blob(root, entry).toString("utf8");
}

function createPreparationBody(root, source, base, version) {
  version = validateReleaseVersion(root, source, base, version);
  const changelog = createReleaseChangelog(root, source, base, version);
  const entries = changelog.slice(changelog.search(/^## /m));
  const nextEntry = entries.indexOf("\n## ");
  const latestEntry = (nextEntry < 0 ? entries : entries.slice(0, nextEntry)).trimEnd();
  return [
    "## Prepare release", "", releaseMetadata(root, source, base, version), "",
    `- Plugin version: \`${version}\` (selected source: \`${packageVersion(root, source)}\`; main baseline: \`${packageVersion(root, base)}\`)`,
    `- Selected dev commit: [\`${source}\`](${repositoryUrl}/commit/${source})`,
    `- Main baseline: [\`${base}\`](${repositoryUrl}/commit/${base})`, "",
    "Updates only version metadata and the changelog on dev. OpenCode catalogs remain off dev.", "",
    "You may edit `README.md` in this preparation PR before merging. Other source changes must land on dev and be prepared again.", "",
    "**Merge into dev with a merge commit, not squash or rebase.** If dev advances, regenerate this preparation instead of updating its branch.", "",
    "## After this PR merges", "",
    "**Promote Release runs automatically** after this PR merges into dev, without waiting for the post-merge CI run.",
    "It pins that exact merge SHA, preserves these versions and changelog, and generates the OpenCode catalogs.",
    "It opens a draft release PR targeting main. Review and merge that PR with a merge commit to publish the release.",
    "Promotion has no manual trigger. Neither workflow merges a PR or pushes directly to main.", "",
    latestEntry.replace(`${releaseMetadata(root, source, base, version)}\n`, ""), ""
  ].join("\n");
}

function createPromotionSummary(root, prepared) {
  const { source, base, version } = checkPreparedMerge(root, prepared);
  return [
    `## Release v${version}`, "", releaseMetadata(root, source, base, version),
    `<!-- aspire-skills-promotion prepared=${prepared} -->`, "",
    `- Release version: \`${version}\``,
    `- Prepared dev merge: [\`${prepared}\`](${repositoryUrl}/commit/${prepared})`,
    `- Main baseline: [\`${base}\`](${repositoryUrl}/commit/${base})`, "",
    "Promotes exactly the reviewed dev snapshot, preserving its versions and changelog and adding generated OpenCode V1/V2 catalogs.",
    "Later dev commits are not included. Fix source on dev and prepare again rather than editing this candidate.", "",
    "**Merge into main with a merge commit, not squash or rebase**, to preserve the prepared dev history.",
    "The catalogs become available when this PR merges. The workflow does not update main directly.", ""
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

function verifyBundle(root, path, candidate, stage) {
  const candidateRef = `refs/heads/${releaseStage(stage).branch}`;
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
  for (const name of ["release.bundle", "release-summary.md", "release.json"]) {
    const entry = lstatSync(join(root, "dist", "release", name), { throwIfNoEntry: false });
    if (entry && !entry.isFile()) throw new Error(`Release artifact must be a regular file: ${name}`);
  }
}

function parents(root, ref) {
  return git(root, ["show", "-s", "--format=%P", ref]).stdout.trim().split(" ").filter(Boolean);
}

function requireParents(root, ref, expected) {
  if (JSON.stringify(parents(root, ref)) !== JSON.stringify(expected)) {
    throw new Error("Release ancestry does not match the prepared snapshots. Use merge commits and regenerate after source changes.");
  }
}

function requireSameTree(root, source, ref, { staged = false, excludeCatalog = false } = {}) {
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--quiet",
    ...(staged ? ["--cached"] : []), source, ...(staged ? [] : [ref]), "--", ".",
    ...(excludeCatalog ? [":(top,exclude)opencode"] : [])];
  if (git(root, args, [0, 1]).status !== 0) {
    throw new Error("Promotion must preserve the exact prepared dev snapshot, including versions and changelog.");
  }
}

function requireCurrentMain(root, base) {
  if (base !== commit(root, "origin/main")) {
    throw new Error("The main baseline changed. Prepare a new release to preserve main's history.");
  }
}

function requireUnreleased(root, source, base) {
  if (git(root, ["merge-base", "--is-ancestor", source, base], [0, 1]).status === 0) {
    throw new Error("The selected dev commit has already been released.");
  }
}

function resolvePreparation(root, { sourceCommit, baseCommit, releaseVersion } = {}) {
  root = assertGitRepositoryRoot(root);
  const source = resolveReleaseSource(root, sourceCommit);
  const base = baseCommit ? selectedCommit(root, baseCommit, "base_commit") : commit(root, "origin/main");
  requireCurrentMain(root, base);
  if (source !== commit(root, "origin/dev")) {
    throw new Error("The dev baseline changed. Prepare again from the current dev tip.");
  }
  requireUnreleased(root, source, base);
  const version = validateReleaseVersion(root, source, base, releaseVersion);
  return { source, base, version };
}

function checkPreparation(root, { headCommit, sourceCommit, baseCommit, prBody } = {}) {
  root = assertGitRepositoryRoot(root);
  const ref = headCommit ? selectedCommit(root, headCommit, "head_commit") : commit(root, "HEAD");
  requireSourceOnly(root, ref);
  const changelog = readChangelog(root, ref);
  const { source, base, version } = metadataFromChangelog(changelog);
  resolveReleaseSource(root, source);
  selectedCommit(root, base, "base_commit");
  requireAncestor(root, base, "origin/main");
  requireUnreleased(root, source, base);
  requireAncestor(root, source, ref);
  if (sourceCommit && source !== selectedCommit(root, sourceCommit, "source_commit")) {
    throw new Error("The dev baseline changed. Regenerate the preparation PR.");
  }
  if (baseCommit && base !== selectedCommit(root, baseCommit, "base_commit")) {
    throw new Error("The main baseline changed. Regenerate the preparation PR.");
  }
  validateReleaseVersion(root, source, base, version);
  requireSourceMatch(root, source, ref, { version, allowReadme: true });
  if (changelog !== createReleaseChangelog(root, source, base, version)) {
    throw new Error("CHANGELOG.md does not match the selected commit range and preserved main history.");
  }
  if (prBody !== undefined) checkBodyMetadata(root, prBody, source, base, version);
  return { source, base, candidate: ref, version };
}

function checkPreparedMerge(root, prepared) {
  selectedCommit(root, prepared, "prepared_commit");
  resolveReleaseSource(root, prepared);
  const lineage = parents(root, prepared);
  if (lineage.length !== 2) {
    throw new Error("Promotion requires the full merge commit of a preparation PR into dev, not an unprepared dev commit.");
  }
  const preparation = checkPreparation(root, { headCommit: lineage[1], sourceCommit: lineage[0] });
  requireSameTree(root, lineage[1], prepared);
  return preparation;
}

function resolvePromotion(root, { sourceCommit, baseCommit, releaseVersion } = {}) {
  root = assertGitRepositoryRoot(root);
  const source = selectedCommit(root, sourceCommit, "source_commit");
  const { base, version } = checkPreparedMerge(root, source);
  requireCurrentMain(root, base);
  requireUnreleased(root, source, base);
  if (baseCommit && base !== selectedCommit(root, baseCommit, "base_commit")) {
    throw new Error("The promotion baseline does not match the prepared release.");
  }
  if (releaseVersion !== undefined && releaseVersion !== version) {
    throw new Error("Promotion must use the reviewed preparation version.");
  }
  return { source, base, version };
}

function preparedCommitTrailer(root, ref) {
  const body = git(root, ["show", "-s", "--format=%B", ref]).stdout;
  const trailers = [...body.matchAll(/^Prepared-Commit: (.+)$/gm)];
  if (!trailers.length) return undefined;
  if (trailers.length !== 1) throw new Error("A promotion must identify exactly one prepared dev commit.");
  return fullSha(trailers[0][1], "prepared_commit");
}

function checkRelease(root, { target, head, headCommit, baseCommit, prBody } = {}) {
  root = assertGitRepositoryRoot(root);
  const ref = headCommit ? selectedCommit(root, headCommit, "head_commit") : commit(root, "HEAD");
  if (target === "dev") {
    requireSourceOnly(root, ref);
    if (head?.startsWith("prepare-release/")) {
      const result = checkPreparation(root, {
        headCommit: ref, sourceCommit: baseCommit || commit(root, "origin/dev"),
        baseCommit: commit(root, "origin/main"), prBody
      });
      if (result.source !== commit(root, "origin/dev")) {
        throw new Error("The dev baseline changed. Regenerate the preparation PR.");
      }
      if (head !== "prepare-release/candidate" && head !== `prepare-release/${result.version}`) {
        throw new Error("The preparation branch must match its release version.");
      }
      return result;
    }
    if (head === "main" || head?.startsWith("release/")) {
      throw new Error("Main and promotion branches must not target dev.");
    }
    if (baseCommit && git(root, ["diff", "--no-ext-diff", "--no-textconv", "--quiet",
      selectedCommit(root, baseCommit, "base_commit"), ref, "--", "CHANGELOG.md"], [0, 1]).status !== 0) {
      throw new Error("Use Prepare Release to update the changelog on dev.");
    }
    return;
  }
  if (target !== "main") throw new Error("Release checks require target main or dev.");
  if (head !== undefined && !/^release\/[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(head)) {
    throw new Error("Pull requests to main must use a generated release/ branch.");
  }
  const { source: original, base, version } = metadataFromChangelog(readChangelog(root, ref));
  requireAncestor(root, base, "origin/main");
  if (((head !== undefined || baseCommit) && base !== commit(root, "origin/main"))
      || (baseCommit && base !== selectedCommit(root, baseCommit, "base_commit"))) {
    throw new Error("The main baseline changed. Prepare a new release to preserve main's history.");
  }
  if (head !== undefined && head !== `release/${version}`) {
    throw new Error("The release branch must match its release version.");
  }
  let promotion = ref;
  let source = preparedCommitTrailer(root, promotion);
  if (source === undefined && head === undefined) {
    const lineage = parents(root, ref);
    if (lineage.length !== 2 || lineage[0] !== base) {
      throw new Error("Main must receive the release PR with a merge commit.");
    }
    promotion = lineage[1];
    requireSameTree(root, promotion, ref);
    source = preparedCommitTrailer(root, promotion);
  }
  if (source === undefined) throw new Error("The promotion commit must identify its prepared dev merge.");
  requireParents(root, promotion, [base, source]);
  const preparation = checkPreparedMerge(root, source);
  if (preparation.source !== original || preparation.base !== base || preparation.version !== version) {
    throw new Error("Promotion provenance does not match the reviewed preparation.");
  }
  requireSameTree(root, source, ref, { excludeCatalog: true });
  checkCatalog(root, ref, source, version);
  if (prBody !== undefined) {
    checkBodyMetadata(root, prBody, original, base, version);
    const metadata = [...prBody.matchAll(promotionPattern)];
    if (metadata.length !== 1 || metadata[0][1] !== source) {
      throw new Error("The promotion summary must record the exact prepared dev merge.");
    }
  }
  return { source, base, candidate: ref, version };
}

function requireCleanCandidate(root) {
  requireArtifactPaths(root);
  if (git(root, ["status", "--porcelain"]).stdout.trim()) throw new Error("Release preparation requires a clean worktree.");
}

function prepareRelease(root, options = {}) {
  root = assertGitRepositoryRoot(root);
  requireCleanCandidate(root);
  const { source, base, version } = resolvePreparation(root, options);
  const paths = versionPaths(root, source);
  const changelog = createReleaseChangelog(root, source, base, version);
  git(root, ["switch", "--create", stages.prepare.branch, source]);
  for (const [path, contents] of versionManifests(root, source)) {
    writeFileSync(join(root, path), updateManifestVersion(contents, path, version));
  }
  writeFileSync(join(root, "CHANGELOG.md"), changelog);
  git(root, ["add", "--force", "--all", "--", "CHANGELOG.md", ...paths]);
  git(root, [
    "commit", "-m", `Prepare Aspire skills v${version} from ${source.slice(0, 12)}`,
    "-m", `Source-Commit: ${source}\nBase-Commit: ${base}`,
    "-m", "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
  ]);
  const result = checkPreparation(root, { sourceCommit: source, baseCommit: base });
  writeArtifacts(root, "prepare", result, createPreparationBody(root, source, base, version));
  return result;
}

function promoteRelease(root, options = {}) {
  root = assertGitRepositoryRoot(root);
  requireCleanCandidate(root);
  const { source, base, version } = resolvePromotion(root, options);
  git(root, ["switch", "--create", stages.promote.branch, base]);
  const merge = git(root, ["merge", "--no-ff", "--no-commit", "--no-edit", source], [0, 1]);
  if (merge.status !== 0) {
    const conflicts = git(root, ["diff", "--name-only", "--diff-filter=U", "-z"]).stdout.split("\0").filter(Boolean);
    if (!conflicts.length || conflicts.some(path => path !== "opencode" && !path.startsWith("opencode/"))) {
      throw new Error(`Resolve source conflicts on dev and prepare again before promotion:\n${merge.stderr}`);
    }
    git(root, ["rm", "--force", "-r", "--ignore-unmatch", "--", "opencode"]);
  }
  requireSameTree(root, source, undefined, { staged: true, excludeCatalog: true });
  rmSync(join(root, "opencode"), { recursive: true, force: true });
  for (const [path, contents] of expectedCatalog(root, source, version)) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
  git(root, ["add", "--force", "--all", "--", "opencode"]);
  // The dev merge SHA does not exist when the changelog is prepared and reviewed.
  git(root, [
    "commit", "-m", `Update to v${version}`,
    "-m", `Prepared-Commit: ${source}\nBase-Commit: ${base}`,
    "-m", "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
  ]);
  const result = checkRelease(root, { target: "main", baseCommit: base });
  writeArtifacts(root, "promote", result, createPromotionSummary(root, source));
  return result;
}

function writeArtifacts(root, stage, result, body) {
  const { source, base, candidate } = result;
  const candidateRef = `refs/heads/${releaseStage(stage).branch}`;
  const outputRoot = join(root, "dist", "release");
  requireArtifactPaths(root);
  mkdirSync(outputRoot, { recursive: true });
  git(root, ["bundle", "create", join(outputRoot, "release.bundle"), candidateRef, `^${stage === "prepare" ? source : base}`]);
  verifyBundle(root, join(outputRoot, "release.bundle"), candidate, stage);
  writeFileSync(join(outputRoot, "release-summary.md"), body);
  writeFileSync(join(outputRoot, "release.json"), `${JSON.stringify(result, null, 2)}\n`);
}

function receiveRelease(root, { stage, bundlePath, summaryPath, sourceCommit, baseCommit, candidateCommit, releaseVersion } = {}) {
  const details = releaseStage(stage);
  const candidateRef = `refs/heads/${details.branch}`;
  root = assertGitRepositoryRoot(root);
  const source = selectedCommit(root, sourceCommit, "source_commit");
  const base = selectedCommit(root, baseCommit, "base_commit");
  const candidate = fullSha(candidateCommit, "candidate_commit");
  const options = { sourceCommit: source, baseCommit: base, releaseVersion };
  const { version } = stage === "prepare" ? resolvePreparation(root, options) : resolvePromotion(root, options);
  for (const path of [bundlePath, summaryPath]) {
    if (!path || !lstatSync(path).isFile()) throw new Error("Release artifacts must be regular files, not symlinks.");
  }
  verifyBundle(root, bundlePath, candidate, stage);
  if (git(root, ["show-ref", "--verify", "--quiet", candidateRef], [0, 1]).status === 0) {
    throw new Error("The receiver already has a release candidate.");
  }
  git(root, ["-c", "fetch.fsckObjects=true", "fetch", "--no-tags", "--no-write-fetch-head", resolve(bundlePath), `${candidateRef}:${candidateRef}`]);
  const body = readFileSync(summaryPath, "utf8");
  const result = stage === "prepare"
    ? checkPreparation(root, { headCommit: candidate, sourceCommit: source, baseCommit: base, prBody: body })
    : checkRelease(root, { target: "main", headCommit: candidate, baseCommit: base, prBody: body });
  if (result.source !== source || result.base !== base || result.candidate !== candidate || result.version !== version) {
    throw new Error("The bundle provenance does not match the preparation outputs.");
  }
  const expectedBody = stage === "prepare" ? createPreparationBody(root, source, base, version) : createPromotionSummary(root, source);
  if (body !== expectedBody) throw new Error("The release summary artifact has been modified.");
  return result;
}

const repository = "microsoft/aspire-skills";

function requestedDevCommit(event) {
  const run = event?.workflow_run;
  if (event?.action !== "requested" || event?.repository?.full_name !== repository
    || run?.repository?.full_name !== repository || run?.head_repository?.full_name !== repository
    || run?.name !== "Tests" || run?.path !== ".github/workflows/test.yml"
    || run?.event !== "push" || run?.head_branch !== "dev") {
    throw new Error("Automatic promotion requires a requested Tests push run on this repository's dev branch.");
  }
  if (typeof run.head_sha !== "string" || !/^[0-9a-f]{40}$/.test(run.head_sha)) {
    throw new Error("The merged dev head must be a full commit SHA.");
  }
  return run.head_sha;
}

function selectPreparedRelease(event, pullRequests) {
  const source = requestedDevCommit(event);
  if (!Array.isArray(pullRequests)) throw new Error("The associated pull request response must be an array.");
  const matches = pullRequests.filter(pr => pr?.state === "closed" && typeof pr.merged_at === "string"
    && pr.merged_at.length > 0 && pr.merge_commit_sha === source
    && pr.base?.ref === "dev" && pr.base?.repo?.full_name === repository
    && pr.head?.repo?.full_name === repository && typeof pr.head?.ref === "string"
    && pr.head.ref.startsWith("prepare-release/"));
  if (matches.length > 1) throw new Error("The dev commit belongs to more than one merged preparation PR.");
  if (!matches.length) return undefined;
  const pr = matches[0];
  parseVersion(pr.head.ref.slice("prepare-release/".length));
  if (!Number.isSafeInteger(pr.number) || pr.number < 1) throw new Error("The preparation PR number is invalid.");
  return { source, pullRequest: pr.number };
}

function selectAutomaticPreparation() {
  if (!process.env.GITHUB_EVENT_PATH || !process.env.GITHUB_OUTPUT) {
    throw new Error("Automatic selection requires GITHUB_EVENT_PATH and GITHUB_OUTPUT.");
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const source = requestedDevCommit(event);
  const response = spawnSync("gh", [
    "api", "--paginate", "--slurp", `repos/${repository}/commits/${source}/pulls?per_page=100`
  ], { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  if (response.error) throw response.error;
  if (response.status !== 0) throw new Error(`Cannot look up the merged preparation PR: ${response.stderr.trim()}`);
  const pages = JSON.parse(response.stdout);
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) {
    throw new Error("The associated pull request response must contain array pages.");
  }
  const selected = selectPreparedRelease(event, pages.flat());
  if (!selected) {
    console.log(`Dev commit ${source} is not a merged preparation PR; no promotion will run.`);
    return;
  }
  console.log(`Promoting preparation PR #${selected.pullRequest} at dev merge ${selected.source}.`);
  return { source: selected.source };
}

try {
  const [operation, ...args] = process.argv.slice(2);
  if (!operation || args.length) {
    throw new Error("Usage: node scripts/release.mjs <select|resolve-prepare|prepare|receive-prepare|resolve-promote|promote|receive-promote|check>");
  }
  if (operation !== "select" && !process.env.RELEASE_REPO) {
    throw new Error("RELEASE_REPO is required for release operations.");
  }
  const root = operation === "select" ? undefined : resolve(process.env.RELEASE_REPO);
  const options = {
    sourceCommit: process.env.SOURCE_COMMIT, baseCommit: process.env.BASE_COMMIT,
    releaseVersion: process.env.RELEASE_VERSION || undefined
  };
  let result;
  if (operation === "select") {
    result = selectAutomaticPreparation();
  } else if (operation === "resolve-prepare") {
    result = resolvePreparation(root, options);
  } else if (operation === "resolve-promote") {
    result = resolvePromotion(root, options);
  } else if (operation === "prepare" || operation === "promote") {
    result = operation === "prepare" ? prepareRelease(root, options) : promoteRelease(root, options);
  } else if (operation === "check") {
    result = checkRelease(root, {
      target: process.env.TARGET_BRANCH, head: process.env.HEAD_BRANCH || undefined,
      headCommit: process.env.HEAD_COMMIT || undefined, baseCommit: process.env.BASE_COMMIT || undefined,
      prBody: process.env.HEAD_BRANCH ? process.env.PR_BODY ?? "" : undefined
    });
  } else if (operation === "receive-prepare" || operation === "receive-promote") {
    result = receiveRelease(root, {
      ...options, stage: operation.slice("receive-".length),
      bundlePath: process.env.BUNDLE_PATH, summaryPath: process.env.SUMMARY_PATH,
      candidateCommit: process.env.CANDIDATE_COMMIT
    });
  } else {
    throw new Error("Unknown release operation.");
  }
  if (result && process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(""), { flag: "a" });
  }
  console.log(`Release ${operation} succeeded${result ? `: ${JSON.stringify(result)}` : "."}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
