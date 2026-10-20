import { Repository } from "./release-git.mjs";
import { expectedCatalog, validateCatalog } from "./release-catalog.mjs";

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== "--source-only")) {
    throw new Error("Usage: npm run catalog:check -- [--source-only]");
  }
  const repo = new Repository(process.cwd());
  const head = repo.sha("HEAD");
  const expected = expectedCatalog(repo, head);
  if (args[0] === "--source-only") {
    console.log("Committed skill source generates valid OpenCode V1 and V2 catalogs.");
  } else {
    validateCatalog(repo, head, expected);
    console.log("Committed OpenCode V1 and V2 catalogs match the shipped skill files.");
  }
} catch (error) {
  console.error(error.message);
  console.error("Source PRs need no generated files. Release candidates must refresh their catalog snapshot.");
  process.exitCode = 1;
}
