import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("bundle manifests emit Aspire 13.6 support metadata and compatible SHA-256/SHA-512 file hashes", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "aspire-bundle-manifest-"));

  try {
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-aspire-bundles.mjs"),
        "--version", "9.9.9",
        "--out", outputRoot
      ],
      { cwd: repoRoot, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr);

    const skillsManifest = assertManifestHashes({
      bundleRoot: join(outputRoot, "aspire-skills-v9.9.9"),
      manifestName: "skill-manifest.json",
      entriesProperty: "skills",
      entriesDirectory: "skills"
    });
    const migrationSkill = skillsManifest.skills.find(skill => skill.name === "aspire-project-v2-migration");
    assert.ok(migrationSkill, "skills bundle must include aspire-project-v2-migration");
    assert.deepEqual(
      migrationSkill.files.map(file => file.relativePath),
      [
        "references/compatibility-and-validation.md",
        "references/migration-patterns.md",
        "SKILL.md"
      ],
      "migration skill bundle must include its references and exclude eval assets"
    );
    assert.deepEqual(migrationSkill.installExcludedRelativePaths, ["evals"]);
    assertManifestHashes({
      bundleRoot: join(outputRoot, "aspire-extensions-v9.9.9"),
      manifestName: "extension-manifest.json",
      entriesProperty: "extensions",
      entriesDirectory: "extensions"
    });
  }
  finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

function assertManifestHashes({
  bundleRoot,
  manifestName,
  entriesProperty,
  entriesDirectory
}) {
  const manifest = JSON.parse(readFileSync(join(bundleRoot, manifestName), "utf8"));
  const entries = manifest[entriesProperty];

  assert.deepEqual(manifest.supports, {
    aspireCli: ">=13.6.0 <13.7.0",
    aspireSdk: ">=13.6.0 <13.7.0"
  });
  assert.ok(entries.length > 0, `${manifestName} must contain ${entriesProperty}.`);

  for (const entry of entries) {
    assert.ok(entry.files.length > 0, `${entry.name} must contain files.`);

    for (const file of entry.files) {
      assert.match(
        file.sha256,
        /^[0-9a-f]{64}$/,
        `${entry.name}/${file.relativePath} must emit a raw lowercase SHA-256 hash.`
      );
      assert.match(
        file.sha512,
        /^[0-9a-f]{128}$/,
        `${entry.name}/${file.relativePath} must emit a raw lowercase SHA-512 hash.`
      );

      const filePath = join(
        bundleRoot,
        entriesDirectory,
        entry.name,
        ...file.relativePath.split("/")
      );
      const contents = readFileSync(filePath);
      const expectedSha256 = createHash("sha256").update(contents).digest("hex");
      const expectedSha512 = createHash("sha512").update(contents).digest("hex");
      assert.equal(file.sha256, expectedSha256, `${entry.name}/${file.relativePath} SHA-256 must match its contents.`);
      assert.equal(file.sha512, expectedSha512, `${entry.name}/${file.relativePath} SHA-512 must match its contents.`);
    }

  }

  return manifest;
}
