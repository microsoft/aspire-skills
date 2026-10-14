import { Repository } from "./git.mjs";
import { publishedBaseline } from "./changelog.mjs";
import { requireSourceOnly } from "./development.mjs";
import { compareVersions, versionSnapshot, versionTree } from "./versions.mjs";

export function prepareDevelopmentVersion(repo, version) {
  if (repo.run(["status", "--porcelain"]).trim()) {
    throw new Error("Development version preparation requires a clean working tree and index.");
  }
  const head = repo.sha("HEAD");
  const branch = repo.run(["branch", "--show-current"]).trim();
  const initialize = branch === `initialize-dev/${version}`;
  if (!initialize && branch !== `bump-dev/${version}`) {
    throw new Error(`Use initialize-dev/${version} or bump-dev/${version}.`);
  }
  if (head !== repo.sha("origin/dev")) {
    throw new Error("Start the version branch at the current origin/dev tip.");
  }
  if (initialize) {
    const main = repo.sha("origin/main");
    if (head !== main) throw new Error("Fast-forward dev to the approved bootstrap main before initialization.");
    publishedBaseline(repo, main);
  } else {
    requireSourceOnly(repo, head);
  }
  if (compareVersions(version, versionSnapshot(repo, head).version) <= 0) {
    throw new Error("The next development version must be greater than the current version.");
  }
  let tree = versionTree(repo, head, version);
  if (initialize) {
    tree = repo.withIndex(indexFile => {
      repo.run(["read-tree", tree], { indexFile });
      for (const path of repo.files(tree, ["opencode"]).keys()) {
        repo.run(["update-index", "--force-remove", "--", path], { indexFile });
      }
      return repo.run(["write-tree"], { indexFile }).trim();
    });
  }
  const patch = repo.run([
    "diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", head, tree, "--"
  ], { binary: true });
  repo.run(["apply", "--index", "--binary"], { input: patch });
  return { branch, version };
}
