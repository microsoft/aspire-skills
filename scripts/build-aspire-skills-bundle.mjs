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
const bundleName = `aspire-skills-v${version}`;
const bundleRoot = join(outputRoot, bundleName);
const archivePath = join(outputRoot, `${bundleName}.tgz`);
const skillsRoot = join(repoRoot, "skills");

const supports = {
  aspireCli: args["supports-aspire-cli"] ?? ">=13.4.0 <13.5.0",
  aspireSdk: args["supports-aspire-sdk"] ?? ">=13.4.0 <13.5.0"
};

rmSync(bundleRoot, { recursive: true, force: true });
rmSync(archivePath, { force: true });
mkdirSync(bundleRoot, { recursive: true });

const skills = listSkillDirectories(skillsRoot).map(skillDirectory => buildSkill(skillDirectory));

const manifest = {
  version,
  supports,
  skills
};

writeFileSync(join(bundleRoot, "skill-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const tarResult = spawnSync(
  "tar",
  ["-czf", archivePath, "-C", outputRoot, bundleName],
  { cwd: repoRoot, stdio: "inherit" }
);

if (tarResult.status !== 0) {
  throw new Error("Failed to create Aspire skills archive with tar.");
}

console.log(`Created ${relative(repoRoot, archivePath)}`);

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
  const targetRoot = join(bundleRoot, "skills", skillName);
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

function listSkillDirectories(root) {
  return listDirectories(root)
    .filter(directory => existsSync(join(root, directory, "SKILL.md")))
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
