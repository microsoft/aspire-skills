// Adapted from microsoft/aspire's Arcade-derived backport.yml at
// 6bcd0302e2fb4a6dea2b1c3eedb8ab1caa4bb75c (Arcade 66269f6a88f6062f2cccf6eb84660a8a6f5cc5ec).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Repository, fullSha } from "./release-git.mjs";
import { versionSnapshot } from "./release-versions.mjs";
import { validateCatalog, expectedCatalog } from "./release-catalog.mjs";
import { assertPublishedHistory, commitFiles, ensurePullRequest, githubRequest, guardedPush, releaseVersion, remoteHead } from "./release-automation.mjs";

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

export function runBackport(repo, { repository, number, target, automatic = false, api = githubRequest, downloadPatch }) {
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
  let directory;
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
      directory = mkdtempSync(join(tmpdir(), "aspire-backport-"));
      const patch = join(directory, "changes.patch");
      if (downloadPatch) {
        writeFileSync(patch, downloadPatch(pr));
      } else {
        const result = spawnSync("gh", ["pr", "diff", "--patch", String(number), "--repo", repository], {
          encoding: "utf8", maxBuffer: 64 * 1024 * 1024
        });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`Downloading backport patch failed: ${result.stderr}`);
        writeFileSync(patch, result.stdout);
      }
      repo.run(["am", "--3way", "--empty=keep", "--ignore-whitespace", "--keep-non-patch", patch]);
      const patched = repo.sha("HEAD");
      validateBackport(repo, targetTip, patched, source, target);
      let commit = patched;
      if (automatic) {
        validateCatalog(repo, source, expectedCatalog(repo, source));
        const entries = repo.files(source, ["opencode"]);
        const contents = repo.contents(entries.values());
        const files = new Map([...entries].map(([path, entry]) => [path, contents.get(entry.oid)]));
        commit = commitFiles(repo, patched, files, "Carry the released catalog snapshot without regeneration", { replace: ["opencode"] });
      }
      commit = commitFiles(repo, commit, new Map(),
        `Record backport of #${number} to ${target}\n\n${marker}`, { allowEmpty: true });
      if (remoteHead(repo, target) !== targetTip) throw new Error("The target advanced during patch application; retry.");
      guardedPush(repo, branch, commit, null);
    }
    return ensurePullRequest(api, repository, {
      branch, base: target, marker, title: `[${target}] ${pr.title}`,
      body: `Backport of #${number} to ${target}\n\n/cc @${pr.user.login}\n\n## Customer Impact\n\n## Testing\n\n## Risk\n\n## Regression?\n\nGenerated using Arcade's patch-copy flow. Conflicts require manual resolution.\n\nWorkflow: ${runUrl}`
    });
  } catch (error) {
    console.error(error.message);
    postComment(`Backporting to \`${target}\` failed. Please backport manually while preserving the target version, newer work, and changelog history. [Workflow output](${runUrl}).\n\n${error.message.slice(0, 10000)}`);
    throw error;
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
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
