// Adapted from microsoft/aspire's Arcade-derived backport.yml at
// 6bcd0302e2fb4a6dea2b1c3eedb8ab1caa4bb75c (Arcade 66269f6a88f6062f2cccf6eb84660a8a6f5cc5ec).
// Unlike Arcade, this builds the patch locally instead of downloading GitHub's PR patch.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Repository, fullSha } from "./release-git.mjs";
import { updateVersion, versionManifests, versionSnapshot } from "./release-versions.mjs";
import { expectedCatalog } from "./release-catalog.mjs";
import { assertPublishedHistory, commitFiles, ensurePullRequest, githubRequest, guardedPush, mergeChangelogs, releaseSources, releaseVersion, remoteHead } from "./release-automation.mjs";

export function validateBackport(repo, before, after, source, target) {
  const original = versionSnapshot(repo, before);
  if (versionSnapshot(repo, after).version !== original.version) {
    throw new Error("The patch changes the target's coordinated version. Resolve manually without changing its version.");
  }
  if (target === "dev") {
    const heading = `## [${original.version}](https://github.com/microsoft/aspire-skills/releases/tag/v${original.version})`;
    const currentEntry = sha => {
      const text = repo.read(sha, "CHANGELOG.md").toString("utf8").replaceAll("\r\n", "\n");
      const start = text.indexOf(`${heading}\n`);
      if (start < 0 || text.search(/^## /m) !== start) throw new Error("Dev's current changelog heading must be preserved.");
      return text.slice(start).split(/(?=^## )/m)[0].trimEnd();
    };
    if (currentEntry(before) !== currentEntry(after)) throw new Error("The patch changes dev's current changelog notes; resolve manually.");
    assertPublishedHistory(repo, after, source);
  }
}

function isAncestor(repo, ancestor, descendant) {
  try {
    repo.run(["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

function fetchHead(repo, number, head) {
  try {
    repo.run(["cat-file", "-e", `${head}^{commit}`]);
  } catch {
    // Merged PR branches may be deleted or live in forks, but GitHub keeps refs/pull/N/head.
    repo.run(["fetch", "--no-tags", "origin", `refs/pull/${number}/head`]);
    repo.run(["cat-file", "-e", `${head}^{commit}`]);
  }
}

// GitHub diffs a release PR against main, which spans all dev work since the last release.
// Diff from the recorded dev source instead.
function patchBase(repo, head, source, targetTip) {
  const recorded = releaseSources(repo.run(["log", "--format=%B%x00", head, "--not", targetTip, `${source}^1`]));
  if (recorded.size > 1) throw new Error("The source PR records more than one release source; backport manually.");
  if (recorded.size === 1) {
    const [base] = recorded;
    if (!isAncestor(repo, base, head) || !isAncestor(repo, base, targetTip)) {
      throw new Error("The source PR and target do not share the recorded release source; backport manually.");
    }
    return base;
  }
  return fullSha(repo.run(["merge-base", head, `${source}^1`]).trim());
}

// Both sides use the target's version so the patch carries manifest content changes without version changes.
function normalizedTree(repo, sha, version) {
  const files = new Map();
  for (const [path, bytes] of versionManifests(repo, sha)) {
    const updated = updateVersion(bytes, path, version);
    if (updated !== bytes) files.set(path, updated);
  }
  return repo.run(["rev-parse", `${commitFiles(repo, sha, files, "Normalize versions for backport")}^{tree}`]).trim();
}

function backportPatch(repo, pr, base, head, version) {
  const parentTree = normalizedTree(repo, base, version);
  const tree = normalizedTree(repo, head, version);
  if (tree === parentTree) return null;
  const parent = fullSha(repo.run(["commit-tree", parentTree], { input: "Backport base\n" }).trim());
  const author = {
    GIT_AUTHOR_NAME: pr.user.login,
    GIT_AUTHOR_EMAIL: `${pr.user.id}+${pr.user.login}@users.noreply.github.com`
  };
  const commit = fullSha(repo.run(["commit-tree", tree, "-p", parent], {
    input: `${pr.title}\n\nBackport of #${pr.number}.\n`, env: author
  }).trim());
  return repo.run(["format-patch", "--stdout", "--binary", "-1", commit], { binary: true });
}

export function runBackport(repo, { repository, number, target, automatic = false, api = githubRequest }) {
  if (!/^[1-9]\d*$/.test(String(number))) throw new Error("Source PR must be a positive integer.");
  if (automatic ? target !== "dev" : !target.startsWith("release/")) throw new Error("Invalid backport target.");
  if (!automatic) releaseVersion(target);
  const pr = api(`repos/${repository}/pulls/${number}`);
  const expectedBase = automatic ? "main" : "dev";
  if (!pr.merged || pr.base.ref !== expectedBase || pr.base.repo.full_name !== repository) {
    throw new Error(`Source PR must be merged into this repository's ${expectedBase}.`);
  }
  const source = fullSha(pr.merge_commit_sha);
  const marker = `<!-- Aspire-Backport: ${number}:${target}:${source} -->`;
  const branch = `backport/pr-${number}-to-${target}`;
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`;
  const postComment = body => api(`repos/${repository}/issues/${number}/comments`, { method: "POST", body: { body } });
  try {
    const targetTip = remoteHead(repo, target);
    if (!targetTip) throw new Error(`The specified target branch "${target}" was not found.`);
    repo.run(["fetch", "--no-tags", "origin", targetTip, source]);
    const previous = remoteHead(repo, branch);
    if (previous) {
      repo.run(["fetch", "--no-tags", "origin", previous]);
      if (!repo.run(["log", "--format=%B%x00", previous, "--not", targetTip]).includes(marker)) {
        throw new Error("Existing backport branch belongs to another operation; resolve manually.");
      }
    } else {
      postComment(`Started backporting to \`${target}\` ([link to workflow run](${runUrl})).`);
      if (repo.run(["status", "--porcelain"]).trim()) throw new Error("Backport requires a clean working tree.");
      repo.run(["checkout", "--detach", targetTip]);
      const head = fullSha(pr.head.sha);
      fetchHead(repo, number, head);
      const patch = backportPatch(repo, pr, patchBase(repo, head, source, targetTip), head, versionSnapshot(repo, targetTip).version);
      // Generated catalogs are rebuilt for the target instead of patched.
      const applyArgs = ["am", "--3way", "--empty=keep", "--ignore-whitespace", "--keep-non-patch", "--exclude=opencode/*"];
      let mergedChangelog;
      if (automatic) {
        // Release snapshots must not replace dev's changelog entry.
        mergedChangelog = mergeChangelogs(
          repo.read(targetTip, "CHANGELOG.md").toString("utf8"),
          repo.read(source, "CHANGELOG.md").toString("utf8")
        );
        applyArgs.push("--exclude=CHANGELOG.md");
      }
      if (patch) repo.run(applyArgs, { input: patch });
      let patched = repo.sha("HEAD");
      if (mergedChangelog) {
        patched = commitFiles(repo, patched, new Map([["CHANGELOG.md", mergedChangelog]]), "Merge approved release notes into dev");
      }
      validateBackport(repo, targetTip, patched, source, target);
      let commit = commitFiles(repo, patched, expectedCatalog(repo, patched), "Regenerate catalogs", { replace: ["opencode"] });
      commit = commitFiles(repo, commit, new Map(),
        `Record backport of #${number} to ${target}\n\n${marker}`, { allowEmpty: true });
      if (remoteHead(repo, target) !== targetTip) throw new Error("The target advanced during patch application; retry.");
      guardedPush(repo, branch, commit, null);
    }
    return ensurePullRequest(api, repository, {
      branch, base: target, marker, title: `[${target}] ${pr.title}`,
      body: `Backport of #${number} to ${target}\n\n/cc @${pr.user.login}\n\n## Customer Impact\n\n## Testing\n\n## Risk\n\n## Regression?\n\nGenerated using Arcade's patch-copy flow with a locally built patch. Conflicts require manual resolution.\n\nWorkflow: ${runUrl}`
    });
  } catch (error) {
    console.error(error.message);
    try {
      postComment(`Backporting to \`${target}\` failed. Please backport manually while preserving the target version, newer work, and changelog history. [Workflow output](${runUrl}).\n\n${error.message.slice(0, 10000)}`);
    } catch (commentError) {
      console.error(`Failed to post the failure comment: ${commentError.message}`);
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [number, target, mode, ...rest] = process.argv.slice(2);
    if (rest.length || !["manual", "automatic"].includes(mode)) throw new Error("Usage: backport.mjs <PR> <target> <manual|automatic>");
    const result = runBackport(new Repository(process.cwd()), {
      repository: process.env.GITHUB_REPOSITORY, number, target, automatic: mode === "automatic"
    });
    console.log(result.html_url);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
