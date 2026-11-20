import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { Repository } from "../scripts/release-git.mjs";
import { expectedCatalog, validateCatalog } from "../scripts/release-catalog.mjs";
import { developmentVersionFiles } from "../scripts/version-development.mjs";
import { versionSnapshot } from "../scripts/release-versions.mjs";
import { commitFiles, ensurePullRequest, guardedPush, prepareRelease, remoteHead, syncChangelog, validateChangelogPlacement, validateRelease } from "../scripts/release-automation.mjs";
import { Changelog } from "../scripts/release-changelog.mjs";
import { ReleaseOperation } from "../scripts/release-operation.mjs";

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
  const devVersion = commitFiles(repo, main, files, "Development version");
  const dev = commitFiles(repo, devVersion, expectedCatalog(repo, devVersion), "Development catalogs", { replace: ["opencode"] });
  repo.run(["update-ref", "refs/heads/dev", dev]);
  repo.run(["push", "--quiet", "origin", "main", "dev"]);
  return { repo, root, main, dev };
}

function githubFixture() {
  const pulls = [];
  const api = (path, options = {}) => {
    if (options.method === "POST") {
      const pull = {
        number: pulls.length + 1, state: "open", body: options.body.body,
        head: { ref: options.body.head, repo: { full_name: "example/test" } }, base: { ref: options.body.base },
        html_url: `https://github.com/example/test/pull/${pulls.length + 1}`
      };
      pulls.push(pull);
      return pull;
    }
    const url = new URL(`https://api.github.com/${path}`);
    const params = url.searchParams;
    const head = params.get("head");
    if (head) return pulls.filter(pull => pull.head.ref === head.split(":")[1]);
    return pulls.filter(pull => pull.state === params.get("state") && pull.base.ref === params.get("base"));
  };
  return { api, pulls };
}

function prepareWithGithub(f, github, source, nextVersion) {
  return prepareRelease(f.repo, { source, nextVersion }, {
    api: github.api, repository: "example/test"
  });
}

function openPreparedPulls(github, plan) {
  for (const { branch, base } of plan.branches) {
    ensurePullRequest(github.api, "example/test", {
      branch, base, marker: plan.marker, title: branch, body: "Prepared release."
    });
  }
}

test("preparation cuts the release at the selected dev commit; reruns preserve edits", t => {
  const f = fixture(t);
  const github = githubFixture();
  const plan = prepareWithGithub(f, github, f.dev, "0.0.5");
  assert.deepEqual(plan.branches.map(({commit, ...branch}) => branch), [
    {
      kind: "release", branch: "release/0.0.4", base: "main", baseCommit: f.main, existing: false, title: "Release 0.0.4",
      description: `This PR releases \`dev\` commit ${f.dev} as 0.0.4. `
        + "Finalize the release notes, then merge after required checks pass."
    },
    {
      kind: "bump-dev", branch: "bump-dev/0.0.5", base: "dev", baseCommit: f.dev, existing: false, title: "Advance dev to 0.0.5",
      description: [
        `This PR advances \`dev\` to 0.0.5. Release 0.0.4 ships \`dev\` commit ${f.dev}.`,
        "",
        "Until this PR merges, keep adding changelog entries under 0.0.4. After each merge into `dev`, "
          + `automation rebuilds this PR on the latest \`dev\` and moves 0.0.4 entries added after ${f.dev} `
          + "to 0.0.5. Don't push to this branch."
      ].join("\n")
    }
  ]);
  assert.deepEqual(plan.operation.toJSON(), { source: f.dev, version: "0.0.4", nextVersion: "0.0.5" });
  assert.equal(plan.marker, plan.operation.comment());
  for (const {branch} of plan.branches) assert.equal(remoteHead(f.repo, branch), null);
  const [{commit: release}, {commit: bump}] = plan.branches;
  assert.equal(release, f.dev);
  validateRelease(f.repo, release, f.main, "release/0.0.4");
  assert.equal(versionSnapshot(f.repo, bump).version, "0.0.5");
  validateCatalog(f.repo, bump, expectedCatalog(f.repo, bump));
  assert.match(f.repo.read(bump, "package.json").toString(), /Preserve non-version metadata/);
  for (const {branch, commit} of plan.branches) guardedPush(f.repo, branch, commit, null);
  openPreparedPulls(github, plan);
  for (const pull of github.pulls) pull.body = pull.body.replaceAll("\n", "\r\n");
  const edited = commitFiles(f.repo, release, new Map([["maintainer.txt", Buffer.from("Keep this edit.\n")]]), "Maintainer review");
  guardedPush(f.repo, "release/0.0.4", edited, release);
  const retry = prepareWithGithub(f, github, f.dev, "0.0.5");
  assert.deepEqual(retry.branches.map(({commit, existing}) => ({commit, existing})), [
    { commit: edited, existing: true }, { commit: bump, existing: true }
  ]);
  assert.equal(remoteHead(f.repo, "release/0.0.4"), edited);
  const advanced = commitFiles(f.repo, f.dev, new Map([["newer.txt", Buffer.from("New dev work.\n")]]), "New dev work");
  guardedPush(f.repo, "dev", advanced, f.dev);
  const afterDevAdvance = prepareWithGithub(f, github, f.dev, "0.0.5");
  assert.deepEqual(afterDevAdvance.branches.map(({commit, existing}) => ({commit, existing})), [
    { commit: edited, existing: true }, { commit: bump, existing: true }
  ]);
  assert.throws(() => prepareWithGithub(f, github, f.dev, "0.0.6"), /does not match this automation operation/);
});

test("preparation resumes when the workflow has pushed only one branch", t => {
  const f = fixture(t);
  const github = githubFixture();
  const plan = prepareWithGithub(f, github, f.dev, "0.0.5");
  const release = plan.branches[0];
  assert.equal(release.commit, f.dev);
  guardedPush(f.repo, release.branch, release.commit, null);
  const retry = prepareWithGithub(f, github, f.dev, "0.0.5");
  assert.deepEqual(retry.branches[0], { ...release, existing: true });
  assert.equal(retry.branches[1].existing, false);
  assert.equal(remoteHead(f.repo, retry.branches[1].branch), null);
});

test("preparation rejects invalid versions, unrelated sources, and existing tags or branches", t => {
  const f = fixture(t);
  const github = githubFixture();
  const prepare = (source = f.dev, next = "0.0.5") => prepareWithGithub(f, github, source, next);
  assert.throws(() => prepare(f.dev, "v0.0.5"), /SemVer/);
  assert.throws(() => prepare(f.dev, "0.0.4"), /newer than the release/);
  assert.throws(() => prepare(f.main), /newer than main/);
  const unrelated = commitFiles(f.repo, null, new Map([["unrelated", Buffer.from("Unrelated")]]), "Unrelated root");
  assert.throws(() => prepare(unrelated), /git merge-base failed/);
  const unexpected = commitFiles(f.repo, f.dev, new Map([["unexpected.txt", Buffer.from("Not generated.\n")]]), "Unrelated branch work");
  guardedPush(f.repo, "release/0.0.4", unexpected, null);
  assert.throws(() => prepare(), /unexpected changes/);
  f.repo.run(["tag", "v0.0.4", f.main]);
  f.repo.run(["push", "--quiet", "origin", "refs/tags/v0.0.4"]);
  assert.throws(() => prepare(), /published tag/);
});

test("preparation uses the selected commit's version when dev has advanced", t => {
  const f = fixture(t);
  const github = githubFixture();
  const { files } = developmentVersionFiles(f.repo, f.dev, "0.0.5");
  const advancedVersion = commitFiles(f.repo, f.dev, files, "Advance development");
  const advanced = commitFiles(f.repo, advancedVersion, expectedCatalog(f.repo, advancedVersion),
    "Update development catalogs", { replace: ["opencode"] });
  guardedPush(f.repo, "dev", advanced, f.dev);

  const plan = prepareWithGithub(f, github, f.dev, "0.0.6");
  assert.equal(plan.operation.version, "0.0.4");
  assert.equal(plan.branches[0].branch, "release/0.0.4");
  assert.equal(plan.branches[0].commit, f.dev);
  assert.equal(plan.branches[1].baseCommit, advanced);
  assert.equal(versionSnapshot(f.repo, plan.branches[1].commit).version, "0.0.6");
  assert.throws(() => prepareWithGithub(f, github, f.dev, "0.0.5"), /newer than dev/);
});

test("preparation leaves stale catalogs for the PR check", t => {
  const f = fixture(t);
  const github = githubFixture();
  const path = "skills/aspire/SKILL.md";
  const stale = commitFiles(f.repo, f.dev, new Map([[path, Buffer.concat([
    f.repo.read(f.dev, path), Buffer.from("\nA new skill change.\n")
  ])]]), "Change skill without updating catalogs");
  guardedPush(f.repo, "dev", stale, f.dev);

  const plan = prepareWithGithub(f, github, stale, "0.0.5");
  assert.equal(plan.branches[0].commit, stale);
  assert.throws(() => validateCatalog(f.repo, stale, expectedCatalog(f.repo, stale)), /Catalog bytes or SHA-512/);
  assert.equal(remoteHead(f.repo, "release/0.0.4"), null);
});

function editChangelog(repo, parent, version, notes, message = "Edit changelog") {
  const changelog = repo.read(parent, "CHANGELOG.md").toString();
  const section = Changelog.read(repo, parent).section(version);
  const heading = section.split("\n")[0];
  return commitFiles(repo, parent, new Map([["CHANGELOG.md", Buffer.from(
    changelog.replace(section, notes ? `${heading}\n\n${notes}` : heading)
  )]]), message);
}

test("the bump moves changelog entries added after the release commit", async t => {
  const f = fixture(t);
  const github = githubFixture();
  const released = "### Added\n- Release note\n  continued.\n\n### Changed\n- Released change.";
  const source = editChangelog(f.repo, f.dev, "0.0.4", released, "Release snapshot");
  const later = editChangelog(f.repo, source, "0.0.4",
    "### Added\n- Release note\n  continued.\n- Later addition.\n\n### Changed\n- Released change.\n- Later change.");
  guardedPush(f.repo, "dev", later, f.dev);

  const plan = prepareWithGithub(f, github, source, "0.0.5");
  assert.equal(plan.branches[0].commit, source);
  const bumpChangelog = Changelog.read(f.repo, plan.branches[1].commit);
  assert.equal(bumpChangelog.notes("0.0.4"), released);
  assert.equal(bumpChangelog.notes("0.0.5"), "### Added\n- Later addition.\n\n### Changed\n- Later change.");

  const edited = editChangelog(f.repo, source, "0.0.4", released.replace("Released change.", "Reworded change."));
  guardedPush(f.repo, "dev", edited, later);
  assert.throws(() => prepareWithGithub(f, github, source, "0.0.5"), /0\.0\.4 changelog entries changed after the release commit/);

  const workflow = parse(readFileSync(new URL("../.github/workflows/prepare-release.yml", import.meta.url), "utf8"));
  const script = workflow.jobs.prepare.steps.find(step => step.name === "Open release and development PRs").with.script;
  const run = new (Object.getPrototypeOf(async function () {}).constructor)("github", "context", "core", "process", script);
  const created = [];
  const summary = { addHeading() {}, addLink() { return this; }, addEOL() {}, async write() {} };
  await run({
    rest: { pulls: { list() {}, async create(pull) {
      created.push(pull);
      return { data: { ...pull, html_url: `https://github.com/example/test/pull/${created.length}` } };
    } } },
    async paginate() { return []; }
  }, { repo: { owner: "example", repo: "test" } }, { summary, info() {} }, {
    env: { RELEASE_PLAN: JSON.stringify(plan) }
  });
  const body = created.find(pull => pull.head === "bump-dev/0.0.5").body;
  assert.ok(body.includes(`This PR advances \`dev\` to 0.0.5. Release 0.0.4 ships \`dev\` commit ${source}`));
  assert.doesNotMatch(body, /Source commit:|Workflow:/);
});

test("changelog placement allows cut-version entries only until the bump merges", t => {
  const f = fixture(t);
  const github = githubFixture();
  const check = (head, base) => validateChangelogPlacement(f.repo, head, base);
  const feature = editChangelog(f.repo, f.dev, "0.0.4", "- Feature.");
  check(feature, f.dev);
  assert.throws(() => check(editChangelog(f.repo, feature, "0.0.3", "Rewritten."), feature), /0\.0\.3 is already released/);
  guardedPush(f.repo, "dev", feature, f.dev);

  guardedPush(f.repo, "release/0.0.4", feature, null);
  const late = editChangelog(f.repo, feature, "0.0.4", "- Feature.\n- Late.");
  check(late, feature);
  assert.throws(() => check(editChangelog(f.repo, feature, "0.0.4", "- Reworded."), feature),
    /0\.0\.4 changelog entries shipped in release\/0\.0\.4/);
  guardedPush(f.repo, "dev", late, feature);

  const bump = prepareWithGithub(f, github, feature, "0.0.5").branches[1].commit;
  check(bump, late);
  check(editChangelog(f.repo, bump, "0.0.5", "- Late.\n- Next feature."), bump);
  assert.throws(() => check(editChangelog(f.repo, bump, "0.0.4", "- Feature.\n- After bump."), bump),
    /release\/0\.0\.4 was cut from dev\. Add changelog entries under 0\.0\.5/);
});

test("changelog sync rebuilds the open bump PR on the latest dev", t => {
  const f = fixture(t);
  const github = githubFixture();
  const sync = () => syncChangelog(f.repo, { api: github.api, repository: "example/test" });
  const feature = editChangelog(f.repo, f.dev, "0.0.4", "- Feature.");
  guardedPush(f.repo, "dev", feature, f.dev);
  const plan = prepareWithGithub(f, github, feature, "0.0.5");
  for (const { branch, commit } of plan.branches) guardedPush(f.repo, branch, commit, null);
  openPreparedPulls(github, plan);
  github.pulls.push({ number: 3, state: "open", body: "", head: { ref: "bump-dev/0.0.5", repo: { full_name: "fork/test" } }, base: { ref: "dev" } });
  assert.deepEqual(sync(), { updates: [] });

  const late = commitFiles(f.repo, editChangelog(f.repo, feature, "0.0.4", "- Feature.\n- Late."),
    new Map([["late.txt", Buffer.from("Late work.\n")]]), "Late work");
  guardedPush(f.repo, "dev", late, feature);
  const { updates: [rebuild, ...extra] } = sync();
  assert.deepEqual(extra, []);
  assert.deepEqual({ ...rebuild, commit: undefined }, {
    branch: "bump-dev/0.0.5", current: plan.branches[1].commit, commit: undefined, pull: 2
  });
  const bumped = Changelog.read(f.repo, rebuild.commit);
  assert.equal(bumped.notes("0.0.4"), "- Feature.");
  assert.equal(bumped.notes("0.0.5"), "- Late.");
  assert.equal(f.repo.read(rebuild.commit, "late.txt").toString(), "Late work.\n");
  assert.equal(versionSnapshot(f.repo, rebuild.commit).version, "0.0.5");
  validateCatalog(f.repo, rebuild.commit, expectedCatalog(f.repo, rebuild.commit));
  validateChangelogPlacement(f.repo, rebuild.commit, late);
  guardedPush(f.repo, rebuild.branch, rebuild.commit, rebuild.current);
  assert.deepEqual(sync(), { updates: [] });

  guardedPush(f.repo, "dev", rebuild.commit, late);
  assert.deepEqual(sync(), { updates: [] });
});

test("release validation rejects changes to published notes", t => {
  const f = fixture(t);
  const bad = commitFiles(f.repo, f.dev, new Map([["CHANGELOG.md", Buffer.from(
    f.repo.read(f.dev, "CHANGELOG.md").toString().replace("Approved notes.", "Rewritten history.")
  )]]), "Corrupt history");
  assert.throws(() => validateRelease(f.repo, bad, f.main), /Approved changelog history/);
});

test("release checks reject empty notes before a candidate can merge", t => {
  const f = fixture(t);
  assert.doesNotThrow(() => validateRelease(f.repo, f.dev, f.main, "release/0.0.4"));
  assert.throws(() => validateRelease(f.repo, f.dev, f.main, "release/0.0.4", { requireNotes: true }),
    /notes must be finalized/);
});

test("release operation markers parse one validated operation and reject ambiguous ones", () => {
  const source = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const marker = `<!-- Aspire-Release-Source: ${source.toUpperCase()}\r\nAspire-Release-Version: 0.0.6\r\nAspire-Next-Version: 0.0.7 -->`;
  const operation = ReleaseOperation.parse(marker);
  assert.deepEqual(operation.toJSON(), { source, version: "0.0.6", nextVersion: "0.0.7" });
  assert.ok(Object.isFrozen(operation));
  assert.ok(operation.equals(ReleaseOperation.parse(`Title\n\n${operation.comment()}\n\n${marker}`)));
  assert.equal(operation.equals({ source, version: "0.0.6", nextVersion: "0.0.7" }), false);
  assert.equal(ReleaseOperation.parse("Release PR without a source marker"), null);
  assert.equal(ReleaseOperation.parse(undefined), null);
  assert.throws(() => ReleaseOperation.parse(`<!-- Aspire-Release-Source: ${source} -->`), /incomplete or malformed/);
  assert.throws(() => ReleaseOperation.parse(marker.replace("0.0.7", "0.0.5")), /newer than the release/);
  assert.throws(() => ReleaseOperation.parse(`${marker}\n${marker.replace("0.0.7", "0.0.8")}`), /More than one release operation/);
  assert.throws(() => ReleaseOperation.parse(marker.replace(" -->", "")), /incomplete or malformed/);
  assert.throws(() => ReleaseOperation.create({ ...operation.toJSON(), source: `${source}\nAspire-Next-Version: 9.9.9` }), /Release source/);
  assert.throws(() => new ReleaseOperation(Symbol("ReleaseOperation"), source, "0.0.6", "0.0.7"), /ReleaseOperation\.create/);
});

test("changelogs reject out-of-order sections and preserve line endings", () => {
  const heading = version => `## [${version}](https://github.com/microsoft/aspire-skills/releases/tag/v${version})`;
  assert.throws(() => Changelog.parse(`# Changelog\n\n${heading("0.0.3")}\n\n${heading("0.0.4")}\n`), /descending order/);
  const text = `# Changelog\r\n\r\n${heading("0.0.4")}\r\n\r\nNotes.\r\n`;
  const changelog = Changelog.parse(text);
  assert.equal(changelog.toBuffer().toString(), text);
  assert.equal(changelog.withNewSection("0.0.5").toBuffer().toString(), text.replace(heading("0.0.4"), `${heading("0.0.5")}\r\n\r\n${heading("0.0.4")}`));
  assert.throws(() => changelog.withNewSection("0.0.3"), /descending order/);
  assert.throws(() => changelog.withNewSection("0.0.4"), /already has 0\.0\.4/);
  assert.throws(() => changelog.withNewSection("not-a-version"), /SemVer/);
  assert.throws(() => Changelog.parse(`# Changelog\n\n## [0.0.4](https://example.com/v0.0.4)\n`), /Invalid changelog section/);
  assert.throws(() => Changelog.parse(`# Changelog\n\n${heading("0.0.4")}\n\n${heading("0.0.4")}\n`), /duplicate/);
  assert.throws(() => new Changelog(Symbol("Changelog"), "", new Map(), "\n"), /Changelog\.parse/);
  assert.ok(Object.isFrozen(changelog));
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
  const branch = "release/0.0.4";
  const original = f.dev;
  guardedPush(f.repo, branch, original, null);
  const newer = commitFiles(f.repo, original, new Map([["candidate.txt", Buffer.from("Newer candidate.\n")]]), "Concurrent candidate");
  const attempted = commitFiles(f.repo, original, new Map([["candidate.txt", Buffer.from("Stale candidate.\n")]]), "Stale candidate");
  const run = f.repo.run.bind(f.repo);
  f.repo.run = (args, options) => {
    if (args[0] === "push") {
      run(["push", "--quiet", "origin", `${newer}:refs/heads/${branch}`]);
      f.repo.run = run;
    }
    return run(args, options);
  };
  assert.throws(() => guardedPush(f.repo, branch, attempted, original), /git push failed/);
  assert.equal(remoteHead(f.repo, branch), newer);
});

test("release workflow wiring keeps preparation unprivileged and bot checks on candidates", () => {
  const workflow = name => parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
  const config = workflow("prepare-release");
  assert.deepEqual(Object.keys(config.on.workflow_dispatch.inputs), ["source", "next_version"]);
  assert.equal(config.permissions.contents, "read");
  assert.equal(config.permissions["pull-requests"], "read");
  assert.equal(config.on.pull_request_target, undefined);
  assert.equal(config.concurrency["cancel-in-progress"], false);
  const job = config.jobs.prepare;
  assert.match(job.if, /microsoft\/aspire-skills/);
  const checkout = job.steps.find(step => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "main");
  assert.equal(checkout.with["persist-credentials"], false);
  const token = job.steps.find(step => step.uses?.startsWith("actions/create-github-app-token@"));
  assert.equal(token.with["client-id"], "${{ secrets.ASPIRE_BOT_APP_ID }}");
  assert.equal(token.with["private-key"], "${{ secrets.ASPIRE_BOT_PRIVATE_KEY }}");
  const preparation = job.steps;
  const prepare = preparation.find(step => step.id === "prepare");
  assert.equal(prepare.env.GH_TOKEN, "${{ github.token }}");
  assert.match(prepare.run, /prepare "\$SOURCE_SHA" "\$NEXT_VERSION"/);
  const push = preparation.find(step => step.name === "Push release and development branches");
  assert.equal(push.env.GH_TOKEN, "${{ steps.app-token.outputs.token }}");
  assert.match(push.run, /push "--force-with-lease=refs\/heads\/\$branch:"/);
  const open = preparation.find(step => step.name === "Open release and development PRs");
  assert.equal(open.with["github-token"], "${{ steps.app-token.outputs.token }}");
  assert.match(open.with.script, /github\.rest\.pulls\.create/);
  assert.ok(Object.hasOwn(workflow("test").on, "merge_group"));
  const catalogCheck = workflow("catalog-check").jobs["catalog-check"].steps.find(step => step.name === "Reject catalog drift");
  assert.equal(catalogCheck.run, "npm run catalog:check");
  const changelogCheck = workflow("changelog-check").jobs["changelog-check"];
  assert.equal(changelogCheck.name, "Changelog check");
  assert.match(changelogCheck.steps.at(-1).run, /check-changelog "\$BASE_SHA"/);
  assert.match(workflow("release-branch-check").jobs["release-branch-check"].steps.at(-1).run,
    /validate-release "\$BASE_SHA" "\$RELEASE_BRANCH"/);
  const sync = workflow("sync-changelog");
  assert.deepEqual(sync.permissions, { contents: "read", "pull-requests": "read" });
  assert.equal(sync.on.pull_request_target, undefined);
  assert.match(sync.jobs.sync.if, /microsoft\/aspire-skills/);
  const syncSteps = sync.jobs.sync.steps;
  assert.equal(syncSteps.find(step => step.uses?.startsWith("actions/checkout@")).with.ref, "dev");
  assert.equal(syncSteps.find(step => step.id === "plan").env.GH_TOKEN, "${{ github.token }}");
  const syncPush = syncSteps.find(step => step.name === "Rebuild bump PRs");
  assert.equal(syncPush.env.GH_TOKEN, "${{ steps.app-token.outputs.token }}");
  assert.match(syncPush.run, /push "--force-with-lease=refs\/heads\/\$branch:\$current"/);
  const publisher = workflow("publish").jobs.publish.steps.find(step => step.name === "Check release contents");
  assert.match(publisher.run, /npm run catalog:check/);
});

test("Aspire backport workflow checks the repository and commenter before using the app", async () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/backport.yml", import.meta.url), "utf8"));
  assert.deepEqual(workflow.on.issue_comment, { types: ["created"] });
  const job = workflow.jobs.backport;
  const allowed = new Function("github", "contains", `return (${job.if});`);
  const event = { issue: { pull_request: {} }, comment: { body: "/backport to release/0.0.4" } };
  const github = { repository: "microsoft/aspire-skills", event_name: "issue_comment", event };
  const contains = (value, text) => value.includes(text);
  assert.equal(allowed(github, contains), true);
  assert.equal(allowed({ ...github, repository: "fork/aspire-skills" }, contains), false);
  assert.equal(allowed({ ...github, event_name: "schedule" }, contains), false);
  assert.equal(allowed({ ...github, event: { ...event, issue: { pull_request: "" } } }, contains), false);
  assert.equal(allowed({ ...github, event: { ...event, comment: { body: "hello" } } }, contains), false);
  const cleanupAllowed = new Function("github", `return (${workflow.jobs.cleanup.if});`);
  assert.equal(cleanupAllowed({ ...github, event_name: "schedule" }), true);
  assert.equal(cleanupAllowed({ ...github, event_name: "schedule", repository: "fork/aspire-skills" }), false);

  const steps = job.steps;
  const permissionIndex = steps.findIndex(step => step.name === "Verify user has write access");
  const tokenIndex = steps.findIndex(step => step.id === "app-token");
  assert.ok(permissionIndex >= 0 && tokenIndex > permissionIndex);
  const token = steps[tokenIndex];
  assert.equal(token.with["client-id"], "${{ secrets.ASPIRE_BOT_APP_ID }}");
  assert.equal(token.with["private-key"], "${{ secrets.ASPIRE_BOT_PRIVATE_KEY }}");
  const checkout = steps.find(step => step.name === "Checkout repo");
  assert.equal(checkout.with.token, "${{ steps.app-token.outputs.token }}");
  const backport = steps.find(step => step.name === "Run backport");
  assert.equal(backport.env.GH_TOKEN, "${{ steps.app-token.outputs.token }}");
  assert.equal(backport.with["github-token"], "${{ steps.app-token.outputs.token }}");

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const verify = new AsyncFunction("github", "context", "core", steps[permissionIndex].with.script);
  const context = { repo: { owner: "microsoft", repo: "aspire-skills" }, payload: { comment: { user: { login: "requester" } } } };
  for (const permission of ["write", "read"]) {
    const failures = [];
    await verify({ rest: { repos: { async getCollaboratorPermissionLevel(request) {
      assert.equal(request.username, "requester");
      return { data: { permission } };
    } } } }, context, { setFailed: message => failures.push(message) });
    assert.equal(failures.length, permission === "write" ? 0 : 1);
  }
  const extract = new AsyncFunction("context", `let target_branch;\n${steps.find(step => step.id === "target-branch-extractor").with.script}`);
  assert.equal(await extract({ eventName: "issue_comment", payload: { comment: event.comment } }), "release/0.0.4");
});

test("Aspire backport workflow applies a PR patch and opens a backport PR", async t => {
  const f = fixture(t);
  const source = commitFiles(f.repo, f.dev, new Map([["skills/aspire/fix.md", Buffer.from("Selected fix.\n")]]), "Selected fix");
  const target = commitFiles(f.repo, f.dev, new Map([["skills/aspire/newer.md", Buffer.from("Target work.\n")]]), "Target work");
  guardedPush(f.repo, "dev", source, f.dev);
  guardedPush(f.repo, "release/0.0.4", target, null);
  f.repo.run(["fetch", "origin"]);
  const patch = f.repo.run(["format-patch", "--stdout", "--binary", "-1", source], { binary: true });

  const workflow = parse(readFileSync(new URL("../.github/workflows/backport.yml", import.meta.url), "utf8"));
  const step = workflow.jobs.backport.steps.find(item => item.name === "Run backport");
  const script = step.with.script.replaceAll("${{ steps.target-branch-extractor.outputs.result }}", "release/0.0.4");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction("github", "context", "core", "exec", "process", script);
  const pulls = [];
  const failures = [];
  const github = { rest: {
    pulls: { async create(request) {
      pulls.push(request);
      return { data: { number: 1, html_url: "https://github.com/example/test/pull/1" } };
    } },
    issues: { async createComment() { return { data: { html_url: "https://github.com/example/test/comment/1" } }; } }
  } };
  const context = {
    repo: { owner: "example", repo: "test" }, serverUrl: "https://github.com", runId: 1,
    payload: {
      repository: { owner: { login: "example" }, name: "test" },
      issue: { number: 42, title: "Selected fix", user: { login: "contributor" } },
      comment: { user: { login: "maintainer" } }
    }
  };
  const exec = { async exec(command, _args, options = {}) {
    if (command === "git clean -xdff") return 0;
    if (command === 'bash -c "gh pr diff --patch 42 > changes.patch"') {
      writeFileSync(join(f.root, "changes.patch"), patch);
      return 0;
    }
    const args = command.match(/"[^"]*"|\S+/g).map(arg => arg.replace(/^"|"$/g, ""));
    assert.equal(args.shift(), "git");
    const output = f.repo.run(args);
    if (options.listeners?.stdout) options.listeners.stdout(Buffer.from(output));
    return 0;
  } };
  await run(github, context, { setFailed: message => failures.push(message) }, exec, { env: step.env });
  assert.deepEqual(failures, []);
  assert.deepEqual(pulls.map(({ head, base }) => ({ head, base })), [
    { head: "backport/pr-42-to-release/0.0.4", base: "release/0.0.4" }
  ]);
  const backport = remoteHead(f.repo, pulls[0].head);
  assert.equal(f.repo.read(backport, "skills/aspire/fix.md").toString(), "Selected fix.\n");
  assert.equal(f.repo.read(backport, "skills/aspire/newer.md").toString(), "Target work.\n");
});

test("release preparation only admits main dispatches and reuses CRLF-marked PRs", async () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/prepare-release.yml", import.meta.url), "utf8"));
  const job = workflow.jobs.prepare;
  const allowed = new Function("github", `return (${job.if});`);
  assert.equal(allowed({ repository: "microsoft/aspire-skills", event_name: "workflow_dispatch", ref: "refs/heads/main" }), true);
  assert.equal(allowed({ repository: "microsoft/aspire-skills", event_name: "push", ref: "refs/heads/feature" }), false);
  assert.equal(allowed({ repository: "fork/aspire-skills", event_name: "workflow_dispatch", ref: "refs/heads/main" }), false);
  assert.equal(workflow.on.workflow_call, undefined);
  assert.equal(existsSync(new URL("../.github/workflows/prepare-release-test.yml", import.meta.url)), false);
  const step = job.steps.find(step => step.name === "Open release and development PRs");
  const run = new (Object.getPrototypeOf(async function () {}).constructor)(
    "github", "context", "core", "process", step.with.script);
  const marker = "<!-- test operation -->";
  const operation = { source: "a".repeat(40), version: "0.0.6", nextVersion: "0.0.7" };
  const branches = [
    { branch: "release/0.0.6", base: "main", title: "Release 0.0.6", description: "Release." },
    { branch: "bump-dev/0.0.7", base: "dev", title: "Advance dev to 0.0.7", description: "Bump." }
  ];
  const created = [];
  const summary = { addHeading() {}, addLink() { return this; }, addEOL() {}, async write() {} };
  await run({
    rest: { pulls: { list() {}, async create(pull) {
      created.push(pull);
      return { data: { ...pull, html_url: `https://github.com/example/test/pull/${created.length}` } };
    } } },
    async paginate(_method, { head }) {
      const branch = branches.find(({ branch }) => head.endsWith(`:${branch}`));
      return [{
        number: 1, title: `Existing ${branch.branch}`, state: "open", base: { ref: branch.base },
        body: `${marker}\r\n\r\nExisting PR`, html_url: "https://github.com/example/test/pull/1"
      }];
    }
  }, { repo: { owner: "microsoft", repo: "aspire-skills" } }, { summary, info() {} }, {
    env: { RELEASE_PLAN: JSON.stringify({ operation, marker, branches }) }
  });
  assert.deepEqual(created, []);
});
