import { requireSourceOnly } from "../.github/skills/release/scripts/development.mjs";
import { Repository } from "../.github/skills/release/scripts/git.mjs";

try {
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/check-dev-tree.mjs");
  const repo = new Repository(process.cwd());
  requireSourceOnly(repo, repo.sha("HEAD"));
  console.log("Dev tree contains no OpenCode catalogs; published changelog history is allowed.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
