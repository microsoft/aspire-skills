import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Repository } from "../.github/skills/release/scripts/git.mjs";
import { checkPull, prepareLocalRelease, validatePublished } from "../.github/skills/release/scripts/candidates.mjs";
import { latestRelease, publishedBaseline, releaseMessage } from "../.github/skills/release/scripts/changelog.mjs";
import { prepareDevelopmentVersion } from "../.github/skills/release/scripts/prepare-development.mjs";
import { updateVersion, versionManifests, versionSnapshot } from "../.github/skills/release/scripts/versions.mjs";

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

function releaseCycle(f) {
  const { repo, root, write, commit, track } = f;
  initialize(f);
  write("shipped.txt", "Selected development feature.\n");
  const source = commit("Feature selected for release");
  track("dev");
  repo.run(["switch", "--quiet", "-c", "release/0.0.5", "main"]);
  const prepared = prepareLocalRelease(repo, { releaseVersion: "0.0.5", sourceCommit: source, remote: "origin" });
  const pending = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  write("CHANGELOG.md", pending.replace("aspire-skills-changelog from=", "aspire-skills-changelog-done from=")
    .replace(/^_User-facing release notes are pending\..+_$/m, "### Added\n- Selected development feature."));
  const message = releaseMessage(prepared);
  const reviewed = commit(`${message.title}\n\n${message.body}\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>\nCopilot-Session: 3fabff6b-b957-46d0-882a-7a42346d87e3`);
  checkPull(repo, { target: "main", headBranch: "release/0.0.5", headCommit: reviewed });
  repo.run(["switch", "--quiet", "-c", "bump-dev/0.0.6", "dev"]);
  prepareDevelopmentVersion(repo, "0.0.6");
  const bump = commit("Advance dev to 0.0.6");
  checkPull(repo, { target: "dev", headBranch: "bump-dev/0.0.6", headCommit: bump, baseCommit: source });
  repo.run(["switch", "--quiet", "dev"]);
  repo.run(["merge", "--quiet", "--no-ff", "bump-dev/0.0.6", "-m", "Advance development"]);
  write("newer.txt", "Work after the release cut.\n");
  write(".plugin/plugin.json", '{\n  "name": "aspire",\n  "version": "0.0.6",\n  "description": "Newer dev manifest content"\n}\n');
  const dev = commit("Continue development");
  track("dev");
  repo.run(["switch", "--quiet", "main"]);
  repo.run(["merge", "--quiet", "--squash", "release/0.0.5"]);
  const released = commit("Release approved by maintainer");
  track("main");
  const validated = validatePublished(repo, released, { headCommit: reviewed });
  return { ...f, source, reviewed, dev, released, validated };
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

test("legacy baseline uses the exact published tag without rewriting historical notes", t => {
  const f = fixture(t);
  const baseline = publishedBaseline(f.repo, f.main);
  assert.equal(baseline.version, "0.0.4");
  assert.equal(baseline.source, f.legacy);
  assert.equal(f.repo.read(f.main, "CHANGELOG.md").toString(), f.history);
  f.repo.run(["tag", "--delete", "v0.0.4"]);
  assert.throws(() => publishedBaseline(f.repo, f.main), /git rev-parse failed/);
});

test("legacy initialization advances versions, removes catalogs, and preserves all source and history", t => {
  const f = fixture(t);
  f.write("opencode/v2/index.json", "Legacy generated catalog.\n");
  const main = f.commit("Generated main content");
  f.main = main;
  f.track("main");
  f.repo.run(["branch", "--force", "dev", "main"]);
  f.track("dev");
  initialize(f);
  assert.equal(versionSnapshot(f.repo, f.repo.sha("dev")).version, "0.0.5");
  assert.equal(f.repo.files(f.repo.sha("dev"), ["opencode"]).size, 0);
  assert.equal(f.repo.read(f.repo.sha("dev"), "CHANGELOG.md").toString(), f.history);
  assert.equal(f.repo.read(f.repo.sha("dev"), "tooling.txt").toString(), "Approved release infrastructure.\n");
});

test("release cut, next-version development, exact squash publication, and backflow preserve the intended trees", t => {
  const f = releaseCycle(fixture(t));
  const { repo } = f;
  assert.equal(f.validated.release, f.released);
  assert.equal(f.validated.source, f.source);
  assert.equal(f.validated.from, f.legacy);
  assert.equal(versionSnapshot(repo, f.released).version, "0.0.5");
  assert.equal(versionSnapshot(repo, f.dev).version, "0.0.6");
  assert.equal(repo.files(f.released, ["newer.txt"]).size, 0);
  assert.ok(repo.files(f.released, ["opencode"]).size > 0);
  const changelog = repo.read(f.released, "CHANGELOG.md").toString();
  assert.ok(changelog.endsWith(f.history.slice(f.history.indexOf("## "))));
  assert.equal(latestRelease(changelog).source, f.source);
  const head = backflow(f);
  checkPull(repo, { target: "dev", headBranch: "backport/pr-100-to-dev", headCommit: head, baseCommit: f.dev });
  assert.equal(versionSnapshot(repo, head).version, "0.0.6");
  assert.equal(repo.read(head, "CHANGELOG.md").toString(), changelog);
  assert.equal(repo.read(head, "newer.txt").toString(), "Work after the release cut.\n");
  assert.match(repo.read(head, ".plugin/plugin.json").toString(), /Newer dev manifest content/);
  assert.equal(repo.files(head, ["opencode"]).size, 0);
  assert.ok(repo.ancestor(f.released, head));
  repo.run(["switch", "--quiet", "dev"]);
  repo.run(["merge", "--quiet", "--no-ff", "backport/pr-100-to-dev", "-m", "Accept reviewed backflow"]);
  f.track("dev");
  checkPull(repo, { target: "dev", headCommit: repo.sha("dev") });
  repo.requireFirstParent(f.source, repo.sha("dev"));
  const nextSource = repo.sha("dev");
  repo.run(["switch", "--quiet", "-c", "release/0.0.6", "main"]);
  const next = prepareLocalRelease(repo, { releaseVersion: "0.0.6", sourceCommit: nextSource, remote: "origin" });
  assert.equal(next.from, f.source);
  assert.equal(next.source, nextSource);
  assert.equal(next.baselineVersion, "0.0.5");
  assert.equal(versionSnapshot(repo, repo.run(["write-tree"]).trim()).version, "0.0.6");
  assert.ok(readFileSync(join(f.root, "CHANGELOG.md"), "utf8").endsWith(changelog.slice(changelog.indexOf("## "))));
});

test("dev backflow rejects a coordinated downgrade even when newer work and changelog survive", t => {
  const f = releaseCycle(fixture(t));
  backflow(f);
  for (const [path, contents] of versionManifests(f.repo, f.repo.sha("HEAD"))) {
    f.write(path, updateVersion(contents, path, "0.0.5"));
  }
  const head = f.commit("Incorrectly downgrade dev");
  assert.throws(() => checkPull(f.repo, {
    target: "dev", headBranch: "backport/pr-100-to-dev", headCommit: head, baseCommit: f.dev
  }), /preserve dev's current version/);
});

test("dev backflow rejects dropped cleanly mergeable source", t => {
  const f = releaseCycle(fixture(t));
  backflow(f);
  f.repo.run(["rm", "--quiet", "--", "newer.txt"]);
  const head = f.commit("Drop newer work");
  assert.throws(() => checkPull(f.repo, {
    target: "dev", headBranch: "backport/pr-100-to-dev", headCommit: head, baseCommit: f.dev
  }), /Backflow follow-ups may only/);
});

test("dev backflow rejects rewritten approved changelog and missing merge ancestry", t => {
  const f = releaseCycle(fixture(t));
  const head = backflow(f);
  f.write("CHANGELOG.md", f.repo.read(head, "CHANGELOG.md").toString().replace("Selected development feature.", "Different notes."));
  const changed = f.commit("Rewrite published notes");
  assert.throws(() => checkPull(f.repo, {
    target: "dev", headBranch: "backport/pr-100-to-dev", headCommit: changed, baseCommit: f.dev
  }), /copy main's approved CHANGELOG/);
  const squashed = f.repo.commitTree(f.repo.run(["rev-parse", `${head}^{tree}`]).trim(), [f.dev], "Squashed backflow");
  assert.throws(() => checkPull(f.repo, {
    target: "dev", headBranch: "backport/pr-100-to-dev", headCommit: squashed, baseCommit: f.dev
  }), /must be an ancestor/);
});

test("development version preparation rejects unrelated branches, dirty trees, and nonadvancing versions", t => {
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
  const head = f.commit("Version bump");
  assert.throws(() => checkPull(f.repo, {
    target: "dev", headBranch: "feature/ordinary", headCommit: head, baseCommit: base
  }), /must preserve their dev baseline's version/);
  f.write("CHANGELOG.md", `${f.history}\nUnapproved development notes.\n`);
  const changed = f.commit("Edit notes");
  assert.throws(() => checkPull(f.repo, {
    target: "dev", headBranch: "bump-dev/0.0.6", headCommit: changed, baseCommit: base
  }), /without changing source or changelog/);
});
