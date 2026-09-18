import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildCatalog } from "../scripts/build-opencode-catalog.mjs";
import {
  checkRelease, createReleaseBody as createVersionedBody, createReleaseChangelog as createVersionedChangelog,
  prepareRelease as prepareVersionedRelease, receiveRelease, resolveReleaseSource, validateReleaseVersion, hasProductChanges
} from "../scripts/release.mjs";
import { releaseVersionFiles, manifestVersion, updateManifestVersion } from "../scripts/release-version.mjs";

const prepareRelease = (root, options) => prepareVersionedRelease(root, { releaseVersion: "0.0.3", ...options });
const createReleaseBody = (root, source, base, version = "0.0.3") => createVersionedBody(root, source, base, version);
const createReleaseChangelog = (root, source, base, version = "0.0.3") => createVersionedChangelog(root, source, base, version);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const oldChangelog = "# Changelog\n\nHistorical introduction.\n\n## 0.0.1\n\n- The original release.\n";
const gitEnv = {
  ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_DATE: "2026-09-17T12:00:00Z", GIT_COMMITTER_DATE: "2026-09-17T12:00:00Z"
};

function git(root, ...args) {
  const result = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], {
    cwd: root, encoding: "utf8", env: gitEnv
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function put(root, path, value) {
  const target = join(root, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
}

function save(root, subject) {
  git(root, "add", "--all");
  git(root, "commit", "-qm", subject);
  return git(root, "rev-parse", "HEAD");
}

function putVersions(root, version) {
  for (const path of releaseVersionFiles) {
    const document = path.endsWith("/marketplace.json")
      ? { plugins: [{ name: "unrelated", version: "5.0.0" }, { name: "aspire", version }] }
      : { name: path === "package.json" ? "aspire-skills" : "aspire", version };
    put(root, path, `${JSON.stringify(document, null, 2)}\n`);
  }
  const skill = "skills/aspire/SKILL.md";
  if (existsSync(join(root, skill))) {
    put(root, skill, updateManifestVersion(readFileSync(join(root, skill)), skill, version));
  }
}

function emptyRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "aspire-release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "--initial-branch=main");
  git(root, "config", "user.name", "Release Test");
  git(root, "config", "user.email", "release-test@example.invalid");
  return root;
}

function fixture(t) {
  const root = emptyRepo(t);
  put(root, ".gitignore", "dist/\n");
  putVersions(root, "0.0.1");
  put(root, "CHANGELOG.md", oldChangelog);
  put(root, "skills/aspire/SKILL.md", "---\nname: aspire\ndescription: Release fixture\nmetadata:\n  version: \"0.0.1\"\n---\n\n[Guide](references/guide.md)\n");
  put(root, "skills/aspire/references/guide.md", "[Back](../SKILL.md)\n");
  put(root, "source.txt", "initial source\n");
  const base = save(root, "Initial released source");
  git(root, "update-ref", "refs/remotes/origin/main", base);
  git(root, "switch", "-qc", "dev");
  rmSync(join(root, "CHANGELOG.md"));
  putVersions(root, "0.0.2");
  put(root, "skills/aspire/references/guide.md", "Development guide. [Back](../SKILL.md)\n");
  put(root, "source.txt", "development source\n");
  const source = save(root, "Develop skills <safely> [with links]");
  git(root, "update-ref", "refs/remotes/origin/dev", source);
  return { root, base, source };
}

function check(root, options = {}) {
  return checkRelease(root, { target: "main", head: "release/candidate", ...options });
}

function prepared(t) {
  const fixtureData = fixture(t);
  return { ...fixtureData, ...prepareRelease(fixtureData.root) };
}

function receiver(t, sourceRoot, result) {
  const root = emptyRepo(t);
  git(root, "fetch", "--no-tags", sourceRoot,
    "refs/heads/main:refs/remotes/origin/main", "refs/heads/dev:refs/remotes/origin/dev");
  git(root, "switch", "--detach", "origin/main");
  return {
    root,
    options: {
      bundlePath: join(sourceRoot, "dist", "release", "release.bundle"),
      prBodyPath: join(sourceRoot, "dist", "release", "pr-body.md"),
      sourceCommit: result.source, baseCommit: result.base, candidateCommit: result.candidate, releaseVersion: result.version
    }
  };
}

test("initial release merges selected dev while preserving main history and branch tips", t => {
  const { root, base, source, candidate } = prepared(t);
  assert.equal(git(root, "rev-parse", "main"), base);
  assert.equal(git(root, "rev-parse", "dev"), source);
  assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD"), "release/candidate");
  assert.deepEqual(git(root, "show", "-s", "--format=%P", candidate).split(" "), [base, source]);
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  assert.ok(changelog.startsWith("# Changelog\n\nHistorical introduction.\n\n## v0.0.3 - 2026-09-17"));
  assert.ok(changelog.endsWith(oldChangelog.slice(oldChangelog.indexOf("## "))));
  assert.ok(changelog.includes(`<!-- aspire-skills-release source=${source} base=${base} version=0.0.3 source-version=0.0.2 base-version=0.0.1 -->`));
  assert.match(changelog, /Develop skills &lt;safely&gt; \\\[with links\\\]/);
  assert.equal(changelog, createReleaseChangelog(root, source, base));
  assert.deepEqual(check(root, { baseCommit: base, prBody: createReleaseBody(root, source, base) }), { source, base, candidate, version: "0.0.3" });
  assert.equal(check(root, { head: "release/0.0.3" }).candidate, candidate);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(git(root, "ls-tree", "--name-only", "dev", "--", "opencode", "CHANGELOG.md"), "");
  assert.ok(existsSync(join(root, "dist", "release", "release.bundle")));
  assert.deepEqual(JSON.parse(readFileSync(join(root, "dist", "release", "release.json"))), { source, base, candidate, version: "0.0.3" });
  for (const path of [...releaseVersionFiles, "skills/aspire/SKILL.md"]) {
    assert.equal(manifestVersion(readFileSync(join(root, path)), path), "0.0.3");
    assert.equal(manifestVersion(Buffer.from(git(root, "show", `dev:${path}`)), path), "0.0.2");
  }
});

test("subsequent source-only dev releases preserve release history without add/add conflicts", t => {
  const first = prepared(t);
  const { root } = first;
  const oldRelease = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  git(root, "switch", "main");
  git(root, "merge", "--no-ff", "--no-edit", "release/candidate");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", base);
  git(root, "branch", "-d", "release/candidate");
  git(root, "switch", "dev");
  assert.equal(existsSync(join(root, "CHANGELOG.md")), false);
  assert.equal(existsSync(join(root, "opencode", "v2", "index.json")), false);
  put(root, "skills/aspire/references/guide.md", "Second version. [Back](../SKILL.md)\n");
  const source = save(root, "Improve reference");
  git(root, "update-ref", "refs/remotes/origin/dev", source);
  const second = prepareRelease(root, { releaseVersion: "0.0.4" });
  assert.equal(second.base, base);
  assert.equal(second.source, source);
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  assert.ok(changelog.endsWith(oldRelease.slice(oldRelease.indexOf("## "))));
  assert.equal(changelog.match(/Improve reference/g)?.length, 1);
  assert.equal(changelog.match(/Develop skills/g)?.length, 1);
  assert.equal(git(root, "rev-parse", "dev"), source);
  check(root, { baseCommit: base });
});

test("default source resolves once and an older pinned dev snapshot remains valid", t => {
  const { root, source, base } = fixture(t);
  assert.equal(resolveReleaseSource(root), source);
  put(root, "source.txt", "newer dev head\n");
  const newer = save(root, "Newer development");
  git(root, "update-ref", "refs/remotes/origin/dev", newer);
  assert.equal(resolveReleaseSource(root), newer);
  assert.equal(resolveReleaseSource(root, source.toUpperCase()), source);
  const result = prepareRelease(root, { sourceCommit: source, baseCommit: base });
  assert.equal(result.source, source);
  assert.equal(git(root, "show", "HEAD:source.txt"), "development source");
  assert.doesNotMatch(readFileSync(join(root, "CHANGELOG.md"), "utf8"), /Newer development/);
  check(root, { baseCommit: base });
});

test("source resolution rejects malformed, abbreviated, nonexistent, unrelated, and tag SHAs", t => {
  const { root, base, source } = fixture(t);
  for (const requested of ["dev", "origin/dev", source.slice(0, 12), "--all", "../dev", `${source}\necho bad`, "0".repeat(40)]) {
    assert.throws(() => resolveReleaseSource(root, requested));
  }
  git(root, "tag", "-a", "snapshot", "-m", "tag", source);
  assert.throws(() => resolveReleaseSource(root, git(root, "rev-parse", "snapshot")), /not a tag/);
  git(root, "switch", "--detach", base);
  put(root, "other.txt", "unrelated history");
  const unrelated = save(root, "Not in dev");
  assert.throws(() => resolveReleaseSource(root, unrelated), /ancestor/);
});

test("all dev checks reject root catalogs or changelogs, including selected older sources", t => {
  const { root } = fixture(t);
  checkRelease(root, { target: "dev" });
  const valid = git(root, "rev-parse", "HEAD");
  for (const path of ["CHANGELOG.md", "opencode/v1/index.json", "opencode/v2/index.json"]) {
    git(root, "switch", "--detach", valid);
    put(root, path, "development copies are forbidden");
    const source = save(root, `Add ${path}`);
    git(root, "update-ref", "refs/remotes/origin/dev", source);
    assert.throws(() => checkRelease(root, { target: "dev" }), /release-owned/);
    assert.throws(() => resolveReleaseSource(root, source), /release-owned/);
  }
});

test("main checks reject direct dev PRs, wrong branch names, and unknown targets", t => {
  const { root } = fixture(t);
  assert.throws(() => check(root, { head: "dev" }), /Direct dev -> main/);
  for (const head of ["feature/test", "main", "release", "release/", "release/a/b", "release/-option", "release/a\nx"]) {
    assert.throws(() => check(root, { head }), /prepared release/);
  }
  assert.throws(() => check(root, { target: "other" }), /target main or dev/);
  assert.throws(() => check(root), /regular CHANGELOG/);
});

test("preparation rejects unstaged, staged, and untracked source drift without switching branch", t => {
  const { root } = fixture(t);
  put(root, "source.txt", "dirty");
  assert.throws(() => prepareRelease(root), /clean worktree/);
  git(root, "add", "source.txt");
  assert.throws(() => prepareRelease(root), /clean worktree/);
  save(root, "Staged change");
  put(root, "untracked.txt", "unexpected");
  assert.throws(() => prepareRelease(root), /clean worktree/);
  assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD"), "dev");
});

test("preparation fails explicitly on source conflicts without resolving or committing them", t => {
  const { root, source } = fixture(t);
  git(root, "switch", "main");
  put(root, "source.txt", "conflicting released source");
  const base = save(root, "Main source diverges");
  git(root, "update-ref", "refs/remotes/origin/main", base);
  assert.throws(() => prepareRelease(root), /Resolve source conflicts/);
  assert.equal(git(root, "diff", "--name-only", "--diff-filter=U"), "source.txt");
  assert.equal(git(root, "rev-parse", "main"), base);
  assert.equal(git(root, "rev-parse", "dev"), source);
});

test("preparation rejects a clean merge that would retain main-only source drift", t => {
  const { root } = fixture(t);
  git(root, "switch", "main");
  put(root, "only-on-main.txt", "not part of selected source");
  const base = save(root, "Main source-only addition");
  git(root, "update-ref", "refs/remotes/origin/main", base);
  assert.throws(() => prepareRelease(root), /source differs/);
  assert.equal(git(root, "rev-parse", "HEAD"), base, "no release commit on source mismatch");
});

test("only release-owned merge conflicts may be resolved automatically", t => {
  const { root } = fixture(t);
  git(root, "switch", "main");
  put(root, "CHANGELOG.md", `${oldChangelog}\n## Later historical main entry\n\n- Keep this too.\n`);
  const base = save(root, "Main changelog history");
  git(root, "update-ref", "refs/remotes/origin/main", base);
  const result = prepareRelease(root);
  assert.equal(result.base, base);
  assert.match(readFileSync(join(root, "CHANGELOG.md"), "utf8"), /Later historical main entry/);
  check(root);
});

test("catalog checks reject both formats' tampered content, hashes, lists, paths, and CRLF blob bytes", t => {
  const { root, candidate } = prepared(t);
  for (const format of ["v1", "v2"]) {
    for (const mutation of ["content", "hash", "files", "path", "missing", "extra", "crlf"]) {
      git(root, "switch", "--detach", candidate);
      const entry = `opencode/${format}/aspire/${format === "v1" ? "SKILL.md" : "aspire.md"}`;
      const indexPath = `opencode/${format}/index.json`;
      const index = JSON.parse(readFileSync(join(root, indexPath), "utf8"));
      if (mutation === "content") put(root, entry, "tampered");
      if (mutation === "missing") rmSync(join(root, entry));
      if (mutation === "extra") put(root, `opencode/${format}/extra.md`, "extra");
      if (mutation === "crlf") put(root, entry, readFileSync(join(root, entry), "utf8").replaceAll("\n", "\r\n"));
      if (mutation === "hash") index.skills[0].version = `sha512-${"a".repeat(128)}`;
      if (mutation === "files") index.skills[0].files.pop();
      if (mutation === "path") index.skills[0].files.push("../escape");
      if (["hash", "files", "path"].includes(mutation)) put(root, indexPath, `${JSON.stringify(index, null, 2)}\n`);
      save(root, `Tamper ${format} ${mutation}`);
      assert.throws(() => check(root), /OpenCode catalog/);
    }
  }
});

test("release object checks reject source drift and executable or symlink catalog entries", t => {
  const { root, candidate } = prepared(t);
  put(root, "source.txt", "tampered source");
  save(root, "Source mismatch");
  assert.throws(() => check(root), /source differs/);
  git(root, "switch", "--detach", candidate);
  chmodSync(join(root, "opencode", "v2", "aspire", "aspire.md"), 0o755);
  git(root, "update-index", "--chmod=+x", "opencode/v2/aspire/aspire.md");
  git(root, "commit", "-qm", "Change published mode");
  assert.throws(() => check(root), /OpenCode catalog/);
  git(root, "switch", "--detach", candidate);
  const oid = git(root, "rev-parse", "HEAD:source.txt");
  git(root, "update-index", "--cacheinfo", `120000,${oid},opencode/v2/aspire/aspire.md`);
  git(root, "commit", "-qm", "Symlink catalog entry");
  assert.throws(() => check(root), /OpenCode catalog/);
});

test("changelog checks reject wrong provenance, range, history, ordering, and body metadata", t => {
  const { root, candidate, source, base } = prepared(t);
  const correct = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const changes = [
    correct.replace(source, base),
    correct.replace(`base=${base}`, `base=${source}`),
    correct.replace("- The original release.", "- History was changed."),
    correct.replace("Develop skills", "Wrong range"),
    correct.replace(/^## [^\n]+\n/m, match => `${match}\n`),
    correct.replace("version=0.0.3", "version=9.9.9"),
    correct.replace("source-version=0.0.2", "source-version=9.9.9"),
    correct.replace("base-version=0.0.1", "base-version=9.9.9"),
    correct.replace(" version=0.0.3 source-version=0.0.2 base-version=0.0.1", ""),
    `${oldChangelog}\n${correct.slice(correct.indexOf("## "))}`
  ];
  for (const changelog of changes) {
    git(root, "switch", "--detach", candidate);
    put(root, "CHANGELOG.md", changelog);
    save(root, "Wrong changelog");
    assert.throws(() => check(root));
  }
  git(root, "switch", "--detach", candidate);
  for (const prBody of ["", "not recorded", createReleaseBody(root, source, base).replace(source, base),
    createReleaseBody(root, source, base).replace("version=0.0.3", "version=9.9.9")]) {
    assert.throws(() => check(root, { prBody }), /PR body/);
  }
  check(root, { prBody: createReleaseBody(root, source, base), headCommit: candidate, baseCommit: base });
});

test("squashing or rebasing away the source ancestry fails even with an identical tree", t => {
  const { root, base } = prepared(t);
  const tree = git(root, "rev-parse", "HEAD^{tree}");
  const squashed = git(root, "commit-tree", tree, "-p", base, "-m", "Squashed release");
  assert.throws(() => check(root, { headCommit: squashed }), /ancestor/);
});

test("changed main baseline and an already released source require a new release selection", t => {
  const { root, candidate, base, source } = prepared(t);
  git(root, "switch", "main");
  git(root, "merge", "--no-ff", "--no-edit", "release/candidate");
  const advanced = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", advanced);
  assert.throws(() => check(root, { headCommit: candidate, baseCommit: advanced }), /baseline changed/);
  assert.throws(() => check(root, { headCommit: candidate, baseCommit: base }), /baseline changed/);
  assert.throws(() => prepareRelease(root, { sourceCommit: source, baseCommit: base }), /baseline changed/);
  assert.throws(() => prepareRelease(root, { sourceCommit: source }), /already been released/);
  checkRelease(root, { target: "main", headCommit: advanced });
});

test("checks inspect exact Git objects rather than mutable checkout or synthetic merge contents", t => {
  const { root, source, candidate } = prepared(t);
  put(root, "source.txt", "unstaged workspace changes");
  put(root, "opencode/v2/aspire/aspire.md", "unstaged catalog changes");
  check(root, { headCommit: candidate });
  checkRelease(root, { target: "dev", headCommit: source });
});

test("bundle receiver validates provenance without checking out or executing selected code", t => {
  const original = fixture(t);
  put(original.root, "package.json", '{"version":"0.0.2","scripts":{"test":"exit 123"}}\n');
  const source = save(original.root, "Include source code that must not run in receiver");
  git(original.root, "update-ref", "refs/remotes/origin/dev", source);
  const result = prepareRelease(original.root);
  const { root, options } = receiver(t, original.root, result);
  const before = git(root, "rev-parse", "HEAD");
  assert.deepEqual(receiveRelease(root, options), result);
  assert.equal(git(root, "rev-parse", "HEAD"), before);
  assert.equal(existsSync(join(root, "opencode")), false);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), { name: "aspire-skills", version: "0.0.1" });
  assert.equal(git(root, "rev-parse", "release/candidate"), result.candidate);
  assert.throws(() => receiveRelease(root, options), /already has a release candidate/);
});

test("bundle receiver rejects invalid SHA inputs and unexpected or extra refs", t => {
  const result = prepared(t);
  const { root, options } = receiver(t, result.root, result);
  for (const key of ["sourceCommit", "baseCommit", "candidateCommit"]) {
    assert.throws(() => receiveRelease(root, { ...options, [key]: "--all" }), /full Git commit SHA/);
  }
  assert.throws(() => receiveRelease(root, { ...options, candidateCommit: result.base }), /advertise only/);
  const alternate = join(result.root, "dist", "release", "extra.bundle");
  git(result.root, "bundle", "create", alternate, "release/candidate", "dev");
  assert.throws(() => receiveRelease(root, { ...options, bundlePath: alternate }), /advertise only/);
  writeFileSync(alternate, "not a git bundle");
  assert.throws(() => receiveRelease(root, { ...options, bundlePath: alternate }), /failed/);
});

test("bundle receiver rejects modified PR artifacts and inconsistent preparation outputs", t => {
  const result = prepared(t);
  const first = receiver(t, result.root, result);
  const body = readFileSync(first.options.prBodyPath, "utf8");
  writeFileSync(first.options.prBodyPath, `${body}\nInjected instructions\n`);
  assert.throws(() => receiveRelease(first.root, first.options), /body artifact has been modified/);
  writeFileSync(first.options.prBodyPath, body);
  const second = receiver(t, result.root, result);
  assert.throws(() => receiveRelease(second.root, { ...second.options, sourceCommit: result.base, releaseVersion: "0.0.1" }), /provenance/);
});

test("bundle receiver rejects catalog tampering even when the supplied candidate SHA matches", t => {
  const result = prepared(t);
  put(result.root, "opencode/v2/aspire/aspire.md", "malicious bytes");
  const tampered = save(result.root, "Tamper bundle");
  const bundlePath = join(result.root, "dist", "release", "tampered.bundle");
  git(result.root, "bundle", "create", bundlePath, "release/candidate", `^${result.base}`);
  const { root, options } = receiver(t, result.root, result);
  assert.throws(() => receiveRelease(root, { ...options, bundlePath, candidateCommit: tampered }), /OpenCode catalog/);
});

test("release catalogs preserve binary Git bytes and normalize source text regardless of checkout", t => {
  const { root } = fixture(t);
  const binary = Buffer.from([0xff, 0xfe, 0x0d, 0x0a, 0x00]);
  put(root, "skills/aspire/assets/binary.md", binary);
  put(root, "skills/aspire/scripts/run.sh", "#!/bin/sh\r\necho release\r\n");
  const source = save(root, "Add binary and text assets");
  git(root, "update-ref", "refs/remotes/origin/dev", source);
  prepareRelease(root);
  for (const format of ["v1", "v2"]) {
    assert.deepEqual(readFileSync(join(root, "opencode", format, "aspire", "assets", "binary.md")), binary);
    assert.equal(readFileSync(join(root, "opencode", format, "aspire", "scripts", "run.sh"), "utf8"),
      "#!/bin/sh\necho release\n");
  }
  check(root);
});

test("generator release mode writes only the explicitly selected output root and rejects symlinks", t => {
  const { root } = fixture(t);
  buildCatalog(root);
  const local = readFileSync(join(root, "dist", "opencode", "v2", "index.json"));
  buildCatalog(root, { release: true });
  buildCatalog(root, { release: true, check: true });
  assert.deepEqual(readFileSync(join(root, "opencode", "v2", "index.json")), local);
  rmSync(join(root, "opencode"), { recursive: true });
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(root, "opencode"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => buildCatalog(root, { release: true }), /Symbolic links/);
});

test("CLI resolves SHA outputs and dev checks in a specified disposable repository", t => {
  const { root, source, base } = fixture(t);
  const output = join(root, "dist", "outputs");
  mkdirSync(dirname(output), { recursive: true });
  const script = join(repoRoot, "scripts", "release.mjs");
  const env = { ...gitEnv, RELEASE_REPO: root, GITHUB_OUTPUT: output, SOURCE_COMMIT: source, RELEASE_VERSION: "0.0.3" };
  const result = spawnSync(process.execPath, [script, "resolve"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), `source=${source}\nbase=${base}\nversion=0.0.3\n`);
  const checked = spawnSync(process.execPath, [script, "check"], {
    env: { ...env, TARGET_BRANCH: "dev", HEAD_COMMIT: source }, encoding: "utf8"
  });
  assert.equal(checked.status, 0, checked.stderr);
  const invalid = spawnSync(process.execPath, [script, "prepare", "--unknown"], { env, encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Usage:/);
  assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD"), "dev");
});

test("release tools reject nested roots and ignore ambient Git repository and config overrides", t => {
  const { root, source } = fixture(t);
  const nested = join(root, "nested");
  mkdirSync(nested);
  assert.throws(() => prepareRelease(nested), /not the Git repository root/);
  assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD"), "dev");
  const unrelated = fixture(t);
  const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "release.mjs"), "resolve"], {
    encoding: "utf8",
    env: {
      ...gitEnv, RELEASE_REPO: root, SOURCE_COMMIT: source, RELEASE_VERSION: "0.0.3",
      GIT_DIR: join(unrelated.root, ".git"), GIT_WORK_TREE: unrelated.root,
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.repositoryFormatVersion", GIT_CONFIG_VALUE_0: "invalid",
      GIT_CONFIG_GLOBAL: join(root, "nonexistent-config"), GIT_INDEX_FILE: join(root, "nonexistent-index")
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(source));
  assert.equal(git(unrelated.root, "rev-parse", "--abbrev-ref", "HEAD"), "dev");
});

test("push checks do not require PR body metadata but main PR checks do", t => {
  const { root, candidate } = prepared(t);
  const env = {
    ...gitEnv, RELEASE_REPO: root, TARGET_BRANCH: "main", HEAD_COMMIT: candidate,
    HEAD_BRANCH: "", BASE_COMMIT: "", PR_BODY: ""
  };
  const script = join(repoRoot, "scripts", "release.mjs");
  const push = spawnSync(process.execPath, [script, "check"], { env, encoding: "utf8" });
  assert.equal(push.status, 0, push.stderr);
  const pr = spawnSync(process.execPath, [script, "check"], {
    env: { ...env, HEAD_BRANCH: "release/candidate" }, encoding: "utf8"
  });
  assert.equal(pr.status, 1);
  assert.match(pr.stderr, /PR body/);
});

test("release metadata rejects a missing or invalid package version rather than inventing a fallback", t => {
  const { root, base } = fixture(t);
  const original = git(root, "rev-parse", "HEAD");
  for (const value of [null, "{}", '{"version":"1\\n-->"}', '{"version":2}']) {
    git(root, "switch", "--detach", original);
    if (value === null) rmSync(join(root, "package.json"));
    else put(root, "package.json", value);
    const source = save(root, "Invalid version metadata");
    assert.throws(() => createReleaseChangelog(root, source, base), /Release metadata|valid SemVer/);
  }
});

test("release preparation rejects artifact directory symlinks without changing branches", t => {
  const { root } = fixture(t);
  const outside = emptyRepo(t);
  symlinkSync(outside, join(root, "dist"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => prepareRelease(root), /artifact directory/);
  assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD"), "dev");
  assert.equal(existsSync(join(outside, "release")), false);
});

test("release version is required and must advance both source and main SemVer precedence", t => {
  const { root, source, base } = fixture(t);
  for (const version of [undefined, "", "v0.0.3", "0.0.1", "0.0.2", "0.0.2+build", "0.0.2-rc.1"]) {
    assert.throws(() => prepareVersionedRelease(root, { releaseVersion: version }), /version|SemVer/i);
    assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD"), "dev");
  }
  assert.equal(validateReleaseVersion(root, source, base, "0.0.3-rc.1"), "0.0.3-rc.1");
  const result = prepareRelease(root);
  git(root, "switch", "main");
  git(root, "merge", "--no-ff", "--no-edit", "release/candidate");
  git(root, "switch", "dev");
  put(root, "skills/aspire/references/guide.md", "Another shipped change\n");
  const nextSource = save(root, "Change shipped reference");
  assert.throws(() => validateReleaseVersion(root, nextSource, result.candidate, "0.0.3"), /main baseline/);
});

test("release checks reject arbitrary or incomplete changes inside every version manifest", t => {
  const { root, candidate } = prepared(t);
  for (const path of [...releaseVersionFiles, "skills/aspire/SKILL.md"]) {
    git(root, "switch", "--detach", candidate);
    const original = readFileSync(join(root, path), "utf8");
    put(root, path, original.replace('"0.0.3"', '"0.0.4"'));
    save(root, `Wrong version in ${path}`);
    assert.throws(() => check(root), /permitted version bump/);
    git(root, "switch", "--detach", candidate);
    if (path.endsWith("SKILL.md")) {
      put(root, path, `${original}\nUnapproved skill body changes\n`);
    } else {
      const document = JSON.parse(original);
      document.unapprovedField = "not in selected dev";
      put(root, path, `${JSON.stringify(document, null, 2)}\n`);
    }
    save(root, `Extra field in ${path}`);
    assert.throws(() => check(root), /permitted version bump/);
  }
});

test("preparation refuses unsynchronized canonical source manifests", t => {
  const { root } = fixture(t);
  put(root, "gemini-extension.json", '{"name":"aspire","version":"0.0.1"}\n');
  const source = save(root, "Unsynchronized source");
  git(root, "update-ref", "refs/remotes/origin/dev", source);
  assert.throws(() => prepareRelease(root), /must be synchronized/);
  assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD"), "dev");
});

test("manifest edits on main cannot be discarded under the version-only exception", t => {
  const { root } = fixture(t);
  git(root, "switch", "main");
  put(root, "gemini-extension.json", '{"name":"aspire","version":"0.0.1","mainOnly":true}\n');
  const base = save(root, "Unreconciled main manifest change");
  git(root, "update-ref", "refs/remotes/origin/main", base);
  assert.throws(() => prepareRelease(root), /source conflicts|permitted version bump/);
  assert.equal(git(root, "rev-parse", "main"), base);
});

test("subsequent releases resolve proven version-only conflicts without losing source manifest edits", t => {
  const { root } = prepared(t);
  git(root, "switch", "main");
  git(root, "merge", "--no-ff", "--no-edit", "release/candidate");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "branch", "-d", "release/candidate");
  git(root, "switch", "dev");
  putVersions(root, "0.0.4");
  const gemini = JSON.parse(readFileSync(join(root, "gemini-extension.json"), "utf8"));
  gemini.description = "Selected dev changes must survive the release bump";
  put(root, "gemini-extension.json", `${JSON.stringify(gemini, null, 2)}\n`);
  const source = save(root, "Advance development manifests");
  git(root, "update-ref", "refs/remotes/origin/dev", source);
  const result = prepareRelease(root, { releaseVersion: "0.0.5" });
  assert.equal(result.version, "0.0.5");
  const released = JSON.parse(readFileSync(join(root, "gemini-extension.json"), "utf8"));
  assert.equal(released.description, gemini.description);
  assert.equal(released.version, "0.0.5");
  check(root);
});

test("version bumps preserve plugin mirror symlink objects instead of replacing them with copies", t => {
  const { root } = fixture(t);
  git(root, "config", "core.symlinks", "false");
  const path = ".github/plugins/aspire-skills/gemini-extension.json";
  put(root, path, "../../../gemini-extension.json");
  git(root, "add", path);
  const oid = git(root, "rev-parse", `:${path}`);
  git(root, "update-index", "--cacheinfo", `120000,${oid},${path}`);
  git(root, "commit", "-qm", "Add plugin mirror link");
  git(root, "update-ref", "refs/remotes/origin/dev", "HEAD");
  prepareRelease(root);
  assert.equal(git(root, "ls-tree", "HEAD", "--", path), `120000 blob ${oid}\t${path}`);
  assert.equal(git(root, "show", `HEAD:${path}`), "../../../gemini-extension.json");
});

test("bundle receiver binds the requested release version to the verified candidate", t => {
  const result = prepared(t);
  const { root, options } = receiver(t, result.root, result);
  assert.throws(() => receiveRelease(root, { ...options, releaseVersion: "0.0.4" }), /provenance/);
});

function releasedBaseline(t) {
  const first = prepared(t);
  const { root } = first;
  git(root, "switch", "main");
  git(root, "merge", "--no-ff", "--no-edit", "release/candidate");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", base);
  git(root, "branch", "-d", "release/candidate");
  git(root, "switch", "dev");
  return { ...first, base };
}

test("repository-only promotion requires the unchanged main version and preserves identical catalogs", t => {
  const { root, base } = releasedBaseline(t);
  for (const path of ["README.md", "docs/development.md", "tests/example.test.mjs", "evals/test.yaml",
    ".github/workflows/test.yml", "skills/aspire/evals/eval.yaml", "extensions/example/tests/example.test.mjs",
    "hooks/tests/hook.test.mjs", ".plugin/tests/plugin.test.mjs"]) {
    put(root, path, "Repository-only change\n");
  }
  const source = save(root, "Update repository maintenance");
  git(root, "update-ref", "refs/remotes/origin/dev", source);
  assert.equal(hasProductChanges(root, source, base), false);
  assert.throws(() => validateReleaseVersion(root, source, base), /valid SemVer/);
  assert.equal(validateReleaseVersion(root, source, base, "0.0.3"), "0.0.3");
  assert.throws(() => validateReleaseVersion(root, source, base, "0.0.4"), /Repository-only/);
  const result = prepareVersionedRelease(root, { releaseVersion: "0.0.3" });
  assert.equal(result.version, "0.0.3");
  for (const path of [...releaseVersionFiles, "skills/aspire/SKILL.md"]) {
    assert.equal(manifestVersion(readFileSync(join(root, path)), path), "0.0.3");
  }
  assert.equal(git(root, "diff", "--name-only", base, "HEAD", "--", "opencode"), "");
  check(root);
  put(root, "CHANGELOG.md", readFileSync(join(root, "CHANGELOG.md"), "utf8").replace("version=0.0.3", "version=0.0.4"));
  save(root, "Attempt unnecessary version bump");
  assert.throws(() => check(root), /Repository-only/);
});

test("product detection includes skill references, canvas payloads, plugin metadata, hooks and catalog packaging", t => {
  const { root, base, source: previousSource } = releasedBaseline(t);
  for (const path of ["skills/aspire/references/guide.md", "extensions/example/extension.mjs",
    "extensions/example/README.md", "hooks/scripts/track-telemetry.sh", ".plugin/settings.json",
    ".github/plugins/aspire-skills/.plugin/extra.json", "scripts/build-opencode-catalog.mjs"]) {
    git(root, "switch", "--detach", previousSource);
    put(root, path, "Shipped content change\n");
    const source = save(root, `Update ${path}`);
    assert.equal(hasProductChanges(root, source, base), true, path);
    assert.throws(() => validateReleaseVersion(root, source, base), /valid SemVer/);
    assert.equal(validateReleaseVersion(root, source, base, "0.0.4"), "0.0.4");
  }
});

test("canvas-only release advances every semantic version including unchanged skill metadata", t => {
  const { root, base } = releasedBaseline(t);
  put(root, "extensions/example/extension.mjs", "export const canvas = true;\n");
  const source = save(root, "Add canvas behavior");
  git(root, "update-ref", "refs/remotes/origin/dev", source);
  assert.equal(hasProductChanges(root, source, base), true);
  const result = prepareVersionedRelease(root, { releaseVersion: "0.0.4" });
  assert.equal(result.version, "0.0.4");
  for (const path of [...releaseVersionFiles, "skills/aspire/SKILL.md"]) {
    assert.equal(manifestVersion(readFileSync(join(root, path)), path), "0.0.4");
  }
  assert.match(readFileSync(join(root, "opencode", "v2", "aspire", "aspire.md"), "utf8"), /version: "0.0.4"/);
  assert.notEqual(git(root, "rev-parse", `${base}:opencode/v2/index.json`), git(root, "rev-parse", "HEAD:opencode/v2/index.json"));
  check(root);
});

test("initial source-only cleanup finalizes 0.0.2 Unreleased notes without a bump or duplicate section", t => {
  const { root } = fixture(t);
  git(root, "switch", "main");
  git(root, "merge", "--no-ff", "--no-edit", "dev");
  const history = "## [0.0.1] - 2026-05-27\n\n- Historical release notes.\n";
  const notes = "### Changed\n- Deliver releases through main.\n\n### Added\n- OpenCode catalogs and canvas updates.\n";
  put(root, "CHANGELOG.md", `# Changelog\n\nIntroductory text.\n\n## [0.0.2] - Unreleased\n\n${notes}\n${history}`);
  const base = save(root, "Install release automation on main");
  git(root, "update-ref", "refs/remotes/origin/main", base);
  git(root, "switch", "-c", "setup-dev");
  rmSync(join(root, "CHANGELOG.md"));
  const source = save(root, "Keep dev source-only");
  git(root, "update-ref", "refs/remotes/origin/dev", source);
  const result = prepareVersionedRelease(root, { releaseVersion: "0.0.2" });
  assert.equal(result.version, "0.0.2");
  assert.equal(git(root, "rev-parse", "main"), base);
  assert.equal(git(root, "rev-parse", "setup-dev"), source);
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /^# Changelog\n\nIntroductory text\.\n\n## v0\.0\.2 - /);
  assert.equal(changelog.match(/^## v0\.0\.2 /gm)?.length, 1);
  assert.doesNotMatch(changelog, /Unreleased/);
  assert.ok(changelog.includes(notes));
  assert.ok(changelog.endsWith(history));
  assert.ok(changelog.includes(`source=${source} base=${base} version=0.0.2 source-version=0.0.2 base-version=0.0.2`));
  const body = readFileSync(join(root, "dist", "release", "pr-body.md"), "utf8");
  assert.ok(body.includes(notes));
  assert.doesNotMatch(body, /Historical release notes/);
  assert.equal(body.match(/<!-- aspire-skills-release/g)?.length, 1);
  check(root, { prBody: body });
  put(root, "CHANGELOG.md", changelog.replace("OpenCode catalogs and canvas updates.", "Lost pending release notes."));
  save(root, "Tamper initial release notes");
  assert.throws(() => check(root), /preserved main history/);
});
