import { isUtf8 } from "node:buffer";

export const releaseVersionFiles = [
  "package.json",
  ".plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".cursor-plugin/marketplace.json",
  "gemini-extension.json"
];

export function isSkillVersionPath(path) {
  return /^skills\/[^/]+\/SKILL\.md$/.test(path);
}

export function parseVersion(value) {
  const match = typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || match[4]?.split(".").some(part => /^\d+$/.test(part) && /^0\d/.test(part))) {
    throw new Error("Release version must be a valid SemVer value without a v prefix.");
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

export function manifestVersion(contents, path) {
  return versionToken(contents, path).value;
}

export function updateManifestVersion(contents, path, version) {
  parseVersion(version);
  const { text, start, end, quote } = versionToken(contents, path);
  return Buffer.from(text.slice(0, start) + quote + version + quote + text.slice(end));
}
