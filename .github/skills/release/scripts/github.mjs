import { spawnSync } from "node:child_process";
import { latestRelease, readChangelog } from "./changelog.mjs";
import { fullSha } from "./git.mjs";

export function repositoryName() {
  const repository = process.env.GITHUB_REPOSITORY ?? "microsoft/aspire-skills";
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository)
    || [".", ".."].includes(repository.split("/")[1])) {
    throw new Error("GITHUB_REPOSITORY must identify one GitHub repository as owner/name.");
  }
  return repository;
}

export function repositoryUrl(repository = repositoryName()) {
  return `https://github.com/${repository}`;
}

function gh(args, input) {
  const result = spawnSync("gh", args, {
    encoding: "utf8", input, timeout: 60_000, maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`GitHub request failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function api(path, { pages = false } = {}) {
  const args = ["api", path];
  if (pages) args.push("--paginate", "--slurp");
  const response = JSON.parse(gh(args));
  if (!pages) return response;
  if (!Array.isArray(response) || response.some(page => !Array.isArray(page))) {
    throw new Error("Expected paginated GitHub array responses.");
  }
  return response.flat();
}

function positiveNumber(value, label) {
  const number = String(value);
  if (number !== number.trim() || !/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number))) {
    throw new Error(`${label} must be a positive decimal integer.`);
  }
  return number;
}

function requireRepositoryOrigin(repo) {
  const repository = repositoryName();
  const expected = repositoryUrl(repository).toLowerCase();
  for (const flags of [[], ["--push"]]) {
    const urls = repo.run(["remote", "get-url", ...flags, "--all", "origin"]).trim().split(/\r?\n/);
    if (urls.length !== 1 || urls[0].replace(/\.git$/i, "").toLowerCase() !== expected) {
      throw new Error(`Publication requires an HTTPS fetch and push origin matching ${repository}.`);
    }
  }
  return repository;
}

export function resolveReleasePull(repo, release, { pullNumber, headCommit } = {}) {
  const repository = requireRepositoryOrigin(repo);
  release = fullSha(release, "published squash commit");
  const branch = `release/${latestRelease(readChangelog(repo, release)).version}`;
  if (headCommit !== undefined) headCommit = fullSha(headCommit, "reviewed release head");
  const matchesRelease = pull => pull.state === "closed" && pull.merge_commit_sha === release
    && pull.base?.ref === "main" && pull.base?.repo?.full_name === repository
    && pull.head?.ref === branch && pull.head?.repo?.full_name === repository;
  if (pullNumber === undefined) {
    const matches = api(`repos/${repository}/commits/${release}/pulls?per_page=100`, { pages: true })
      .filter(pull => pull.merged_at && matchesRelease(pull));
    if (matches.length !== 1) throw new Error("The published commit must identify exactly one merged release PR.");
    pullNumber = matches[0].number;
  }
  const number = positiveNumber(pullNumber, "Release PR number");
  const pull = api(`repos/${repository}/pulls/${number}`);
  if (String(pull.number) !== number || !pull.merged || !matchesRelease(pull)
    || (headCommit !== undefined && pull.head.sha !== headCommit)) {
    throw new Error("The merged release PR does not match the published commit and reviewed head.");
  }
  const head = fullSha(pull.head.sha, "reviewed release head");
  repo.run([
    "fetch", "--no-tags", "origin",
    `+refs/pull/${number}/head:refs/remotes/origin/published-pr`
  ]);
  if (repo.sha("origin/published-pr") !== head) throw new Error("The reviewed release PR head changed.");
  return Object.freeze({ pull: number, head });
}

export function publishSourceRelease(repo, result) {
  const repository = requireRepositoryOrigin(repo);
  if (!process.env.GH_TOKEN) throw new Error("Release publication requires a GitHub token.");
  const tag = `v${result.version}`;
  const ref = `refs/tags/${tag}`;
  repo.run(["check-ref-format", ref]);
  const rows = repo.run(["ls-remote", "--tags", "origin", ref, `${ref}^{}`]).trim().split(/\r?\n/).filter(Boolean);
  const refs = new Map(rows.map(row => {
    const [sha, name] = row.split("\t");
    if (![ref, `${ref}^{}`].includes(name)) throw new Error("Unexpected release tag response.");
    return [name, fullSha(sha, "release tag")];
  }));
  if (refs.size !== rows.length || refs.size > 2 || (refs.size && !refs.has(ref))) {
    throw new Error("Unexpected release tag response.");
  }
  if (refs.size) {
    if ((refs.get(`${ref}^{}`) || refs.get(ref)) !== result.release) {
      throw new Error(`${tag} already points to a different commit; release tags must not be rewritten.`);
    }
  } else {
    if (repo.hasRef(ref)) {
      if (repo.sha(ref) !== result.release) throw new Error(`Local ${tag} points to a different commit.`);
    } else {
      repo.run(["tag", "--annotate", "--no-sign", "--message", `Aspire skills ${tag}`, tag, result.release]);
    }
    repo.run([
      "-c", "credential.helper=", "-c", "credential.https://github.com.helper=!gh auth git-credential",
      "-c", "push.followTags=false",
      "push", "origin", ref
    ]);
  }
  const releases = api(`repos/${repository}/releases?per_page=100`, { pages: true })
    .filter(release => release.tag_name === tag);
  if (releases.length > 1) throw new Error(`More than one GitHub release uses ${tag}.`);
  if (releases[0]?.draft) throw new Error(`${tag} already belongs to a draft GitHub release; publish it explicitly.`);
  const url = `${repositoryUrl(repository)}/releases/tag/${tag}`;
  if (!releases.length) {
    const changelog = readChangelog(repo, result.release);
    const entry = changelog.slice(changelog.search(/^## /m)).split(/\r?\n## /)[0];
    const notes = `${entry.split(/\r?\n/).slice(1).filter(line => !line.startsWith("<!-- aspire-skills-")).join("\n").trim()}\n`;
    const created = gh([
      "release", "create", tag, "--repo", repository, "--verify-tag", "--target", result.release,
      "--title", tag, "--notes-file", "-", ...(result.version.split("+")[0].includes("-") ? ["--prerelease"] : [])
    ], notes).trim();
    if (decodeURI(created) !== url) throw new Error("GitHub did not return the created release URL.");
  }
  console.log(`Verified release ${tag} at main squash ${result.release}: ${url}`);
  return Object.freeze({ ...result, tag, url });
}
