import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Repository } from "./release-git.mjs";

export function requireSourceOnly(repo, sha) {
  const paths = [...repo.files(sha, ["opencode"]).keys()];
  if (paths.length) throw new Error(`Dev must not contain OpenCode catalogs:\n${paths.join("\n")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("Usage: node scripts/check-dev-tree.mjs");
    const repo = new Repository(process.cwd());
    requireSourceOnly(repo, repo.sha("HEAD"));
    console.log("Dev tree contains no OpenCode catalogs; published changelog history is allowed.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
