import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const excludedDirectories = new Set(["evals", "tests", "node_modules", "__pycache__"]);

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
    if (excludeDevelopment && (entry.name.startsWith(".") || excludedDirectories.has(entry.name))) {
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
  // Git checkouts may use CRLF. Preserve binary assets byte-for-byte.
  return contents.includes(0) || !isUtf8(contents)
    ? contents : Buffer.from(contents.toString("utf8").replaceAll("\r\n", "\n"));
}

function entryFileName(name, format) {
  if (format === "v1") return "SKILL.md";
  if (format === "v2") return `${name}.md`;
  throw new Error(`Unsupported OpenCode catalog format: ${format}`);
}

export function validateIndex(index, { format = "v2" } = {}) {
  if (!index || !Array.isArray(index.skills) || index.skills.length === 0) {
    throw new Error("Catalog index must contain a nonempty skills array.");
  }
  const names = new Set();
  for (const entry of index.skills) {
    if (!entry || typeof entry.name !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.name) || entry.name.length > 64) {
      throw new Error("Catalog skill names must be lowercase kebab-case IDs of 1-64 characters.");
    }
    if (names.has(entry.name)) {
      throw new Error(`Duplicate catalog skill: ${entry.name}`);
    }
    names.add(entry.name);
    if (typeof entry.version !== "string" || !/^sha512-[0-9a-f]{128}$/.test(entry.version)) {
      throw new Error(`${entry.name} must have a SHA-512 content version.`);
    }
    const entryFile = entryFileName(entry.name, format);
    if (!Array.isArray(entry.files) || !entry.files.includes(entryFile)) {
      throw new Error(`${entry.name} must list its ${entryFile} entry.`);
    }
    const paths = new Set();
    for (const path of entry.files) {
      assertSafePath(path);
      if (paths.has(path.toLowerCase())) {
        throw new Error(`Duplicate or case-colliding catalog file: ${entry.name}/${path}`);
      }
      paths.add(path.toLowerCase());
      if (path.split("/").some(part => excludedDirectories.has(part))
          || (path !== entryFile && path.split("/").includes("SKILL.md"))) {
        throw new Error(`Unpublished catalog file: ${entry.name}/${path}`);
      }
    }
  }
}

function readPublishedSkills(root, format) {
  const sourceRoot = join(root, "skills");
  const sourceFiles = listFiles(sourceRoot, true);
  const names = sourceFiles.filter(path => /^[^/]+\/SKILL\.md$/.test(path))
    .map(path => path.split("/")[0]).sort();
  const skills = new Map();
  for (const name of names) {
    const entry = `${name}/SKILL.md`;
    const entryFile = entryFileName(name, format);
    const files = new Map();
    for (const path of sourceFiles.filter(path => path.startsWith(`${name}/`))) {
      const relativePath = path.slice(name.length + 1);
      const target = relativePath === "SKILL.md" ? entryFile : relativePath;
      if (files.has(target)) throw new Error(`Named entry collides with a supporting file: ${name}/${target}`);
      let contents = normalizeContents(readFileSync(join(sourceRoot, ...path.split("/"))));
      if (path.endsWith(".md")) {
        // Keep frontmatter untouched; only Markdown link destinations need relocation.
        const markdown = contents.toString("utf8");
        const frontmatter = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(markdown)?.[0] ?? "";
        const body = markdown.slice(frontmatter.length).replace(
          /(\]\()([^)\s]+)(\))/g,
          (match, before, destination, after) => {
            if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(destination)) return match;
            const [, linkPath, suffix] = /^([^#?]*)(.*)$/.exec(destination);
            const resolved = posix.normalize(posix.join(posix.dirname(path), linkPath));
            if (!sourceFiles.includes(resolved)) {
              throw new Error(`Broken relative Markdown link in skills/${path}: ${destination}`);
            }
            if (!resolved.startsWith(`${name}/`)) {
              // OpenCode caches each skill independently; sibling directories are not guaranteed.
              return `${before}https://github.com/microsoft/aspire-skills/blob/main/skills/${resolved}${suffix}${after}`;
            }
            if (resolved === entry) {
              return `${before}${posix.relative(posix.dirname(relativePath), entryFile)}${suffix}${after}`;
            }
            return match;
          }
        );
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
  // Frame paths and file hashes unambiguously, without depending on a prior deployment.
  return `sha512-${createHash("sha512").update(JSON.stringify(manifest)).digest("hex")}`;
}

export function createCatalog(root, { format = "v2" } = {}) {
  const skills = readPublishedSkills(root, format);
  const index = { skills: [] };
  const outputFiles = new Map();
  for (const [name, files] of skills) {
    index.skills.push({ name, version: contentVersion(files), files: [...files.keys()].sort() });
    for (const [path, contents] of files) outputFiles.set(`${name}/${path}`, contents);
  }
  validateIndex(index, { format });
  outputFiles.set("index.json", Buffer.from(`${JSON.stringify(index, null, 2)}\n`));
  return { index, files: outputFiles };
}

export function buildCatalog(root, { check = false } = {}) {
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
  if (check) {
    for (const [format, path] of [["v2", "v2/index.json"], ["v1", "v1/index.json"]]) {
      if (existingPaths.includes(path)) {
        validateIndex(JSON.parse(readFileSync(join(outputRoot, ...path.split("/")), "utf8")), { format });
      }
    }
    if (JSON.stringify(existingPaths) !== JSON.stringify([...outputFiles.keys()].sort())
        || [...outputFiles].some(([path, contents]) =>
          !normalizeContents(readFileSync(join(outputRoot, ...path.split("/")))).equals(contents))) {
      throw new Error("OpenCode catalog is out of sync. Run npm run catalog to rebuild dist/opencode/.");
    }
  }
  if (!check) {
    for (const [path, contents] of outputFiles) {
      const target = join(outputRoot, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    for (const path of existingPaths) {
      if (!outputFiles.has(path)) unlinkSync(join(outputRoot, ...path.split("/")));
    }
  }
  return index;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const check = args[0] === "--check";
    if (check) args.shift();
    if (args.length) throw new Error("Usage: node scripts/build-opencode-catalog.mjs [--check]");
    const index = buildCatalog(repoRoot, { check });
    console.log(`${check ? "Checked" : "Generated"} OpenCode V1 and V2 catalogs (${index.skills.length} skills each).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
