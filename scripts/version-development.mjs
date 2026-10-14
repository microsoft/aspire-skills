import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Repository } from "./release-git.mjs";
import { compareVersions, updateVersion, versionSnapshot } from "./release-versions.mjs";
import { buildCatalog } from "./build-opencode-catalog.mjs";

export function prepareDevelopmentVersion(repo, version) {
  if (repo.run(["status", "--porcelain"]).trim()) throw new Error("Version preparation requires a clean working tree and index.");
  const head = repo.sha("HEAD");
  const branch = repo.run(["branch", "--show-current"]).trim();
  const initialize = branch === `initialize-dev/${version}`;
  if (!initialize && branch !== `bump-dev/${version}`) throw new Error(`Use initialize-dev/${version} or bump-dev/${version}.`);
  if (head !== repo.sha("origin/dev")) throw new Error("Start the version branch at the current origin/dev tip.");
  if (initialize) {
    if (head !== repo.sha("origin/main")) throw new Error("Fast-forward dev to the approved bootstrap main before initialization.");
  }
  const snapshot = versionSnapshot(repo, head);
  if (compareVersions(version, snapshot.version) <= 0) throw new Error("The next development version must be greater than the current version.");
  for (const [path, contents] of snapshot.manifests) {
    writeFileSync(join(repo.root, ...path.split("/")), updateVersion(contents, path, version));
  }
  buildCatalog(repo.root);
  repo.run(["add", "--", ...snapshot.manifests.keys(), "opencode"]);
  return { branch, version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [version, ...rest] = process.argv.slice(2);
    if (!version || rest.length) throw new Error("Usage: npm run version:dev -- <next-version>");
    prepareDevelopmentVersion(new Repository(process.cwd()), version);
    console.log(`Staged development versions at ${version}; review and open a PR to dev.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
