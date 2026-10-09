import { spawnSync } from "node:child_process";
import timers from "node:timers/promises";
import { fullSha } from "./git.mjs";

export const releaseLabel = "aspire-skills-release";

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

function openPullRequests(repository, base) {
  return api(`repos/${repository}/pulls?state=open&base=${base}&per_page=100`, { pages: true });
}

function remoteHead(repo, branch) {
  repo.run(["check-ref-format", `refs/heads/${branch}`]);
  const lines = repo.run(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]).trim().split("\n").filter(Boolean);
  if (!lines.length) return "";
  if (lines.length !== 1 || !/^[0-9a-f]{40}\trefs\/heads\//.test(lines[0])) {
    throw new Error(`Unexpected remote branch response for ${branch}.`);
  }

  return lines[0].split("\t")[0];
}

export function authorizeRelease() {
  const repository = repositoryName();
  const actors = [process.env.GITHUB_ACTOR, process.env.GITHUB_TRIGGERING_ACTOR];
  if (actors.some(actor => !actor)) throw new Error("Both release actors must be present.");
  for (const actor of new Set(actors)) {
    const result = api(`repos/${repository}/collaborators/${encodeURIComponent(actor)}/permission`);
    if (!["write", "maintain", "admin"].includes(result.permission)) {
      throw new Error(`Release actor ${actor} requires write, maintain, or admin permission.`);
    }
  }
}

function positiveNumber(value, label) {
  const number = String(value);
  if (number !== number.trim() || !/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number))) {
    throw new Error(`${label} must be a positive decimal integer.`);
  }
  return number;
}

export async function publishCandidate(repo, result, summaryPath) {
  const repository = requireRepositoryOrigin(repo);
  const existing = remoteHead(repo, result.branch);
  if (existing !== result.previous) {
    throw new Error("The publication branch changed. Rerun without overwriting it.");
  }
  const target = "main";
  const open = openPullRequests(repository, target);
  if (open.some(pr => pr.head?.ref?.startsWith("release/")
    && pr.head.repo?.full_name === repository && pr.head.ref !== result.branch)) {
    throw new Error("A different release cycle is already open.");
  }
  const matches = open.filter(pr =>
    pr.head?.ref === result.branch && pr.head?.repo?.full_name === repository);
  if (matches.length > 1) throw new Error("More than one PR uses the publication branch.");
  const pr = matches[0];
  if (existing && !pr) {
    const prior = api(
      `repos/${repository}/pulls?state=closed&head=${repository.split("/")[0]}:${encodeURIComponent(result.branch)}&per_page=100`,
      { pages: true }
    ).filter(pr => pr.head?.ref === result.branch && pr.head?.repo?.full_name === repository);
    if (prior.length) throw new Error("The publication branch belongs to a closed PR. Resolve it explicitly before rerunning.");
  }
  if (!process.env.GH_TOKEN) throw new Error("Publication requires a short-lived GitHub App token.");
  if (existing !== result.candidate) {
    if (existing) repo.requireAncestor(existing, result.candidate);
    repo.run([
      "-c", "credential.helper=",
      "-c", "credential.https://github.com.helper=!gh auth git-credential",
      "-c", "push.followTags=false",
      "push", "origin", `${result.candidateRef}:refs/heads/${result.branch}`
    ]);
  }
  let number = pr?.number;
  if (pr) {
    console.log(`Verified existing ${pr.draft ? "draft" : "ready"} PR #${pr.number} at ${result.candidate}.`);
    if (pr.body !== result.summary) {
      gh(["api", "--method", "PATCH", `repos/${repository}/pulls/${pr.number}`, "--input", "-"],
        JSON.stringify({ body: result.summary }));
    }
  } else {
    const url = gh([
      "pr", "create", "--repo", repository, "--draft", "--base", target,
      "--head", result.branch, "--title", `Release v${result.version}`,
      "--body-file", summaryPath
    ]).trim();
    const prefix = `${repositoryUrl(repository)}/pull/`;
    if (!url.startsWith(prefix)) throw new Error("GitHub did not return a PR in the selected repository.");
    number = Number(positiveNumber(url.slice(prefix.length), "Created release PR number"));
  }
  if (result.notesState === "pending") {
    await triggerReleaseChangelog(repository, number, result);
  }
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

export function publishSourceRelease(repo, result) {
  const repository = requireRepositoryOrigin(repo);
  if (!process.env.GH_TOKEN) throw new Error("Source release publication requires a GitHub token.");
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
    const notes = readReleaseNotes(repo, result);
    const created = gh([
      "release", "create", tag, "--repo", repository, "--verify-tag", "--target", result.release,
      "--title", tag, "--notes-file", "-", ...(result.version.split("+")[0].includes("-") ? ["--prerelease"] : [])
    ], notes).trim();
    if (decodeURI(created) !== url) throw new Error("GitHub did not return the created source release URL.");
  }
  console.log(`Verified source release ${tag} at main merge ${result.release}: ${url}`);
  return Object.freeze({ ...result, tag, url });
}

function readReleaseNotes(repo, result) {
  const changelog = repo.read(result.release, "CHANGELOG.md").toString("utf8");
  const entry = changelog.slice(changelog.search(/^## /m)).split(/\r?\n## /)[0];
  return `${entry.split(/\r?\n/).slice(1).filter(line => !line.startsWith("<!-- aspire-skills-")).join("\n").trim()}\n`;
}

async function triggerReleaseChangelog(repository, number, result) {
  positiveNumber(number, "Release PR number");
  let pr;
  for (let attempt = 0; attempt < 5; attempt++) {
    pr = api(`repos/${repository}/pulls/${number}`);
    if (pr.head?.sha === result.candidate) break;
    if (attempt < 4) await timers.setTimeout(2_000);
  }
  if (pr.number !== number || pr.state !== "open" || pr.base?.ref !== "main"
    || pr.base?.repo?.full_name !== repository || pr.head?.ref !== result.branch
    || pr.head?.repo?.full_name !== repository || pr.head?.sha !== result.candidate
    || !Array.isArray(pr.labels)) {
    throw new Error("The release PR changed before changelog generation could be triggered. Recheck it before retrying.");
  }
  gh([
    "label", "create", releaseLabel, "--repo", repository, "--color", "BFD4F2",
    "--description", "Prepared source release; triggers its user-facing changelog.", "--force"
  ]);
  if (pr.labels.some(label => label.name === releaseLabel)) {
    gh(["api", "--method", "DELETE", `repos/${repository}/issues/${number}/labels/${releaseLabel}`]);
  }
  const labels = JSON.parse(gh([
    "api", "--method", "POST", `repos/${repository}/issues/${number}/labels`, "--input", "-"
  ], JSON.stringify({ labels: [releaseLabel] })));
  if (!Array.isArray(labels) || !labels.some(label => label.name === releaseLabel)) {
    throw new Error("GitHub did not confirm the changelog trigger label.");
  }
  console.log(`Triggered agentic changelog generation for release PR #${number} at ${result.candidate}.`);
}
