import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Repository } from "../scripts/release-git.mjs";
import { checkPull, validatePublished } from "../scripts/release-checks.mjs";
import { latestRelease, readChangelog, releaseNotes, validateChangelog } from "../scripts/release-changelog.mjs";
import { prepareDevelopmentVersion } from "../scripts/version-development.mjs";
import { updateVersion, versionManifests, versionSnapshot } from "../scripts/release-versions.mjs";
import { buildCatalog } from "../scripts/build-opencode-catalog.mjs";
import { publishSourceRelease, resolveReleasePull } from "../scripts/release-github.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "release-flow-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const initialized = spawnSync("git", ["init", "--quiet", "--initial-branch=main", root], {
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const repo = new Repository(root);
  const write = (path, contents) => {
    const destination = join(root, ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  };
  const commit = (message = "Update fixture") => {
    repo.run(["add", "--all"]);
    repo.run(["commit", "--quiet", "-m", message]);
    return repo.sha("HEAD");
  };
  const track = branch => repo.run(["update-ref", `refs/remotes/origin/${branch}`, repo.sha(branch)]);
  for (const path of ["package.json", ".plugin/plugin.json", ".claude-plugin/plugin.json", "gemini-extension.json"]) {
    write(path, '{\n  "name": "aspire",\n  "version": "0.0.4"\n}\n');
  }
  write("package-lock.json", '{"version":"0.0.4","packages":{"":{"version":"0.0.4"}}}\n');
  for (const path of [".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json"]) {
    write(path, '{"plugins":[{"name":"aspire","version":"0.0.4"}]}\n');
  }
  write("skills/aspire/SKILL.md", "---\nname: aspire\nmetadata:\n  version: 0.0.4\n---\n\n# Aspire\n\nPublished skill.\n");
  const history = "# Changelog\n\n## [0.0.4] - 2026-10-14\n\n### Added\n- Legacy main release.\n";
  write("CHANGELOG.md", history);
  const legacy = commit("Legacy release 0.0.4");
  repo.run(["tag", "--annotate", "--message", "Legacy release", "v0.0.4"]);
  write("tooling.txt", "Approved release infrastructure.\n");
  const main = commit("Bootstrap infrastructure after release");
  repo.run(["branch", "dev"]);
  track("main");
  track("dev");
  return { repo, root, write, commit, track, history, legacy, main };
}

function initialize(f) {
  const { repo, commit, track } = f;
  repo.run(["switch", "--quiet", "-c", "initialize-dev/0.0.5", "dev"]);
  prepareDevelopmentVersion(repo, "0.0.5");
  const head = commit("Initialize dev at 0.0.5");
  checkPull(repo, { target: "dev", headBranch: "initialize-dev/0.0.5", headCommit: head, baseCommit: f.main });
  repo.run(["switch", "--quiet", "dev"]);
  repo.run(["merge", "--quiet", "--no-ff", "initialize-dev/0.0.5", "-m", "Initialize development"]);
  track("dev");
}

function notes(f, version = "0.0.5", description = "Selected development feature.") {
  return `# Changelog\n\n## [${version}](https://github.com/microsoft/aspire-skills/releases/tag/v${version})\n\n### Added\n- ${description}\n\n${f.history.slice(f.history.indexOf("## "))}`;
}

function candidate(f) {
  const { repo, write, commit, track } = f;
  initialize(f);
  write("shipped.txt", "Selected development feature.\n");
  const source = commit("Feature selected for release");
  track("dev");
  repo.run(["switch", "--quiet", "-c", "release/0.0.5", source]);
  assert.equal(repo.sha("HEAD"), source);
  write("CHANGELOG.md", notes(f));
  buildCatalog(f.root);
  const reviewed = commit("Finalize release notes and catalogs");
  checkPull(repo, { target: "main", headBranch: "release/0.0.5", headCommit: reviewed });
  return { ...f, source, reviewed };
}

function releaseCycle(f, method = "merge") {
  f = candidate(f);
  const { repo, write, commit, track } = f;
  repo.run(["switch", "--quiet", "-c", "bump-dev/0.0.6", "dev"]);
  prepareDevelopmentVersion(repo, "0.0.6");
  const bump = commit("Advance dev to 0.0.6");
  checkPull(repo, { target: "dev", headBranch: "bump-dev/0.0.6", headCommit: bump, baseCommit: f.source });
  repo.run(["switch", "--quiet", "dev"]);
  repo.run(["merge", "--quiet", "--no-ff", "bump-dev/0.0.6", "-m", "Advance development"]);
  write("newer.txt", "Work after the release cut.\n");
  write(".plugin/plugin.json", '{\n  "name": "aspire",\n  "version": "0.0.6",\n  "description": "Newer dev manifest content"\n}\n');
  const dev = commit("Continue development");
  track("dev");
  repo.run(["switch", "--quiet", "main"]);
  let released;
  if (method === "merge") {
    repo.run(["merge", "--quiet", "--no-ff", "release/0.0.5", "-m", "Release approved by maintainer"]);
    released = repo.sha("HEAD");
  } else if (method === "squash") {
    repo.run(["merge", "--quiet", "--squash", "release/0.0.5"]);
    released = commit("Release approved by maintainer");
  } else {
    write("main-only.txt", "Main advanced while this release was reviewed.\n");
    commit("Update main");
    repo.run(["switch", "--quiet", "-c", "rebased-release", "release/0.0.5"]);
    repo.run(["rebase", "--quiet", "--onto", "main", f.main]);
    repo.run(["switch", "--quiet", "main"]);
    repo.run(["merge", "--quiet", "--ff-only", "rebased-release"]);
    released = repo.sha("HEAD");
    assert.equal(repo.ancestor(f.reviewed, released), false);
  }
  track("main");
  const validated = validatePublished(repo, released, { headCommit: f.reviewed });
  return { ...f, dev, released, validated };
}

function backflow(f) {
  const { repo, root, write, commit } = f;
  const manifests = versionManifests(repo, f.dev);
  repo.run(["switch", "--quiet", "-c", "backport/pr-100-to-dev", "dev"]);
  const merged = repo.run(["merge", "--no-ff", "--no-commit", "main"], { statuses: [0, 1] });
  assert.ok([0, 1].includes(merged.status));
  for (const [path, contents] of manifests) write(path, contents);
  write("CHANGELOG.md", repo.read(f.released, "CHANGELOG.md"));
  rmSync(join(root, "opencode"), { recursive: true, force: true });
  return commit("Merge released main back into dev");
}

test("legacy initialization advances versions, removes catalogs, and preserves all source and history", t => {
  const f = fixture(t);
  f.write("opencode/v2/index.json", "Legacy generated catalog.\n");
  f.main = f.commit("Generated main content");
  f.track("main");
  f.repo.run(["branch", "--force", "dev", "main"]);
  f.track("dev");
  initialize(f);
  assert.equal(versionSnapshot(f.repo, f.repo.sha("dev")).version, "0.0.5");
  assert.equal(f.repo.files(f.repo.sha("dev"), ["opencode"]).size, 0);
  assert.equal(readChangelog(f.repo, f.repo.sha("dev")), f.history);
  assert.equal(f.repo.read(f.repo.sha("dev"), "tooling.txt").toString(), "Approved release infrastructure.\n");
});

for (const method of ["merge", "squash", "rebase"]) {
  test(`${method} publication validates the exact merged main commit independently of later dev work`, t => {
    const f = releaseCycle(fixture(t), method);
    const { repo } = f;
    assert.equal(f.validated.release, f.released);
    assert.equal(versionSnapshot(repo, f.released).version, "0.0.5");
    assert.equal(versionSnapshot(repo, f.dev).version, "0.0.6");
    assert.equal(repo.files(f.released, ["newer.txt"]).size, 0);
    assert.ok(repo.files(f.released, ["opencode"]).size > 0);
    assert.equal(latestRelease(readChangelog(repo, f.released)).version, "0.0.5");
    assert.equal(releaseNotes(readChangelog(repo, f.released)), "### Added\n- Selected development feature.\n");
    if (method === "merge") assert.equal(repo.parents(f.released).length, 2);
    if (method === "rebase") assert.ok(repo.files(f.released, ["main-only.txt"]).size > 0);
  });
}

test("existing release branches accept a dev fix without later dev features or a version bump", t => {
  const f = candidate(fixture(t));
  f.repo.run(["switch", "--quiet", "-c", "bump-dev/0.0.6", "dev"]);
  prepareDevelopmentVersion(f.repo, "0.0.6");
  f.commit("Advance dev");
  f.repo.run(["switch", "--quiet", "dev"]);
  f.repo.run(["merge", "--quiet", "--no-ff", "bump-dev/0.0.6", "-m", "Bump dev"]);
  f.write("newer.txt", "Do not backport this feature.\n");
  f.commit("New development");
  f.write("shipped.txt", "Selected development feature with a fix.\n");
  const fix = f.commit("Fix required for release");
  f.track("dev");
  f.repo.run(["switch", "--quiet", "-c", "backport/fix-to-release", "release/0.0.5"]);
  f.repo.run(["cherry-pick", "--no-edit", fix]);
  const head = f.repo.sha("HEAD");
  checkPull(f.repo, { target: "release/0.0.5", headBranch: "backport/fix-to-release", headCommit: head });
  checkPull(f.repo, { target: "main", headBranch: "release/0.0.5", headCommit: head });
  assert.equal(versionSnapshot(f.repo, head).version, "0.0.5");
  assert.equal(f.repo.files(head, ["newer.txt"]).size, 0);
  assert.match(f.repo.read(head, "shipped.txt").toString(), /with a fix/);
});

test("release checks reject wrong branch versions, changed published history, and stale catalogs", t => {
  const f = candidate(fixture(t));
  assert.throws(() => checkPull(f.repo, {
    target: "main", headBranch: "release/0.0.6", headCommit: f.reviewed
  }), /branch must match/);
  assert.throws(() => checkPull(f.repo, {
    target: "release/0.0.6", headCommit: f.reviewed
  }), /preserve the release branch version/);
  f.write("CHANGELOG.md", notes(f).replace("Legacy main release.", "Rewritten legacy history."));
  const changedHistory = f.commit();
  assert.throws(() => checkPull(f.repo, {
    target: "main", headBranch: "release/0.0.5", headCommit: changedHistory
  }), /history or its header/);
  f.write("CHANGELOG.md", notes(f));
  f.write("skills/aspire/SKILL.md", f.repo.read(f.reviewed, "skills/aspire/SKILL.md").toString() + "\nSource fix.\n");
  const stale = f.commit();
  assert.throws(() => checkPull(f.repo, {
    target: "release/0.0.5", headCommit: stale
  }), /Catalog bytes/);
  buildCatalog(f.root);
  const refreshed = f.commit();
  checkPull(f.repo, { target: "release/0.0.5", headCommit: refreshed });
});

test("released version and notes must still match the reviewed PR", t => {
  const f = releaseCycle(fixture(t));
  f.write("CHANGELOG.md", notes(f, "0.0.5", "Different notes."));
  const changed = f.commit();
  assert.throws(() => validatePublished(f.repo, changed, { headCommit: f.reviewed }), /match the approved PR/);
  assert.throws(() => validatePublished(f.repo, f.released, { headCommit: f.dev }), /coordinated versions must match/);
});

test("dev backflow preserves next-version manifests, newer work, approved notes, and merge ancestry", t => {
  const f = releaseCycle(fixture(t));
  const head = backflow(f);
  checkPull(f.repo, { target: "dev", headBranch: "backport/pr-100-to-dev", headCommit: head, baseCommit: f.dev });
  assert.equal(versionSnapshot(f.repo, head).version, "0.0.6");
  assert.equal(readChangelog(f.repo, head), readChangelog(f.repo, f.released));
  assert.equal(f.repo.read(head, "newer.txt").toString(), "Work after the release cut.\n");
  assert.match(f.repo.read(head, ".plugin/plugin.json").toString(), /Newer dev manifest content/);
  assert.equal(f.repo.files(head, ["opencode"]).size, 0);
  assert.ok(f.repo.ancestor(f.released, head));
});

test("dev backflow rejects downgrades, dropped newer work, rewritten history, and squash ancestry", t => {
  const f = releaseCycle(fixture(t));
  const head = backflow(f);
  for (const [path, contents] of versionManifests(f.repo, head)) f.write(path, updateVersion(contents, path, "0.0.5"));
  const downgrade = f.commit();
  const check = headCommit => checkPull(f.repo, {
    target: "dev", headBranch: "backport/pr-100-to-dev", headCommit, baseCommit: f.dev
  });
  assert.throws(() => check(downgrade), /preserve dev's current version/);
  for (const [path, contents] of versionManifests(f.repo, head)) f.write(path, contents);
  f.repo.run(["rm", "--quiet", "--", "newer.txt"]);
  const dropped = f.commit();
  assert.throws(() => check(dropped), /Backflow follow-ups may only/);
  f.write("CHANGELOG.md", readChangelog(f.repo, head).replace("Selected development feature.", "Different notes."));
  const changed = f.commit();
  assert.throws(() => check(changed), /copy main's approved CHANGELOG/);
  const tree = f.repo.run(["rev-parse", `${head}^{tree}`]).trim();
  const squashed = f.repo.run(["commit-tree", tree, "-p", f.dev, "-m", "Squashed backflow"]).trim();
  assert.throws(() => check(squashed), /must be an ancestor/);
});

test("development version preparation rejects dirty trees, unrelated branches, and nonadvancing versions", t => {
  const f = fixture(t);
  assert.throws(() => prepareDevelopmentVersion(f.repo, "0.0.5"), /Use initialize-dev/);
  f.repo.run(["switch", "--quiet", "-c", "bump-dev/0.0.4", "dev"]);
  assert.throws(() => prepareDevelopmentVersion(f.repo, "0.0.4"), /greater than the current version/);
  f.repo.run(["switch", "--quiet", "-c", "initialize-dev/0.0.5", "dev"]);
  f.write("uncommitted.txt", "Existing work.\n");
  assert.throws(() => prepareDevelopmentVersion(f.repo, "0.0.5"), /clean working tree/);
});

test("ordinary dev PRs cannot disguise a version bump or a changelog edit", t => {
  const f = fixture(t);
  initialize(f);
  const base = f.repo.sha("dev");
  f.repo.run(["switch", "--quiet", "-c", "bump-dev/0.0.6", "dev"]);
  prepareDevelopmentVersion(f.repo, "0.0.6");
  const head = f.commit();
  assert.throws(() => checkPull(f.repo, {
    target: "dev", headBranch: "feature/ordinary", headCommit: head, baseCommit: base
  }), /must preserve their dev baseline's version/);
  f.write("CHANGELOG.md", `${f.history}\nUnapproved development notes.\n`);
  const changed = f.commit();
  assert.throws(() => checkPull(f.repo, {
    target: "dev", headBranch: "bump-dev/0.0.6", headCommit: changed, baseCommit: base
  }), /without changing source or changelog/);
});

test("version preparation preserves formatting, skill prose, other marketplace plugins, and both lock roots", t => {
  const f = fixture(t);
  const marketplace = '{\n  "plugins": [\n    {"name": "other", "version": "9.9.9"},\n    {"name": "aspire", "version": "0.0.4", "description": "Keep me"}\n  ]\n}\n';
  f.write(".cursor-plugin/marketplace.json", marketplace);
  const skill = "---\nname: aspireify\nmetadata:\n  version: '0.0.4'\n---\n\n# Wire apps\n\nKeep this prose.\n";
  f.write("skills/aspireify/SKILL.md", skill);
  const base = f.commit();
  f.repo.run(["branch", "--force", "dev", base]);
  f.track("dev");
  f.repo.run(["switch", "--quiet", "-c", "bump-dev/0.0.5", "dev"]);
  prepareDevelopmentVersion(f.repo, "0.0.5");
  const head = f.commit();
  assert.equal(f.repo.read(head, ".cursor-plugin/marketplace.json").toString(), marketplace.replace('"0.0.4"', '"0.0.5"'));
  assert.equal(f.repo.read(head, "skills/aspireify/SKILL.md").toString(), skill.replace("'0.0.4'", "'0.0.5'"));
  const lock = JSON.parse(f.repo.read(head, "package-lock.json"));
  assert.equal(lock.version, "0.0.5");
  assert.equal(lock.packages[""].version, "0.0.5");
  assert.equal(versionSnapshot(f.repo, head).version, "0.0.5");
});

test("notes need no state marker or prescribed commit message but must preserve published history", () => {
  const history = "# Changelog\n\n## [0.0.4] - 2026-10-14\n\n### Added\n- Previous release.\n";
  const current = notes({ history });
  validateChangelog(current, "0.0.5", history);
  assert.equal(releaseNotes(current.replaceAll("\n", "\r\n")), releaseNotes(current));
  for (const malformed of [
    current.replace("### Added", "### Features"),
    current.replace("- Selected development feature.", "_Notes pending._"),
    current.replace("- Previous release.", "- Changed old notes."),
    current.replace("### Added", "<!-- aspire-skills-changelog from=old -->\n\n### Added")
  ]) assert.throws(() => validateChangelog(malformed, "0.0.5", history));
});

test("publication binds the event to a genuinely merged same-repository release PR", t => {
  const f = releaseCycle(fixture(t));
  f.repo.run(["remote", "add", "origin", "https://github.com/microsoft/aspire-skills.git"]);
  const repo = Object.create(f.repo);
  const fetched = [];
  repo.run = (args, options) => {
    if (args[0] === "fetch") {
      fetched.push(args);
      f.repo.run(["update-ref", "refs/remotes/origin/published-pr", f.reviewed]);
      return "";
    }
    return f.repo.run(args, options);
  };
  const pull = {
    number: 100, merged: true, state: "closed", merge_commit_sha: f.released,
    base: { ref: "main", repo: { full_name: "microsoft/aspire-skills" } },
    head: { ref: "release/0.0.5", sha: f.reviewed, repo: { full_name: "microsoft/aspire-skills" } }
  };
  const paths = [];
  const request = path => { paths.push(path); return pull; };
  assert.deepEqual(resolveReleasePull(repo, f.released, {
    pullNumber: "100", headCommit: f.reviewed, request
  }), { pull: "100", head: f.reviewed });
  assert.deepEqual(paths, ["repos/microsoft/aspire-skills/pulls/100"]);
  assert.equal(fetched.length, 1);
  for (const changed of [
    { merged: false }, { state: "open" }, { number: 101 }, { merge_commit_sha: f.dev },
    { base: { ...pull.base, ref: "dev" } },
    { head: { ...pull.head, ref: "feature/unreviewed" } },
    { head: { ...pull.head, sha: f.dev } },
    { head: { ...pull.head, repo: { full_name: "contributor/aspire-skills" } } }
  ]) {
    assert.throws(() => resolveReleasePull(repo, f.released, {
      pullNumber: "100", headCommit: f.reviewed, request: () => ({ ...pull, ...changed })
    }), /does not match/);
  }
  assert.equal(fetched.length, 1, "Rejected metadata must not fetch another PR head.");
});

function publication(t, f, rows = "") {
  const previousToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "fixture-workflow-token";
  t.after(() => {
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
  });
  f.repo.run(["remote", "add", "origin", "https://github.com/microsoft/aspire-skills.git"]);
  const repo = Object.create(f.repo);
  let releases = [];
  const calls = [];
  repo.run = (args, options) => {
    if (args[0] === "ls-remote") return rows;
    if (args.includes("push")) {
      calls.push({ args });
      rows = `${f.repo.run(["rev-parse", "refs/tags/v0.0.5"]).trim()}\trefs/tags/v0.0.5\n${f.released}\trefs/tags/v0.0.5^{}\n`;
      return "";
    }
    return f.repo.run(args, options);
  };
  const client = {
    request: () => releases,
    run: (args, input) => {
      calls.push({ args, input });
      releases = [{ tag_name: "v0.0.5", body: input, draft: false }];
      return "https://github.com/microsoft/aspire-skills/releases/tag/v0.0.5\n";
    }
  };
  return { repo, client, calls, setReleases: value => { releases = value; } };
}

test("publisher tags the event's exact merged main commit and safely reuses that immutable tag and release", t => {
  const f = releaseCycle(fixture(t));
  f.write("after-release.txt", "Main advanced before publication.\n");
  const newerMain = f.commit();
  const mock = publication(t, f);
  const result = publishSourceRelease(mock.repo, f.validated, mock.client);
  assert.notEqual(newerMain, f.released);
  assert.equal(f.repo.sha("refs/tags/v0.0.5"), f.released);
  assert.equal(result.tag, "v0.0.5");
  assert.equal(mock.calls.length, 2);
  const creation = mock.calls.find(call => call.args[0] === "release");
  assert.ok(creation.args.includes("--verify-tag"));
  assert.equal(creation.args[creation.args.indexOf("--target") + 1], f.released);
  assert.equal(creation.input, "### Added\n- Selected development feature.\n");
  publishSourceRelease(mock.repo, f.validated, mock.client);
  assert.equal(mock.calls.length, 2);
  mock.setReleases([{ tag_name: "v0.0.5", body: "Changed notes.", draft: false }]);
  assert.throws(() => publishSourceRelease(mock.repo, f.validated, mock.client), /notes that do not match/);
  mock.setReleases([{ tag_name: "v0.0.5", body: creation.input, draft: true }]);
  assert.throws(() => publishSourceRelease(mock.repo, f.validated, mock.client), /draft GitHub release/);
});

test("publisher refuses to move a colliding tag or silently accept failed release creation", t => {
  const f = releaseCycle(fixture(t));
  const mock = publication(t, f, `${f.dev}\trefs/tags/v0.0.5\n`);
  assert.throws(() => publishSourceRelease(mock.repo, f.validated, mock.client), /must not be rewritten/);
  assert.equal(mock.calls.length, 0);
  const noTag = Object.create(mock.repo);
  noTag.run = (args, options) => args[0] === "ls-remote" ? "" : mock.repo.run(args, options);
  assert.throws(() => publishSourceRelease(noTag, f.validated, {
    request: () => [], run: () => { throw new Error("Publication denied."); }
  }), /Publication denied/);
});
