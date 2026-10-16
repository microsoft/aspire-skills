import { Repository } from "./release-git.mjs";
import { expectedCatalog, validateCatalog } from "./release-catalog.mjs";

try {
  if (process.argv.length !== 2) throw new Error("Usage: npm run catalog:check");
  const repo = new Repository(process.cwd());
  const head = repo.sha("HEAD");
  validateCatalog(repo, head, expectedCatalog(repo, head));
  console.log("Committed OpenCode V1 and V2 catalogs match the shipped skill files.");
} catch (error) {
  console.error(error.message);
  console.error("Run npm run catalog and commit opencode/ with the source changes.");
  process.exitCode = 1;
}
