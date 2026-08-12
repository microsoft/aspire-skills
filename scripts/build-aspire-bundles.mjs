import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const version = normalizeVersion(args.version ?? packageJson.version);
const outputRoot = join(repoRoot, args.out ?? "dist");
const skillsBundleName = `aspire-skills-v${version}`;
const skillsBundleRoot = join(outputRoot, skillsBundleName);
const skillsArchivePath = join(outputRoot, `${skillsBundleName}.tgz`);
const extensionsBundleName = `aspire-extensions-v${version}`;
const extensionsBundleRoot = join(outputRoot, extensionsBundleName);
const extensionsArchivePath = join(outputRoot, `${extensionsBundleName}.tgz`);
const skillsRoot = join(repoRoot, "skills");
const extensionsRoot = join(repoRoot, "extensions");
const bundleSelection = parseBundleSelection(args.bundle);
const shouldBuildSkills = bundleSelection === undefined || bundleSelection === "skills";
const shouldBuildExtensions = bundleSelection === undefined || bundleSelection === "extensions";

const supports = {
  aspireCli: args["supports-aspire-cli"] ?? ">=13.4.0 <13.5.0",
  aspireSdk: args["supports-aspire-sdk"] ?? ">=13.4.0 <13.5.0"
};

if (shouldBuildSkills) {
  rmSync(skillsBundleRoot, { recursive: true, force: true });
  rmSync(skillsArchivePath, { force: true });
  mkdirSync(skillsBundleRoot, { recursive: true });

  const skills = listSkillDirectories(skillsRoot).map(skillDirectory => buildSkill(skillDirectory));
  const manifest = {
    version,
    supports,
    skills
  };

  writeFileSync(join(skillsBundleRoot, "skill-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  createArchive(skillsBundleName, skillsArchivePath, "Aspire skills");
}

if (shouldBuildExtensions) {
  rmSync(extensionsBundleRoot, { recursive: true, force: true });
  rmSync(extensionsArchivePath, { force: true });
  mkdirSync(extensionsBundleRoot, { recursive: true });

  const extensions = buildExtensions();
  const extensionManifest = {
    version,
    supports,
    extensions
  };

  writeFileSync(join(extensionsBundleRoot, "extension-manifest.json"), `${JSON.stringify(extensionManifest, null, 2)}\n`);

  createArchive(extensionsBundleName, extensionsArchivePath, "Aspire extensions");
}

function createArchive(bundleName, archivePath, description) {
  const tarResult = spawnSync(
    "tar",
    ["-czf", archivePath, "-C", outputRoot, bundleName],
    { cwd: repoRoot, stdio: "inherit" }
  );

  if (tarResult.status !== 0) {
    throw new Error(`Failed to create ${description} archive with tar.`);
  }

  console.log(`Created ${relative(repoRoot, archivePath)}`);
}

function buildSkill(skillDirectory) {
  const skillName = skillDirectory.split(/[\\/]/).at(-1);
  const skillFilePath = join(skillsRoot, skillDirectory, "SKILL.md");
  const skillFile = readFileSync(skillFilePath, "utf8");
  const frontmatter = parseSkillFrontmatter(skillFile, skillFilePath);

  if (frontmatter.name !== skillName) {
    throw new Error(`${relative(repoRoot, skillFilePath)} declares name '${frontmatter.name}' but lives under '${skillName}'.`);
  }

  if (frontmatter.description.length > 1024) {
    throw new Error(`${relative(repoRoot, skillFilePath)} frontmatter description is ${frontmatter.description.length} characters; limit is 1024.`);
  }

  const sourceRoot = join(skillsRoot, skillDirectory);
  const targetRoot = join(skillsBundleRoot, "skills", skillName);
  const files = [];

  for (const relativePath of listFiles(sourceRoot)) {
    if (relativePath === "evals" || relativePath.startsWith(`evals${sep}`)) {
      continue;
    }

    const sourcePath = join(sourceRoot, relativePath);
    const targetPath = join(targetRoot, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    cpSync(sourcePath, targetPath);

    files.push({
      relativePath: toManifestPath(relativePath),
      sha256: sha256(targetPath)
    });
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));

  return {
    name: skillName,
    description: frontmatter.description,
    isDefault: ["aspire", "aspireify", "aspire-deployment"].includes(skillName),
    applicableLanguages: [],
    installExcludedRelativePaths: ["evals"],
    files
  };
}

function buildExtensions() {
  if (!existsSync(extensionsRoot)) {
    throw new Error(`${relative(repoRoot, extensionsRoot)} does not exist; cannot build the extensions bundle.`);
  }

  const extensions = listExtensionDirectories(extensionsRoot).map(extensionDirectory => buildExtension(extensionDirectory));
  if (extensions.length === 0) {
    throw new Error(`${relative(repoRoot, extensionsRoot)} must contain at least one extension directory with extension.mjs.`);
  }

  return extensions;
}

function buildExtension(extensionDirectory) {
  const extensionName = extensionDirectory.split(/[\\/]/).at(-1);
  const sourceRoot = join(extensionsRoot, extensionDirectory);
  const description = readExtensionDescription(sourceRoot, extensionName);

  const targetRoot = join(extensionsBundleRoot, "extensions", extensionName);
  const files = [];

  for (const relativePath of listFiles(sourceRoot)) {
    const sourcePath = join(sourceRoot, relativePath);
    const targetPath = join(targetRoot, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    cpSync(sourcePath, targetPath);

    files.push({
      relativePath: toManifestPath(relativePath),
      sha256: sha256(targetPath)
    });
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));

  if (!files.some(file => file.relativePath === "extension.mjs")) {
    throw new Error(`extensions/${extensionName} must include extension.mjs.`);
  }

  return {
    name: extensionName,
    description,
    isDefault: true,
    applicableLanguages: [],
    installExcludedRelativePaths: [],
    files
  };
}

function listSkillDirectories(root) {
  return listDirectories(root)
    .filter(directory => existsSync(join(root, directory, "SKILL.md")))
    .sort((left, right) => left.localeCompare(right, "en"));
}

function listExtensionDirectories(root) {
  return listDirectories(root)
    .filter(directory => existsSync(join(root, directory, "extension.mjs")))
    .sort((left, right) => left.localeCompare(right, "en"));
}

function listDirectories(root) {
  return readdirRelative(root, { directories: true });
}

function listFiles(root) {
  return readdirRelative(root, { files: true });
}

function readdirRelative(root, options, prefix = "") {
  const results = [];
  for (const entry of readdirSync(join(root, prefix)).sort((left, right) => left.localeCompare(right, "en"))) {
    const relativePath = prefix ? join(prefix, entry) : entry;
    const fullPath = join(root, relativePath);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (options.directories) {
        results.push(relativePath);
      }

      results.push(...readdirRelative(root, options, relativePath));
      continue;
    }

    if (stat.isFile() && options.files) {
      results.push(relativePath);
    }
  }

  return results;
}

function parseSkillFrontmatter(skillFile, filePath) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillFile);
  if (!match) {
    throw new Error(`${relative(repoRoot, filePath)} does not start with YAML frontmatter.`);
  }

  const lines = match[1].split(/\r?\n/);
  const name = readScalar(lines, "name");
  const description = readScalar(lines, "description");
  if (!name || !description) {
    throw new Error(`${relative(repoRoot, filePath)} must declare name and description.`);
  }

  return { name, description };
}

function readExtensionDescription(sourceRoot, extensionName) {
  const readmePath = join(sourceRoot, "README.md");
  if (!existsSync(readmePath)) {
    throw new Error(`extensions/${extensionName} must include README.md with a short description.`);
  }

  const description = readFirstMarkdownParagraph(readFileSync(readmePath, "utf8"));
  if (!description) {
    throw new Error(`${relative(repoRoot, readmePath)} must include a short description paragraph.`);
  }

  if (description.length > 1024) {
    throw new Error(`${relative(repoRoot, readmePath)} description is ${description.length} characters; limit is 1024.`);
  }

  return description;
}

function readFirstMarkdownParagraph(markdown) {
  const paragraph = [];
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }

    if (trimmed.startsWith("#")) {
      continue;
    }

    paragraph.push(trimmed);
  }

  return paragraph
    .join(" ")
    .replace(/\*\*/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function readScalar(lines, key) {
  const index = lines.findIndex(line => line.startsWith(`${key}:`));
  if (index < 0) {
    return undefined;
  }

  const value = lines[index].slice(key.length + 1).trim();
  if (value === ">-" || value === ">" || value === "|") {
    const parts = [];
    for (let i = index + 1; i < lines.length; i++) {
      if (/^[A-Za-z0-9_-]+:/.test(lines[i])) {
        break;
      }

      if (lines[i].startsWith("  ")) {
        parts.push(lines[i].trim());
      }
    }

    return parts.join(" ").trim();
  }

  return value.replace(/^['"]|['"]$/g, "");
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function toManifestPath(path) {
  return path.split(sep).join("/");
}

function normalizeVersion(version) {
  return version.startsWith("v") || version.startsWith("V") ? version.slice(1) : version;
}

function parseBundleSelection(value) {
  if (value === undefined || value === "skills" || value === "extensions") {
    return value;
  }

  throw new Error(`Invalid --bundle value '${value}'. Expected 'skills' or 'extensions'. Omit --bundle to build both.`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument '${arg}'.`);
    }

    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for '${arg}'.`);
    }

    parsed[key] = value;
    i++;
  }

  return parsed;
}
