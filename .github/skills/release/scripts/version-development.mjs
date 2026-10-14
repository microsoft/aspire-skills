import { Repository } from "./git.mjs";
import { prepareDevelopmentVersion } from "./prepare-development.mjs";

try {
  const [version, ...extra] = process.argv.slice(2);
  if (!version || extra.length) throw new Error("Usage: npm run version:dev -- <next-version>");
  const result = prepareDevelopmentVersion(new Repository(process.cwd()), version);
  console.log(`Staged ${result.branch} at ${result.version}. Review, test, commit, and open a PR to dev.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
