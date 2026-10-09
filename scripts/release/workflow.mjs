import { writeFileSync } from "node:fs";
import { fullSha } from "./git.mjs";
import { repositoryName } from "./github.mjs";
import { parseVersion } from "./versions.mjs";

function positiveNumber(value, label) {
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error(`${label} must be a positive decimal integer.`);
  }
  return text;
}

function remoteBranch(repo, branch) {
  repo.run(["check-ref-format", `refs/heads/${branch}`]);
  const result = repo.run(
    ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`],
    { statuses: [0, 2] }
  );
  return result.status === 0;
}

export function fetchReleaseRefs(repo, version) {
  parseVersion(version);
  const branch = `release/${version}`;
  repo.run(["check-ref-format", `refs/heads/${branch}`]);
  repo.run([
    "fetch", "--no-tags", "origin",
    "refs/heads/main:refs/remotes/origin/main",
    "refs/heads/dev:refs/remotes/origin/dev"
  ]);
  if (remoteBranch(repo, branch)) {
    repo.run([
      "fetch", "--no-tags", "origin",
      `refs/heads/${branch}:refs/remotes/origin/${branch}`
    ]);
  }
  return Object.freeze({ branch });
}

export function fetchReleaseNotesRefs(repo, number) {
  number = positiveNumber(number, "Release PR number");
  repo.run([
    "fetch", "--no-tags", "origin",
    "refs/heads/main:refs/remotes/origin/main",
    "refs/heads/dev:refs/remotes/origin/dev",
    `refs/pull/${number}/head:refs/remotes/origin/notes-pr`
  ]);
  return Object.freeze({ pull: number, head: repo.sha("origin/notes-pr") });
}

export function captureReleaseNotesBaseline(repo, options, environmentPath) {
  const repository = repositoryName();
  const head = fullSha(options.headCommit, "release PR head");
  const pull = positiveNumber(options.pull, "Release PR number");
  if (!environmentPath) throw new Error("GITHUB_ENV is required to capture the release PR baseline.");
  if (!options.headBranch?.startsWith("release/")) throw new Error("The changelog baseline requires a release PR branch.");
  repo.run(["check-ref-format", `refs/heads/${options.headBranch}`]);
  if (repo.sha("HEAD") !== head || repo.sha("origin/notes-pr") !== head) {
    throw new Error("The changelog baseline must match the validated, checked-out release PR head.");
  }
  const ref = "refs/remotes/origin/pr-head";
  repo.run(["update-ref", ref, head]);
  const values = {
    GH_AW_PR_HEAD_BASE_BRANCH: options.headBranch,
    GH_AW_PR_HEAD_BASE_SHA: head,
    GH_AW_PR_HEAD_BASE_REPO: repository,
    GH_AW_PR_HEAD_REPO: repository,
    GH_AW_PR_HEAD_BASE_PR_NUMBER: pull,
    GH_AW_PR_HEAD_BASE_REF: ref
  };
  writeFileSync(environmentPath, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""), { flag: "a" });
}

export function publicationPermissions(repo, base, candidate) {
  base = fullSha(base, "base commit");
  candidate = fullSha(candidate, "candidate commit");
  const changed = repo.run([
    "diff", "--quiet", base, candidate, "--", ".github/workflows"
  ], { statuses: [0, 1] }).status === 1;
  return Object.freeze(changed ? { workflows: "write" } : {});
}

export function fetchPublishedMain(repo) {
  repo.run(["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"]);
  return Object.freeze({ main: repo.sha("origin/main") });
}
