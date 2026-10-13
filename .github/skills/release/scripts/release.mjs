import { writeFileSync } from "node:fs";
import { Repository } from "./git.mjs";
import { checkPull, publishRelease, validatePublished } from "./candidates.mjs";
import { resolveReleasePull } from "./github.mjs";

const operations = new Set(["check", "validate-release", "publish-release"]);

try {
  const [operation, ...args] = process.argv.slice(2);
  if (!operations.has(operation) || args.length) {
    throw new Error(`Usage: node .github/skills/release/scripts/release.mjs <${[...operations].join("|")}>`);
  }
  if (!process.env.RELEASE_REPO) throw new Error("RELEASE_REPO is required.");
  const repo = new Repository(process.env.RELEASE_REPO);
  let result;
  if (operation === "check") {
    result = checkPull(repo, {
      target: process.env.TARGET_BRANCH, headBranch: process.env.HEAD_BRANCH || undefined,
      headCommit: process.env.HEAD_COMMIT, baseCommit: process.env.BASE_COMMIT
    });
  } else {
    repo.run([
      "fetch", "--no-tags", "origin",
      "refs/heads/main:refs/remotes/origin/main", "refs/heads/dev:refs/remotes/origin/dev"
    ]);
    const commit = repo.selected(process.env.RELEASE_COMMIT, "released_commit");
    const options = { pullNumber: process.env.PR_NUMBER, headCommit: process.env.RELEASE_HEAD };
    if (operation === "publish-release") {
      result = publishRelease(repo, commit, options);
    } else {
      const reviewed = resolveReleasePull(repo, commit, options);
      result = validatePublished(repo, commit, { headCommit: reviewed.head });
      repo.requireFirstParent(result.release, repo.sha("origin/main"));
    }
  }
  const outputs = Object.fromEntries(["version", "release", "tag", "url"]
    .filter(key => typeof result?.[key] === "string").map(key => [key, result[key]]));
  if (Object.values(outputs).some(value => /[\r\n]/.test(value))) {
    throw new Error("Release outputs must be single-line scalar strings.");
  }
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""), { flag: "a" });
  }
  console.log(`Release ${operation} completed${Object.keys(outputs).length ? `: ${JSON.stringify(outputs)}` : "."}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
