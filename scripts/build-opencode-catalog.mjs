import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const excludedDirectories = new Set(["evals", "tests", "node_modules", "__pycache__"]);
const inlineLink = /(\]\([ \t]*)(<[^<>\n]*>|[^\s()<>]+)((?:[ \t]+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\)))?[ \t]*\))/g;
const referenceLink = /^([ ]{0,3}\[(?:\\.|[^\]\\\n])+\]:[ \t]*)(<[^<>\n]*>|[^\s()<>]+)((?:[ \t]+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\)))?[ \t]*)$/gm;
const markdownLink = new RegExp(`${inlineLink.source}|${referenceLink.source}`, "gm");

export function isDevelopmentPath(path) {
  return path.split("/").some(part => part.startsWith(".") || excludedDirectories.has(part));
}

export function assertSafePath(path) {
  if (typeof path !== "string" || !path.split("/").every(part =>
    /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Unsafe catalog path: ${JSON.stringify(path)}`);
  }
}

function listFiles(root, excludeDevelopment = false, prefix = "") {
  if (lstatSync(root).isSymbolicLink()) {
    throw new Error(`Symbolic links are not supported in the catalog: ${root}`);
  }
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (excludeDevelopment && isDevelopmentPath(entry.name)) {
      continue;
    }
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    assertSafePath(path);
    if (entry.isDirectory()) {
      files.push(...listFiles(join(root, entry.name), excludeDevelopment, path));
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      throw new Error(`Only regular files and directories are supported: ${join(root, entry.name)}`);
    }
  }
  return files.sort();
}

function normalizeContents(contents) {
  return contents.includes(0) || !isUtf8(contents)
    ? contents : Buffer.from(contents.toString("utf8").replaceAll("\r\n", "\n"));
}

function readPublishedSkills(root, format) {
  const sourceRoot = join(root, "skills");
  const sourceFiles = listFiles(sourceRoot, true);
  const names = sourceFiles.filter(path => /^[^/]+\/SKILL\.md$/.test(path))
    .map(path => path.split("/")[0]).sort();
  if (!names.length) throw new Error("Catalog must contain at least one skill.");
  const skills = new Map();
  for (const name of names) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) {
      throw new Error("Catalog skill names must be lowercase kebab-case IDs of 1-64 characters.");
    }
    const entry = `${name}/SKILL.md`;
    const entryFile = format === "v1" ? "SKILL.md" : `${name}.md`;
    const files = new Map();
    const paths = new Set();
    for (const path of sourceFiles.filter(path => path.startsWith(`${name}/`))) {
      const relativePath = path.slice(name.length + 1);
      const target = relativePath === "SKILL.md" ? entryFile : relativePath;
      if (paths.has(target.toLowerCase())) throw new Error(`Catalog file collides with another entry: ${name}/${target}`);
      paths.add(target.toLowerCase());
      if (relativePath !== "SKILL.md" && relativePath.split("/").includes("SKILL.md")) {
        throw new Error(`Unpublished catalog file: ${name}/${relativePath}`);
      }
      let contents = normalizeContents(readFileSync(join(sourceRoot, ...path.split("/"))));
      if (path.endsWith(".md") && !contents.includes(0) && isUtf8(contents)) {
        const markdown = contents.toString("utf8");
        const frontmatter = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(markdown)?.[0] ?? "";
        const relocate = (match, ...groups) => {
          const [before, token, after] = groups.slice(groups[0] === undefined ? 3 : 0);
          const enclosed = token.startsWith("<");
          const destination = enclosed ? token.slice(1, -1) : token;
          if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(destination)) return match;
          const [, linkPath, suffix] = /^([^#?]*)(.*)$/.exec(destination);
          const resolved = posix.normalize(posix.join(posix.dirname(path), linkPath));
          if (!sourceFiles.includes(resolved)) {
            throw new Error(`Broken relative Markdown link in skills/${path}: ${destination}`);
          }
          let relocated;
          if (!resolved.startsWith(`${name}/`)) {
            // OpenCode caches each skill independently; sibling directories are not guaranteed.
            relocated = `https://github.com/microsoft/aspire-skills/blob/main/skills/${resolved}${suffix}`;
          } else if (resolved === entry) {
            relocated = `${posix.relative(posix.dirname(relativePath), entryFile)}${suffix}`;
          } else {
            return match;
          }
          return `${before}${enclosed ? `<${relocated}>` : relocated}${after}`;
        };
        const body = markdown.slice(frontmatter.length).replace(markdownLink, relocate);
        contents = Buffer.from(frontmatter + body);
      }
      files.set(target, contents);
    }
    skills.set(name, files);
  }
  return skills;
}

function contentVersion(files) {
  const manifest = [...files.keys()].sort().map(path => [
    path, createHash("sha512").update(files.get(path)).digest("hex")
  ]);
  return `sha512-${createHash("sha512").update(JSON.stringify(manifest)).digest("hex")}`;
}

export function createCatalog(root, { format = "v2" } = {}) {
  if (!["v1", "v2"].includes(format)) throw new Error(`Unsupported OpenCode catalog format: ${format}`);
  const skills = readPublishedSkills(root, format);
  const index = { skills: [] };
  const outputFiles = new Map();
  for (const [name, files] of skills) {
    index.skills.push({ name, version: contentVersion(files), files: [...files.keys()].sort() });
    for (const [path, contents] of files) outputFiles.set(`${name}/${path}`, contents);
  }
  outputFiles.set("index.json", Buffer.from(`${JSON.stringify(index, null, 2)}\n`));
  return { index, files: outputFiles };
}

export function buildCatalog(root) {
  const { index, files } = createCatalog(root);
  const outputFiles = new Map([...files].map(([path, contents]) => [`v2/${path}`, contents]));
  const v1 = createCatalog(root, { format: "v1" });
  for (const [path, contents] of v1.files) outputFiles.set(`v1/${path}`, contents);
  const distRoot = join(root, "dist");
  if (existsSync(distRoot) && lstatSync(distRoot).isSymbolicLink()) {
    throw new Error(`Symbolic links are not supported in the output path: ${distRoot}`);
  }
  const outputRoot = join(distRoot, "opencode");
  const existingPaths = existsSync(outputRoot) ? listFiles(outputRoot) : [];
  for (const [path, contents] of outputFiles) {
    const target = join(outputRoot, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  for (const path of existingPaths) {
    if (!outputFiles.has(path)) unlinkSync(join(outputRoot, ...path.split("/")));
  }
  return index;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length) throw new Error("Usage: node scripts/build-opencode-catalog.mjs");
    const index = buildCatalog(repoRoot);
    console.log(`Generated OpenCode V1 and V2 catalogs (${index.skills.length} skills each).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
