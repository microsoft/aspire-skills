import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Repository } from "./release/git.mjs";
import {
  checkPull, prepareReleaseNotes, publishRelease, receiveCandidate,
  resolveStage, stageRelease, verifyCandidate
} from "./release/candidates.mjs";
import { authorizeRelease, publishCandidate } from "./release/github.mjs";
import { changelogEntry, commitLog, releaseNotes } from "./release/changelog.mjs";
import {
  captureReleaseNotesBaseline, fetchPublishedMain, fetchReleaseNotesRefs, fetchReleaseRefs, publicationPermissions
} from "./release/workflow.mjs";

const operations = new Set([
  "resolve-stage", "stage", "verify-stage", "receive-stage", "publish-stage",
  "check", "authorize", "prepare-notes", "publish-release",
  "generate-commit-log", "generate-notes", "fetch-stage", "publication-permissions"
]);

try {
  const [operation, ...args] = process.argv.slice(2);
  if (!operations.has(operation) || args.length) {
    throw new Error(`Usage: node scripts/release.mjs <${[...operations].join("|")}>`);
  }
  let repo;
  if (operation !== "authorize") {
    if (!process.env.RELEASE_REPO) throw new Error("RELEASE_REPO is required.");
    repo = new Repository(process.env.RELEASE_REPO);
  }
  const options = {
    sourceCommit: process.env.SOURCE_COMMIT || process.env.TO_SHA, baseCommit: process.env.BASE_COMMIT,
    releaseVersion: process.env.RELEASE_VERSION || process.env.NEW_VERSION,
    releaseWorkDir: process.env.RELEASE_WORK_DIR,
    candidateCommit: process.env.CANDIDATE_COMMIT, previousCommit: process.env.PREVIOUS_COMMIT
  };
  let result;
  if (operation === "authorize") {
    authorizeRelease();
  } else if (operation === "publish-release") {
    fetchPublishedMain(repo);
    result = publishRelease(repo, process.env.RELEASE_COMMIT);
  } else if (operation === "fetch-stage") {
    result = fetchReleaseRefs(repo, options.releaseVersion);
  } else if (operation === "publication-permissions") {
    result = publicationPermissions(repo, options.baseCommit, options.candidateCommit);
  } else if (operation === "resolve-stage") {
    result = resolveStage(repo, options);
  } else if (["generate-commit-log", "generate-notes"].includes(operation)) {
    result = resolveStage(repo, options);
    if (process.env.FROM_SHA !== result.from || (operation === "generate-notes" && process.env.BASE_VERSION !== result.baselineVersion)) {
      throw new Error("Release note inputs do not match the resolved changelog metadata.");
    }
    if (!options.releaseWorkDir) throw new Error("RELEASE_WORK_DIR is required.");
    mkdirSync(options.releaseWorkDir, { recursive: true });
    const path = join(options.releaseWorkDir, "commits.txt");
    if (operation === "generate-commit-log") {
      writeFileSync(path, commitLog(result));
    } else {
      if (readFileSync(path, "utf8") !== commitLog(result)) throw new Error("The commit log changed after its range was resolved.");
      writeFileSync(join(options.releaseWorkDir, "release_notes.md"), releaseNotes(repo, result));
      writeFileSync(join(options.releaseWorkDir, "changelog_entry.md"), `${changelogEntry(result)}\n`);
    }
  } else if (operation === "stage") {
    result = stageRelease(repo, options);
  } else if (operation === "prepare-notes") {
    const refs = fetchReleaseNotesRefs(repo, process.env.PR_NUMBER);
    if (!process.env.RELEASE_NOTES_PATH) throw new Error("RELEASE_NOTES_PATH is required.");
    mkdirSync(dirname(process.env.RELEASE_NOTES_PATH), { recursive: true });
    result = prepareReleaseNotes(repo, {
      headBranch: process.env.HEAD_BRANCH, headCommit: process.env.HEAD_COMMIT
    }, process.env.RELEASE_NOTES_PATH);
    if (process.env.GITHUB_ENV) {
      captureReleaseNotesBaseline(repo, {
        headBranch: process.env.HEAD_BRANCH, headCommit: process.env.HEAD_COMMIT, pull: refs.pull
      }, process.env.GITHUB_ENV);
    }
  } else if (operation === "receive-stage") {
    result = receiveCandidate(repo, options, process.env.BUNDLE_PATH, process.env.SUMMARY_PATH);
  } else if (operation === "verify-stage" || operation === "publish-stage") {
    if (operation === "publish-stage") {
      repo.run([
        "fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main",
        "refs/heads/dev:refs/remotes/origin/dev"
      ]);
    }
    result = verifyCandidate(repo, options, process.env.BUNDLE_PATH, process.env.SUMMARY_PATH);
    if (operation === "publish-stage") await publishCandidate(repo, result, process.env.SUMMARY_PATH);
  } else if (operation === "check") {
    result = checkPull(repo, {
      target: process.env.TARGET_BRANCH, headBranch: process.env.HEAD_BRANCH || undefined,
      headCommit: process.env.HEAD_COMMIT, baseCommit: process.env.BASE_COMMIT
    });
  }
  const outputs = Object.fromEntries([
    "from", "source", "base", "version", "candidate", "previous", "branch", "release",
    "notesState", "tag", "url", "workflows", "main", "pull", "head"
  ].filter(key => typeof result?.[key] === "string").map(key => [key, result[key]]));
  if (result?.from) outputs.from_sha = result.from;
  if (result?.source) outputs.to_sha = result.source;
  if (result?.baselineVersion) outputs.base_version = result.baselineVersion;
  if (result?.changes) outputs.commit_count = String(result.changes.length);
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
