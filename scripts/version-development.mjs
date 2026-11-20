import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Repository } from "./release-git.mjs";
import { compareVersions, updateVersion, versionSnapshot } from "./release-versions.mjs";
import { buildCatalog } from "./build-opencode-catalog.mjs";
import { Changelog } from "./release-changelog.mjs";

export function developmentVersionFiles(repo, head, version) {
  const snapshot = versionSnapshot(repo, head);
  if (compareVersions(version, snapshot.version) <= 0) throw new Error("The next development version must be greater than the current version.");
  const changelog = Changelog.read(repo, head);
  if (changelog.newest !== snapshot.version) {
    throw new Error("The newest changelog heading must match the current version and tag.");
  }
  const files = new Map([...snapshot.manifests].map(([path, bytes]) => [path, updateVersion(bytes, path, version)]));
  files.set("CHANGELOG.md", changelog.withNewSection(version).toBuffer());
  return Object.freeze({
    files, originals: new Map([...snapshot.manifests, ["CHANGELOG.md", repo.read(head, "CHANGELOG.md")]])
  });
}

export function prepareDevelopmentVersion(repo, version) {
  if (repo.run(["status", "--porcelain"]).trim()) throw new Error("Version preparation requires a clean working tree and index.");
  const { files, originals } = developmentVersionFiles(repo, repo.sha("HEAD"), version);
  try {
    for (const [path, contents] of files) {
      writeFileSync(join(repo.root, ...path.split("/")), contents);
    }
    buildCatalog(repo.root);
  } catch (error) {
    for (const [path, original] of originals) writeFileSync(join(repo.root, ...path.split("/")), original);
    throw error;
  }
  repo.run(["add", "--", ...files.keys(), "opencode"]);
  return { version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [version, ...rest] = process.argv.slice(2);
    if (!version || rest.length) throw new Error("Usage: npm run version:dev -- <next-version>");
    prepareDevelopmentVersion(new Repository(process.cwd()), version);
    console.log(`Staged version ${version}, its changelog heading, and catalogs; review and open a PR to dev.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
