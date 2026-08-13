import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  normalizeHookBytes,
  resolveSourceCommit,
  telemetryHookFileModes
} from "../scripts/telemetry-hook-bundle.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsRoot = join(repoRoot, ".test-artifacts");
const sourceCommit = resolveSourceCommit(undefined, repoRoot);
const hookFileNames = ["track-telemetry.sh", "track-telemetry.ps1"];

after(() => {
  rmSync(artifactsRoot, { recursive: true, force: true });
});

test("publishes telemetry hooks with deterministic file modes", () => {
  assert.deepEqual(telemetryHookFileModes, {
    "track-telemetry.sh": 0o755,
    "track-telemetry.ps1": 0o644
  });
});

test("normalizes BOM, CRLF, and CR before hashing", () => {
  const canonical = Buffer.from("#!/bin/bash\necho aspire\n", "utf8");
  const variants = [
    canonical,
    Buffer.from("#!/bin/bash\r\necho aspire\r\n", "utf8"),
    Buffer.from("#!/bin/bash\recho aspire\r", "utf8"),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("#!/bin/bash\r\necho aspire\r\n", "utf8")])
  ];

  for (const variant of variants) {
    assert.deepEqual(normalizeHookBytes(variant), canonical);
  }
});

test("resolves the current commit when provenance is not passed explicitly", () => {
  const expected = spawnSync("git", ["rev-parse", "HEAD^{commit}"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(expected.status, 0, expected.stderr);
  assert.equal(resolveSourceCommit(undefined, repoRoot), expected.stdout.trim());
});

test("skills bundle publishes hook bytes and compatible provenance", () => {
  mkdirSync(artifactsRoot, { recursive: true });
  const outputRoot = mkdtempSync(join(artifactsRoot, "aspire-skills-bundle-"));

  try {
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-aspire-bundles.mjs"),
        "--bundle", "skills",
        "--version", "9.9.9",
        "--out", outputRoot,
        "--source-commit", sourceCommit
      ],
      { cwd: repoRoot, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr);

    const bundleRoot = join(outputRoot, "aspire-skills-v9.9.9");
    const manifest = JSON.parse(readFileSync(join(bundleRoot, "skill-manifest.json"), "utf8"));

    assert.equal(manifest.hooks.commitSha, sourceCommit);
    assert.deepEqual(Object.keys(manifest.hooks.files).sort(), hookFileNames.toSorted());

    for (const fileName of hookFileNames) {
      const sourceBytes = normalizeHookBytes(
        readFileSync(join(repoRoot, "hooks", "scripts", fileName))
      );
      const publishedBytes = readFileSync(join(bundleRoot, "hooks", "scripts", fileName));
      const expectedHash = createHash("sha512").update(publishedBytes).digest("hex");

      assert.deepEqual(publishedBytes, sourceBytes);
      assert.equal(manifest.hooks.files[fileName], expectedHash);
      assert.match(manifest.hooks.files[fileName], /^[0-9a-f]{128}$/);
      assert.equal(
        statSync(join(bundleRoot, "hooks", "scripts", fileName)).mode & 0o777,
        telemetryHookFileModes[fileName]
      );
    }

    const archive = join(outputRoot, "aspire-skills-v9.9.9.tgz");
    const listed = spawnSync("tar", ["-tvzf", archive], { encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /aspire-skills-v9\.9\.9\/hooks\/scripts\/track-telemetry\.sh/);
    assert.match(listed.stdout, /aspire-skills-v9\.9\.9\/hooks\/scripts\/track-telemetry\.ps1/);
    assert.match(listed.stdout, /-rwxr-xr-x\s+.*aspire-skills-v9\.9\.9\/hooks\/scripts\/track-telemetry\.sh/);
    assert.match(listed.stdout, /-rw-r--r--\s+.*aspire-skills-v9\.9\.9\/hooks\/scripts\/track-telemetry\.ps1/);
  }
  finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("builder rejects provenance whose commit does not contain the published hooks", () => {
  mkdirSync(artifactsRoot, { recursive: true });
  const outputRoot = mkdtempSync(join(artifactsRoot, "aspire-skills-bundle-root-commit-"));
  const rootCommit = spawnSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  try {
    assert.equal(rootCommit.status, 0, rootCommit.stderr);

    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-aspire-bundles.mjs"),
        "--bundle", "skills",
        "--version", "9.9.9",
        "--out", outputRoot,
        "--source-commit", rootCommit.stdout.trim()
      ],
      { cwd: repoRoot, encoding: "utf8" }
    );

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Could not read hook '.+' from commit '[0-9a-f]{40}'|does not match commit/
    );
  }
  finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("extensions-only bundle ignores invalid hook provenance", () => {
  mkdirSync(artifactsRoot, { recursive: true });
  const outputRoot = mkdtempSync(join(artifactsRoot, "aspire-extensions-bundle-invalid-"));

  try {
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-aspire-bundles.mjs"),
        "--bundle", "extensions",
        "--version", "9.9.9",
        "--out", outputRoot,
        "--source-commit", "not-a-commit"
      ],
      { cwd: repoRoot, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(statSync(join(outputRoot, "aspire-extensions-v9.9.9.tgz")).isFile(), true);
  }
  finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("builder rejects invalid hook provenance", () => {
  mkdirSync(artifactsRoot, { recursive: true });
  const outputRoot = mkdtempSync(join(artifactsRoot, "aspire-skills-bundle-invalid-"));

  try {
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-aspire-bundles.mjs"),
        "--bundle", "skills",
        "--version", "9.9.9",
        "--out", outputRoot,
        "--source-commit", "not-a-commit"
      ],
      { cwd: repoRoot, encoding: "utf8" }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /40-character Git commit SHA/);
  }
  finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});
