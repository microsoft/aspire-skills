import { Repository } from "./git.mjs";
import { prepareLocalRelease } from "./candidates.mjs";
import { releaseMessage } from "./changelog.mjs";
import { repositoryName } from "./github.mjs";

try {
  const [releaseVersion, sourceCommit, remote, ...extra] = process.argv.slice(2);
  if (!releaseVersion || !sourceCommit || !remote || extra.length) {
    throw new Error("Usage: npm run release -- <version> <full-dev-sha> <target-remote>");
  }
  const repo = new Repository(process.cwd());
  if (remote.startsWith("-") || !repo.run(["remote"]).trim().split(/\r?\n/).includes(remote)) {
    throw new Error("The target remote must name an existing Git remote.");
  }
  repo.run(["check-ref-format", `refs/remotes/${remote}/main`]);
  const url = repo.run(["remote", "get-url", remote]).trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!match) throw new Error("Release preparation requires a GitHub target remote.");
  if (process.env.GITHUB_REPOSITORY && repositoryName() !== match[1]) {
    throw new Error("GITHUB_REPOSITORY does not match the target remote.");
  }
  process.env.GITHUB_REPOSITORY = match[1];
  repositoryName();
  repo.run([
    "fetch", "--no-tags", remote,
    `refs/heads/main:refs/remotes/${remote}/main`,
    `refs/heads/dev:refs/remotes/${remote}/dev`
  ]);
  const result = prepareLocalRelease(repo, { releaseVersion, sourceCommit, remote });
  const message = releaseMessage(result);
  console.log(`Prepared ${result.branch} from main ${result.base} using dev ${result.source}.`);
  console.log("Continue the release skill to generate notes, validate, and open the PR. Commit with:\n");
  console.log(`${message.title}\n\n${message.body}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
