import { isUtf8 } from "node:buffer";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Repository } from "./release-git.mjs";
import { compareVersions, updateVersion, versionSnapshot } from "./release-versions.mjs";

export function developmentVersionFiles(repo, head, version) {
  const snapshot = versionSnapshot(repo, head);
  if (compareVersions(version, snapshot.version) <= 0) throw new Error("The next development version must be greater than the current version.");
  const contents = repo.read(head, "CHANGELOG.md");
  if (!isUtf8(contents)) throw new Error("CHANGELOG.md must be UTF-8.");
  const previous = contents.toString("utf8");
  const start = previous.search(/^## /m);
  const url = "https://github.com/microsoft/aspire-skills/releases/tag/v";
  if (start < 0 || previous.slice(start).split(/\r?\n/, 1)[0] !== `## [${snapshot.version}](${url}${snapshot.version})`) {
    throw new Error("The newest changelog heading must match the current version and tag.");
  }
  const newline = previous.match(/\r?\n/)?.[0] ?? "\n";
  const changelog = previous.slice(0, start)
    + `## [${version}](${url}${version})${newline}${newline}` + previous.slice(start);
  const files = new Map([...snapshot.manifests].map(([path, bytes]) => [path, updateVersion(bytes, path, version)]));
  files.set("CHANGELOG.md", Buffer.from(changelog));
  return { files, originals: new Map([...snapshot.manifests, ["CHANGELOG.md", contents]]) };
}

export function prepareDevelopmentVersion(repo, version) {
  if (repo.run(["status", "--porcelain"]).trim()) throw new Error("Version preparation requires a clean working tree and index.");
  const { files, originals } = developmentVersionFiles(repo, repo.sha("HEAD"), version);
  try {
    for (const [path, contents] of files) {
      writeFileSync(join(repo.root, ...path.split("/")), contents);
    }
  } catch (error) {
    for (const [path, original] of originals) writeFileSync(join(repo.root, ...path.split("/")), original);
    throw error;
  }
  repo.run(["add", "--", ...files.keys()]);
  return { version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [version, ...rest] = process.argv.slice(2);
    if (!version || rest.length) throw new Error("Usage: npm run version:dev -- <next-version>");
    prepareDevelopmentVersion(new Repository(process.cwd()), version);
    console.log(`Staged version ${version} and its changelog heading; catalogs are unchanged. Review and open a PR to dev.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
