import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { Repository } from "../scripts/release-git.mjs";
import { expectedCatalog, validateCatalog } from "../scripts/release-catalog.mjs";
import { developmentVersionFiles } from "../scripts/version-development.mjs";
import { versionSnapshot } from "../scripts/release-versions.mjs";
import { commitFiles, ensurePullRequest, guardedPush, prepareRelease, publishDevelopment, refreshRelease, releaseFiles, remoteHead, validateRelease } from "../scripts/release-automation.mjs";
import { runBackport, validateBackport } from "../scripts/backport.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "aspire-release-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  const root = join(directory, "source");
  const remote = join(directory, "origin.git");
  for (const args of [["init", "--quiet", "--initial-branch=main", root], ["init", "--quiet", "--bare", remote]]) {
    const result = spawnSync("git", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const repo = new Repository(root);
  repo.run(["remote", "add", "origin", remote]);
  const write = (path, bytes) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  for (const path of ["package.json", ".plugin/plugin.json", ".claude-plugin/plugin.json", "gemini-extension.json"]) {
    write(path, '{"version":"0.0.3","description":"Preserve non-version metadata."}\n');
  }
  write("package-lock.json", '{"version":"0.0.3","packages":{"":{"version":"0.0.3"}}}\n');
  for (const path of [".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json"]) {
    write(path, '{"plugins":[{"name":"other","version":"9.0.0"},{"name":"aspire","version":"0.0.3"}]}\n');
  }
  write("skills/aspire/SKILL.md", "---\nname: aspire\nmetadata:\n  version: 0.0.3\n---\n\n# Aspire\n");
  write("skills/aspire/links.md", "[Other](../other/SKILL.md)\n");
  write("skills/other/SKILL.md", "---\nname: other\nmetadata:\n  version: 0.0.3\n---\n\n# Other\n");
  write("CHANGELOG.md", "# Changelog\n\n## [0.0.3](https://github.com/microsoft/aspire-skills/releases/tag/v0.0.3)\n\nApproved notes.\n");
  repo.run(["add", "--all"]);
  repo.run(["commit", "--quiet", "-m", "Initial stable source"]);
  const initial = repo.sha("HEAD");
  const main = commitFiles(repo, initial, expectedCatalog(repo, initial), "Stable catalogs");
  repo.run(["checkout", "--detach", initial]);
  repo.run(["update-ref", "refs/heads/main", main]);
  repo.run(["checkout", "--detach", main]);
  const { files } = developmentVersionFiles(repo, main, "0.0.4");
  const dev = commitFiles(repo, main, files, "Development source");
  repo.run(["update-ref", "refs/heads/dev", dev]);
  repo.run(["push", "--quiet", "origin", "main", "dev"]);
  return { repo, root, main, dev };
}

function githubFixture() {
  const pulls = [];
  const comments = [];
  const sources = new Map();
  const api = (path, options = {}) => {
    if (path.endsWith("/comments")) {
      comments.push(options.body.body);
      return { html_url: "https://github.com/example/test/comment/1" };
    }
    const number = /\/pulls\/(\d+)$/.exec(path)?.[1];
    if (number) return sources.get(Number(number));
    if (options.method === "POST") {
      const pull = {
        number: pulls.length + 1, state: "open", body: options.body.body,
        head: { ref: options.body.head }, base: { ref: options.body.base },
        html_url: `https://github.com/example/test/pull/${pulls.length + 1}`
      };
      pulls.push(pull);
      return pull;
    }
    const branch = new URL(`https://api.github.com/${path}`).searchParams.get("head").split(":")[1];
    return pulls.filter(pull => pull.head.ref === branch);
  };
  return { api, pulls, comments, sources };
}

test("development publication is output-only, SHA-pinned, idempotent, and rejects old source", t => {
  const f = fixture(t);
  const first = publishDevelopment(f.repo, f.dev).commit;
  assert.equal(f.repo.run(["rev-list", "--count", first]).trim(), "1");
  assert.ok([...f.repo.files(first).keys()].every(path => path === "source.json" || path.startsWith("opencode/")));
  assert.equal(JSON.parse(f.repo.read(first, "source.json")).sourceCommit, f.dev);
  assert.match(f.repo.read(first, "opencode/v2/aspire/links.md").toString(), new RegExp(`/blob/${f.dev}/`));
  validateCatalog(f.repo, first, expectedCatalog(f.repo, f.dev, { sourceRef: f.dev }));
  assert.equal(publishDevelopment(f.repo, f.dev).commit, first);
  const next = commitFiles(f.repo, f.dev, new Map([["skills/aspire/new.md", Buffer.from("New instructions.\n")]]), "New dev work");
  guardedPush(f.repo, "dev", next, f.dev);
  assert.throws(() => publishDevelopment(f.repo, f.dev), /Stale development/);
  const second = publishDevelopment(f.repo, next).commit;
  assert.equal(f.repo.sha(`${second}^`), first);
  assert.equal(remoteHead(f.repo, "opencode-dev"), second);
  assert.throws(() => guardedPush(f.repo, "opencode-dev", first, first), /Stale operation/);
});

test("release refresh commits exact catalogs, avoids loops, and refuses stale tips", t => {
  const f = fixture(t);
  guardedPush(f.repo, "release/0.0.4", f.dev, null);
  const result = refreshRelease(f.repo, "release/0.0.4", f.dev);
  assert.notEqual(result.commit, f.dev);
  validateRelease(f.repo, result.commit, f.main, "release/0.0.4");
  assert.equal(refreshRelease(f.repo, "release/0.0.4", result.commit).commit, result.commit);
  assert.throws(() => refreshRelease(f.repo, "release/0.0.4", f.dev), /Stale release/);
  assert.throws(() => refreshRelease(f.repo, "release/0.0.5", result.commit), /Stale release/);
});

test("preparation returns 0.0.5 release commits without publishing; reruns preserve edits", t => {
  const f = fixture(t);
  const plan = prepareRelease(f.repo, f.dev, "0.0.5", "0.0.6");
  assert.deepEqual(plan.branches.map(({commit, ...branch}) => branch), [
    { branch: "release/0.0.5", base: "main", baseCommit: f.main, existing: false },
    { branch: "bump-dev/0.0.6", base: "dev", baseCommit: f.dev, existing: false }
  ]);
  assert.match(plan.marker, /Aspire-Release-Version: 0\.0\.5\nAspire-Next-Version: 0\.0\.6/);
  for (const {branch} of plan.branches) assert.equal(remoteHead(f.repo, branch), null);
  const [{commit: release}, {commit: bump}] = plan.branches;
  validateRelease(f.repo, release, f.main, "release/0.0.5");
  assert.equal(versionSnapshot(f.repo, bump).version, "0.0.6");
  assert.equal(f.repo.run(["diff", "--name-only", f.dev, bump, "--", "opencode"]), "");
  assert.match(f.repo.read(bump, "package.json").toString(), /Preserve non-version metadata/);
  for (const {branch, commit} of plan.branches) guardedPush(f.repo, branch, commit, null);
  const edited = commitFiles(f.repo, release, new Map([["maintainer.txt", Buffer.from("Keep this edit.\n")]]), "Maintainer review");
  guardedPush(f.repo, "release/0.0.5", edited, release);
  const retry = prepareRelease(f.repo, f.dev, "0.0.5", "0.0.6");
  assert.deepEqual(retry.branches.map(({commit, existing}) => ({commit, existing})), [
    { commit: edited, existing: true }, { commit: bump, existing: true }
  ]);
  assert.equal(remoteHead(f.repo, "release/0.0.5"), edited);
  assert.throws(() => prepareRelease(f.repo, f.dev, "0.0.5", "0.0.7"), /another operation/);
});

test("preparation resumes when the workflow has pushed only one branch", t => {
  const f = fixture(t);
  const plan = prepareRelease(f.repo, f.dev, "0.0.4", "0.0.5");
  const release = plan.branches[0];
  guardedPush(f.repo, release.branch, release.commit, null);
  const retry = prepareRelease(f.repo, f.dev, "0.0.4", "0.0.5");
  assert.deepEqual(retry.branches[0], { ...release, existing: true });
  assert.equal(retry.branches[1].existing, false);
  assert.equal(remoteHead(f.repo, retry.branches[1].branch), null);
});

test("preparation rejects invalid versions, unrelated sources, and existing tags or branches", t => {
  const f = fixture(t);
  const prepare = (source = f.dev, version = "0.0.4", next = "0.0.5") =>
    prepareRelease(f.repo, source, version, next);
  assert.throws(() => prepare(f.dev, "v0.0.4"), /SemVer/);
  assert.throws(() => prepare(f.dev, "0.0.4", "0.0.4"), /newer than the release/);
  assert.throws(() => prepare(f.dev, "0.0.3"), /newer than main/);
  const unrelated = commitFiles(f.repo, null, new Map([["unrelated", Buffer.from("Unrelated")]]), "Unrelated root");
  assert.throws(() => prepare(unrelated), /git merge-base failed/);
  guardedPush(f.repo, "release/0.0.4", f.dev, null);
  assert.throws(() => prepare(), /another operation/);
  f.repo.run(["tag", "v0.0.4", f.main]);
  f.repo.run(["push", "--quiet", "origin", "refs/tags/v0.0.4"]);
  assert.throws(() => prepare(), /published tag/);
});

test("release version alignment keeps historical notes and rejects historical edits", t => {
  const f = fixture(t);
  const release = prepareRelease(f.repo, f.dev, "0.0.6", "0.0.7").branches[0].commit;
  assert.equal(versionSnapshot(f.repo, release).version, "0.0.6");
  assert.match(f.repo.read(release, "CHANGELOG.md").toString(), /## \[0\.0\.6\]/);
  const bad = commitFiles(f.repo, release, new Map([["CHANGELOG.md", Buffer.from(
    f.repo.read(release, "CHANGELOG.md").toString().replace("Approved notes.", "Rewritten history.")
  )]]), "Corrupt history");
  assert.throws(() => validateRelease(f.repo, bad, f.main), /Approved changelog history/);
  const bootstrap = commitFiles(f.repo, f.main, releaseFiles(f.repo, f.main, "0.0.4", f.main), "Bootstrap next release");
  const bootstrapNotes = f.repo.read(bootstrap, "CHANGELOG.md").toString();
  assert.match(bootstrapNotes, /## \[0\.0\.4\]/);
  assert.ok(bootstrapNotes.endsWith(f.repo.read(f.main, "CHANGELOG.md").toString().split("\n\n").slice(1).join("\n\n")));
  assert.equal(versionSnapshot(f.repo, bootstrap).version, "0.0.4");
});

test("PR deduplication refuses closed PRs and unrelated branch identities", () => {
  const github = githubFixture();
  const args = { branch: "test", base: "dev", marker: "<!-- identity -->", title: "Test", body: "Review this." };
  ensurePullRequest(github.api, "example/test", args);
  assert.equal(ensurePullRequest(github.api, "example/test", args).number, 1);
  assert.throws(() => ensurePullRequest(github.api, "example/test", { ...args, marker: "<!-- different -->" }), /does not match/);
  github.pulls[0].state = "closed";
  assert.throws(() => ensurePullRequest(github.api, "example/test", args), /already closed/);
});

test("a remote update between the last read and push is rejected by the lease", t => {
  const f = fixture(t);
  const original = publishDevelopment(f.repo, f.dev).commit;
  const newer = commitFiles(f.repo, original, new Map([["source.json", Buffer.from('{"newer":true}\n')]]), "Concurrent publication");
  const attempted = commitFiles(f.repo, original, new Map([["source.json", Buffer.from('{"stale":true}\n')]]), "Stale publication");
  const run = f.repo.run.bind(f.repo);
  f.repo.run = (args, options) => {
    if (args[0] === "push") {
      run(["push", "--quiet", "origin", `${newer}:refs/heads/opencode-dev`]);
      f.repo.run = run;
    }
    return run(args, options);
  };
  assert.throws(() => guardedPush(f.repo, "opencode-dev", attempted, original), /git push failed/);
  assert.equal(remoteHead(f.repo, "opencode-dev"), newer);
});

function sourcePull(github, number, source, base) {
  github.sources.set(number, {
    merged: true, merge_commit_sha: source, base: { ref: base, repo: { full_name: "example/test" } },
    title: "Fix an important instruction", user: { login: "contributor" }
  });
}

test("Arcade patch backport preserves unrelated target work and reruns reuse the PR", t => {
  const f = fixture(t);
  const github = githubFixture();
  const source = commitFiles(f.repo, f.dev, new Map([["skills/aspire/fix.md", Buffer.from("Selected fix.\n")]]), "Selected fix");
  guardedPush(f.repo, "dev", source, f.dev);
  const candidate = commitFiles(f.repo, f.dev, new Map([["skills/aspire/newer.md", Buffer.from("Keep candidate work.\n")]]), "Candidate work");
  guardedPush(f.repo, "release/0.0.4", candidate, null);
  sourcePull(github, 42, source, "dev");
  const patch = f.repo.run(["format-patch", "--stdout", "-1", source]);
  const options = { repository: "example/test", number: 42, target: "release/0.0.4", api: github.api, downloadPatch: () => patch };
  runBackport(f.repo, options);
  const backport = remoteHead(f.repo, "backport/pr-42-to-release/0.0.4");
  assert.equal(f.repo.read(backport, "skills/aspire/fix.md").toString(), "Selected fix.\n");
  assert.equal(f.repo.read(backport, "skills/aspire/newer.md").toString(), "Keep candidate work.\n");
  assert.equal(versionSnapshot(f.repo, backport).version, "0.0.4");
  assert.equal(runBackport(f.repo, options).number, 1);
  assert.equal(github.pulls.length, 1);
  github.pulls[0].state = "closed";
  assert.throws(() => runBackport(f.repo, options), /already closed/);
});

test("automatic main-to-dev backport copies the released snapshot without regenerating newer dev source", t => {
  const f = fixture(t);
  const github = githubFixture();
  const release = commitFiles(f.repo, f.dev, expectedCatalog(f.repo, f.dev), "Released catalogs", { replace: ["opencode"] });
  const newer = commitFiles(f.repo, f.dev, new Map([["skills/aspire/newer.md", Buffer.from("Unreleased work.\n")]]), "New dev work");
  guardedPush(f.repo, "main", release, f.main);
  guardedPush(f.repo, "dev", newer, f.dev);
  sourcePull(github, 43, release, "main");
  // As with Arcade, exercise the PR's patch, not a synthetic merge of branch tips.
  const patch = f.repo.run(["format-patch", "--stdout", "-1", release]);
  runBackport(f.repo, { repository: "example/test", number: 43, target: "dev", automatic: true, api: github.api, downloadPatch: () => patch });
  const backport = remoteHead(f.repo, "backport/pr-43-to-dev");
  assert.equal(f.repo.read(backport, "skills/aspire/newer.md").toString(), "Unreleased work.\n");
  assert.equal(f.repo.run(["diff", "--name-only", release, backport, "--", "opencode"]), "");
  assert.throws(() => validateCatalog(f.repo, backport, expectedCatalog(f.repo, backport)), /Catalog paths/);
});

test("Arcade patch conflicts are reported and create no branch or success-shaped PR", t => {
  const f = fixture(t);
  const github = githubFixture();
  const source = commitFiles(f.repo, f.dev, new Map([["skills/aspire/links.md", Buffer.from("Source fix.\n")]]), "Conflicting source");
  const target = commitFiles(f.repo, f.dev, new Map([["skills/aspire/links.md", Buffer.from("Different target fix.\n")]]), "Target work");
  guardedPush(f.repo, "dev", source, f.dev);
  guardedPush(f.repo, "release/0.0.4", target, null);
  sourcePull(github, 44, source, "dev");
  const patch = f.repo.run(["format-patch", "--stdout", "-1", source]);
  assert.throws(() => runBackport(f.repo, {
    repository: "example/test", number: 44, target: "release/0.0.4", api: github.api, downloadPatch: () => patch
  }), /git am failed/);
  assert.equal(remoteHead(f.repo, "backport/pr-44-to-release/0.0.4"), null);
  assert.equal(github.pulls.length, 0);
  assert.match(github.comments.at(-1), /failed.*Please backport manually/);
});

test("backport preservation checks reject version changes and loss of dev notes", t => {
  const f = fixture(t);
  const bump = commitFiles(f.repo, f.dev, developmentVersionFiles(f.repo, f.dev, "0.0.5").files, "Version change");
  assert.throws(() => validateBackport(f.repo, f.dev, bump, f.main, "dev"), /coordinated version/);
  const changed = commitFiles(f.repo, f.dev, new Map([["CHANGELOG.md", Buffer.from(
    f.repo.read(f.dev, "CHANGELOG.md").toString().replace("## [0.0.4]", "New notes.\n\n## [0.0.4]")
  )]]), "Add prefix");
  assert.doesNotThrow(() => validateBackport(f.repo, f.dev, changed, f.main, "dev"));
  const lost = commitFiles(f.repo, f.dev, new Map([["CHANGELOG.md", f.repo.read(f.main, "CHANGELOG.md")]]), "Lose heading");
  assert.throws(() => validateBackport(f.repo, f.dev, lost, f.main, "dev"), /current changelog heading/);
});

test("workflow wiring keeps fork validation unprivileged and bot checks on final candidates", () => {
  const workflow = name => parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
  for (const name of ["publish-dev-catalog", "prepare-release", "refresh-release-catalog", "backport"]) {
    const config = workflow(name);
    assert.equal(config.permissions.contents, "read");
    assert.equal(config.on.pull_request_target, undefined);
    assert.equal(config.concurrency["cancel-in-progress"], false);
    const job = Object.values(config.jobs)[0];
    assert.match(job.if, /microsoft\/aspire-skills/);
    const checkout = job.steps.find(step => step.uses?.startsWith("actions/checkout@"));
    assert.equal(checkout.with.ref, "main");
    assert.equal(checkout.with["persist-credentials"], false);
    const token = job.steps.find(step => step.uses?.startsWith("actions/create-github-app-token@"));
    assert.equal(token.with["client-id"], "${{ secrets.ASPIRE_BOT_APP_ID }}");
    assert.equal(token.with["private-key"], "${{ secrets.ASPIRE_BOT_PRIVATE_KEY }}");
  }
  const preparation = workflow("prepare-release").jobs.prepare.steps;
  assert.equal(preparation.find(step => step.id === "prepare").env.GH_TOKEN, "${{ github.token }}");
  const push = preparation.find(step => step.name === "Push release and development branches");
  assert.equal(push.env.GH_TOKEN, "${{ steps.app-token.outputs.token }}");
  assert.match(push.run, /push "--force-with-lease=refs\/heads\/\$branch:"/);
  const open = preparation.find(step => step.name === "Open release and development PRs");
  assert.equal(open.with["github-token"], "${{ steps.app-token.outputs.token }}");
  assert.match(open.with.script, /github\.rest\.pulls\.create/);
  const backport = workflow("backport");
  assert.equal(backport.on.issue_comment, undefined);
  assert.deepEqual(backport.on.pull_request, { branches: ["main"], types: ["closed"] });
  assert.ok(backport.on.workflow_dispatch.inputs.source_pr);
  assert.ok(backport.on.workflow_dispatch.inputs.target_branch);
  assert.ok(Object.hasOwn(workflow("test").on, "merge_group"));
  const publisher = workflow("publish").jobs.publish.steps.find(step => step.name === "Check release contents");
  assert.match(publisher.run, /validateRelease/);
  assert.match(publisher.run, /npm run catalog:check/);
});
