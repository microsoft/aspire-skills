import { isUtf8 } from "node:buffer";
import { isScalar, parseDocument } from "yaml";

const manifestPaths = [
  "package.json", ".plugin/plugin.json", ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json", "gemini-extension.json"
];
const snapshots = new WeakMap();

export function parseVersion(value) {
  const match = typeof value === "string"
    && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || match[0] !== value || match[4]?.split(".").some(part => /^\d+$/.test(part) && /^0\d/.test(part))) {
    throw new Error("Version must be valid SemVer without a v prefix.");
  }
  return { core: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split(".") ?? [] };
}

export function compareVersions(left, right) {
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

function versionTokens(contents, path) {
  if (!isUtf8(contents)) throw new Error(`Version manifest must be UTF-8: ${path}`);
  const text = contents.toString("utf8");
  let source = text;
  let offset = 0;
  let fields = [["version"]];
  if (/^skills\/[^/]+\/SKILL\.md$/.test(path)) {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!frontmatter) throw new Error(`Skill must contain YAML frontmatter: ${path}`);
    source = frontmatter[1];
    offset = text.indexOf("\n") + 1;
    fields = [["metadata", "version"]];
  } else {
    const data = JSON.parse(text);
    if (path.endsWith("/marketplace.json")) {
      const plugins = data?.plugins;
      if (!Array.isArray(plugins) || plugins.filter(plugin => plugin?.name === "aspire").length !== 1) {
        throw new Error(`Version manifest must identify exactly one aspire plugin: ${path}`);
      }
      fields = [["plugins", plugins.findIndex(plugin => plugin?.name === "aspire"), "version"]];
    } else if (path === "package-lock.json") {
      fields.push(["packages", "", "version"]);
    }
  }
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) {
    throw new Error(`Invalid version manifest ${path}: ${document.errors[0].message}`);
  }
  const tokens = fields.map(field => {
    const scalar = document.getIn(field, true);
    if (!isScalar(scalar) || !scalar.range
      || !["PLAIN", "QUOTE_DOUBLE", "QUOTE_SINGLE"].includes(scalar.type)) {
      throw new Error(`Missing version scalar ${field.join(".")}: ${path}`);
    }
    return {
      value: scalar.value, start: offset + scalar.range[0], end: offset + scalar.range[1],
      quote: scalar.type === "QUOTE_DOUBLE" ? '"' : scalar.type === "QUOTE_SINGLE" ? "'" : ""
    };
  });
  for (const token of tokens) parseVersion(token.value);
  if (tokens.some(token => token.value !== tokens[0].value)) {
    throw new Error(`Version fields disagree: ${path}`);
  }
  return { text, tokens, version: tokens[0].value };
}

export function updateVersion(contents, path, version) {
  parseVersion(version);
  const parsed = versionTokens(contents, path);
  if (parsed.version === version) return contents;
  let text = parsed.text;
  for (const token of [...parsed.tokens].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, token.start) + token.quote + version + token.quote + text.slice(token.end);
  }
  return Buffer.from(text);
}

export function versionManifests(repo, sha) {
  const entries = repo.files(sha);
  const paths = [...manifestPaths, ...entries.keys()].filter(path =>
    manifestPaths.includes(path) || /^skills\/[^/]+\/SKILL\.md$/.test(path));
  const unique = [...new Set(paths)];
  if (entries.has("package-lock.json")) unique.push("package-lock.json");
  for (const path of unique) {
    if (entries.get(path)?.mode !== "100644" || entries.get(path)?.type !== "blob") {
      throw new Error(`Expected a regular version manifest: ${path}`);
    }
  }
  const contents = repo.contents(unique.map(path => entries.get(path)));
  const manifests = new Map(unique.map(path => [path, contents.get(entries.get(path).oid)]));
  for (const [path, bytes] of manifests) versionTokens(bytes, path);
  return manifests;
}

export function versionSnapshot(repo, sha) {
  if (!snapshots.has(repo)) snapshots.set(repo, new Map());
  const cache = snapshots.get(repo);
  if (cache.has(sha)) return cache.get(sha);
  const manifests = versionManifests(repo, sha);
  const versions = [...manifests].map(([path, contents]) => versionTokens(contents, path).version);
  if (versions.some(version => version !== versions[0])) {
    throw new Error("Package, lockfile, plugin, and skill versions must be synchronized.");
  }
  const snapshot = Object.freeze({ version: versions[0], manifests });
  cache.set(sha, snapshot);
  return snapshot;
}

export function onlyVersionChanges(repo, before, after) {
  const previous = versionSnapshot(repo, before);
  const selected = versionSnapshot(repo, after);
  if (previous.manifests.size !== selected.manifests.size
    || !repo.sameTree(before, after, { exclude: ["CHANGELOG.md", "opencode", ...previous.manifests.keys()] })) return false;
  return [...previous.manifests].every(([path, contents]) =>
    selected.manifests.get(path)?.equals(updateVersion(contents, path, selected.version)));
}
