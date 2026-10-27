import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Repository } from "../scripts/release-git.mjs";
import { versionSnapshot } from "../scripts/release-versions.mjs";
import { prepareDevelopmentVersion } from "../scripts/version-development.mjs";

function fixture(t, newline = "\n") {
  const root = mkdtempSync(join(tmpdir(), "dev-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const initialized = spawnSync("git", ["init", "--quiet", root], {
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const repo = new Repository(root);
  repo.run(["switch", "-c", "feature/version"]);
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  for (const path of ["package.json", ".plugin/plugin.json", ".claude-plugin/plugin.json", "gemini-extension.json"]) {
    write(path, '{ "version": "0.0.4", "description": "Keep this spacing." }\n');
  }
  write("package-lock.json", '{"version":"0.0.4","packages":{"":{"version":"0.0.4"}}}\n');
  for (const path of [".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json"]) {
    write(path, '{"plugins":[{"name":"another-plugin","version":"9.0.0"},{"name":"aspire","version":"0.0.4"}]}\n');
  }
  const skill = "---\nname: aspire\nmetadata:\n  version: '0.0.4'\n---\n\n# Keep these instructions.\n";
  write("skills/aspire/SKILL.md", skill);
  const changelog = [
    "# Changelog", "", "## [0.0.4](https://github.com/microsoft/aspire-skills/releases/tag/v0.0.4)",
    "", "### Added", "", "- Current development notes.", "",
    "## [0.0.3](https://github.com/microsoft/aspire-skills/releases/tag/v0.0.3)", "", "Older notes.", ""
  ].join(newline);
  write("CHANGELOG.md", changelog);
  repo.run(["add", "--all"]);
  repo.run(["commit", "--quiet", "-m", "Version fixture"]);
  return { root, repo, changelog, skill };
}

for (const newline of ["\n", "\r\n"]) {
  test(`version bump stages aligned versions, catalogs, and a new heading with ${JSON.stringify(newline)} line endings`, t => {
    const f = fixture(t, newline);
    prepareDevelopmentVersion(f.repo, "0.0.5");
    assert.equal(versionSnapshot(f.repo, f.repo.run(["write-tree"]).trim()).version, "0.0.5");
    const changelog = readFileSync(join(f.root, "CHANGELOG.md"), "utf8");
    const start = f.changelog.indexOf("## ");
    assert.equal(changelog, f.changelog.slice(0, start)
      + `## [0.0.5](https://github.com/microsoft/aspire-skills/releases/tag/v0.0.5)${newline}${newline}`
      + f.changelog.slice(start));
    assert.equal(readFileSync(join(f.root, "skills", "aspire", "SKILL.md"), "utf8"),
      f.skill.replace("version: '0.0.4'", "version: '0.0.5'"));
    assert.equal(JSON.parse(readFileSync(join(f.root, ".claude-plugin", "marketplace.json"))).plugins[0].version, "9.0.0");
    const staged = f.repo.run(["diff", "--cached", "--name-only"]);
    assert.match(staged, /CHANGELOG\.md/);
    assert.match(staged, /opencode\/v1\/index\.json/);
    assert.match(staged, /opencode\/v2\/index\.json/);
    assert.equal(f.repo.run(["diff", "--name-only"]), "");
  });
}

test("a failed catalog build leaves the working tree clean so the bump can be retried", t => {
  const f = fixture(t);
  mkdirSync(join(f.root, "skills", "aspire", "references"), { recursive: true });
  writeFileSync(join(f.root, "skills", "aspire", "references", "broken.md"), "[Missing](missing.md)\n");
  f.repo.run(["add", "--all"]);
  f.repo.run(["commit", "--quiet", "-m", "Add a broken link"]);
  assert.throws(() => prepareDevelopmentVersion(f.repo, "0.0.5"), /Broken relative Markdown link/);
  assert.equal(f.repo.run(["status", "--porcelain"]), "");
});
