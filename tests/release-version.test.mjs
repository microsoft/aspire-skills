import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compareVersions, manifestVersion, parseVersion, releaseVersionFiles, updateManifestVersion } from "../scripts/release-version.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("release version uses strict SemVer including prerelease precedence and build metadata", () => {
  const ordered = ["0.0.3-alpha", "0.0.3-alpha.1", "0.0.3-alpha.2", "0.0.3-alpha.10",
    "0.0.3-beta", "0.0.3-beta.2", "0.0.3-beta.11", "0.0.3-rc.1", "0.0.3", "0.0.4", "0.1.0", "1.0.0"];
  for (let index = 1; index < ordered.length; index++) {
    assert.equal(compareVersions(ordered[index], ordered[index - 1]), 1);
    assert.equal(compareVersions(ordered[index - 1], ordered[index]), -1);
  }
  assert.equal(compareVersions("1.0.0+build.2", "1.0.0+build.1"), 0);
  assert.equal(compareVersions("10000000000000000000.0.0", "9999999999999999999.0.0"), 1);
  for (const value of [undefined, null, 3, "", "v1.0.0", "1.2", "01.0.0", "1.0.0-01", "1.0.0-rc.01", "1.0.0\n", "1.0.0;echo", "1.0.0-"]) {
    assert.throws(() => parseVersion(value), /valid SemVer/);
  }
});

test("all six canonical version fields change without altering formatting or other values", () => {
  const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
  const skills = readdirSync(join(repoRoot, "skills")).map(name => `skills/${name}/SKILL.md`);
  for (const path of [...releaseVersionFiles, ...skills]) {
    const original = readFileSync(join(repoRoot, path));
    assert.equal(manifestVersion(original, path), version);
    const changed = updateManifestVersion(original, path, "9.9.9");
    assert.equal(manifestVersion(changed, path), "9.9.9");
    assert.deepEqual(updateManifestVersion(changed, path, version), original);
  }
});

test("skill metadata version replacement preserves frontmatter, quoting, comments and body", () => {
  for (const quote of ['"', "'", ""]) {
    const source = `---\r\nname: aspire\r\nmetadata:\r\n  author: Microsoft\r\n  version: ${quote}0.0.2${quote} # release\r\n---\r\n\r\nBody version: 0.0.2\r\n`;
    const path = "skills/aspire/SKILL.md";
    assert.equal(manifestVersion(Buffer.from(source), path), "0.0.2");
    assert.equal(updateManifestVersion(Buffer.from(source), path, "0.0.3").toString(),
      source.replace(`version: ${quote}0.0.2${quote} #`, `version: ${quote}0.0.3${quote} #`));
  }
  for (const source of ["---\nname: aspire\n---\n",
    '---\nmetadata:\n  version: "0.0.1"\n  version: "0.0.2"\n---\n',
    '---\nmetadata:\n  version: "0.0.1"\nmetadata:\n  version: "0.0.2"\n---\n']) {
    assert.throws(() => manifestVersion(Buffer.from(source), "skills/aspire/SKILL.md"), /one metadata/);
  }
  const nested = '---\nmetadata:\n  nested:\n    version: "8.0.0"\n  version: "0.0.2"\n---\n';
  assert.equal(updateManifestVersion(Buffer.from(nested), "skills/aspire/SKILL.md", "0.0.3").toString(),
    nested.replace('"0.0.2"', '"0.0.3"'));
});

test("marketplace changes target aspire by name and preserve unrelated versions and formatting", () => {
  const text = '{\r\n\t"version":"5.0.0", "plugins": [ {"version":"8.0.0","name":"other"}, {"name":"aspire", "version" : "0.0.2", "description": "version: 0.0.2"} ]\r\n}\r\n';
  const changed = updateManifestVersion(Buffer.from(text), ".cursor-plugin/marketplace.json", "1.0.0-rc.1");
  assert.equal(changed.toString(), text.replace('"version" : "0.0.2"', '"version" : "1.0.0-rc.1"'));
});

test("manifest parsing rejects ambiguous JSON, missing version fields and invalid targets", () => {
  for (const text of ['{}', '{"version":"0.0.1","version":"0.0.2"}', '{"version":"0.0.1","vers\\u0069on":"0.0.2"}', '{"version":4}', '{']) {
    assert.throws(() => updateManifestVersion(Buffer.from(text), "package.json", "0.0.3"));
  }
  for (const text of ['{"plugins":[]}', '{"plugins":[{"name":"other","version":"0.0.2"}]}',
    '{"plugins":[{"name":"aspire","version":"0.0.2"},{"name":"aspire","version":"0.0.2"}]}']) {
    assert.throws(() => updateManifestVersion(Buffer.from(text), ".claude-plugin/marketplace.json", "0.0.3"));
  }
  assert.throws(() => updateManifestVersion(Buffer.from([0xff]), "package.json", "0.0.3"), /UTF-8/);
});
